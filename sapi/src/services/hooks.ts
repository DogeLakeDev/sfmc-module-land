/**
 * 模块间事件。
 * 执行前的订阅可以拒绝尚未落库的操作；执行后的订阅只是通知，不能撤销已经完成的修改。
 */

import { debug } from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import { LandError } from "../domain/errors.js";
import { makeId } from "../domain/ids.js";
import { hardDelete, listRegistry, saveRegistry } from "../store/repo.js";
import { TABLES } from "../store/tables.js";

interface Subscriber {
  id: string;
  event: string;
  target: string;
}

const subscribers: Subscriber[] = [];

/** 从注册表恢复订阅。目标服务不存在时，执行期会跳过而不是阻止服务器启动。 */
export async function loadSubscribers(): Promise<void> {
  subscribers.length = 0;
  for (const row of await listRegistry("subscriber")) {
    try {
      const parsed = JSON.parse(row.payload) as { event?: string; target?: string };
      if (parsed.event && parsed.target) subscribers.push({ id: row.id, event: parsed.event, target: parsed.target });
    } catch {
      debug.w("Land", `忽略损坏的事件订阅 ${row.key}`);
    }
  }
}

/** 登记订阅。event 以 .before 结尾时，返回 ok:false 会阻止操作。 */
export async function subscribe(event: string, target: string): Promise<void> {
  const existing = subscribers.find((item) => item.event === event && item.target === target);
  if (existing) return;
  const id = makeId("s");
  await saveRegistry("subscriber", `${event}|${target}`, id, JSON.stringify({ event, target }));
  subscribers.push({ id, event, target });
}

/** 取消订阅。 */
export async function unsubscribe(event: string, target: string): Promise<void> {
  const index = subscribers.findIndex((item) => item.event === event && item.target === target);
  if (index < 0) return;
  const removed = subscribers[index];
  subscribers.splice(index, 1);
  if (removed) await hardDelete(TABLES.registry, removed.id);
}

/**
 * 修改落库前通知。
 * 使用场景：其他模块需要否决创建、转让或购买。超时或服务缺失只记录日志，不把领地模块卡死。
 */
export async function beforeEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  for (const sub of subscribers.filter((item) => item.event === event)) {
    try {
      const result = await service.call<{ ok?: boolean; reason?: string }>(sub.target, { event, phase: "before", ...payload });
      if (result && result.ok === false) throw new LandError("rejected", { reason: result.reason ?? sub.target });
    } catch (error) {
      if (error instanceof LandError) throw error;
      debug.w("Land", `执行前订阅 ${sub.target} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** 修改完成后的通知。失败不影响已经成功的领地操作。 */
export async function afterEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await service.call("activity.record", {
      eventType: event,
      actorId: typeof payload.actorId === "string" ? payload.actorId : undefined,
      actorName: typeof payload.actorName === "string" ? payload.actorName : undefined,
      targetId: typeof payload.landId === "string" ? payload.landId : undefined,
      level: "info",
      payload,
    });
  } catch (error) {
    debug.w("Land", `行为日志失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const sub of subscribers.filter((item) => item.event === event)) {
    try {
      await service.call(sub.target, { event, phase: "after", ...payload });
    } catch (error) {
      debug.w("Land", `执行后订阅 ${sub.target} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
