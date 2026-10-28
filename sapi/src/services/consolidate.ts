/**
 * 管理员维护：合并领地、按名称前缀清理子区域、按区块数重排等级。
 * 使用场景：iland 迁移把大片领地切成了许多 100 区块的小领地，管理员需要把同一领主的相邻领地并成一块，
 * 清掉迁移留下的占位子区域，并让等级表调整后超出上限的领地升到放得下的等级。
 * 三项操作都先生成计划（命令不带 confirm 时只预览），执行时在领地写锁内重新生成计划再落库。
 */

import { claimKey, parseClaimKey } from "../domain/geometry.js";
import { LandError } from "../domain/errors.js";
import { makeId, nameKey } from "../domain/ids.js";
import type { Actor, AreaRoleState, AreaState, LandState, MemberState, RoleState } from "../domain/model.js";
import { fitLevelRule } from "../config.js";
import {
  deleteLandGraph,
  insertAreaRole,
  landTx,
  moveAreaRole,
  patchLand,
  reassignClaim,
  updateArea,
  updateRole,
} from "../store/repo.js";
import { afterEvent } from "./hooks.js";
import { withTerritoryLock } from "./lock.js";
import { landConfig, requireLand, roleByPreset, world } from "./shared.js";
import { removalBlocker, removeAreaRecords } from "./territory.js";

/** admin_merge 第二个参数的特殊写法：目标领地按区块四邻接连通、且同一领主的全部领地。 */
export const CONNECTED_TOKEN = "@connected";

/** 合并后能以子区域授权保留下来的成员关系；邀请、访客与封禁无法用区域授权表达。 */
const CARRIED_RELATIONS = new Set(["admin", "member", "trusted"]);

/** 合并计划。预览与执行共用，执行时在锁内重新生成，避免预览后数据已变化。 */
export interface MergePlan {
  actorId: string;
  target: LandState;
  sources: LandState[];
  /** 合并后的区块总数。 */
  chunks: number;
  /** 合并后的等级：目标原等级与“能容纳 chunks 的最低等级”取较大者，不会降级。 */
  level: number;
  /** 迁入目标领地的普通子区域（landId 已改为目标）。 */
  areas: AreaState[];
  /** 迁入目标领地的自定义角色（landId 已改为目标）。 */
  roles: RoleState[];
  /** 来源角色 ID → 目标领地中的角色 ID（预置角色按模板键对应，自定义角色同名复用或整体迁入）。 */
  roleMap: Map<string, string>;
  /** 随子区域迁入的已有区域授权（landId、roleId 已改）。 */
  movedAreaRoles: AreaRoleState[];
  /** 由来源领地成员转换而来的新区域授权：成员只在其原领地的子区域内保留角色。 */
  newAreaRoles: AreaRoleState[];
  /** 无法带入目标领地的成员（邀请、访客、封禁，或原领地没有可挂靠的子区域）。 */
  droppedMembers: MemberState[];
  /** 被丢弃的来源领地级旗标数量；目标领地的旗标保持不变。 */
  droppedFlags: number;
}

/** 子区域清理计划。 */
export interface PrunePlan {
  land: LandState;
  prefix: string;
  /** 将被删除的子区域：名称匹配前缀，且没有区域授权、区域旗标、有效租约和开放挂牌。 */
  removable: AreaState[];
  /** 名称匹配但带有自身数据而保留的子区域。 */
  kept: AreaState[];
}

/** 等级重排中的一项变化。 */
export interface LevelChange {
  land: LandState;
  from: number;
  to: number;
}

function assertAdmin(actor: Actor): void {
  if (!actor.admin && !actor.console) throw new LandError("no_permission", { reason: "land.admin" });
}

/**
 * 与目标领地区块四邻接连通、且属于同一领主的其他领地（传递连通，跨维度不连通）。
 * 使用场景：admin_merge 的 @connected 写法，一次合并整片被切开的领地。
 */
export function connectedLands(target: LandState): LandState[] {
  const index = world();
  const seen = new Set([target.id]);
  const queue = [target];
  const found: LandState[] = [];
  while (queue.length > 0) {
    const land = queue.shift()!;
    for (const key of land.claimKeys) {
      const chunk = parseClaimKey(key);
      if (!chunk) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const otherId = index.claims.get(claimKey(chunk.dimensionId, chunk.chunkX + dx, chunk.chunkZ + dz));
        if (!otherId || seen.has(otherId)) continue;
        const other = index.lands.get(otherId);
        if (!other || other.ownerId !== target.ownerId) continue;
        seen.add(otherId);
        queue.push(other);
        found.push(other);
      }
    }
  }
  return found;
}

/** 解析合并来源：@connected 取连通同主领地，否则按名称或 ID 取单块领地。 */
function resolveSources(target: LandState, token: string): LandState[] {
  const sources = token === CONNECTED_TOKEN ? connectedLands(target) : [requireLand(token)];
  if (sources.length === 0) throw new LandError("merge_none");
  for (const source of sources) {
    if (source.id === target.id) throw new LandError("merge_self");
    if (source.ownerId !== target.ownerId) throw new LandError("merge_owner", { name: source.name });
  }
  return sources;
}

/** 同权限集合（顺序无关）。自定义角色同名时只有权限完全一致才复用。 */
function samePermissions(a: RoleState, b: RoleState): boolean {
  return a.permissions.length === b.permissions.length && a.permissions.every((item) => b.permissions.includes(item));
}

/**
 * 生成合并计划，不写库。来源领地必须与目标同一领主，且没有银行余额、有效租约、开放挂牌和未完成交易（与删除领地同一规则）。
 * 使用场景：admin_merge 预览；mergeLands 在锁内重新生成后执行。
 */
export async function planMerge(actor: Actor, targetToken: string, sourceToken: string): Promise<MergePlan> {
  assertAdmin(actor);
  const index = world();
  const config = landConfig();
  const target = requireLand(targetToken);
  const sources = resolveSources(target, sourceToken);
  for (const source of sources) {
    const blocker = await removalBlocker(source);
    if (blocker) throw new LandError("merge_blocked", { name: source.name, reason: blocker });
  }
  const now = Date.now();
  const targetRoles = index.rolesOf(target.id);
  const roles: RoleState[] = [];
  const roleMap = new Map<string, string>();
  const areas: AreaState[] = [];
  const areaNames = new Set(index.areasOf(target.id).map((area) => area.nameKey));
  const areasBySource = new Map<string, AreaState[]>();
  for (const source of sources) {
    for (const role of index.rolesOf(source.id)) {
      const preset = role.preset ? targetRoles.find((item) => item.preset === role.preset) : undefined;
      if (preset) {
        roleMap.set(role.id, preset.id);
        continue;
      }
      const same = [...targetRoles, ...roles].find((item) => item.nameKey === role.nameKey);
      if (same && samePermissions(same, role)) {
        roleMap.set(role.id, same.id);
        continue;
      }
      if (same) throw new LandError("name_taken", { name: `${source.name}/${role.name}` });
      roles.push({ ...role, landId: target.id, updatedAt: now });
      roleMap.set(role.id, role.id);
    }
    const moved: AreaState[] = [];
    for (const area of index.areasOf(source.id)) {
      if (area.kind !== "box") continue;
      if (areaNames.has(area.nameKey)) throw new LandError("name_taken", { name: `${source.name}/${area.name}` });
      areaNames.add(area.nameKey);
      moved.push({ ...area, landId: target.id, updatedAt: now });
    }
    areasBySource.set(source.id, moved);
    areas.push(...moved);
  }
  const movedAreaIds = new Set(areas.map((area) => area.id));
  const sourceIds = new Set(sources.map((source) => source.id));
  const movedAreaRoles = [...index.areaRoles.values()]
    .filter((role) => sourceIds.has(role.landId) && movedAreaIds.has(role.areaId))
    .map((role) => ({ ...role, landId: target.id, roleId: roleMap.get(role.roleId) ?? role.roleId }));
  const assigned = new Set(movedAreaRoles.map((role) => `${role.areaId}|${role.playerId}`));
  const memberRoleId = roleByPreset(targetRoles, "member").id;
  const newAreaRoles: AreaRoleState[] = [];
  const droppedMembers: MemberState[] = [];
  for (const source of sources) {
    const hosts = areasBySource.get(source.id) ?? [];
    for (const member of index.membersOf(source.id)) {
      if (member.playerId === target.ownerId || index.member(target.id, member.playerId)) continue;
      if (!CARRIED_RELATIONS.has(member.relation) || hosts.length === 0) {
        droppedMembers.push(member);
        continue;
      }
      for (const area of hosts) {
        const key = `${area.id}|${member.playerId}`;
        if (assigned.has(key)) continue;
        assigned.add(key);
        newAreaRoles.push({
          id: makeId("g"),
          areaId: area.id,
          landId: target.id,
          playerId: member.playerId,
          roleId: roleMap.get(member.roleId) ?? memberRoleId,
        });
      }
    }
  }
  const chunks = target.claimKeys.length + sources.reduce((sum, source) => sum + source.claimKeys.length, 0);
  return {
    actorId: actor.id,
    target,
    sources,
    chunks,
    level: Math.max(target.level, fitLevelRule(config, chunks).level),
    areas,
    roles,
    roleMap,
    movedAreaRoles,
    newAreaRoles,
    droppedMembers,
    droppedFlags: sources.reduce((sum, source) => sum + (index.flags.get(source.id)?.size ?? 0), 0),
  };
}

/**
 * 合并领地：来源领地的区块、普通子区域（含区域授权与区域旗标）、自定义角色并入目标；来源成员转为其原子区域内的区域授权；
 * 来源领地的默认区域、预置角色、成员行、领地级旗标随领地一起删除。目标的名称、出生点、银行、旗标与成员保持不变。
 * 使用场景：admin_merge confirm；离线维护脚本直接调用。
 */
export function mergeLands(actor: Actor, targetToken: string, sourceToken: string): Promise<MergePlan> {
  return withTerritoryLock(async () => {
    const plan = await planMerge(actor, targetToken, sourceToken);
    const index = world();
    const now = Date.now();
    const movedClaims = plan.sources.flatMap((source) =>
      source.claimKeys.map((key) => ({ key, id: index.claimIds.get(key) ?? "" })),
    );
    await landTx(async (tx) => {
      for (const claim of movedClaims) if (claim.id) await reassignClaim(claim.id, plan.target.id, tx);
      for (const area of plan.areas) await updateArea(area, tx);
      for (const role of plan.roles) await updateRole(role, tx);
      for (const role of plan.movedAreaRoles) await moveAreaRole(role, tx);
      for (const source of plan.sources) await deleteLandGraph(source.id, tx);
      for (const role of plan.newAreaRoles) await insertAreaRole(role, tx);
      await patchLand(plan.target.id, { level: plan.level, updatedAt: now }, tx);
    });
    // 先把区块、子区域、角色与授权改挂到目标，再从索引移除来源领地，避免 dropLand 连带删掉已迁走的数据
    for (const claim of movedClaims) index.upsertClaim(claim.key, claim.id, plan.target.id);
    for (const area of plan.areas) index.upsertArea(area);
    for (const role of plan.roles) index.upsertRole(role);
    for (const role of plan.movedAreaRoles) index.upsertAreaRole(role);
    for (const source of plan.sources) index.dropLand(source.id);
    for (const role of plan.newAreaRoles) index.upsertAreaRole(role);
    const live = index.lands.get(plan.target.id) ?? plan.target;
    index.upsertLand({ ...live, level: plan.level, updatedAt: now });
    for (const source of plan.sources) {
      await afterEvent("land.deleted", { actorId: actor.id, landId: source.id, name: source.name, mergedInto: plan.target.id });
    }
    await afterEvent("land.claimed", { actorId: actor.id, landId: plan.target.id, count: movedClaims.length });
    if (plan.level !== plan.target.level) {
      await afterEvent("land.level.changed", { actorId: actor.id, landId: plan.target.id, from: plan.target.level, level: plan.level, reason: "merge" });
    }
    await afterEvent("land.merged", {
      actorId: actor.id,
      landId: plan.target.id,
      sourceIds: plan.sources.map((source) => source.id),
      chunks: plan.chunks,
      level: plan.level,
    });
    return plan;
  });
}

/**
 * 生成子区域清理计划：名称（按名称键）以 prefix 开头的普通子区域中，没有区域授权、区域旗标、有效租约与开放挂牌的才会删除。
 * 使用场景：admin_area_prune 预览；pruneAreas 在锁内重新生成后执行。前缀由管理员输入，代码不内置任何名称。
 */
export function planPrune(actor: Actor, landToken: string, prefix: string): PrunePlan {
  assertAdmin(actor);
  const key = nameKey(prefix);
  if (!key) throw new LandError("bad_name", { label: "名称前缀", name: prefix });
  const index = world();
  const land = requireLand(landToken);
  const matched = index.areasOf(land.id).filter((area) => area.kind === "box" && area.nameKey.startsWith(key));
  const ownData = (area: AreaState): boolean =>
    [...index.areaRoles.values()].some((role) => role.areaId === area.id) ||
    (index.flags.get(area.id)?.size ?? 0) > 0 ||
    index.activeLeases.get(area.id)?.status === "active" ||
    [...index.listings.values()].some((listing) => listing.targetId === area.id && listing.status === "open");
  return {
    land,
    prefix,
    removable: matched.filter((area) => !ownData(area)),
    kept: matched.filter(ownData),
  };
}

/** 按清理计划删除子区域。使用场景：admin_area_prune confirm；离线维护脚本。 */
export function pruneAreas(actor: Actor, landToken: string, prefix: string): Promise<PrunePlan> {
  return withTerritoryLock(async () => {
    const plan = planPrune(actor, landToken, prefix);
    for (const area of plan.removable) await removeAreaRecords(plan.land, area, actor.id);
    return plan;
  });
}

/**
 * 列出区块数超过当前等级上限、需要提升的领地：目标等级为能容纳其区块数的最低等级，只升不降。
 * 使用场景：admin_relevel 预览；等级表修改后的一次性重排。landToken 为空时检查全部领地。
 */
export function planRelevel(actor: Actor, landToken?: string): LevelChange[] {
  assertAdmin(actor);
  const config = landConfig();
  const lands = landToken ? [requireLand(landToken)] : [...world().lands.values()];
  return lands
    .map((land) => ({ land, from: land.level, to: Math.max(land.level, fitLevelRule(config, land.claimKeys.length).level) }))
    .filter((change) => change.to !== change.from);
}

/** 执行等级重排。使用场景：admin_relevel confirm；离线维护脚本。 */
export function relevelLands(actor: Actor, landToken?: string): Promise<LevelChange[]> {
  return withTerritoryLock(async () => {
    const changes = planRelevel(actor, landToken);
    if (changes.length === 0) return changes;
    const now = Date.now();
    await landTx(async (tx) => {
      for (const change of changes) await patchLand(change.land.id, { level: change.to, updatedAt: now }, tx);
    });
    const index = world();
    for (const change of changes) {
      const live = index.lands.get(change.land.id);
      if (live) index.upsertLand({ ...live, level: change.to, updatedAt: now });
    }
    for (const change of changes) {
      await afterEvent("land.level.changed", { actorId: actor.id, landId: change.land.id, from: change.from, level: change.to, reason: "relevel" });
    }
    return changes;
  });
}
