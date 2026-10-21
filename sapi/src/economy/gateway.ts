/**
 * 经济模块适配。
 * 只调用 economy.account.get / debit / credit / transfer。
 * 领地银行使用 land:<领地ID> 组织账户，不会和玩家余额混在同一账户里。
 */

import { ServiceError, service } from "@sfmc-bds/sdk/sapi/service";

/** 经济调用的成功结果。replayed 表示幂等键已经执行过。 */
export interface MoneyOk {
  ok: true;
  transactionId: string;
  balance?: number;
  replayed: boolean;
}

/** 经济调用失败。code 保留经济模块的错误码，例如 insufficient_funds。 */
export interface MoneyFail {
  ok: false;
  code: string;
  message: string;
}

export type MoneyResult = MoneyOk | MoneyFail;

/** 领地银行账户。冒号账户由经济模块转换成计分板假名。 */
export function bankAccountId(landId: string): string {
  return `land:${landId}`;
}

function fail(error: unknown): MoneyFail {
  if (error instanceof ServiceError) return { ok: false, code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, code: "economy_error", message };
}

/** 查询账户余额。没有建分的账户按经济模块约定视为 0。 */
export async function getBalance(accountId: string): Promise<number> {
  const result = await service.call<{ balance?: number }>("economy.account.get", {
    accountId,
    playerId: accountId,
  });
  return typeof result?.balance === "number" && Number.isFinite(result.balance) ? result.balance : 0;
}

interface MoveInput {
  accountId?: string;
  fromAccount?: string;
  toAccount?: string;
  amount: number;
  reason: string;
  actorId: string;
  idempotencyKey: string;
  referenceType: string;
  referenceId: string;
}

async function callMove(name: string, input: MoveInput): Promise<MoneyResult> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    return { ok: true, transactionId: "", replayed: false };
  }
  try {
    const result = await service.call<{ transactionId?: string; balance?: number; replayed?: boolean }>(name, {
      accountId: input.accountId,
      playerId: input.accountId,
      fromAccountId: input.fromAccount,
      toAccountId: input.toAccount,
      amount: input.amount,
      reason: input.reason,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
    });
    return {
      ok: true,
      transactionId: result?.transactionId ?? "",
      balance: result?.balance,
      replayed: result?.replayed === true,
    };
  } catch (error) {
    return fail(error);
  }
}

/** 从账户扣款。金额为 0 时不调用经济模块。 */
export function debitAccount(input: MoveInput & { accountId: string }): Promise<MoneyResult> {
  return callMove("economy.account.debit", input);
}

/** 向账户入账。 */
export function creditAccount(input: MoveInput & { accountId: string }): Promise<MoneyResult> {
  return callMove("economy.account.credit", input);
}

/** 账户间转账。两个账户相同会被经济模块拒绝。 */
export function transferAccounts(input: MoveInput & { fromAccount: string; toAccount: string }): Promise<MoneyResult> {
  return callMove("economy.account.transfer", input);
}
