/**
 * 领地持久化。
 * 命令和保护层不直接拼查询；多行修改尽量放进同一个 db.tx。
 * 经济接口不在这个事务里，资金一致性由账本状态机负责。
 */

import { db, type TxContext } from "@sfmc-bds/sdk/sapi/db";
import type { WhereExpr } from "@sfmc-bds/sdk/sapi/db";
import { LandError } from "../domain/errors.js";
import type {
  AreaRoleState,
  AreaState,
  FlagValue,
  LandState,
  LeaseState,
  ListingState,
  MemberState,
  RoleState,
  TxState,
} from "../domain/model.js";
import {
  areaFromRow,
  areaRoleFromRow,
  areaRoleToRow,
  areaToRow,
  flagValueFromJson,
  landFromRow,
  landToRow,
  leaseFromRow,
  listingFromRow,
  memberFromRow,
  memberToRow,
  roleFromRow,
  roleToRow,
  txFromRow,
  type Row,
} from "./codec.js";
import { TABLES } from "./tables.js";

type Store = Pick<TxContext, "query" | "get" | "insert" | "update" | "delete">;

function store(tx?: TxContext): Store {
  return tx ?? db;
}

function unique(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique/i.test(message);
}

async function rows(
  table: string,
  where?: WhereExpr,
  tx?: TxContext,
): Promise<Row[]> {
  const result = await store(tx).query<Row>(table, where ? { where } : {});
  return result;
}

async function put(table: string, row: Row, tx?: TxContext): Promise<void> {
  try {
    await store(tx).insert(table, row);
  } catch (error) {
    if (unique(error))
      throw new LandError("name_taken", {
        name: String(row.name ?? row.claim_key ?? row.item_key ?? ""),
      });
    throw error;
  }
}

/** 按主键硬删除。表没有软删除列。 */
export async function hardDelete(
  table: string,
  id: string,
  tx?: TxContext,
): Promise<void> {
  await store(tx).delete(table, id, { hard: true });
}

/** 在一个数据库事务里执行领地侧修改。不能把经济扣款放进这个回调。 */
export function landTx<T>(fn: (tx: TxContext) => Promise<T>): Promise<T> {
  return db.tx(fn);
}

export async function listLands(): Promise<LandState[]> {
  return (await rows(TABLES.land)).map(landFromRow);
}

export async function listClaims(): Promise<
  Array<{
    id: string;
    key: string;
    landId: string;
    dimensionId: string;
    chunkX: number;
    chunkZ: number;
  }>
> {
  return (await rows(TABLES.claim)).map((row) => ({
    id: String(row.id ?? ""),
    key: String(row.claim_key ?? ""),
    landId: String(row.land_id ?? ""),
    dimensionId: String(row.dimension_id ?? ""),
    chunkX: Number(row.chunk_x ?? 0),
    chunkZ: Number(row.chunk_z ?? 0),
  }));
}

export async function listAreas(): Promise<AreaState[]> {
  return (await rows(TABLES.area)).map(areaFromRow);
}

export async function listRoles(): Promise<RoleState[]> {
  return (await rows(TABLES.role)).map(roleFromRow);
}

export async function listMembers(): Promise<MemberState[]> {
  return (await rows(TABLES.member)).map(memberFromRow);
}

export async function listAreaRoles(): Promise<AreaRoleState[]> {
  return (await rows(TABLES.areaRole)).map(areaRoleFromRow);
}

export async function listFlags(): Promise<
  Array<{
    id: string;
    scope: string;
    scopeId: string;
    flagId: string;
    value: FlagValue;
  }>
> {
  return (await rows(TABLES.flag)).map((row) => ({
    id: String(row.id ?? ""),
    scope: String(row.scope ?? ""),
    scopeId: String(row.scope_id ?? ""),
    flagId: String(row.flag_id ?? ""),
    value: flagValueFromJson(String(row.value_json ?? "null")),
  }));
}

export async function listLeases(): Promise<LeaseState[]> {
  return (await rows(TABLES.lease)).map(leaseFromRow);
}

export async function listListings(): Promise<ListingState[]> {
  return (await rows(TABLES.listing)).map(listingFromRow);
}

export async function listTransactions(): Promise<TxState[]> {
  return (await rows(TABLES.tx)).map(txFromRow);
}

export async function listIdentities(): Promise<
  Array<{ playerId: string; playerName: string; nameKey: string }>
> {
  return (await rows(TABLES.identity)).map((row) => ({
    playerId: String(row.player_id ?? ""),
    playerName: String(row.player_name ?? ""),
    nameKey: String(row.name_key ?? ""),
  }));
}

export async function listRegistry(
  kind: string,
): Promise<Array<{ id: string; key: string; payload: string }>> {
  return (await rows(TABLES.registry, { eq: ["kind", kind] })).map((row) => ({
    id: String(row.id ?? ""),
    key: String(row.item_key ?? ""),
    payload: String(row.payload_json ?? "{}"),
  }));
}

export async function insertLand(
  land: LandState,
  tx?: TxContext,
): Promise<void> {
  await put(TABLES.land, landToRow(land), tx);
}

export async function updateLand(
  land: LandState,
  tx?: TxContext,
): Promise<void> {
  const row = landToRow(land);
  delete row.id;
  await store(tx).update(TABLES.land, land.id, row);
}

/** 只更新调用方负责的标量字段，避免旧快照覆盖并发变更的所有权。 */
export type LandPatch = Partial<
  Pick<
    LandState,
    | "ownerId"
    | "ownerName"
    | "status"
    | "level"
    | "nextUpkeepAt"
    | "graceUntil"
    | "upkeepDue"
    | "taxEnabled"
    | "taxAmount"
    | "taxPeriodMs"
    | "nextTaxAt"
    | "updatedAt"
  >
>;

export async function patchLand(
  landId: string,
  patch: LandPatch,
  tx?: TxContext,
): Promise<void> {
  const columns: Record<keyof LandPatch, string> = {
    ownerId: "owner_id",
    ownerName: "owner_name",
    status: "status",
    level: "level",
    nextUpkeepAt: "next_upkeep_at",
    graceUntil: "grace_until",
    upkeepDue: "upkeep_due",
    taxEnabled: "tax_enabled",
    taxAmount: "tax_amount",
    taxPeriodMs: "tax_period_ms",
    nextTaxAt: "next_tax_at",
    updatedAt: "updated_at",
  };
  const row: Row = {};
  for (const key of Object.keys(patch) as Array<keyof LandPatch>) {
    const value = patch[key];
    if (value !== undefined)
      row[columns[key]] = typeof value === "boolean" ? Number(value) : value;
  }
  if (Object.keys(row).length > 0)
    await store(tx).update(TABLES.land, landId, row);
}

export async function insertClaim(
  claim: {
    id: string;
    key: string;
    dimensionId: string;
    chunkX: number;
    chunkZ: number;
    landId: string;
    createdAt: number;
  },
  tx?: TxContext,
): Promise<void> {
  try {
    await store(tx).insert(TABLES.claim, {
      id: claim.id,
      claim_key: claim.key,
      dimension_id: claim.dimensionId,
      chunk_x: claim.chunkX,
      chunk_z: claim.chunkZ,
      land_id: claim.landId,
      created_at: claim.createdAt,
    });
  } catch (error) {
    if (unique(error))
      throw new LandError("claim_conflict", {
        x: claim.chunkX,
        z: claim.chunkZ,
      });
    throw error;
  }
}

export async function insertArea(
  area: AreaState,
  tx?: TxContext,
): Promise<void> {
  await put(TABLES.area, areaToRow(area), tx);
}

export async function updateArea(
  area: AreaState,
  tx?: TxContext,
): Promise<void> {
  const row = areaToRow(area);
  delete row.id;
  await store(tx).update(TABLES.area, area.id, row);
}

export async function insertRole(
  role: RoleState,
  tx?: TxContext,
): Promise<void> {
  await put(TABLES.role, roleToRow(role), tx);
}

export async function updateRole(
  role: RoleState,
  tx?: TxContext,
): Promise<void> {
  const row = roleToRow(role);
  delete row.id;
  await store(tx).update(TABLES.role, role.id, row);
}

export async function insertMember(
  member: MemberState,
  tx?: TxContext,
): Promise<void> {
  await put(TABLES.member, memberToRow(member), tx);
}

export async function updateMember(
  member: MemberState,
  tx?: TxContext,
): Promise<void> {
  const row = memberToRow(member);
  delete row.id;
  await store(tx).update(TABLES.member, member.id, row);
}

export async function insertAreaRole(
  role: AreaRoleState,
  tx?: TxContext,
): Promise<void> {
  await put(TABLES.areaRole, areaRoleToRow(role), tx);
}

export async function updateAreaRole(
  role: AreaRoleState,
  tx?: TxContext,
): Promise<void> {
  await store(tx).update(TABLES.areaRole, role.id, { role_id: role.roleId });
}

/**
 * 把区域授权改挂到另一个玩家 ID（同时更新唯一键）。
 * 使用场景：旧服占位身份绑定到真实 player.id；调用方需先确认目标玩家在该区域没有授权。
 */
export async function rebindAreaRole(
  role: AreaRoleState,
  tx?: TxContext,
): Promise<void> {
  await store(tx).update(TABLES.areaRole, role.id, {
    player_id: role.playerId,
    assign_key: `${role.areaId}|${role.playerId}`,
  });
}

export async function upsertFlag(
  row: {
    id: string;
    scope: string;
    scopeId: string;
    flagId: string;
    value: FlagValue;
  },
  existingId?: string,
  tx?: TxContext,
): Promise<void> {
  if (existingId) {
    await store(tx).update(TABLES.flag, existingId, {
      value_json: JSON.stringify(row.value),
    });
    return;
  }
  await put(
    TABLES.flag,
    {
      id: row.id,
      scope: row.scope,
      scope_id: row.scopeId,
      flag_id: row.flagId,
      flag_key: `${row.scope}|${row.scopeId}|${row.flagId}`,
      value_json: JSON.stringify(row.value),
    },
    tx,
  );
}

export async function insertTx(
  txState: TxState,
  tx?: TxContext,
): Promise<void> {
  await put(
    TABLES.tx,
    {
      id: txState.id,
      idempotency_key: txState.idempotencyKey,
      kind: txState.kind,
      status: txState.status,
      land_id: txState.landId,
      actor_id: txState.actorId,
      from_account: txState.fromAccount,
      to_account: txState.toAccount,
      amount: txState.amount,
      payload_json: txState.payloadJson,
      error: txState.error,
      economy_tx_id: txState.economyTxId,
      created_at: txState.createdAt,
      updated_at: txState.updatedAt,
    },
    tx,
  );
}

export async function updateTx(
  txState: TxState,
  tx?: TxContext,
): Promise<void> {
  await store(tx).update(TABLES.tx, txState.id, {
    status: txState.status,
    error: txState.error,
    economy_tx_id: txState.economyTxId,
    updated_at: txState.updatedAt,
    payload_json: txState.payloadJson,
  });
}

export async function findTxByKey(key: string): Promise<TxState | undefined> {
  const found = await rows(TABLES.tx, { eq: ["idempotency_key", key] });
  return found[0] ? txFromRow(found[0]) : undefined;
}

export async function insertLease(
  lease: LeaseState,
  tx?: TxContext,
): Promise<void> {
  await store(tx).insert(TABLES.lease, {
    id: lease.id,
    area_id: lease.areaId,
    land_id: lease.landId,
    tenant_id: lease.tenantId,
    tenant_name: lease.tenantName,
    price: lease.price,
    period_ms: lease.periodMs,
    start_at: lease.startAt,
    end_at: lease.endAt,
    status: lease.status,
    created_at: lease.createdAt,
    updated_at: lease.updatedAt,
  });
}

export async function updateLease(
  lease: LeaseState,
  tx?: TxContext,
): Promise<void> {
  await store(tx).update(TABLES.lease, lease.id, {
    end_at: lease.endAt,
    status: lease.status,
    updated_at: lease.updatedAt,
    price: lease.price,
    period_ms: lease.periodMs,
  });
}

export async function insertListing(
  listing: ListingState,
  tx?: TxContext,
): Promise<void> {
  await store(tx).insert(TABLES.listing, {
    id: listing.id,
    target_type: listing.targetType,
    target_id: listing.targetId,
    land_id: listing.landId,
    kind: listing.kind,
    price: listing.price,
    period_ms: listing.periodMs,
    status: listing.status,
    seller_id: listing.sellerId,
    created_at: listing.createdAt,
    updated_at: listing.updatedAt,
  });
}

export async function updateListing(
  listing: ListingState,
  tx?: TxContext,
): Promise<void> {
  await store(tx).update(TABLES.listing, listing.id, {
    status: listing.status,
    price: listing.price,
    period_ms: listing.periodMs,
    updated_at: listing.updatedAt,
  });
}

export async function saveRegistry(
  kind: string,
  key: string,
  id: string,
  payload: string,
  existingId?: string,
): Promise<void> {
  if (existingId) {
    await db.update(TABLES.registry, existingId, {
      payload_json: payload,
      updated_at: Date.now(),
    });
    return;
  }
  await put(TABLES.registry, {
    id,
    kind,
    item_key: `${kind}|${key}`,
    payload_json: payload,
    updated_at: Date.now(),
  });
}

export async function saveIdentity(
  playerId: string,
  playerName: string,
  nameKey: string,
): Promise<void> {
  const existing = await db.get<Row>(TABLES.identity, playerId);
  if (existing) {
    await db.update(TABLES.identity, playerId, {
      player_name: playerName,
      name_key: nameKey,
      updated_at: Date.now(),
    });
    return;
  }
  await db.insert(TABLES.identity, {
    player_id: playerId,
    player_name: playerName,
    name_key: nameKey,
    updated_at: Date.now(),
  });
}

export async function hasReward(rewardKey: string): Promise<boolean> {
  const found = await rows(TABLES.reward, { eq: ["reward_key", rewardKey] });
  return found.length > 0;
}

export async function insertReward(
  id: string,
  rewardKey: string,
  landId: string,
  level: number,
  rewardId: string,
): Promise<void> {
  try {
    await db.insert(TABLES.reward, {
      id,
      reward_key: rewardKey,
      land_id: landId,
      level,
      reward_id: rewardId,
      created_at: Date.now(),
    });
  } catch (error) {
    if (unique(error)) return;
    throw error;
  }
}

/** 删除领地的全部从属行。调用方必须先确认银行、租约和未完成交易已处理。 */
export async function deleteLandGraph(
  landId: string,
  tx: TxContext,
): Promise<void> {
  const claims = await rows(TABLES.claim, { eq: ["land_id", landId] }, tx);
  const areas = await rows(TABLES.area, { eq: ["land_id", landId] }, tx);
  const roles = await rows(TABLES.role, { eq: ["land_id", landId] }, tx);
  const members = await rows(TABLES.member, { eq: ["land_id", landId] }, tx);
  const areaRoles = await rows(
    TABLES.areaRole,
    { eq: ["land_id", landId] },
    tx,
  );
  const leases = await rows(TABLES.lease, { eq: ["land_id", landId] }, tx);
  const listings = await rows(TABLES.listing, { eq: ["land_id", landId] }, tx);
  const flags = await rows(TABLES.flag, { eq: ["scope_id", landId] }, tx);
  for (const area of areas) {
    const areaFlags = await rows(
      TABLES.flag,
      { eq: ["scope_id", String(area.id)] },
      tx,
    );
    flags.push(...areaFlags);
  }
  for (const row of claims) await hardDelete(TABLES.claim, String(row.id), tx);
  for (const row of areaRoles)
    await hardDelete(TABLES.areaRole, String(row.id), tx);
  for (const row of members)
    await hardDelete(TABLES.member, String(row.id), tx);
  for (const row of roles) await hardDelete(TABLES.role, String(row.id), tx);
  for (const row of leases) await hardDelete(TABLES.lease, String(row.id), tx);
  for (const row of listings)
    await hardDelete(TABLES.listing, String(row.id), tx);
  for (const row of flags) await hardDelete(TABLES.flag, String(row.id), tx);
  for (const row of areas) await hardDelete(TABLES.area, String(row.id), tx);
  await hardDelete(TABLES.land, landId, tx);
}
