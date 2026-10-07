/**
 * 经济与行为日志 RPC 薄封装。
 */

import { debug } from "@sfmc-bds/sdk/sapi/runtime";
import { getLandService } from "./clients.js";

export async function economyDebit(opts: {
  accountId: string;
  amount: number;
  reason: string;
  actorId?: string;
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
}): Promise<{ ok: boolean; balance?: number; error?: string }> {
  if (opts.amount <= 0) return { ok: true, balance: undefined };
  try {
    const res = (await getLandService().call("economy.account.debit", {
      accountId: opts.accountId,
      playerId: opts.accountId,
      amount: opts.amount,
      reason: opts.reason,
      actorId: opts.actorId,
      idempotencyKey: opts.idempotencyKey,
      referenceType: opts.referenceType,
      referenceId: opts.referenceId,
    })) as { balance?: number };
    return { ok: true, balance: res?.balance };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug.w("LandEco", `debit failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function economyCredit(opts: {
  accountId: string;
  amount: number;
  reason: string;
  actorId?: string;
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (opts.amount <= 0) return { ok: true };
  try {
    await getLandService().call("economy.account.credit", {
      accountId: opts.accountId,
      playerId: opts.accountId,
      amount: opts.amount,
      reason: opts.reason,
      actorId: opts.actorId,
      idempotencyKey: opts.idempotencyKey,
      referenceType: opts.referenceType,
      referenceId: opts.referenceId,
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug.w("LandEco", `credit failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function activityRecord(input: {
  eventType: string;
  actorId?: string;
  actorName?: string;
  targetId?: string;
  dimension?: string;
  x?: number;
  y?: number;
  z?: number;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    await getLandService().call("activity.record", {
      eventType: input.eventType,
      actorId: input.actorId,
      actorName: input.actorName,
      targetId: input.targetId,
      dimension: input.dimension,
      x: input.x,
      y: input.y,
      z: input.z,
      level: "info",
      payload: input.payload,
    });
  } catch (err) {
    debug.w(
      "LandActivity",
      `activity.record 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function activityQuery(input: Record<string, unknown>): Promise<{
  records: unknown[];
  total: number;
}> {
  try {
    const res = (await getLandService().call("activity.query", input)) as {
      records?: unknown[];
      total?: number;
    };
    return { records: res?.records ?? [], total: res?.total ?? 0 };
  } catch (err) {
    debug.w(
      "LandActivity",
      `activity.query 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { records: [], total: 0 };
  }
}
