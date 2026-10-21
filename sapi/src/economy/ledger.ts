/**
 * 跨系统交易状态机。
 * 经济接口和 SQLite 不在同一个事务里，所以每笔资金先落本地账本，再扣款，再改领地。
 * 重启后由调度器按状态续跑，重复执行依赖经济模块的幂等键。
 */

import { LandError } from "../domain/errors.js";
import type { TxState, TxStatus } from "../domain/model.js";
import { makeId } from "../domain/ids.js";
import {
  creditAccount,
  debitAccount,
  transferAccounts,
  type MoneyResult,
} from "./gateway.js";
import {
  findTxByKey,
  insertTx,
  listTransactions,
  updateTx,
} from "../store/repo.js";
import { withTerritoryLock } from "../services/lock.js";

/** 资金方向。失败时按相反方向退款，不能只把状态改回 pending。 */
export type MoneyMode = "debit" | "credit" | "transfer" | "none";

/** 领域服务注册的落地动作。必须可以安全地重复执行。 */
export type TxApplier = (tx: TxState) => Promise<void>;

/** 本地业务已经部分或全部提交。保持待恢复，绝不能按普通失败退款。 */
export class BusinessCommittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessCommittedError";
  }
}

const appliers = new Map<string, TxApplier>();

/** 注册某种交易的落地动作。模块初始化时调用，恢复流程按 kind 找到它。 */
export function registerTxApplier(kind: string, applier: TxApplier): void {
  appliers.set(kind, applier);
}

export interface PaidRequest {
  idempotencyKey: string;
  kind: string;
  landId: string;
  actorId: string;
  fromAccount: string;
  toAccount: string;
  amount: number;
  mode: MoneyMode;
  payload: Record<string, unknown>;
  /**
   * 已成功的同类交易是否仍然代表当前世界。
   * 返回 false 时另开一笔，避免释放后再次占领被旧成功记录短路。
   */
  stillApplied?: (tx: TxState) => boolean;
}

function moneyOf(
  tx: TxState,
  mode: MoneyMode,
  key: string,
): Promise<MoneyResult> {
  const common = {
    amount: tx.amount,
    reason: tx.kind,
    actorId: tx.actorId,
    idempotencyKey: key,
    referenceType: "land",
    referenceId: tx.landId || tx.id,
  };
  if (mode === "none" || tx.amount <= 0)
    return Promise.resolve({ ok: true, transactionId: "", replayed: false });
  if (mode === "debit") {
    if (!tx.fromAccount)
      return Promise.resolve({
        ok: false,
        code: "refund_account",
        message: "扣款账户为空",
      });
    return debitAccount({ ...common, accountId: tx.fromAccount });
  }
  if (mode === "credit") {
    if (!tx.toAccount)
      return Promise.resolve({
        ok: false,
        code: "refund_account",
        message: "退款账户为空",
      });
    return creditAccount({ ...common, accountId: tx.toAccount });
  }
  return transferAccounts({
    ...common,
    fromAccount: tx.fromAccount,
    toAccount: tx.toAccount,
  });
}

function reverseMode(mode: MoneyMode): MoneyMode {
  if (mode === "debit") return "credit";
  if (mode === "credit") return "debit";
  return mode;
}

/** 退款时把钱退回真正出钱的账户。debit 的来源在 fromAccount，不能沿用空的 toAccount。 */
function reversed(tx: TxState, mode: MoneyMode): TxState {
  if (mode === "transfer")
    return { ...tx, fromAccount: tx.toAccount, toAccount: tx.fromAccount };
  if (mode === "debit")
    return { ...tx, fromAccount: "", toAccount: tx.fromAccount };
  if (mode === "credit")
    return { ...tx, fromAccount: tx.toAccount, toAccount: "" };
  return tx;
}

async function save(
  tx: TxState,
  status: TxStatus,
  extra: Partial<TxState> = {},
): Promise<TxState> {
  const next: TxState = { ...tx, ...extra, status, updatedAt: Date.now() };
  await updateTx(next);
  return next;
}

/**
 * 执行一笔先资金、后领地的交易。
 * 相同 idempotencyKey 在已成功时直接返回，不会重复扣款或重复发放奖励。
 */
export async function runPaid(request: PaidRequest): Promise<TxState> {
  const apply = appliers.get(request.kind);
  if (!apply)
    throw new LandError("internal", {
      message: `未注册交易处理器 ${request.kind}`,
    });
  const family = await listFamily(request.idempotencyKey);
  const open = family.find(
    (tx) =>
      tx.status === "pending" ||
      tx.status === "debited" ||
      tx.status === "refunding",
  );
  if (open) {
    assertSamePayment(open, request);
    return continuePaid(open, modeFromPayload(open), apply);
  }
  const applied = family
    .filter((tx) => tx.status === "applied")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (applied && (request.stillApplied?.(applied) ?? true)) {
    assertSamePayment(applied, request);
    return applied;
  }
  const idempotencyKey =
    family.length === 0
      ? request.idempotencyKey
      : `${request.idempotencyKey}#${family.length + 1}`;
  const created: TxState = {
    id: makeId("t"),
    idempotencyKey,
    kind: request.kind,
    status: "pending",
    landId: request.landId,
    actorId: request.actorId,
    fromAccount: request.fromAccount,
    toAccount: request.toAccount,
    amount: Math.max(0, Math.round(request.amount)),
    payloadJson: JSON.stringify({ ...request.payload, mode: request.mode }),
    error: "",
    economyTxId: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  try {
    await insertTx(created);
  } catch (error) {
    if (!(error instanceof LandError) || error.key !== "name_taken")
      throw error;
    const raced = await findTxByKey(idempotencyKey);
    if (!raced) throw error;
    assertSamePayment(raced, request);
    if (raced.status === "applied" && (request.stillApplied?.(raced) ?? true))
      return raced;
    return continuePaid(raced, modeFromPayload(raced), apply);
  }
  return continuePaid(created, request.mode, apply);
}

async function continuePaid(
  tx: TxState,
  mode: MoneyMode,
  apply: TxApplier,
): Promise<TxState> {
  let current = tx;
  if (current.status === "pending") {
    const paid = await moneyOf(current, mode, `${current.id}:pay`);
    if (!paid.ok) {
      current = await save(current, "failed", { error: paid.message });
      if (paid.code === "insufficient_funds")
        throw new LandError("balance", { amount: current.amount });
      throw new LandError("internal", { message: paid.message }, paid.message);
    }
    current = await save(current, "debited", {
      economyTxId: paid.transactionId,
    });
  }
  if (current.status === "debited") {
    try {
      await apply(current);
    } catch (error) {
      if (error instanceof BusinessCommittedError) throw error;
      // 部分处理器在本地业务事务里同时写 applied。提交后的缓存或通知失败不能触发退款。
      // 读取失败时同样不能证明业务尚未生效，保留 debited 交给后续恢复。
      const persisted = await findTxByKey(current.idempotencyKey);
      if (!persisted || persisted.status !== "debited") {
        throw new BusinessCommittedError(
          error instanceof Error ? error.message : String(error),
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      current = await save(current, "refunding", { error: message });
    }
    if (current.status === "debited") {
      try {
        return await save(current, "applied");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new LandError(
          "internal",
          { message },
          `业务已生效，账本状态未写入，不会退款：${message}`,
        );
      }
    }
  }
  if (current.status === "refunding") {
    const refund = await moneyOf(
      reversed(current, mode),
      reverseMode(mode),
      `${current.id}:refund`,
    );
    if (!refund.ok) {
      await save(current, "refunding", { error: refund.message });
      throw new LandError(
        "internal",
        { message: refund.message },
        refund.message,
      );
    }
    await save(current, "refunded", { error: current.error });
    throw new LandError(
      "internal",
      { message: current.error || "已退款" },
      current.error || "已退款",
    );
  }
  return current;
}

/** 重启后续跑未完成交易。没有落地函数的种类保持原状态，留给管理员诊断。 */
export async function recoverTransactions(list: TxState[]): Promise<number> {
  let count = 0;
  for (const tx of list) {
    if (
      tx.status !== "pending" &&
      tx.status !== "debited" &&
      tx.status !== "refunding"
    )
      continue;
    try {
      await withTerritoryLock(async () => {
        // 调度快照可能早于排队中的正常命令，必须在临界区重新读取交易状态。
        const current = await findTxByKey(tx.idempotencyKey);
        if (
          !current ||
          (current.status !== "pending" &&
            current.status !== "debited" &&
            current.status !== "refunding")
        )
          return;
        const apply = appliers.get(current.kind);
        if (!apply && current.status !== "refunding") return;
        await continuePaid(
          current,
          modeFromPayload(current),
          apply ?? refuseMissingApplier,
        );
      });
      count += 1;
    } catch {
      count += 1;
    }
  }
  return count;
}

/** 相同业务键不能把甲的未完成/已成功付款当成乙的购买结果。 */
function assertSamePayment(tx: TxState, request: PaidRequest): void {
  if (
    tx.kind !== request.kind ||
    tx.actorId !== request.actorId ||
    tx.fromAccount !== request.fromAccount ||
    tx.toAccount !== request.toAccount ||
    tx.amount !== Math.max(0, Math.round(request.amount)) ||
    modeFromPayload(tx) !== request.mode
  ) {
    throw new LandError("sale_blocked", {
      reason: "此交易正在由另一付款主体处理",
    });
  }
}

/** 同一基础键的历次尝试。修订号用 # 分隔，避免短键误匹配更长的键。 */
async function listFamily(baseKey: string): Promise<TxState[]> {
  const rows = await listTransactions();
  return rows.filter(
    (tx) =>
      tx.idempotencyKey === baseKey ||
      tx.idempotencyKey.startsWith(`${baseKey}#`),
  );
}

function refuseMissingApplier(): Promise<void> {
  return Promise.reject(
    new LandError("internal", { message: "退款阶段缺少业务处理器" }),
  );
}

function modeFromPayload(tx: TxState): MoneyMode {
  try {
    const parsed = JSON.parse(tx.payloadJson) as { mode?: MoneyMode };
    if (
      parsed.mode === "debit" ||
      parsed.mode === "credit" ||
      parsed.mode === "transfer" ||
      parsed.mode === "none"
    ) {
      return parsed.mode;
    }
  } catch {
    /* 旧载荷没有 mode 时按转账处理，调用方的账户字段仍然有效 */
  }
  if (!tx.fromAccount) return "credit";
  if (!tx.toAccount) return "debit";
  return "transfer";
}
