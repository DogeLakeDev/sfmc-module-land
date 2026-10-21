/**
 * 配额。
 * 创建、占领、邀请、区域和角色在写入前调用这里。
 * 其他模块可以注册新的配额种类，但本模块不会因此删除已有数据。
 */

import type { WorldIndex } from "../cache/world-index.js";
import type { LandConfig, QuotaGroup } from "../config.js";
import { levelRuleOf } from "../config.js";
import { LandError } from "../domain/errors.js";
import type { Actor, LandState } from "../domain/model.js";
import { service } from "@sfmc-bds/sdk/sapi/service";

/** 一种配额的当前用量和上限。 */
export interface QuotaView {
  id: string;
  used: number;
  limit: number;
  ok: boolean;
}

interface ExtraQuota {
  id: string;
  limit: number;
  usageService?: string;
}

const extras = new Map<string, ExtraQuota>();

/** 注册扩展配额。已有领地数据保持不变，只影响之后的检查。 */
export function registerQuota(def: ExtraQuota): void {
  extras.set(def.id, def);
}

/** 列出扩展配额定义，供公开 API 查询。 */
export function listExtraQuotas(): ExtraQuota[] {
  return [...extras.values()];
}

function groupValue(
  groups: QuotaGroup[],
  key: "lands" | "chunks" | "members" | "areas" | "roles",
  holds: (permission: string) => boolean,
): number | undefined {
  let best: number | undefined;
  for (const group of groups) {
    if (!holds(group.permission)) continue;
    const value = group[key];
    if (typeof value === "number") best = best === undefined ? value : Math.max(best, value);
  }
  return best;
}

/**
 * 计算某个领地或玩家的内置配额。
 * 等级规则决定领地容量；权限组只提高上限，不会把已经占领的区块删掉。
 */
export function builtinQuota(
  config: LandConfig,
  index: WorldIndex,
  actor: Actor,
  land: LandState | undefined,
  id: "lands" | "chunks" | "members" | "areas" | "roles",
  holds: (permission: string) => boolean = () => false,
): QuotaView {
  const level = levelRuleOf(config, land?.level ?? 1);
  const base =
    id === "lands"
      ? config.quotas.lands
      : id === "chunks"
        ? level.chunks
        : id === "members"
          ? level.members
          : id === "areas"
            ? level.areas
            : level.roles;
  const raised = groupValue(config.quotaGroups, id, holds);
  const limit = raised === undefined ? base : Math.max(base, raised);
  const used = usageOf(index, actor.id, land, id);
  return { id, used, limit, ok: used < limit };
}

function usageOf(
  index: WorldIndex,
  playerId: string,
  land: LandState | undefined,
  id: "lands" | "chunks" | "members" | "areas" | "roles",
): number {
  if (id === "lands") return [...index.lands.values()].filter((item) => item.ownerId === playerId).length;
  if (!land) return 0;
  if (id === "chunks") return land.claimKeys.length;
  if (id === "members") {
    return index.membersOf(land.id).filter((member) => member.relation === "admin" || member.relation === "member" || member.relation === "trusted").length;
  }
  if (id === "areas") return index.areasOf(land.id).filter((area) => area.kind === "box").length;
  return index.rolesOf(land.id).filter((role) => !role.reserved).length;
}

/** 达到上限时抛出配额错误。 */
export function assertBuiltin(
  config: LandConfig,
  index: WorldIndex,
  actor: Actor,
  land: LandState | undefined,
  id: "lands" | "chunks" | "members" | "areas" | "roles",
  label: string,
  holds: (permission: string) => boolean = () => false,
): void {
  const view = builtinQuota(config, index, actor, land, id, holds);
  if (!view.ok) throw new LandError("quota", { label, limit: view.limit });
}

/** 查询扩展配额。用量服务不可用时返回错误而不是假装还有容量。 */
export async function queryExtra(id: string, input: Record<string, unknown>): Promise<QuotaView> {
  const def = extras.get(id);
  if (!def) throw new LandError("quota_unknown", { name: id });
  let used = 0;
  if (def.usageService) {
    const result = await service.call<{ used?: number }>(def.usageService, input);
    used = typeof result?.used === "number" ? result.used : 0;
  }
  return { id, used, limit: def.limit, ok: used < def.limit };
}
