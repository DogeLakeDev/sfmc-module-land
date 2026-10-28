/**
 * 领地、区块和子区域。
 * 资金先经过账本，领地写入放在可重复执行的落地函数里。
 */

import { world as mcWorld } from "@minecraft/server";
import type { TxContext } from "@sfmc-bds/sdk/sapi/db";
import {
  aabbFromPoints,
  aabbIntersects,
  chunksCoveredBy,
  chunksInRect,
  chunkOf,
  chunkRect,
  claimKey,
  hasVolume,
  type ChunkPos,
  type Vec3,
} from "../domain/geometry.js";
import { LandError } from "../domain/errors.js";
import { assertDisplayName, makeId, nameKey } from "../domain/ids.js";
import type {
  Actor,
  AreaState,
  LandState,
  ListingState,
  MemberState,
  RoleState,
  SpawnPoint,
  TxState,
} from "../domain/model.js";
import { runPaid } from "../economy/ledger.js";
import { getBalance } from "../economy/gateway.js";
import { afterEvent, beforeEvent } from "./hooks.js";
import { withTerritoryLock } from "./lock.js";
import { assertAllowed } from "./permission.js";
import { assertBuiltin, builtinQuota } from "./quota.js";
import {
  bankOf,
  chunkPrice,
  holds,
  landConfig,
  presetRoleStates,
  roleByPreset,
  requireArea,
  requireLand,
  world,
} from "./shared.js";
import {
  deleteLandGraph,
  hardDelete,
  insertArea,
  insertClaim,
  insertLand,
  insertMember,
  insertRole,
  updateMember,
  landTx,
  listTransactions,
  patchLand,
  updateArea,
  updateLand,
  updateListing,
} from "../store/repo.js";
import { areaFromRow, landFromRow, roleFromRow } from "../store/codec.js";
import { TABLES } from "../store/tables.js";

/** 玩家当前位置。出生点和占领都从这里取维度。 */
export interface Standing {
  dimensionId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

function assertOwner(actor: Actor, land: LandState): void {
  if (actor.console) return;
  if (land.ownerId === actor.id) return;
  if (actor.admin && holds(actor, "land.admin")) return;
  throw new LandError("no_permission", { reason: "owner" });
}

function assertPerm(actor: Actor, land: LandState, permission: string): void {
  if (actor.console || land.ownerId === actor.id) return;
  const index = world();
  const area = index.areas.get(land.defaultAreaId);
  if (!area) throw new LandError("not_ready");
  const decision = assertAllowed(index, actor, permission, {
    land,
    area,
    specific: false,
  });
  if (!decision.allow)
    throw new LandError("no_permission", { reason: decision.reason });
}

/** 创建领地并占领脚下区块。重名和冲突在扣款前检查，并发冲突由账本退款。 */
export async function createLand(
  actor: Actor,
  rawName: string,
  description: string,
  here: Standing,
): Promise<LandState> {
  if (actor.console) throw new LandError("need_player");
  assertChunk({
    dimensionId: here.dimensionId,
    chunkX: chunkOf(here.dimensionId, here.x, here.z).chunkX,
    chunkZ: chunkOf(here.dimensionId, here.x, here.z).chunkZ,
  });
  return withTerritoryLock(async () => {
    const config = landConfig();
    const index = world();
    const name = assertDisplayName(rawName, "领地名称");
    if (index.landByName(name)) throw new LandError("name_taken", { name });
    assertBuiltin(
      config,
      index,
      actor,
      undefined,
      "lands",
      "领地数量",
      (permission) => holds(actor, permission),
    );
    const chunk = chunkOf(here.dimensionId, here.x, here.z);
    const key = claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ);
    if (index.claims.has(key))
      throw new LandError("claim_conflict", {
        x: chunk.chunkX,
        z: chunk.chunkZ,
      });
    const now = Date.now();
    const landId = makeId("l");
    const price = Math.max(
      0,
      Math.round(
        config.claimPrice * (config.levels[0]?.claimPriceMultiplier ?? 1),
      ),
    );
    const draft = draftLand(
      landId,
      name,
      description,
      actor,
      here,
      now,
      config.upkeepPeriodMs,
    );
    const roles = presetRoleStates(landId, now);
    const area: AreaState = {
      id: makeId("a"),
      landId,
      name: "默认",
      nameKey: nameKey("默认"),
      description: "未被普通子区域覆盖的空间",
      kind: "default",
      dimensionId: "",
      box: null,
      createdAt: now,
      updatedAt: now,
    };
    draft.defaultAreaId = area.id;
    const claim = {
      id: makeId("c"),
      key,
      dimensionId: chunk.dimensionId,
      chunkX: chunk.chunkX,
      chunkZ: chunk.chunkZ,
    };
    await beforeEvent("land.before.created", {
      actorId: actor.id,
      name,
      landId,
    });
    const tx = await runPaid({
      idempotencyKey: `create:${actor.id}:${nameKey(name)}`,
      kind: "land.create",
      landId,
      actorId: actor.id,
      fromAccount: actor.id,
      toAccount: "",
      amount: price,
      mode: price > 0 ? "debit" : "none",
      payload: { land: draft, area, roles, claim },
      stillApplied: (saved) => ownedLand(saved),
    });
    const savedId =
      readRecord(tx).land &&
      typeof (readRecord(tx).land as LandState).id === "string"
        ? (readRecord(tx).land as LandState).id
        : landId;
    await afterEvent("land.created", {
      actorId: actor.id,
      actorName: actor.name,
      landId: savedId,
      name,
    });
    return world().lands.get(savedId) ?? draft;
  });
}

/** 按账本载荷创建领地。先验证当前占领记录，绝不覆盖后来占领该位置的领地。 */
export async function applyCreateLand(tx: TxState): Promise<void> {
  const payload = readRecord(tx);
  const land = payload.land as LandState | undefined;
  const area = payload.area as AreaState | undefined;
  const roles = payload.roles as RoleState[] | undefined;
  const claim = payload.claim as
    | {
        id: string;
        key: string;
        dimensionId: string;
        chunkX: number;
        chunkZ: number;
      }
    | undefined;
  if (!land || !area || !roles || !claim) {
    if (world().lands.has(tx.landId)) return;
    throw new LandError("internal", { message: "创建交易载荷不完整" });
  }
  const saved = await landTx(async (db) => {
    const storedLand = await db.get<Record<string, unknown>>(
      TABLES.land,
      land.id,
    );
    if (storedLand) {
      // 创建已经提交后，原区块可能正常释放或转给其他领地；只恢复当前关系，不能退还创建费用。
      return {
        land: landFromRow(storedLand),
        areas: (
          await db.query<Record<string, unknown>>(TABLES.area, {
            where: { eq: ["land_id", land.id] },
          })
        ).map(areaFromRow),
        roles: (
          await db.query<Record<string, unknown>>(TABLES.role, {
            where: { eq: ["land_id", land.id] },
          })
        ).map(roleFromRow),
        claims: await db.query<Record<string, unknown>>(TABLES.claim, {
          where: { eq: ["land_id", land.id] },
        }),
      };
    }
    const existing = await db.query<Record<string, unknown>>(TABLES.claim, {
      where: { eq: ["claim_key", claim.key] },
    });
    if (existing.some((row) => row.land_id !== land.id)) {
      throw new LandError("claim_conflict", {
        x: claim.chunkX,
        z: claim.chunkZ,
      });
    }
    await insertLand(land, db);
    await insertArea(area, db);
    for (const role of roles) await insertRole(role, db);
    if (existing.length === 0) {
      await insertClaim(
        { ...claim, landId: land.id, createdAt: land.createdAt },
        db,
      );
    }
    return {
      land,
      areas: [area],
      roles,
      claims: [{ claim_key: claim.key, id: existing[0]?.id ?? claim.id }],
    };
  });
  const live = world();
  live.upsertLand({ ...saved.land, claimKeys: [] });
  for (const savedArea of saved.areas) live.upsertArea(savedArea);
  for (const role of saved.roles) live.upsertRole(role);
  for (const row of saved.claims)
    live.upsertClaim(String(row.claim_key), String(row.id), land.id);
}

function draftLand(
  id: string,
  name: string,
  description: string,
  actor: Actor,
  here: Standing,
  now: number,
  upkeepPeriodMs: number,
): LandState {
  const spawn: SpawnPoint = {
    dimensionId: here.dimensionId,
    x: here.x,
    y: here.y,
    z: here.z,
    yaw: here.yaw,
    pitch: here.pitch,
  };
  return {
    id,
    name,
    nameKey: nameKey(name),
    description,
    ownerId: actor.id,
    ownerName: actor.name,
    status: "active",
    level: 1,
    spawn,
    bankAccount: `land:${id}`,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    nextUpkeepAt: now + upkeepPeriodMs,
    graceUntil: 0,
    upkeepDue: 0,
    taxEnabled: false,
    taxAmount: 0,
    taxPeriodMs: 0,
    nextTaxAt: 0,
    claimKeys: [],
    defaultAreaId: "",
  };
}

/** 删除领地。银行有余额、有效租约或未完成交易时拒绝，不静默丢弃资金。 */
export async function deleteLand(actor: Actor, token: string): Promise<void> {
  return withTerritoryLock(() => deleteLandLocked(actor, token));
}

/**
 * 领地整体消失（删除或被合并）前必须清空的状态；返回第一条阻止原因，没有则返回 undefined。
 * 使用场景：deleteLand 与合并领地（consolidate.ts）共用，保证两条路径都不会静默丢弃资金、租约或挂牌。
 */
export async function removalBlocker(land: LandState): Promise<string | undefined> {
  const balance = await getBalance(bankOf(land));
  if (balance > 0) return `银行仍有 ${balance}`;
  if (
    [...world().activeLeases.values()].some(
      (lease) => lease.landId === land.id && lease.status === "active",
    )
  ) {
    return "仍有有效租约";
  }
  if (
    [...world().listings.values()].some(
      (listing) => listing.landId === land.id && listing.status === "open",
    )
  ) {
    return "仍有未取消的挂牌";
  }
  const openTx = (await listTransactions()).filter(
    (tx) =>
      tx.landId === land.id &&
      (tx.status === "pending" ||
        tx.status === "debited" ||
        tx.status === "refunding"),
  );
  if (openTx.length > 0) return "有未完成交易";
  return undefined;
}

async function deleteLandLocked(actor: Actor, token: string): Promise<void> {
  const land = requireLand(token);
  assertOwner(actor, land);
  const blocker = await removalBlocker(land);
  if (blocker) throw new LandError("delete_blocked", { reason: blocker });
  await beforeEvent("land.before.deleted", {
    actorId: actor.id,
    landId: land.id,
  });
  await landTx(async (tx) => deleteLandGraph(land.id, tx));
  world().dropLand(land.id);
  await afterEvent("land.deleted", {
    actorId: actor.id,
    landId: land.id,
    name: land.name,
  });
}

/** 重命名。角色和授权绑定 ID，不随显示名变化。 */
export async function renameLand(
  actor: Actor,
  token: string,
  rawName: string,
): Promise<LandState> {
  return withTerritoryLock(() => renameLandLocked(actor, token, rawName));
}

async function renameLandLocked(
  actor: Actor,
  token: string,
  rawName: string,
): Promise<LandState> {
  const land = requireLand(token);
  assertPerm(actor, land, "land.manage");
  const name = assertDisplayName(rawName, "领地名称");
  const other = world().landByName(name);
  if (other && other.id !== land.id)
    throw new LandError("name_taken", { name });
  const next = { ...land, name, nameKey: nameKey(name), updatedAt: Date.now() };
  await updateLand(next);
  world().upsertLand(next);
  return next;
}

/** 修改介绍。 */
export async function describeLand(
  actor: Actor,
  token: string,
  description: string,
): Promise<void> {
  return withTerritoryLock(() => describeLandLocked(actor, token, description));
}

async function describeLandLocked(
  actor: Actor,
  token: string,
  description: string,
): Promise<void> {
  const land = requireLand(token);
  assertPerm(actor, land, "land.manage");
  const next = {
    ...land,
    description: description.slice(0, 200),
    updatedAt: Date.now(),
  };
  await updateLand(next);
  world().upsertLand(next);
}

/** 写入扩展元数据。值保持字符串，避免把任意结构塞进权限判断。 */
export async function setMetadata(
  actor: Actor,
  token: string,
  key: string,
  value: string,
): Promise<void> {
  return withTerritoryLock(() => setMetadataLocked(actor, token, key, value));
}

async function setMetadataLocked(
  actor: Actor,
  token: string,
  key: string,
  value: string,
): Promise<void> {
  const land = requireLand(token);
  assertPerm(actor, land, "land.manage");
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key))
    throw new LandError("bad_name", { label: "元数据键", name: key });
  const next = {
    ...land,
    metadata: { ...land.metadata, [key]: value.slice(0, 200) },
    updatedAt: Date.now(),
  };
  await updateLand(next);
  world().upsertLand(next);
}

/** 占领一批区块。调用方先算好价格；落地函数重复执行时跳过已经属于本领地的区块。 */
export async function claimChunks(
  actor: Actor,
  token: string,
  chunks: ChunkPos[],
): Promise<number> {
  for (const chunk of chunks) assertChunk(chunk);
  return withTerritoryLock(() => claimChunksLocked(actor, token, chunks));
}

async function claimChunksLocked(
  actor: Actor,
  token: string,
  chunks: ChunkPos[],
): Promise<number> {
  const config = landConfig();
  const land = requireLand(token);
  assertPerm(actor, land, "land.claim");
  if (land.status !== "active")
    throw new LandError("frozen", { reason: land.status });
  const index = world();
  const fresh = chunks.filter((chunk) => {
    const key = claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ);
    const owner = index.claims.get(key);
    if (owner && owner !== land.id)
      throw new LandError("claim_conflict", {
        x: chunk.chunkX,
        z: chunk.chunkZ,
      });
    return owner !== land.id;
  });
  if (fresh.length === 0) return 0;
  if (fresh.length > config.maxBatchChunks)
    throw new LandError("batch_limit", { limit: config.maxBatchChunks });
  const limit = builtinQuota(
    config,
    index,
    actor,
    land,
    "chunks",
    (permission) => holds(actor, permission),
  ).limit;
  if (land.claimKeys.length + fresh.length > limit)
    throw new LandError("quota", { label: "区块数量", limit });
  const price = chunkPrice(config, land) * fresh.length;
  const now = Date.now();
  const rows = fresh.map((chunk) => ({
    id: makeId("c"),
    key: claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ),
    dimensionId: chunk.dimensionId,
    chunkX: chunk.chunkX,
    chunkZ: chunk.chunkZ,
  }));
  await beforeEvent("land.before.claimed", {
    actorId: actor.id,
    landId: land.id,
    count: fresh.length,
  });
  await runPaid({
    idempotencyKey: `claim:${land.id}:${rows.map((row) => row.key).join(",")}`,
    kind: "land.claim",
    landId: land.id,
    actorId: actor.id,
    fromAccount: actor.id,
    toAccount: "",
    amount: price,
    mode: price > 0 ? "debit" : "none",
    payload: { chunks: rows, createdAt: now },
    stillApplied: (saved) => chunksOwned(land.id, saved),
  });
  await afterEvent("land.claimed", {
    actorId: actor.id,
    landId: land.id,
    count: fresh.length,
  });
  return fresh.length;
}

/** 把载荷里的区块写入领地。已经属于本领地的区块保持原记录。 */
export async function applyClaim(tx: TxState): Promise<void> {
  const payload = readRecord(tx);
  const chunks = payload.chunks as
    | Array<{
        id: string;
        key: string;
        dimensionId: string;
        chunkX: number;
        chunkZ: number;
      }>
    | undefined;
  if (!chunks || chunks.length === 0)
    throw new LandError("internal", { message: "占领交易载荷不完整" });
  const createdAt =
    typeof payload.createdAt === "number" ? payload.createdAt : tx.createdAt;
  const ids = new Map<string, string>();
  await landTx(async (db) => {
    for (const row of chunks) {
      const existing = await db.query<Record<string, unknown>>(TABLES.claim, {
        where: { eq: ["claim_key", row.key] },
      });
      const owner = existing[0]?.land_id;
      if (
        typeof owner === "string" &&
        owner.length > 0 &&
        owner !== tx.landId
      ) {
        throw new LandError("claim_conflict", { x: row.chunkX, z: row.chunkZ });
      }
      if (typeof owner === "string" && owner === tx.landId) {
        ids.set(row.key, String(existing[0]?.id ?? row.id));
        continue;
      }
      await insertClaim({ ...row, landId: tx.landId, createdAt }, db);
      ids.set(row.key, row.id);
    }
  });
  for (const row of chunks)
    world().upsertClaim(row.key, ids.get(row.key) ?? row.id, tx.landId);
}

/** 释放区块。最后一块不能释放；退款比例为 0 时不调用入账。 */
export async function unclaimChunks(
  actor: Actor,
  token: string,
  chunks: ChunkPos[],
): Promise<number> {
  for (const chunk of chunks) assertChunk(chunk);
  return withTerritoryLock(() => unclaimChunksLocked(actor, token, chunks));
}

async function unclaimChunksLocked(
  actor: Actor,
  token: string,
  chunks: ChunkPos[],
): Promise<number> {
  const config = landConfig();
  const land = requireLand(token);
  assertPerm(actor, land, "land.claim");
  const index = world();
  const owned = chunks.filter(
    (chunk) =>
      index.claims.get(
        claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ),
      ) === land.id,
  );
  if (owned.length === 0) throw new LandError("claim_foreign");
  if (land.claimKeys.length - owned.length < 1)
    throw new LandError("claim_empty");
  const affected = areasBrokenBy(land, owned);
  if (affected) throw new LandError("area_outside");
  const refund =
    Math.round(chunkPrice(config, land) * config.unclaimRefundRatio) *
    owned.length;
  const keys = owned.map((chunk) => ({
    key: claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ),
    id:
      index.claimIds.get(
        claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ),
      ) ?? "",
  }));
  await runPaid({
    idempotencyKey: `unclaim:${land.id}:${keys
      .map((item) => item.key)
      .sort()
      .join(",")}`,
    kind: "land.unclaim",
    landId: land.id,
    actorId: actor.id,
    fromAccount: "",
    toAccount: actor.id,
    amount: refund,
    mode: refund > 0 ? "credit" : "none",
    payload: { keys },
    stillApplied: (saved) => chunksReleased(land.id, saved),
  });
  await afterEvent("land.unclaimed", {
    actorId: actor.id,
    landId: land.id,
    count: owned.length,
  });
  return owned.length;
}

/** 仅释放交易记录的原占领行。位置被重新占领后，重放不能删除新记录或其索引。 */
export async function applyUnclaim(tx: TxState): Promise<void> {
  const keys = readRecord(tx).keys as
    Array<{ key: string; id: string }> | undefined;
  if (
    !keys ||
    keys.length === 0 ||
    keys.some((item) => !item.key || !item.id)
  ) {
    throw new LandError("internal", { message: "释放交易载荷不完整" });
  }
  const current = await landTx(async (db) => {
    const remaining = new Map<string, { id: string; landId: string }>();
    for (const item of keys) {
      const rows = await db.query<Record<string, unknown>>(TABLES.claim, {
        where: { eq: ["claim_key", item.key] },
      });
      const row = rows[0];
      if (!row) continue;
      if (row.id === item.id && row.land_id === tx.landId) {
        await hardDelete(TABLES.claim, item.id, db);
      } else {
        if (row.id === item.id) throw new LandError("claim_foreign");
        remaining.set(item.key, {
          id: String(row.id),
          landId: String(row.land_id),
        });
      }
    }
    return remaining;
  });
  const index = world();
  for (const item of keys) {
    const remaining = current.get(item.key);
    if (remaining) {
      index.upsertClaim(item.key, remaining.id, remaining.landId);
    } else if (
      index.claims.get(item.key) === tx.landId &&
      index.claimIds.get(item.key) === item.id
    ) {
      index.removeClaim(item.key);
    }
  }
}

function areasBrokenBy(land: LandState, dropping: ChunkPos[]): boolean {
  const drop = new Set(
    dropping.map((chunk) =>
      claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ),
    ),
  );
  for (const area of world().areasOf(land.id)) {
    if (area.kind !== "box" || !area.box) continue;
    for (const chunk of chunksCoveredBy(area.dimensionId, area.box)) {
      const key = claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ);
      if (drop.has(key)) return true;
    }
  }
  return false;
}

/** 用两个选点展开区块矩形。 */
export function chunksFromSelection(
  dimensionId: string,
  a: Vec3,
  b: Vec3,
): ChunkPos[] {
  return chunksInRect(dimensionId, chunkRect(a, b));
}

/** 设置出生点。必须落在本领地已占领的区块里。 */
export async function setSpawn(
  actor: Actor,
  token: string,
  here: Standing,
): Promise<void> {
  return withTerritoryLock(() => setSpawnLocked(actor, token, here));
}

async function setSpawnLocked(
  actor: Actor,
  token: string,
  here: Standing,
): Promise<void> {
  const land = requireLand(token);
  assertPerm(actor, land, "land.manage");
  const chunk = chunkOf(here.dimensionId, here.x, here.z);
  if (
    world().claims.get(
      claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ),
    ) !== land.id
  ) {
    throw new LandError("spawn_outside");
  }
  const next = {
    ...land,
    spawn: {
      dimensionId: here.dimensionId,
      x: here.x,
      y: here.y,
      z: here.z,
      yaw: here.yaw,
      pitch: here.pitch,
    },
    updatedAt: Date.now(),
  };
  await updateLand(next);
  world().upsertLand(next);
}

/** 把出生点改到一块已占领区块的中心，高度沿用玩家当前高度。 */
export async function resetSpawn(
  actor: Actor,
  token: string,
  here: Standing,
): Promise<void> {
  return withTerritoryLock(() => resetSpawnLocked(actor, token, here));
}

async function resetSpawnLocked(
  actor: Actor,
  token: string,
  here: Standing,
): Promise<void> {
  const land = requireLand(token);
  assertPerm(actor, land, "land.manage");
  const first = land.claimKeys[0];
  if (!first) throw new LandError("spawn_outside");
  const [dimensionId, chunkX, chunkZ] = first.split("|");
  await setSpawnLocked(actor, land.id, {
    dimensionId: dimensionId ?? here.dimensionId,
    x: Number(chunkX) * 16 + 8,
    y: here.y,
    z: Number(chunkZ) * 16 + 8,
    yaw: here.yaw,
    pitch: here.pitch,
  });
}

/** 创建普通子区域。覆盖的每个区块都必须属于该领地，不能只检查两个角。 */
export async function createArea(
  actor: Actor,
  token: string,
  rawName: string,
  a: Vec3 & { dimensionId: string },
  b: Vec3 & { dimensionId: string },
): Promise<AreaState> {
  return withTerritoryLock(async () => {
    const land = requireLand(token);
    assertPerm(actor, land, "area.manage");
    if (a.dimensionId !== b.dimensionId) throw new LandError("selection_dim");
    const box = aabbFromPoints(a, b);
    if (!hasVolume(box)) throw new LandError("selection_missing");
    assertAreaInside(land, a.dimensionId, box);
    assertNoOverlap(land, a.dimensionId, box, undefined);
    assertBuiltin(
      landConfig(),
      world(),
      actor,
      land,
      "areas",
      "子区域数量",
      (permission) => holds(actor, permission),
    );
    const name = assertDisplayName(rawName, "区域名称");
    if (world().areaByName(land.id, name))
      throw new LandError("name_taken", { name });
    const now = Date.now();
    const area: AreaState = {
      id: makeId("a"),
      landId: land.id,
      name,
      nameKey: nameKey(name),
      description: "",
      kind: "box",
      dimensionId: a.dimensionId,
      box,
      createdAt: now,
      updatedAt: now,
    };
    await beforeEvent("land.before.area", {
      actorId: actor.id,
      landId: land.id,
      areaId: area.id,
      op: "create",
    });
    await insertArea(area);
    world().upsertArea(area);
    await afterEvent("land.area.changed", {
      actorId: actor.id,
      landId: land.id,
      areaId: area.id,
      op: "create",
    });
    return area;
  });
}

/** 用新的选点调整区域，并重新检查越界和重叠。 */
export async function resizeArea(
  actor: Actor,
  token: string,
  areaToken: string,
  a: Vec3 & { dimensionId: string },
  b: Vec3 & { dimensionId: string },
): Promise<void> {
  return withTerritoryLock(async () => {
    const land = requireLand(token);
    assertPerm(actor, land, "area.manage");
    const area = requireArea(land, areaToken);
    if (area.kind === "default") throw new LandError("area_default");
    if (a.dimensionId !== b.dimensionId) throw new LandError("selection_dim");
    const box = aabbFromPoints(a, b);
    if (!hasVolume(box)) throw new LandError("selection_missing");
    assertAreaInside(land, a.dimensionId, box);
    assertNoOverlap(land, a.dimensionId, box, area.id);
    const next = {
      ...area,
      dimensionId: a.dimensionId,
      box,
      updatedAt: Date.now(),
    };
    await updateArea(next);
    world().upsertArea(next);
    await afterEvent("land.area.changed", {
      actorId: actor.id,
      landId: land.id,
      areaId: area.id,
      op: "resize",
    });
  });
}

/** 重命名子区域。 */
export async function renameArea(
  actor: Actor,
  token: string,
  areaToken: string,
  rawName: string,
): Promise<void> {
  return withTerritoryLock(() =>
    renameAreaLocked(actor, token, areaToken, rawName),
  );
}

async function renameAreaLocked(
  actor: Actor,
  token: string,
  areaToken: string,
  rawName: string,
): Promise<void> {
  const land = requireLand(token);
  assertPerm(actor, land, "area.manage");
  const area = requireArea(land, areaToken);
  if (area.kind === "default") throw new LandError("area_default");
  const name = assertDisplayName(rawName, "区域名称");
  const other = world().areaByName(land.id, name);
  if (other && other.id !== area.id)
    throw new LandError("name_taken", { name });
  const next = { ...area, name, nameKey: nameKey(name), updatedAt: Date.now() };
  await updateArea(next);
  world().upsertArea(next);
}

/** 修改子区域介绍。 */
export async function describeArea(
  actor: Actor,
  token: string,
  areaToken: string,
  description: string,
): Promise<void> {
  return withTerritoryLock(() =>
    describeAreaLocked(actor, token, areaToken, description),
  );
}

async function describeAreaLocked(
  actor: Actor,
  token: string,
  areaToken: string,
  description: string,
): Promise<void> {
  const land = requireLand(token);
  assertPerm(actor, land, "area.manage");
  const area = requireArea(land, areaToken);
  const next = {
    ...area,
    description: description.slice(0, 200),
    updatedAt: Date.now(),
  };
  await updateArea(next);
  world().upsertArea(next);
}

/** 删除普通子区域。有效租约或出售挂牌会阻止删除。 */
export async function deleteArea(
  actor: Actor,
  token: string,
  areaToken: string,
): Promise<void> {
  return withTerritoryLock(() => deleteAreaLocked(actor, token, areaToken));
}

async function deleteAreaLocked(
  actor: Actor,
  token: string,
  areaToken: string,
): Promise<void> {
  const land = requireLand(token);
  assertPerm(actor, land, "area.manage");
  const area = requireArea(land, areaToken);
  if (area.kind === "default") throw new LandError("area_default");
  const lease = world().activeLeases.get(area.id);
  if (lease?.status === "active")
    throw new LandError("delete_blocked", { reason: "区域仍在租赁" });
  const listing = [...world().listings.values()].find(
    (item) => item.targetId === area.id && item.status === "open",
  );
  if (listing)
    throw new LandError("delete_blocked", { reason: "区域仍在挂牌" });
  await removeAreaRecords(land, area, actor.id);
}

/**
 * 删除一个普通子区域及其区域授权（库、索引与 land.area.changed 事件）。调用方负责权限、租约与挂牌检查，并持有领地写锁。
 * 使用场景：deleteArea；管理员按名称前缀清理子区域（consolidate.ts 的 pruneAreas）。
 */
export async function removeAreaRecords(
  land: LandState,
  area: AreaState,
  actorId: string,
): Promise<void> {
  await landTx(async (tx) => {
    for (const role of [...world().areaRoles.values()].filter(
      (item) => item.areaId === area.id,
    )) {
      await hardDelete(TABLES.areaRole, role.id, tx);
    }
    await hardDelete(TABLES.area, area.id, tx);
  });
  for (const role of [...world().areaRoles.values()].filter(
    (item) => item.areaId === area.id,
  )) {
    world().removeAreaRole(area.id, role.playerId, land.id);
  }
  world().removeArea(area.id);
  await afterEvent("land.area.changed", {
    actorId,
    landId: land.id,
    areaId: area.id,
    op: "delete",
  });
}

function assertAreaInside(
  land: LandState,
  dimensionId: string,
  box: ReturnType<typeof aabbFromPoints>,
): void {
  const index = world();
  for (const chunk of chunksCoveredBy(dimensionId, box)) {
    if (
      index.claims.get(
        claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ),
      ) !== land.id
    ) {
      throw new LandError("area_outside");
    }
  }
}

function assertNoOverlap(
  land: LandState,
  dimensionId: string,
  box: ReturnType<typeof aabbFromPoints>,
  ignoreId: string | undefined,
): void {
  for (const area of world().areasOf(land.id)) {
    if (
      area.id === ignoreId ||
      area.kind !== "box" ||
      !area.box ||
      area.dimensionId !== dimensionId
    )
      continue;
    if (aabbIntersects(area.box, box))
      throw new LandError("area_overlap", { name: area.name });
  }
}

function assertChunk(chunk: ChunkPos): void {
  if (
    !Number.isSafeInteger(chunk.chunkX) ||
    !Number.isSafeInteger(chunk.chunkZ)
  ) {
    throw new LandError("bad_name", {
      label: "区块坐标",
      name: `${chunk.chunkX},${chunk.chunkZ}`,
    });
  }
  try {
    mcWorld.getDimension(chunk.dimensionId);
  } catch {
    throw new LandError("bad_name", { label: "维度", name: chunk.dimensionId });
  }
}

function readRecord(tx: TxState): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tx.payloadJson) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function ownedLand(tx: TxState): boolean {
  const land = readRecord(tx).land as LandState | undefined;
  return Boolean(land?.id && world().lands.has(land.id));
}

function chunksOwned(landId: string, tx: TxState): boolean {
  const chunks = readRecord(tx).chunks as Array<{ key?: string }> | undefined;
  if (!chunks || chunks.length === 0) return false;
  return chunks.every(
    (chunk) => chunk.key && world().claims.get(chunk.key) === landId,
  );
}

function chunksReleased(landId: string, tx: TxState): boolean {
  const keys = readRecord(tx).keys as Array<{ key?: string }> | undefined;
  if (!keys || keys.length === 0) return false;
  return keys.every(
    (item) => item.key && world().claims.get(item.key) !== landId,
  );
}

/** 已校验的转让计划。调用方必须从准备到发布持续持有领地写锁。 */
export interface LandTransferPlan {
  actorId: string;
  landId: string;
  nextOwner: { id: string; name: string };
  former?: MemberState;
  previousMemberId?: string;
  incomingMemberId?: string;
  closedListings: ListingState[];
  updatedAt: number;
  unchanged: boolean;
}

/** 准备共享的转让规则。购买服务可把 writeLandTransfer 与挂牌状态放进同一事务。 */
export async function prepareLandTransfer(
  actor: Actor,
  token: string,
  nextOwner: { id: string; name: string },
  options?: { skipOpenTx?: boolean; allowSameOwner?: boolean },
): Promise<LandTransferPlan> {
  const land = requireLand(token);
  assertOwner(actor, land);
  if (nextOwner.id === land.ownerId) {
    if (!options?.allowSameOwner)
      throw new LandError("transfer_blocked", { reason: "对方已经是领主" });
    return {
      actorId: actor.id,
      landId: land.id,
      nextOwner,
      closedListings: [],
      updatedAt: land.updatedAt,
      unchanged: true,
    };
  }
  assertBuiltin(
    landConfig(),
    world(),
    { ...actor, id: nextOwner.id, name: nextOwner.name },
    undefined,
    "lands",
    "对方的领地数量",
    () => false,
  );
  const openTx =
    options?.skipOpenTx === true
      ? false
      : (await listTransactions()).some(
          (tx) =>
            tx.landId === land.id &&
            (tx.status === "pending" ||
              tx.status === "debited" ||
              tx.status === "refunding"),
        );
  if (openTx)
    throw new LandError("transfer_blocked", { reason: "有未完成交易" });
  await beforeEvent("land.before.transferred", {
    actorId: actor.id,
    landId: land.id,
    to: nextOwner.id,
  });
  const adminRole = roleByPreset(world().rolesOf(land.id), "admin");
  const now = Date.now();
  const previous = world().member(land.id, land.ownerId);
  const former: MemberState = {
    id: previous?.id ?? makeId("m"),
    landId: land.id,
    playerId: land.ownerId,
    playerName: land.ownerName,
    relation: "admin" as const,
    roleId: adminRole.id,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  return {
    actorId: actor.id,
    landId: land.id,
    nextOwner,
    former,
    previousMemberId: previous?.id,
    incomingMemberId: world().member(land.id, nextOwner.id)?.id,
    closedListings: [...world().listings.values()]
      .filter(
        (listing) =>
          listing.landId === land.id &&
          listing.targetType === "land" &&
          listing.status === "open",
      )
      .map((listing) => ({ ...listing, status: "closed", updatedAt: now })),
    updatedAt: now,
    unchanged: false,
  };
}

/** 只写数据库。调用方负责同一事务中的其他业务写入以及提交后的索引发布。 */
export async function writeLandTransfer(
  plan: LandTransferPlan,
  tx: TxContext,
): Promise<void> {
  if (plan.unchanged || !plan.former) return;
  await patchLand(
    plan.landId,
    {
      ownerId: plan.nextOwner.id,
      ownerName: plan.nextOwner.name,
      updatedAt: plan.updatedAt,
    },
    tx,
  );
  if (plan.previousMemberId) await updateMember(plan.former, tx);
  else await insertMember(plan.former, tx);
  if (plan.incomingMemberId)
    await hardDelete(TABLES.member, plan.incomingMemberId, tx);
  for (const listing of plan.closedListings) await updateListing(listing, tx);
}

/** 数据库事务成功后再更新保护索引和发送事件。 */
export async function publishLandTransfer(
  plan: LandTransferPlan,
): Promise<void> {
  if (plan.unchanged || !plan.former) return;
  const land = requireLand(plan.landId);
  world().upsertLand({
    ...land,
    ownerId: plan.nextOwner.id,
    ownerName: plan.nextOwner.name,
    updatedAt: plan.updatedAt,
  });
  world().upsertMember(plan.former);
  world().removeMember(plan.landId, plan.nextOwner.id);
  for (const listing of plan.closedListings) world().upsertListing(listing);
  await afterEvent("land.transferred", {
    actorId: plan.actorId,
    landId: plan.landId,
    to: plan.nextOwner.id,
  });
}

/** 转让领主。原领主变为管理员，开放中的整领出售被关闭。 */
export async function transferLand(
  actor: Actor,
  token: string,
  nextOwner: { id: string; name: string },
  options?: { skipOpenTx?: boolean },
): Promise<void> {
  return withTerritoryLock(async () => {
    const plan = await prepareLandTransfer(actor, token, nextOwner, options);
    await landTx((tx) => writeLandTransfer(plan, tx));
    await publishLandTransfer(plan);
  });
}
