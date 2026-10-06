/** 租赁操作串行化、持久化去重与经济失败补偿。 */
import type { TxContext } from "@sfmc-bds/sdk/sapi/db";
import { ServiceError } from "@sfmc-bds/sdk/sapi/service";
import { debug } from "@sfmc-bds/sdk/sapi/runtime";
import { getLandDb } from "./clients.js";
import { economyCredit, economyDebit } from "./platform.js";
import { OPS_TABLE } from "./store.js";

let queue: Promise<unknown> = Promise.resolve();
export function serializeLandMutation<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

type OperationMeta = {
  ownerId: string;
  amount: number;
  referenceId: string;
  fingerprint: string;
};
type Operation = {
  request_id: string;
  operation_type: string;
  status: string;
  response_json: string;
};
function parse(row: Operation): {
  meta?: OperationMeta;
  result?: Record<string, unknown>;
} {
  return JSON.parse(row.response_json);
}
export function requestId(input: Record<string, unknown>): string {
  if (
    typeof input.requestId !== "string" ||
    !/^[A-Za-z0-9_.:-]{8,128}$/.test(input.requestId)
  ) {
    throw new ServiceError(
      "缺少有效的 requestId，请重新预览后提交",
      "invalid_argument",
      400,
    );
  }
  return input.requestId;
}
export function fingerprint(input: Record<string, unknown>): string {
  function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => [key, sorted(v)]),
      );
    return value;
  }
  return JSON.stringify(sorted(input));
}
export async function replayOperation(
  input: Record<string, unknown>,
  ownerId: string,
  type: string,
): Promise<Record<string, unknown> | null> {
  const row = (await getLandDb().get(
    OPS_TABLE,
    requestId(input),
  )) as unknown as Operation | null;
  if (!row) return null;
  const saved = parse(row);
  if (
    row.operation_type !== type ||
    saved.meta?.ownerId !== ownerId ||
    saved.meta.fingerprint !== fingerprint(input)
  ) {
    throw new ServiceError("requestId 已用于其他请求", "already_exists", 409);
  }
  if (row.status === "ok" && saved.result) return saved.result;
  throw new ServiceError(
    row.status === "rolled_back"
      ? "上次操作失败并已退款，请重新预览后重试"
      : "上次操作尚待确认，请稍后刷新或联系管理员",
    "failed_precondition",
    409,
  );
}
async function refund(row: Operation, meta: OperationMeta): Promise<void> {
  const result = await economyCredit({
    accountId: meta.ownerId,
    amount: meta.amount,
    actorId: meta.ownerId,
    reason: `land.lease.${row.operation_type}.rollback`,
    idempotencyKey: `${row.request_id}_rollback`,
    referenceType: "land.lease",
    referenceId: meta.referenceId,
  });
  await getLandDb().update(OPS_TABLE, row.request_id, {
    status: result.ok ? "rolled_back" : "refund_pending",
  });
  if (!result.ok)
    throw new ServiceError("退款尚待处理，请联系管理员", "refund_pending", 503);
}

/** 资金通过经济模块结算；领地更新和成功结果在同一数据库事务中提交。 */
export async function commitLandOperation(
  input: Record<string, unknown>,
  type: string,
  ownerId: string,
  amount: number,
  referenceId: string,
  write: (tx: TxContext) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new ServiceError("租金金额无效", "invalid_argument", 400);
  const id = requestId(input);
  const meta: OperationMeta = {
    ownerId,
    amount,
    referenceId,
    fingerprint: fingerprint(input),
  };
  const row: Operation = {
    request_id: id,
    operation_type: type,
    status: "pending",
    response_json: JSON.stringify({ meta }),
  };
  await getLandDb().insert(OPS_TABLE, { ...row, created_at: Date.now() });
  const debit = await economyDebit({
    accountId: ownerId,
    amount,
    actorId: ownerId,
    reason: `land.lease.${type}`,
    idempotencyKey: id,
    referenceType: "land.lease",
    referenceId,
  });
  if (!debit.ok) {
    // 网络超时可能发生在实际扣款之后；保留 pending，恢复时以相同键确认再补偿。
    throw new ServiceError(
      debit.error ?? "扣款失败，请重新预览",
      "payment_failed",
      503,
    );
  }
  try {
    return await getLandDb().tx(async (tx) => {
      const result = await write(tx);
      await tx.update(OPS_TABLE, id, {
        status: "ok",
        response_json: JSON.stringify({ meta, result }),
      });
      return result;
    });
  } catch (error) {
    // 提交应答丢失时先确认数据库结果，避免给已成功的租赁退款。
    const saved = (await getLandDb().get(
      OPS_TABLE,
      id,
    )) as unknown as Operation | null;
    if (saved?.status === "ok") return parse(saved).result!;
    await refund(row, meta);
    throw new ServiceError(
      `操作失败，已退款：${error instanceof Error ? error.message : String(error)}`,
      "mutation_failed",
      500,
    );
  }
}

/** 恢复未提交的操作：经济扣款重放会去重，退款也使用固定去重键。 */
export async function recoverLandOperations(): Promise<void> {
  const pending = await getLandDb().query(OPS_TABLE, {
    where: { in: ["status", ["pending", "refund_pending"]] },
    limit: 1000,
  });
  for (const value of pending) {
    const row = value as unknown as Operation;
    try {
      const meta = parse(row).meta;
      if (!meta) continue;
      if (row.status === "pending") {
        const debit = await economyDebit({
          accountId: meta.ownerId,
          amount: meta.amount,
          actorId: meta.ownerId,
          reason: `land.lease.${row.operation_type}`,
          idempotencyKey: row.request_id,
          referenceType: "land.lease",
          referenceId: meta.referenceId,
        });
        if (!debit.ok) continue;
      }
      await refund(row, meta);
    } catch (error) {
      debug.w("LandRecovery", `${row.request_id}: ${String(error)}`);
    }
  }
}
