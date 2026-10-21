/**
 * 子区域租赁和出售。
 * 租客只得到区域角色，不获得领主身份。整领出售会走和转让相同的所有权规则。
 */

import { LandError } from "../domain/errors.js";
import { makeId } from "../domain/ids.js";
import type {
  Actor,
  AreaRoleState,
  LandState,
  LeaseState,
  ListingState,
  TxState,
} from "../domain/model.js";
import { BusinessCommittedError, runPaid } from "../economy/ledger.js";
import { getBalance } from "../economy/gateway.js";
import { afterEvent, beforeEvent } from "./hooks.js";
import { assertAllowed } from "./permission.js";
import { withTerritoryLock } from "./lock.js";
import {
  holds,
  requireArea,
  requireLand,
  roleByPreset,
  world,
} from "./shared.js";
import {
  findTxByKey,
  hardDelete,
  insertAreaRole,
  insertLease,
  insertListing,
  landTx,
  listLeases,
  listTransactions,
  updateAreaRole,
  updateLease,
  updateListing,
  updateTx,
} from "../store/repo.js";
import type { TxContext } from "@sfmc-bds/sdk/sapi/db";
import { TABLES } from "../store/tables.js";
import { hydrate } from "../store/hydrate.js";
import {
  prepareLandTransfer,
  publishLandTransfer,
  writeLandTransfer,
} from "./territory.js";

function assertEconomy(actor: Actor, land: LandState): void {
  if (actor.console || land.ownerId === actor.id) return;
  const area = world().areas.get(land.defaultAreaId);
  if (!area) throw new LandError("not_ready");
  const decision = assertAllowed(world(), actor, "economy.manage", {
    land,
    area,
    specific: false,
  });
  if (!decision.allow && !holds(actor, "land.admin"))
    throw new LandError("no_permission", { reason: decision.reason });
}

function openListing(
  targetId: string,
  kind: ListingState["kind"],
): ListingState | undefined {
  return [...world().listings.values()].find(
    (listing) =>
      listing.targetId === targetId &&
      listing.kind === kind &&
      listing.status === "open",
  );
}

/** 发布区域租赁。租金进入领地银行。 */
async function publishRentLocked(
  actor: Actor,
  token: string,
  areaToken: string,
  price: number,
  periodMs: number,
): Promise<ListingState> {
  const land = requireLand(token);
  assertEconomy(actor, land);
  const area = requireArea(land, areaToken);
  if (area.kind !== "box") throw new LandError("area_default");
  if (world().activeLeases.get(area.id)?.status === "active")
    throw new LandError("sale_blocked", { reason: "区域已有租约" });
  if (openListing(area.id, "rent") || openListing(area.id, "sale"))
    throw new LandError("sale_blocked", { reason: "区域已有挂牌" });
  const listing = listingOf(
    land,
    "area",
    area.id,
    "rent",
    price,
    periodMs,
    actor.id,
  );
  await insertListing(listing);
  world().upsertListing(listing);
  return listing;
}

/** 发布区域出售。买家获得该区域的成员角色覆盖，不获得领主身份。 */
async function publishAreaSaleLocked(
  actor: Actor,
  token: string,
  areaToken: string,
  price: number,
): Promise<ListingState> {
  const land = requireLand(token);
  assertEconomy(actor, land);
  const area = requireArea(land, areaToken);
  if (area.kind !== "box") throw new LandError("area_default");
  if (world().activeLeases.get(area.id)?.status === "active")
    throw new LandError("sale_blocked", { reason: "请先结束租约" });
  if (openListing(area.id, "sale") || openListing(area.id, "rent"))
    throw new LandError("sale_blocked", { reason: "区域已有挂牌" });
  const listing = listingOf(land, "area", area.id, "sale", price, 0, actor.id);
  await insertListing(listing);
  world().upsertListing(listing);
  return listing;
}

/** 发布整领出售。银行不为空、仍有租约或未完成交易时拒绝。 */
async function publishLandSaleLocked(
  actor: Actor,
  token: string,
  price: number,
): Promise<ListingState> {
  const land = requireLand(token);
  if (land.ownerId !== actor.id && !actor.console)
    throw new LandError("no_permission", { reason: "owner" });
  if (
    [...world().activeLeases.values()].some(
      (lease) => lease.landId === land.id && lease.status === "active",
    )
  ) {
    throw new LandError("sale_blocked", { reason: "仍有有效租约" });
  }
  if ((await getBalance(land.bankAccount)) > 0)
    throw new LandError("sale_blocked", { reason: "请先取出银行余额" });
  const openTx = (await listTransactions()).some(
    (tx) =>
      tx.landId === land.id &&
      (tx.status === "pending" ||
        tx.status === "debited" ||
        tx.status === "refunding"),
  );
  if (openTx) throw new LandError("sale_blocked", { reason: "有未完成交易" });
  if (openListing(land.id, "sale"))
    throw new LandError("sale_blocked", { reason: "领地已在出售" });
  const listing = listingOf(land, "land", land.id, "sale", price, 0, actor.id);
  await insertListing(listing);
  world().upsertListing(listing);
  return listing;
}

function listingOf(
  land: LandState,
  targetType: ListingState["targetType"],
  targetId: string,
  kind: ListingState["kind"],
  price: number,
  periodMs: number,
  sellerId: string,
): ListingState {
  if (!Number.isSafeInteger(price) || price <= 0)
    throw new LandError("bad_name", { label: "价格", name: String(price) });
  if (kind === "rent" && periodMs < 60_000)
    throw new LandError("bad_name", { label: "租期", name: String(periodMs) });
  const now = Date.now();
  return {
    id: makeId("p"),
    targetType,
    targetId,
    landId: land.id,
    kind,
    price,
    periodMs: kind === "rent" ? periodMs : 0,
    status: "open",
    sellerId,
    createdAt: now,
    updatedAt: now,
  };
}

/** 取消开放挂牌。 */
async function cancelListingLocked(
  actor: Actor,
  token: string,
  areaToken?: string,
): Promise<void> {
  const land = requireLand(token);
  assertEconomy(actor, land);
  const targetId = areaToken ? requireArea(land, areaToken).id : land.id;
  const listing = [...world().listings.values()].find(
    (item) =>
      item.landId === land.id &&
      item.targetId === targetId &&
      item.status === "open",
  );
  if (!listing)
    throw new LandError("land_not_found", { name: areaToken ?? token });
  const next = { ...listing, status: "closed" as const, updatedAt: Date.now() };
  await updateListing(next);
  world().upsertListing(next);
}

/** 接受租赁。租金付给领地银行，租客获得租客角色的区域覆盖。 */
async function takeLeaseLocked(
  actor: Actor,
  token: string,
  areaToken: string,
): Promise<LeaseState> {
  const land = requireLand(token);
  const area = requireArea(land, areaToken);
  const listing = openListing(area.id, "rent");
  if (!listing) throw new LandError("land_not_found", { name: areaToken });
  if (actor.id === land.ownerId)
    throw new LandError("no_permission", { reason: "owner" });
  if (world().member(land.id, actor.id)?.relation === "banned")
    throw new LandError("no_permission", { reason: "banned" });
  const now = Date.now();
  const lease: LeaseState = {
    id: makeId("e"),
    areaId: area.id,
    landId: land.id,
    tenantId: actor.id,
    tenantName: actor.name,
    price: listing.price,
    periodMs: listing.periodMs,
    startAt: now,
    endAt: now + listing.periodMs,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await beforeEvent("land.before.lease", {
    actorId: actor.id,
    landId: land.id,
    areaId: area.id,
  });
  const transaction = await runPaid({
    idempotencyKey: `rent:${listing.id}:${actor.id}`,
    kind: "land.rent",
    landId: land.id,
    actorId: actor.id,
    fromAccount: actor.id,
    toAccount: land.bankAccount,
    amount: listing.price,
    mode: "transfer",
    payload: { lease, listingId: listing.id },
  });
  const savedLease = payloadOf(transaction).lease as LeaseState;
  await afterEvent("land.lease.started", {
    actorId: actor.id,
    landId: land.id,
    areaId: area.id,
    leaseId: savedLease.id,
  });
  return savedLease;
}

/** 续租。租客或领主都可以支付下一期。 */
async function renewLeaseLocked(
  actor: Actor,
  token: string,
  areaToken: string,
): Promise<void> {
  const land = requireLand(token);
  const area = requireArea(land, areaToken);
  const lease = world().activeLeases.get(area.id);
  if (!lease || lease.status !== "active")
    throw new LandError("land_not_found", { name: areaToken });
  if (
    actor.id !== lease.tenantId &&
    actor.id !== land.ownerId &&
    !actor.console
  )
    throw new LandError("no_permission", { reason: "tenant" });
  const payer = actor.id === land.ownerId ? actor.id : lease.tenantId;
  await runPaid({
    idempotencyKey: `renew:${lease.id}:${lease.endAt}`,
    kind: "land.renew",
    landId: land.id,
    actorId: actor.id,
    fromAccount: payer,
    toAccount: land.bankAccount,
    amount: lease.price,
    mode: "transfer",
    payload: { leaseId: lease.id, endAt: lease.endAt + lease.periodMs },
  });
}

/** 提前结束租约。不自动退还未使用的租金。 */
async function endLeaseLocked(
  actor: Actor,
  token: string,
  areaToken: string,
): Promise<void> {
  const land = requireLand(token);
  const area = requireArea(land, areaToken);
  const lease = world().activeLeases.get(area.id);
  if (!lease) throw new LandError("land_not_found", { name: areaToken });
  if (
    actor.id !== lease.tenantId &&
    actor.id !== land.ownerId &&
    !actor.console
  )
    throw new LandError("no_permission", { reason: "tenant" });
  await finishLease(lease, "ended");
}

/** 购买开放中的区域或整领挂牌。 */
async function buyLocked(
  actor: Actor,
  token: string,
  areaToken?: string,
): Promise<void> {
  const land = requireLand(token);
  const targetId = areaToken ? requireArea(land, areaToken).id : land.id;
  const listing = [...world().listings.values()].find(
    (item) =>
      item.targetId === targetId &&
      item.kind === "sale" &&
      item.status === "open",
  );
  if (!listing)
    throw new LandError("land_not_found", { name: areaToken ?? token });
  if (actor.id === land.ownerId)
    throw new LandError("no_permission", { reason: "owner" });
  await beforeEvent("land.before.sale", {
    actorId: actor.id,
    landId: land.id,
    listingId: listing.id,
  });
  await runPaid({
    idempotencyKey: `buy:${listing.id}`,
    kind: listing.targetType === "land" ? "land.buy" : "land.buy_area",
    landId: land.id,
    actorId: actor.id,
    fromAccount: actor.id,
    toAccount: land.ownerId,
    amount: listing.price,
    mode: "transfer",
    payload: {
      listingId: listing.id,
      buyerName: actor.name,
      sellerId: land.ownerId,
    },
  });
  await afterEvent("land.sale.completed", {
    actorId: actor.id,
    landId: land.id,
    listingId: listing.id,
  });
}

/** 租约、挂牌和区域授权在同一事务中生效，重放补齐旧版本的部分提交。 */
export async function applyRent(tx: TxState): Promise<void> {
  const payload = payloadOf(tx);
  const requested = payload.lease as LeaseState | undefined;
  const listingId =
    typeof payload.listingId === "string" ? payload.listingId : "";
  if (!requested || !listingId)
    throw new LandError("internal", { message: "租赁交易载荷不完整" });
  const leases = await leasesForRecovery();
  const existing = leases.find((item) => item.id === requested.id);
  try {
    const land = requireLand(requested.landId);
    const area = requireArea(land, requested.areaId);
    const listing = world().listings.get(listingId);
    if (
      area.kind !== "box" ||
      requested.status !== "active" ||
      requested.landId !== tx.landId ||
      requested.tenantId !== tx.actorId ||
      tx.fromAccount !== requested.tenantId ||
      tx.toAccount !== land.bankAccount ||
      requested.price !== tx.amount ||
      !listing ||
      listing.kind !== "rent" ||
      listing.targetType !== "area" ||
      listing.landId !== land.id ||
      listing.targetId !== area.id ||
      listing.price !== requested.price ||
      listing.periodMs !== requested.periodMs
    )
      throw new LandError("internal", {
        message: "租赁交易与付款或挂牌不匹配",
      });
    if (
      existing &&
      (existing.areaId !== area.id ||
        existing.landId !== land.id ||
        existing.tenantId !== tx.actorId)
    ) {
      throw new LandError("internal", {
        message: "租约标识与已保存的租约不匹配",
      });
    }
    if (listing.status === "sold" || (!existing && listing.status !== "open")) {
      throw new LandError("sale_blocked", { reason: "挂牌已结束" });
    }
    const closed = {
      ...listing,
      status: "closed" as const,
      updatedAt: Date.now(),
    };
    // 已结束的旧租约不重新授权；仅补齐其账本和挂牌状态。
    if (existing && existing.status !== "active") {
      await commitPaid(
        tx,
        async (db) => {
          await updateListing(closed, db);
        },
        async () => {
          world().upsertListing(closed);
        },
      );
      return;
    }
    if (
      leases.some(
        (item) =>
          item.areaId === area.id &&
          item.id !== requested.id &&
          item.status === "active",
      )
    ) {
      throw new LandError("sale_blocked", { reason: "区域已租出" });
    }
    const lease = existing ?? requested;
    const role = areaRolePlan(land, area.id, lease.tenantId, "tenant");
    await commitPaid(
      tx,
      async (db) => {
        if (!existing) await insertLease(lease, db);
        await updateListing(closed, db);
        await writeAreaRole(role, db);
      },
      async () => {
        world().upsertLease(lease);
        world().upsertListing(closed);
        await publishAreaRole(role.next, tx.actorId);
      },
    );
  } catch (error) {
    // 旧版本可能已经单独写入租约；不能因补齐剩余步骤失败而把租金退回。
    if (existing && !(error instanceof BusinessCommittedError)) {
      throw new BusinessCommittedError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

/** 把租约结束时间推进到载荷记录的时刻。已经更晚则不再改写。 */
export async function applyRenew(tx: TxState): Promise<void> {
  const payload = payloadOf(tx);
  const leaseId = typeof payload.leaseId === "string" ? payload.leaseId : "";
  const endAt = typeof payload.endAt === "number" ? payload.endAt : 0;
  if (!leaseId || !Number.isSafeInteger(endAt) || endAt <= 0)
    throw new LandError("internal", { message: "续租交易载荷不完整" });
  const lease = (await leasesForRecovery()).find((item) => item.id === leaseId);
  if (!lease) throw new LandError("internal", { message: "续租时租约不存在" });
  const land = requireLand(lease.landId);
  if (
    tx.landId !== land.id ||
    tx.toAccount !== land.bankAccount ||
    tx.amount !== lease.price ||
    (tx.fromAccount !== lease.tenantId && tx.fromAccount !== land.ownerId)
  ) {
    throw new LandError("internal", { message: "续租交易与付款主体不匹配" });
  }
  if (lease.status !== "active" && lease.endAt < endAt)
    throw new LandError("sale_blocked", { reason: "租约已结束" });
  const next =
    lease.endAt >= endAt ? lease : { ...lease, endAt, updatedAt: Date.now() };
  await commitPaid(
    tx,
    async (db) => {
      await updateLease(next, db);
    },
    async () => {
      world().upsertLease(next);
    },
  );
}

/** 所有权/区域授权、挂牌和本地成功状态一起提交，提交前不发布索引。 */
export async function applyBuy(tx: TxState): Promise<void> {
  const payload = payloadOf(tx);
  const listingId =
    typeof payload.listingId === "string" ? payload.listingId : "";
  const buyerName =
    typeof payload.buyerName === "string" ? payload.buyerName : tx.actorId;
  const listing = listingId ? world().listings.get(listingId) : undefined;
  if (!listing || listing.kind !== "sale")
    throw new LandError("internal", { message: "购买交易载荷不完整" });
  const land = requireLand(listing.landId);
  const sellerId =
    typeof payload.sellerId === "string"
      ? payload.sellerId
      : listing.targetType === "land"
        ? listing.sellerId
        : land.ownerId;
  if (
    tx.landId !== land.id ||
    tx.fromAccount !== tx.actorId ||
    tx.toAccount !== sellerId ||
    tx.amount !== listing.price
  ) {
    throw new LandError("internal", { message: "购买交易与付款主体不匹配" });
  }
  if (listing.status !== "open" && listing.status !== "sold")
    throw new LandError("sale_blocked", { reason: "挂牌已结束" });
  const sold = { ...listing, status: "sold" as const, updatedAt: Date.now() };
  const previouslyCommitted =
    listing.status === "sold" ||
    (listing.targetType === "land" && land.ownerId === tx.actorId);
  try {
    if (listing.targetType === "land") {
      if (land.ownerId !== tx.actorId) {
        if (land.ownerId !== sellerId)
          throw new LandError("sale_blocked", { reason: "领主已变化" });
        if (
          [...world().activeLeases.values()].some(
            (item) => item.landId === land.id && item.status === "active",
          )
        ) {
          throw new LandError("sale_blocked", {
            reason: "出售期间出现了新租约",
          });
        }
        if ((await getBalance(land.bankAccount)) > 0)
          throw new LandError("sale_blocked", { reason: "银行余额已变化" });
      }
      const plan = await prepareLandTransfer(
        {
          id: land.ownerId,
          name: land.ownerName,
          admin: false,
          console: false,
        },
        land.id,
        { id: tx.actorId, name: buyerName },
        { skipOpenTx: true, allowSameOwner: true },
      );
      await commitPaid(
        tx,
        async (db) => {
          await writeLandTransfer(plan, db);
          await updateListing(sold, db);
        },
        async () => {
          await publishLandTransfer(plan);
          world().upsertListing(sold);
        },
      );
    } else {
      const area = requireArea(land, listing.targetId);
      if (area.kind !== "box") throw new LandError("area_default");
      if (land.ownerId !== sellerId)
        throw new LandError("sale_blocked", { reason: "领主已变化" });
      const role = areaRolePlan(land, area.id, tx.actorId, "member");
      await commitPaid(
        tx,
        async (db) => {
          await writeAreaRole(role, db);
          await updateListing(sold, db);
        },
        async () => {
          await publishAreaRole(role.next, tx.actorId);
          world().upsertListing(sold);
        },
      );
    }
  } catch (error) {
    // 老账本恢复遇到已转让/已售状态时，不能证明权益没有提交，保留资金等待补齐。
    if (previouslyCommitted && !(error instanceof BusinessCommittedError)) {
      throw new BusinessCommittedError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

interface AreaRolePlan {
  existing: boolean;
  next: AreaRoleState;
}

function areaRolePlan(
  land: LandState,
  areaId: string,
  playerId: string,
  preset: string,
): AreaRolePlan {
  if (world().member(land.id, playerId)?.relation === "banned")
    throw new LandError("no_permission", { reason: "banned" });
  const role = roleByPreset(world().rolesOf(land.id), preset);
  const existing = world().areaRoles.get(`${areaId}|${playerId}`);
  return {
    existing: Boolean(existing),
    next: {
      id: existing?.id ?? makeId("g"),
      areaId,
      landId: land.id,
      playerId,
      roleId: role.id,
    },
  };
}

async function writeAreaRole(plan: AreaRolePlan, db: TxContext): Promise<void> {
  if (plan.existing) await updateAreaRole(plan.next, db);
  else await insertAreaRole(plan.next, db);
}

async function publishAreaRole(
  role: AreaRoleState,
  actorId: string,
): Promise<void> {
  world().upsertAreaRole(role);
  const payload = {
    actorId,
    landId: role.landId,
    playerId: role.playerId,
    areaId: role.areaId,
    roleId: role.roleId,
  };
  await afterEvent("land.member.changed", payload);
  await afterEvent("land.permission.changed", payload);
}

/** 账本成功与权益写入原子提交；之后的发布失败不能把已提交权益当作失败退款。 */
async function commitPaid(
  tx: TxState,
  write: (db: TxContext) => Promise<void>,
  publish: () => Promise<void>,
): Promise<void> {
  try {
    await landTx(async (db) => {
      await write(db);
      await updateTx({ ...tx, status: "applied", updatedAt: Date.now() }, db);
    });
  } catch (error) {
    // 数据库可能已提交，只是确认响应丢失。凭事务内的 applied 标记判定并补发索引。
    let saved: TxState | undefined;
    try {
      saved = await findTxByKey(tx.idempotencyKey);
    } catch {
      throw new BusinessCommittedError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (saved?.status !== "applied") throw error;
  }
  try {
    await publish();
  } catch (error) {
    // 本地成功标记已经提交，补齐运行时索引；重建失败时 ready 保持 false，保护层拒绝放行。
    const index = world();
    try {
      await hydrate(index);
    } catch {
      index.ready = false;
    }
    throw new BusinessCommittedError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function leasesForRecovery(): Promise<LeaseState[]> {
  try {
    return await listLeases();
  } catch (error) {
    // 读取失败时不能排除旧版本曾部分提交；等待存储恢复后重试，不冒险退款。
    throw new BusinessCommittedError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function payloadOf(tx: TxState): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tx.payloadJson) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 到期租约收回区域角色。调度器调用。 */
async function expireLeasesLocked(now = Date.now()): Promise<number> {
  let count = 0;
  const leases = await listLeases();
  for (const lease of leases) {
    if (lease.status === "active" && lease.endAt <= now) {
      await finishLease(lease, "expired");
      count += 1;
    } else if (lease.status !== "active") {
      // 兼容旧版本已结束但撤权失败的记录；后来的新租约不受旧记录影响。
      const current = leases.find(
        (item) => item.areaId === lease.areaId && item.status === "active",
      );
      const override = world().areaRoles.get(
        `${lease.areaId}|${lease.tenantId}`,
      );
      const tenantRole = world()
        .rolesOf(lease.landId)
        .find((role) => role.preset === "tenant");
      if (!current && override && override.roleId === tenantRole?.id) {
        await finishLease(lease, lease.status);
        count += 1;
      }
    }
  }
  return count;
}

async function finishLease(
  lease: LeaseState,
  status: "ended" | "expired",
): Promise<void> {
  const next = { ...lease, status, updatedAt: Date.now() };
  const override = world().areaRoles.get(`${lease.areaId}|${lease.tenantId}`);
  const tenantRole = world()
    .rolesOf(lease.landId)
    .find((role) => role.preset === "tenant");
  const revoke = override && tenantRole && override.roleId === tenantRole.id;
  await landTx(async (db) => {
    if (revoke) await hardDelete(TABLES.areaRole, override.id, db);
    await updateLease(next, db);
  });
  if (revoke) {
    world().removeAreaRole(lease.areaId, lease.tenantId, lease.landId);
  }
  world().upsertLease(next);
  if (revoke)
    await afterEvent("land.permission.changed", {
      landId: lease.landId,
      areaId: lease.areaId,
      playerId: lease.tenantId,
      roleId: "",
    });
  await afterEvent("land.lease.ended", {
    landId: lease.landId,
    areaId: lease.areaId,
    playerId: lease.tenantId,
    status,
  });
}

/** 市场写入与领地创建、转让、删除和交易恢复共用同一临界区。 */
export function publishRent(
  actor: Actor,
  token: string,
  areaToken: string,
  price: number,
  periodMs: number,
): Promise<ListingState> {
  return withTerritoryLock(() =>
    publishRentLocked(actor, token, areaToken, price, periodMs),
  );
}

export function publishAreaSale(
  actor: Actor,
  token: string,
  areaToken: string,
  price: number,
): Promise<ListingState> {
  return withTerritoryLock(() =>
    publishAreaSaleLocked(actor, token, areaToken, price),
  );
}

export function publishLandSale(
  actor: Actor,
  token: string,
  price: number,
): Promise<ListingState> {
  return withTerritoryLock(() => publishLandSaleLocked(actor, token, price));
}

export function cancelListing(
  actor: Actor,
  token: string,
  areaToken?: string,
): Promise<void> {
  return withTerritoryLock(() => cancelListingLocked(actor, token, areaToken));
}

export function takeLease(
  actor: Actor,
  token: string,
  areaToken: string,
): Promise<LeaseState> {
  return withTerritoryLock(() => takeLeaseLocked(actor, token, areaToken));
}

export function renewLease(
  actor: Actor,
  token: string,
  areaToken: string,
): Promise<void> {
  return withTerritoryLock(() => renewLeaseLocked(actor, token, areaToken));
}

export function endLease(
  actor: Actor,
  token: string,
  areaToken: string,
): Promise<void> {
  return withTerritoryLock(() => endLeaseLocked(actor, token, areaToken));
}

export function buy(
  actor: Actor,
  token: string,
  areaToken?: string,
): Promise<void> {
  return withTerritoryLock(() => buyLocked(actor, token, areaToken));
}

export function expireLeases(now = Date.now()): Promise<number> {
  return withTerritoryLock(() => expireLeasesLocked(now));
}
