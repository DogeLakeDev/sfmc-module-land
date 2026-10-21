/**
 * 领地银行、维护费、税费和升级。
 * 银行账户是经济模块里的 land:<id>，和玩家余额分开。
 */

import { service } from "@sfmc-bds/sdk/sapi/service";
import { levelRuleOf, nextLevelRule } from "../config.js";
import { LandError } from "../domain/errors.js";
import type { Actor, LandState, TxState } from "../domain/model.js";
import {
  creditAccount,
  debitAccount,
  getBalance,
  transferAccounts,
} from "../economy/gateway.js";
import { BusinessCommittedError, runPaid } from "../economy/ledger.js";
import {
  hasReward,
  insertReward,
  listLands,
  patchLand,
  type LandPatch,
} from "../store/repo.js";
import { makeId } from "../domain/ids.js";
import { afterEvent, beforeEvent } from "./hooks.js";
import { assertAllowed } from "./permission.js";
import { landConfig, requireLand, world } from "./shared.js";
import { upgradeConditionServices, upgradeRewardServices } from "./registry.js";
import { withTerritoryLock } from "./lock.js";

function assertBank(actor: Actor, land: LandState, permission: string): void {
  if (actor.console || land.ownerId === actor.id) return;
  const area = world().areas.get(land.defaultAreaId);
  if (!area) throw new LandError("not_ready");
  const decision = assertAllowed(world(), actor, permission, {
    land,
    area,
    specific: false,
  });
  if (!decision.allow)
    throw new LandError("no_permission", { reason: decision.reason });
}

/** 查询领地银行余额。 */
export async function bankBalance(
  actor: Actor,
  token: string,
): Promise<number> {
  const land = requireLand(token);
  assertBank(actor, land, "bank.view");
  return getBalance(land.bankAccount);
}

/** 玩家向领地银行存款。 */
export async function deposit(
  actor: Actor,
  token: string,
  amount: number,
): Promise<number> {
  return withTerritoryLock(() => depositLocked(actor, token, amount));
}

async function depositLocked(
  actor: Actor,
  token: string,
  amount: number,
): Promise<number> {
  const land = requireLand(token);
  assertBank(actor, land, "bank.deposit");
  const value = positive(amount);
  await runPaid({
    idempotencyKey: `deposit:${land.id}:${actor.id}:${value}:${Date.now()}`,
    kind: "land.deposit",
    landId: land.id,
    actorId: actor.id,
    fromAccount: actor.id,
    toAccount: land.bankAccount,
    amount: value,
    mode: "transfer",
    payload: {},
  });
  return getBalance(land.bankAccount);
}

/** 从领地银行取到玩家账户。 */
export async function withdraw(
  actor: Actor,
  token: string,
  amount: number,
): Promise<number> {
  return withTerritoryLock(() => withdrawLocked(actor, token, amount));
}

async function withdrawLocked(
  actor: Actor,
  token: string,
  amount: number,
): Promise<number> {
  const land = requireLand(token);
  assertBank(actor, land, "bank.withdraw");
  const value = positive(amount);
  await runPaid({
    idempotencyKey: `withdraw:${land.id}:${actor.id}:${value}:${Date.now()}`,
    kind: "land.withdraw",
    landId: land.id,
    actorId: actor.id,
    fromAccount: land.bankAccount,
    toAccount: actor.id,
    amount: value,
    mode: "transfer",
    payload: {},
  });
  return getBalance(land.bankAccount);
}

function positive(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new LandError("bad_name", { label: "金额", name: String(amount) });
  return amount;
}

/** 当前维护费。等级系数和区块数量都来自配置。 */
export function upkeepAmount(land: LandState): number {
  const config = landConfig();
  const rule = levelRuleOf(config, land.level);
  return Math.max(
    0,
    Math.round(
      (config.upkeepBase + config.upkeepPerChunk * land.claimKeys.length) *
        rule.upkeepMultiplier,
    ),
  );
}

/** 尝试结算一期维护费。余额不足时进入欠费或冻结，不删除领地。 */
export async function settleUpkeep(
  land: LandState,
  actorId = "system",
): Promise<"paid" | "delinquent" | "frozen" | "skipped"> {
  return withTerritoryLock(() => {
    const current = world().lands.get(land.id);
    return current
      ? settleUpkeepLocked(current, actorId)
      : Promise.resolve("skipped" as const);
  });
}

async function settleUpkeepLocked(
  land: LandState,
  actorId: string,
): Promise<"paid" | "delinquent" | "frozen" | "skipped"> {
  const config = landConfig();
  const now = Date.now();
  if (land.nextUpkeepAt > now && land.status === "active") return "skipped";
  const amount = land.upkeepDue > 0 ? land.upkeepDue : upkeepAmount(land);
  if (amount <= 0) {
    await saveStatus(land, {
      status: "active",
      nextUpkeepAt: now + config.upkeepPeriodMs,
      graceUntil: 0,
      upkeepDue: 0,
    });
    return "paid";
  }
  const paid = await debitAccount({
    accountId: land.bankAccount,
    amount,
    reason: "land.upkeep",
    actorId,
    idempotencyKey: `upkeep:${land.id}:${land.nextUpkeepAt}`,
    referenceType: "land",
    referenceId: land.id,
  });
  if (paid.ok) {
    await saveStatus(land, {
      status: "active",
      nextUpkeepAt: now + config.upkeepPeriodMs,
      graceUntil: 0,
      upkeepDue: 0,
    });
    await afterEvent("land.upkeep.paid", { actorId, landId: land.id, amount });
    return "paid";
  }
  if (land.status === "active") {
    await saveStatus(land, {
      status: "delinquent",
      graceUntil: now + config.gracePeriodMs,
      upkeepDue: amount,
    });
    await afterEvent("land.upkeep.delinquent", {
      actorId,
      landId: land.id,
      amount,
    });
    return "delinquent";
  }
  if (
    land.status === "delinquent" &&
    now > land.graceUntil &&
    config.freezeAfterGrace
  ) {
    await saveStatus(land, { status: "frozen", upkeepDue: amount });
    await afterEvent("land.upkeep.frozen", {
      actorId,
      landId: land.id,
      amount,
    });
    return "frozen";
  }
  return land.status === "frozen" ? "frozen" : "delinquent";
}

/** 领主主动补交维护费。 */
export async function payUpkeep(actor: Actor, token: string): Promise<void> {
  return withTerritoryLock(async () => {
    const land = requireLand(token);
    assertBank(actor, land, "economy.manage");
    await settleUpkeepLocked(land, actor.id);
  });
}

async function saveStatus(land: LandState, patch: LandPatch): Promise<void> {
  const fields = { ...patch, updatedAt: Date.now() };
  await patchLand(land.id, fields);
  world().upsertLand({ ...requireLand(land.id), ...fields });
}

/** 设置成员税费。金额为 0 时关闭，不会因为缺省配置自动开税。 */
export async function setTax(
  actor: Actor,
  token: string,
  amount: number,
  periodMs: number,
): Promise<void> {
  return withTerritoryLock(() => setTaxLocked(actor, token, amount, periodMs));
}

async function setTaxLocked(
  actor: Actor,
  token: string,
  amount: number,
  periodMs: number,
): Promise<void> {
  const land = requireLand(token);
  assertBank(actor, land, "economy.manage");
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new LandError("bad_name", { label: "税费", name: String(amount) });
  const enabled = amount > 0;
  if (enabled && !Number.isFinite(periodMs))
    throw new LandError("bad_name", {
      label: "税费周期",
      name: String(periodMs),
    });
  const period = enabled ? Math.max(60_000, periodMs) : 0;
  await saveStatus(land, {
    taxEnabled: enabled,
    taxAmount: amount,
    taxPeriodMs: period,
    nextTaxAt: enabled ? Date.now() + period : 0,
  });
}

/** 向正式成员收取一期税费。失败只记录，不踢人。 */
export async function settleTax(land: LandState): Promise<number> {
  return withTerritoryLock(() => {
    const current = world().lands.get(land.id);
    return current ? settleTaxLocked(current) : Promise.resolve(0);
  });
}

async function settleTaxLocked(land: LandState): Promise<number> {
  if (!land.taxEnabled || land.taxAmount <= 0 || land.nextTaxAt > Date.now())
    return 0;
  let failed = 0;
  for (const member of world().membersOf(land.id)) {
    if (
      member.relation !== "member" &&
      member.relation !== "admin" &&
      member.relation !== "trusted"
    )
      continue;
    const moved = await transferAccounts({
      fromAccount: member.playerId,
      toAccount: land.bankAccount,
      amount: land.taxAmount,
      reason: "land.tax",
      actorId: "system",
      idempotencyKey: `tax:${land.id}:${member.playerId}:${land.nextTaxAt}`,
      referenceType: "land",
      referenceId: land.id,
    });
    if (!moved.ok) {
      failed += 1;
      await afterEvent("land.tax.failed", {
        landId: land.id,
        playerId: member.playerId,
        message: moved.message,
      });
    }
  }
  await saveStatus(land, { nextTaxAt: Date.now() + land.taxPeriodMs });
  return failed;
}

/** 升级领地。条件不足或银行余额不足时不会提高等级，奖励以等级键保证只发一次。 */
export async function upgradeLand(
  actor: Actor,
  token: string,
): Promise<number> {
  return withTerritoryLock(() => upgradeLandLocked(actor, token));
}

async function upgradeLandLocked(actor: Actor, token: string): Promise<number> {
  const land = requireLand(token);
  assertBank(actor, land, "economy.manage");
  const next = nextLevelRule(landConfig(), land.level);
  if (!next) throw new LandError("upgrade_max");
  if (land.claimKeys.length < next.minChunks)
    throw new LandError("upgrade_need", {
      reason: `区块 ${land.claimKeys.length}/${next.minChunks}`,
    });
  const members = world()
    .membersOf(land.id)
    .filter(
      (member) =>
        member.relation === "member" ||
        member.relation === "admin" ||
        member.relation === "trusted",
    ).length;
  if (members < next.minMembers)
    throw new LandError("upgrade_need", {
      reason: `成员 ${members}/${next.minMembers}`,
    });
  for (const [id, target] of upgradeConditionServices()) {
    const result = await service.call<{ ok?: boolean; reason?: string }>(
      target,
      { landId: land.id, targetLevel: next.level, conditionId: id },
    );
    if (!result || result.ok === false)
      throw new LandError("upgrade_need", { reason: result?.reason ?? id });
  }
  await beforeEvent("land.before.upgraded", {
    actorId: actor.id,
    landId: land.id,
    level: next.level,
  });
  await runPaid({
    idempotencyKey: `upgrade:${land.id}:${next.level}`,
    kind: "land.upgrade",
    landId: land.id,
    actorId: actor.id,
    fromAccount: land.bankAccount,
    toAccount: "",
    amount: next.cost,
    mode: next.cost > 0 ? "debit" : "none",
    payload: { level: next.level, reward: next.reward },
  });
  await afterEvent("land.upgraded", {
    actorId: actor.id,
    landId: land.id,
    level: next.level,
  });
  return next.level;
}

/** 按载荷升级。重放也补齐未发出的奖励，资金幂等键和奖励记录防止重复。 */
export async function applyUpgrade(tx: TxState): Promise<void> {
  const payload = JSON.parse(tx.payloadJson) as {
    level?: number;
    reward?: number;
  };
  const level = payload.level;
  if (typeof level !== "number")
    throw new LandError("internal", { message: "升级交易载荷不完整" });
  const current = world().lands.get(tx.landId);
  if (!current) throw new LandError("land_not_found", { name: tx.landId });
  if (current.level < level) {
    try {
      await saveStatus(current, { level });
    } catch (error) {
      // 数据库更新可能已成功，仅确认响应或索引发布失败。无法确认回滚时不得退款。
      let stored: LandState | undefined;
      try {
        stored = (await listLands()).find((land) => land.id === tx.landId);
      } catch {
        throw new BusinessCommittedError(
          `无法确认等级提交状态：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (stored && stored.level >= level) {
        throw new BusinessCommittedError(
          `等级已更新，索引待恢复：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }
  const reward = typeof payload.reward === "number" ? payload.reward : 0;
  try {
    await grantRewards(requireLand(tx.landId), level, reward);
  } catch (error) {
    throw new BusinessCommittedError(
      `等级已更新，奖励待重试：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function grantRewards(
  land: LandState,
  level: number,
  amount: number,
): Promise<void> {
  const rewardKey = `${land.id}|${level}|bank`;
  if (amount > 0 && !(await hasReward(rewardKey))) {
    const credited = await creditAccount({
      accountId: land.bankAccount,
      amount,
      reason: "land.upgrade.reward",
      actorId: "system",
      idempotencyKey: `reward:${rewardKey}`,
      referenceType: "land",
      referenceId: land.id,
    });
    if (!credited.ok)
      throw new LandError(
        "internal",
        { message: credited.message },
        credited.message,
      );
    await insertReward(makeId("w"), rewardKey, land.id, level, "bank");
  }
  for (const [id, target] of upgradeRewardServices()) {
    const key = `${land.id}|${level}|${id}`;
    if (await hasReward(key)) continue;
    await service.call(target, {
      landId: land.id,
      level,
      rewardId: id,
      idempotencyKey: `reward:${key}`,
    });
    await insertReward(makeId("w"), key, land.id, level, id);
  }
}
