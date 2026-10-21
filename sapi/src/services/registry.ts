/**
 * 可扩展注册项的持久化。
 * 其他模块注册的旗标、配额、升级条件和奖励在重启后仍然有效。
 */

import { debug } from "@sfmc-bds/sdk/sapi/runtime";
import { makeId } from "../domain/ids.js";
import { registerFlag, registerHostile, registerPermission, type FlagDef, type PermissionDef } from "../domain/permissions.js";
import { listRegistry, saveRegistry } from "../store/repo.js";
import { registerQuota } from "./quota.js";

const upgradeConditions = new Map<string, string>();
const upgradeRewards = new Map<string, string>();

/** 其他模块提供的升级条件。服务返回 `{ ok, reason }`。 */
export function upgradeConditionServices(): Map<string, string> {
  return upgradeConditions;
}

/** 其他模块提供的升级奖励。服务在等级已经写入后调用，并自行保证幂等。 */
export function upgradeRewardServices(): Map<string, string> {
  return upgradeRewards;
}

/** 注册升级条件。 */
export async function registerUpgradeCondition(id: string, serviceName: string): Promise<void> {
  upgradeConditions.set(id, serviceName);
  await persist("condition", id, { service: serviceName });
}

/** 注册升级奖励。 */
export async function registerUpgradeReward(id: string, serviceName: string): Promise<void> {
  upgradeRewards.set(id, serviceName);
  await persist("reward", id, { service: serviceName });
}

/** 注册并记住自定义权限。 */
export async function registerStoredPermission(def: PermissionDef): Promise<void> {
  registerPermission(def);
  await persist("permission", def.id, def);
}

/** 注册并记住自定义旗标。 */
export async function registerStoredFlag(def: FlagDef): Promise<void> {
  registerFlag(def);
  await persist("flag", def.id, def);
}

/** 注册扩展配额。 */
export async function registerStoredQuota(id: string, limit: number, usageService?: string): Promise<void> {
  registerQuota({ id, limit, ...(usageService ? { usageService } : {}) });
  await persist("quota", id, { id, limit, usageService });
}

/** 注册敌对生物类型。 */
export async function registerStoredHostile(typeId: string): Promise<void> {
  registerHostile(typeId);
  await persist("hostile", typeId, { typeId });
}

async function persist(kind: string, key: string, payload: unknown): Promise<void> {
  const rows = await listRegistry(kind);
  const existing = rows.find((row) => row.key === `${kind}|${key}`);
  await saveRegistry(kind, key, existing?.id ?? makeId("y"), JSON.stringify(payload), existing?.id);
}

/** 启动时恢复扩展注册。损坏的行只记日志。 */
export async function loadExtensions(): Promise<void> {
  await loadKind("permission", (payload) => {
    const def = payload as PermissionDef;
    if (def.id) registerPermission(def);
  });
  await loadKind("flag", (payload) => {
    const def = payload as FlagDef;
    if (def.id && def.type) registerFlag(def);
  });
  await loadKind("quota", (payload) => {
    const def = payload as { id?: string; limit?: number; usageService?: string };
    if (def.id && typeof def.limit === "number") {
      registerQuota({ id: def.id, limit: def.limit, ...(def.usageService ? { usageService: def.usageService } : {}) });
    }
  });
  await loadKind("condition", (payload, key) => {
    const def = payload as { service?: string };
    if (def.service) upgradeConditions.set(key.split("|").slice(1).join("|"), def.service);
  });
  await loadKind("reward", (payload, key) => {
    const def = payload as { service?: string };
    if (def.service) upgradeRewards.set(key.split("|").slice(1).join("|"), def.service);
  });
  await loadKind("hostile", (payload) => {
    const def = payload as { typeId?: string };
    if (def.typeId) registerHostile(def.typeId);
  });
}

async function loadKind(kind: string, apply: (payload: unknown, key: string) => void): Promise<void> {
  for (const row of await listRegistry(kind)) {
    try {
      apply(JSON.parse(row.payload) as unknown, row.key);
    } catch (error) {
      debug.w("Land", `忽略损坏的注册项 ${row.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
