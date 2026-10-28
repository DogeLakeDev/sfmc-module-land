/**
 * 领地界面的只读视图投影。
 * 使用场景：land.ui.* 只读服务为声明式页面（sapi/src/ui/screens）准备展示数据与能力开关。
 * 只读内存索引，不写库；能力开关只决定按钮是否显示，真正的权限仍由命令执行时的领域服务判定。
 */

import type { WorldIndex } from "../cache/world-index.js";
import type { LandConfig } from "../config.js";
import { nextLevelRule } from "../config.js";
import { chunkOf } from "../domain/geometry.js";
import type { Aabb } from "../domain/geometry.js";
import type { MessageVars } from "../domain/errors.js";
import { LandError } from "../domain/errors.js";
import type { Actor, AreaState, LandState, RoleState } from "../domain/model.js";
import { listFlags, listPermissions, PUBLIC_PLAYER_ID } from "../domain/permissions.js";
import { decide, hasBypass, resolveFlag } from "./permission.js";
import { builtinQuota, isUnlimited } from "./quota.js";
import { requireArea, requireLand, requireRole } from "./shared.js";

/** 视图使用的文案函数：传入消息键，返回当前玩家语言的文本。 */
export type Labeler = (key: string, vars?: MessageVars) => string;

/**
 * 视图计算所需的全部协作者，由调用方注入。
 * 使用场景：ui-services 用真实索引、配置和玩家语言构造；测试可直接传入 harness 的索引。
 */
export interface ViewContext {
  index: WorldIndex;
  actor: Actor;
  label: Labeler;
  config: LandConfig;
  /** 配额组的命名权限判断，与 builtinQuota 的 holds 参数一致。 */
  holds: (permission: string) => boolean;
  now: number;
}

/** 玩家所在的方块位置。 */
export interface ViewPosition {
  dimensionId: string;
  x: number;
  y: number;
  z: number;
}

/** 界面选区（area_pos1 / area_pos2）的展示形态。 */
export interface ViewSelection {
  pos1?: { x: number; y: number; z: number };
  pos2?: { x: number; y: number; z: number };
}

/** 玩家对一块领地的管理能力。只用于决定界面按钮是否出现。 */
export interface LandCaps {
  owner: boolean;
  manage: boolean;
  claim: boolean;
  transfer: boolean;
  members: boolean;
  roles: boolean;
  flags: boolean;
  areas: boolean;
  bankView: boolean;
  deposit: boolean;
  withdraw: boolean;
  economy: boolean;
  teleport: boolean;
}

/** 一小时的毫秒数。租期、税期与维护周期在界面上统一按小时展示。 */
const HOUR_MS = 3_600_000;

/** 距离某个时间点还有多少小时（向上取整，不小于 0）。 */
function hoursUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / HOUR_MS));
}

/** 方块坐标取整后的 "x, y, z" 文本。 */
function pointText(point: { x: number; y: number; z: number } | undefined): string {
  return point ? `${Math.floor(point.x)}, ${Math.floor(point.y)}, ${Math.floor(point.z)}` : "-";
}

/** 子区域范围文本。内部是半开区间，展示时与网页地图一致换成包含两端的方块坐标。 */
function boxText(box: Aabb | null): string {
  if (!box) return "";
  return `${box.min.x}, ${box.min.y}, ${box.min.z} ~ ${box.max.x - 1}, ${box.max.y - 1}, ${box.max.z - 1}`;
}

/** 按 token 取普通（box）子区域；默认区域不在界面上单独编辑，按不存在处理。 */
function boxAreaOf(land: LandState, token: string): AreaState {
  const area = requireArea(land, token);
  if (area.kind !== "box") throw new LandError("area_not_found", { name: token });
  return area;
}

/** 玩家与领地的关系键：领主为 owner，非成员为 none。 */
function relationOf(index: WorldIndex, actorId: string, land: LandState): string {
  if (land.ownerId === actorId) return "owner";
  return index.member(land.id, actorId)?.relation ?? "none";
}

/** 关系键对应的本地化标签。 */
function relationLabel(ctx: ViewContext, relation: string): string {
  return ctx.label(`rel_${relation}`);
}

/**
 * 计算玩家对领地的管理能力：控制台和领主全部允许，其他人按默认区域上的角色判定。
 * 转让、删除只看领主或服务器管理员（与 territory 的 assertOwner 口径一致）。
 */
export function landCaps(ctx: ViewContext, land: LandState): LandCaps {
  const { index, actor } = ctx;
  const owner = actor.console || land.ownerId === actor.id;
  const located = { land, area: index.defaultAreaOf(land), specific: false };
  const can = (permission: string) => owner || decide(index, actor, permission, located, false).allow;
  const publicTeleport = resolveFlag(index, land, undefined, "public_teleport") === true;
  return {
    owner,
    manage: can("land.manage"),
    claim: can("land.claim"),
    transfer: owner || actor.admin,
    members: can("member.manage"),
    roles: can("role.manage"),
    flags: can("flag.manage"),
    areas: can("area.manage"),
    bankView: can("bank.view"),
    deposit: can("bank.deposit"),
    withdraw: can("bank.withdraw"),
    economy: can("economy.manage") || actor.admin,
    teleport: Boolean(land.spawn) && (can("land.teleport") || publicTeleport),
  };
}

/** 领地的最小引用。 */
function landRef(land: LandState): { id: string; name: string } {
  return { id: land.id, name: land.name };
}

/** 普通（box）子区域列表，按名称排序。 */
function boxAreas(index: WorldIndex, landId: string): AreaState[] {
  return index
    .areasOf(landId)
    .filter((area) => area.kind === "box")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 角色列表，按预置在前、名称其次排序。 */
function sortedRoles(index: WorldIndex, landId: string): RoleState[] {
  return index.rolesOf(landId).sort((a, b) => Number(b.reserved) - Number(a.reserved) || a.name.localeCompare(b.name));
}

/** 选区展示信息。 */
function selectionView(picked: ViewSelection): { pos1Text: string; pos2Text: string; ready: boolean } {
  return { pos1Text: pointText(picked.pos1), pos2Text: pointText(picked.pos2), ready: Boolean(picked.pos1 && picked.pos2) };
}

/**
 * 首页：脚下位置、我的领地、待处理邀请、领地配额。
 * 使用场景：land.ui.home → screens/home.ui.json。
 */
export function homeView(ctx: ViewContext, here: ViewPosition | undefined) {
  const { index, actor } = ctx;
  const located = here ? index.locate(here.dimensionId, here.x, here.y, here.z) : undefined;
  const lands = [...index.lands.values()]
    .filter((land) => {
      const relation = relationOf(index, actor.id, land);
      return relation !== "none" && relation !== "banned" && relation !== "invited";
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((land) => {
      const relation = relationLabel(ctx, relationOf(index, actor.id, land));
      const status = ctx.label(`status_${land.status}`);
      return {
        id: land.id,
        name: land.name,
        relationLabel: relation,
        statusLabel: status,
        level: land.level,
        chunks: land.claimKeys.length,
      };
    });
  const invites = [...index.members.values()]
    .filter((member) => member.playerId === actor.id && member.relation === "invited")
    .map((member) => index.lands.get(member.landId))
    .filter((land): land is LandState => land !== undefined)
    .map((land) => ({ id: land.id, landId: land.id, landName: land.name }));
  const quota = builtinQuota(ctx.config, index, actor, undefined, "lands", ctx.holds);
  return {
    inLand: Boolean(located),
    here: located
      ? {
          landId: located.land.id,
          landName: located.land.name,
          areaName: located.specific ? located.area.name : "",
          ownerName: located.land.ownerName,
          relationLabel: relationLabel(ctx, relationOf(index, actor.id, located.land)),
        }
      : null,
    lands,
    landCount: lands.length,
    invites,
    inviteCount: invites.length,
    landQuota: { used: quota.used, limit: quota.limit },
    isAdmin: actor.admin,
  };
}

/**
 * 领地详情：基本信息、出生点、税费、扩展数据和能力开关。
 * 使用场景：land.ui.detail → screens/detail.ui.json、settings.ui.json。
 */
export function detailView(ctx: ViewContext, landToken: string) {
  const { index, actor } = ctx;
  const land = requireLand(landToken);
  const metadata = Object.entries(land.metadata).map(([key, value]) => ({ id: key, key, value }));
  const spawn = land.spawn;
  return {
    land: {
      ...landRef(land),
      description: land.description,
      ownerName: land.ownerName,
      statusLabel: ctx.label(`status_${land.status}`),
      level: land.level,
      chunks: land.claimKeys.length,
      areaCount: boxAreas(index, land.id).length,
      memberCount: index.membersOf(land.id).filter((member) => member.relation !== "banned" && member.relation !== "invited").length,
      roleCount: index.rolesOf(land.id).length,
      hasSpawn: Boolean(spawn),
      spawnText: spawn ? `${pointText(spawn)} (${spawn.dimensionId})` : "",
      taxEnabled: land.taxEnabled,
      taxAmount: land.taxAmount,
      taxHours: Math.round(land.taxPeriodMs / HOUR_MS),
    },
    metadata,
    metaCount: metadata.length,
    relationLabel: relationLabel(ctx, relationOf(index, actor.id, land)),
    caps: landCaps(ctx, land),
  };
}

/**
 * 区块页：脚下区块、所在领地、选区与可占领的领地。
 * 使用场景：land.ui.chunks → screens/chunks.ui.json。
 */
export function chunksView(ctx: ViewContext, here: ViewPosition, picked: ViewSelection) {
  const { index } = ctx;
  const chunk = chunkOf(here.dimensionId, here.x, here.z);
  const located = index.locate(here.dimensionId, here.x, here.y, here.z);
  const manageable = [...index.lands.values()]
    .filter((land) => landCaps(ctx, land).claim)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(landRef);
  return {
    chunk: { x: chunk.chunkX, z: chunk.chunkZ, dimensionId: chunk.dimensionId },
    inLand: Boolean(located),
    standing: located ? { ...landRef(located.land), ownerName: located.land.ownerName, caps: landCaps(ctx, located.land) } : null,
    selection: selectionView(picked),
    manageable,
    manageableCount: manageable.length,
  };
}

/**
 * 成员页：成员、封禁、在线玩家与可分配角色。
 * 使用场景：land.ui.members → screens/members.ui.json。online 由调用方传入，不包含玩家自己。
 */
export function membersView(ctx: ViewContext, landToken: string, online: Array<{ id: string; name: string }>) {
  const { index } = ctx;
  const land = requireLand(landToken);
  const all = index.membersOf(land.id).sort((a, b) => a.playerName.localeCompare(b.playerName));
  const members = all
    .filter((member) => member.relation !== "banned")
    .map((member) => {
      const relation = relationLabel(ctx, member.relation);
      const roleName = index.roles.get(member.roleId)?.name ?? "-";
      return {
        id: member.playerId,
        playerId: member.playerId,
        playerName: member.playerName,
        relationLabel: relation,
        roleName,
      };
    });
  const banned = all
    .filter((member) => member.relation === "banned")
    .map((member) => ({ id: member.playerId, playerId: member.playerId, playerName: member.playerName }));
  const candidates = online.filter((player) => player.id !== land.ownerId);
  const roles = sortedRoles(index, land.id).map((role) => ({ id: role.id, name: role.name }));
  return {
    land: landRef(land),
    ownerName: land.ownerName,
    caps: landCaps(ctx, land),
    members,
    memberCount: members.length,
    banned,
    bannedCount: banned.length,
    online: candidates,
    onlineCount: candidates.length,
    roles,
  };
}

/**
 * 角色列表页。
 * 使用场景：land.ui.roles → screens/roles.ui.json。
 */
export function rolesView(ctx: ViewContext, landToken: string) {
  const { index } = ctx;
  const land = requireLand(landToken);
  const members = index.membersOf(land.id);
  const roles = sortedRoles(index, land.id).map((role) => {
    const users = members.filter((member) => member.roleId === role.id).length;
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      reserved: role.reserved,
      permCount: role.permissions.length,
      userCount: users,
    };
  });
  return { land: landRef(land), caps: landCaps(ctx, land), roles, roleCount: roles.length };
}

/**
 * 单个角色页：逐项权限开关与删除时可选的替代角色。
 * 使用场景：land.ui.role → screens/role.ui.json。
 */
export function roleView(ctx: ViewContext, landToken: string, roleToken: string) {
  const { index } = ctx;
  const land = requireLand(landToken);
  const role = requireRole(land, roleToken);
  const granted = new Set(role.permissions);
  const permissions = listPermissions().map((def) => ({ id: def.id, description: def.description, granted: granted.has(def.id) }));
  const replacements = sortedRoles(index, land.id)
    .filter((item) => item.id !== role.id)
    .map((item) => ({ id: item.id, name: item.name }));
  const userCount =
    index.membersOf(land.id).filter((member) => member.roleId === role.id).length +
    [...index.areaRoles.values()].filter((item) => item.roleId === role.id).length;
  return {
    land: landRef(land),
    caps: landCaps(ctx, land),
    role: { id: role.id, name: role.name, description: role.description, reserved: role.reserved, preset: role.preset },
    permissions,
    replacements,
    userCount,
  };
}

/**
 * 子区域列表页：区域、租约摘要与当前选区。
 * 使用场景：land.ui.areas → screens/areas.ui.json。
 */
export function areasView(ctx: ViewContext, landToken: string, picked: ViewSelection) {
  const { index } = ctx;
  const land = requireLand(landToken);
  const areas = boxAreas(index, land.id).map((area) => {
    const lease = index.activeLeases.get(area.id);
    return {
      id: area.id,
      name: area.name,
      boxText: boxText(area.box),
      tenantName: lease?.tenantName ?? "",
    };
  });
  return { land: landRef(land), caps: landCaps(ctx, land), areas, areaCount: areas.length, selection: selectionView(picked) };
}

/**
 * 单个子区域页：范围、区域角色覆盖、租约、挂牌与可选目标。
 * 使用场景：land.ui.area → screens/area.ui.json。online 由调用方传入，不包含玩家自己。
 */
export function areaView(ctx: ViewContext, landToken: string, areaToken: string, online: Array<{ id: string; name: string }>, picked: ViewSelection) {
  const { index, actor, now } = ctx;
  const land = requireLand(landToken);
  const area = boxAreaOf(land, areaToken);
  const roleName = (roleId: string) => index.roles.get(roleId)?.name ?? "-";
  const nameOf = (playerId: string) =>
    playerId === PUBLIC_PLAYER_ID
      ? ctx.label("rel_public")
      : (index.member(land.id, playerId)?.playerName ?? index.identityByToken(playerId)?.playerName ?? playerId);
  const overrides = [...index.areaRoles.values()]
    .filter((item) => item.areaId === area.id)
    .map((item) => ({ id: item.playerId, playerName: nameOf(item.playerId), roleName: roleName(item.roleId) }));
  const lease = index.activeLeases.get(area.id);
  const listings = [...index.listings.values()].filter((item) => item.status === "open" && item.targetId === area.id);
  const rent = listings.find((item) => item.kind === "rent");
  const sale = listings.find((item) => item.kind === "sale");
  const targets = [{ id: PUBLIC_PLAYER_ID, name: ctx.label("rel_public") }, ...online];
  return {
    land: landRef(land),
    caps: landCaps(ctx, land),
    area: { id: area.id, name: area.name, description: area.description, boxText: boxText(area.box), dimensionId: area.dimensionId },
    overrides,
    overrideCount: overrides.length,
    roles: sortedRoles(index, land.id).map((role) => ({ id: role.id, name: role.name })),
    targets,
    hasLease: Boolean(lease),
    lease: lease
      ? { tenantName: lease.tenantName, price: lease.price, hoursLeft: hoursUntil(lease.endAt, now), mine: lease.tenantId === actor.id }
      : null,
    rent: rent ? { price: rent.price, periodHours: Math.round(rent.periodMs / HOUR_MS) } : null,
    sale: sale ? { price: sale.price } : null,
    hasListing: Boolean(rent || sale),
    selectionReady: selectionView(picked).ready,
  };
}

/**
 * 旗标页：布尔旗标做成开关，其余做成“选择 + 输入”。areaToken 为空时编辑领地级旗标。
 * 使用场景：land.ui.flags → screens/flags.ui.json。command 是写入时使用的子命令（flag / area_flag）。
 */
export function flagsView(ctx: ViewContext, landToken: string, areaToken: string) {
  const { index } = ctx;
  const land = requireLand(landToken);
  const area = areaToken ? boxAreaOf(land, areaToken) : undefined;
  const scopeId = area?.id ?? land.id;
  const defs = listFlags().filter((def) => def.scope === "both" || def.scope === (area ? "area" : "land"));
  const valueOf = (flagId: string) => resolveFlag(index, land, area, flagId);
  const toggles = defs
    .filter((def) => def.type === "boolean")
    .map((def) => ({ id: def.id, description: def.description, value: valueOf(def.id) === true, own: index.flag(scopeId, def.id) !== undefined }));
  const inputs = defs
    .filter((def) => def.type !== "boolean")
    .map((def) => ({ id: def.id, description: def.description, type: def.type, value: String(valueOf(def.id)) }));
  return {
    land: landRef(land),
    area: area ? { id: area.id, name: area.name } : null,
    caps: landCaps(ctx, land),
    command: area ? "area_flag" : "flag",
    toggles,
    inputs,
    inputCount: inputs.length,
  };
}

/**
 * 资金页：银行、等级、维护、税费、配额与整块出售挂牌。balance 为 null 表示无权查看。
 * 使用场景：land.ui.finance → screens/finance.ui.json。
 */
export function financeView(ctx: ViewContext, landToken: string, balance: number | null, upkeep: number) {
  const { index, actor, config, now } = ctx;
  const land = requireLand(landToken);
  const next = nextLevelRule(config, land.level);
  const quota = (id: "chunks" | "members" | "areas" | "roles") => {
    const view = builtinQuota(config, index, actor, land, id, ctx.holds);
    return { used: view.used, limit: isUnlimited(view.limit) ? ctx.label("unlimited") : view.limit };
  };
  const sale = [...index.listings.values()].find(
    (item) => item.status === "open" && item.kind === "sale" && item.targetType === "land" && item.targetId === land.id,
  );
  return {
    land: landRef(land),
    caps: landCaps(ctx, land),
    balanceVisible: balance !== null,
    balance: balance ?? 0,
    level: land.level,
    maxLevel: !next,
    nextLevel: next?.level ?? land.level,
    nextCost: next?.cost ?? 0,
    statusLabel: ctx.label(`status_${land.status}`),
    upkeep,
    upkeepHours: hoursUntil(land.nextUpkeepAt, now),
    delinquent: land.status !== "active",
    tax: { enabled: land.taxEnabled, amount: land.taxAmount, hours: Math.round(land.taxPeriodMs / HOUR_MS) },
    quota: { chunks: quota("chunks"), members: quota("members"), areas: quota("areas"), roles: quota("roles") },
    onSale: Boolean(sale),
    salePrice: sale?.price ?? 0,
  };
}

/**
 * 市场页：其他人的出租 / 出售挂牌，以及我租下的区域。
 * 使用场景：land.ui.market → screens/market.ui.json。
 */
export function marketView(ctx: ViewContext) {
  const { index, actor, now } = ctx;
  const listings = [...index.listings.values()]
    .filter((item) => item.status === "open")
    .map((item) => ({ item, land: index.lands.get(item.landId) }))
    .filter((row): row is { item: (typeof row)["item"]; land: LandState } => row.land !== undefined && row.land.ownerId !== actor.id)
    .map(({ item, land }) => {
      const area = item.targetType === "area" ? index.areas.get(item.targetId) : undefined;
      const periodHours = Math.round(item.periodMs / HOUR_MS);
      return {
        id: item.id,
        landName: land.name,
        areaName: area?.name ?? "",
        isRent: item.kind === "rent",
        price: item.price,
        periodHours,
      };
    });
  const rents = listings.filter((row) => row.isRent);
  const sales = listings.filter((row) => !row.isRent);
  const leases = [...index.activeLeases.values()]
    .filter((lease) => lease.tenantId === actor.id)
    .map((lease) => {
      const land = index.lands.get(lease.landId);
      const area = index.areas.get(lease.areaId);
      return {
        id: lease.id,
        landName: land?.name ?? lease.landId,
        areaName: area?.name ?? lease.areaId,
        price: lease.price,
        hoursLeft: hoursUntil(lease.endAt, now),
      };
    });
  return { rents, rentCount: rents.length, sales, saleCount: sales.length, leases, leaseCount: leases.length };
}

/**
 * 管理员页：会话绕过状态与待绑定的旧服身份。
 * 使用场景：land.ui.admin → screens/admin.ui.json。legacy 由调用方用 legacyOverview 计算后传入。
 */
export function adminView(ctx: ViewContext, legacy: { total: number; rows: Array<{ playerId: string; playerName: string; lands: number }> }) {
  if (!ctx.actor.admin) throw new LandError("no_permission", { reason: "land.admin" });
  const rows = legacy.rows.map((row) => ({ id: row.playerId, ...row }));
  return { bypass: hasBypass(ctx.actor.id), legacy: rows, legacyCount: rows.length, legacyTotal: legacy.total };
}
