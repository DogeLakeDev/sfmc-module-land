/**
 * 统一权限解析。
 * 保护事件、命令和公开 API 都调用 decide，不各自实现一套允许规则。
 */

import type { WorldIndex } from "../cache/world-index.js";
import { getFlag } from "../domain/permissions.js";
import type { Actor, AreaState, FlagValue, LandState, Located, MemberState, RoleState } from "../domain/model.js";

/** 可解释的权限结果。reason 是稳定代码，不是给玩家的最终句子。 */
export interface Decision {
  allow: boolean;
  reason: string;
  permission: string;
  relation: string;
  landId: string;
  areaId: string;
  roleId: string;
  roleName: string;
  /** allow 或 deny。和 allow 布尔值一致，供调用方按三态结果分支。 */
  effect: "allow" | "deny";
  /** explicit 表示当前位置直接决定；inherit 表示子区域没有覆盖，结果来自领地角色。 */
  resolution: "explicit" | "inherit";
}

const BYPASS = new Set<string>();

/** 管理员显式开启的会话绕过。普通领地旗标不能制造这个集合。 */
export function setBypass(playerId: string, enabled: boolean): void {
  if (enabled) BYPASS.add(playerId);
  else BYPASS.delete(playerId);
}

/** 当前会话是否持有绕过。 */
export function hasBypass(playerId: string): boolean {
  return BYPASS.has(playerId);
}

/** 解析旗标。区域值优先，其次领地值，最后用注册表默认值。 */
export function resolveFlag(index: WorldIndex, land: LandState, area: AreaState | undefined, flagId: string): FlagValue {
  if (area) {
    const areaValue = index.flag(area.id, flagId);
    if (areaValue !== undefined) return areaValue;
  }
  const landValue = index.flag(land.id, flagId);
  if (landValue !== undefined) return landValue;
  return getFlag(flagId)?.defaultValue ?? false;
}

function decision(
  partial: Omit<Decision, "allow" | "reason" | "effect" | "resolution"> & {
    allow: boolean;
    reason: string;
    resolution?: Decision["resolution"];
  },
): Decision {
  return {
    ...partial,
    effect: partial.allow ? "allow" : "deny",
    resolution: partial.resolution ?? "explicit",
  };
}

/**
 * 判断玩家能否在当前位置执行某项权限。
 * located 为空表示荒野。索引未就绪时拒绝，避免把尚未加载的领地当成荒野。
 */
export function decide(
  index: WorldIndex,
  actor: Pick<Actor, "id" | "admin">,
  permission: string,
  located: Located | undefined,
  wildernessProtected: boolean,
): Decision {
  const base = {
    permission,
    relation: "none",
    landId: located?.land.id ?? "",
    areaId: located?.area.id ?? "",
    roleId: "",
    roleName: "",
  };
  if (!index.ready) return decision({ ...base, allow: false, reason: "not_ready" });
  if (actor.admin && hasBypass(actor.id)) return decision({ ...base, allow: true, reason: "bypass", relation: "admin_bypass" });
  if (!located) {
    const allow = !wildernessProtected;
    return decision({ ...base, allow, reason: allow ? "wilderness" : "wilderness_protected" });
  }
  if (located.land.ownerId === actor.id) {
    return decision({ ...base, allow: true, reason: "owner", relation: "owner" });
  }
  const member = index.member(located.land.id, actor.id);
  if (member?.relation === "banned") {
    return decision({ ...base, allow: false, reason: "banned", relation: "banned" });
  }
  if (located.land.status === "frozen" && isWorldAction(permission)) {
    return decision({ ...base, allow: false, reason: "frozen", relation: member?.relation ?? "none" });
  }
  if (located.land.status !== "active" && permission === "land.claim") {
    return decision({ ...base, allow: false, reason: "delinquent", relation: member?.relation ?? "none" });
  }
  const resolved = resolveRole(index, located, actor.id, member);
  const allow = resolved.role?.permissions.includes(permission) ?? false;
  return decision({
    ...base,
    allow,
    reason: allow ? "role_grant" : "role_deny",
    relation: member?.relation ?? "none",
    roleId: resolved.role?.id ?? "",
    roleName: resolved.role?.name ?? "",
    resolution: located.specific && resolved.source === "land" ? "inherit" : "explicit",
  });
}

function isWorldAction(permission: string): boolean {
  return (
    permission.startsWith("block.") ||
    permission.startsWith("entity.") ||
    permission === "container.open" ||
    permission === "door.use" ||
    permission === "redstone.interact"
  );
}

/** 区域角色只在命中的普通区域生效；否则回退领地成员角色。 */
export function resolveRole(
  index: WorldIndex,
  located: Located,
  playerId: string,
  member: MemberState | undefined,
): { role: RoleState | undefined; source: "area" | "land" | "none" } {
  if (located.specific) {
    const override = index.areaRoles.get(`${located.area.id}|${playerId}`);
    const areaRole = override ? index.roles.get(override.roleId) : undefined;
    if (areaRole) return { role: areaRole, source: "area" };
  }
  if (!member || member.relation === "invited" || member.relation === "banned" || !member.roleId) {
    return { role: undefined, source: "none" };
  }
  return { role: index.roles.get(member.roleId), source: "land" };
}

/**
 * 命令用的管理权限断言。
 * 领主始终通过；其他人必须具备对应角色权限。服务器管理员绕过只在显式开启后生效。
 */
export function assertAllowed(index: WorldIndex, actor: Actor, permission: string, located: Located | undefined): Decision {
  const result = decide(index, actor, permission, located, false);
  return result;
}
