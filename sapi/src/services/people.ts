/**
 * 成员关系与自定义角色。
 * 关系决定资格，角色决定权限。封禁优先于区域角色覆盖。
 */

import { LandError } from "../domain/errors.js";
import { assertDisplayName, makeId, nameKey } from "../domain/ids.js";
import type {
  Actor,
  AreaRoleState,
  MemberState,
  Relation,
  RoleState,
} from "../domain/model.js";
import { getPermission } from "../domain/permissions.js";
import { afterEvent, beforeEvent } from "./hooks.js";
import { withTerritoryLock } from "./lock.js";
import { assertAllowed } from "./permission.js";
import { assertBuiltin, builtinQuota } from "./quota.js";
import {
  holds,
  landConfig,
  requireArea,
  requireLand,
  requireRole,
  roleByPreset,
  world,
} from "./shared.js";
import {
  hardDelete,
  insertAreaRole,
  insertMember,
  insertRole,
  landTx,
  updateAreaRole,
  updateMember,
  updateRole,
} from "../store/repo.js";
import { TABLES } from "../store/tables.js";

function assertManage(actor: Actor, landId: string, permission: string): void {
  const land = world().lands.get(landId);
  if (!land) throw new LandError("land_not_found", { name: landId });
  if (actor.console || land.ownerId === actor.id) return;
  const area = world().areas.get(land.defaultAreaId);
  if (!area) throw new LandError("not_ready");
  const decision = assertAllowed(world(), actor, permission, {
    land,
    area,
    specific: false,
  });
  if (!decision.allow)
    throw new LandError("no_permission", { reason: decision.reason });
}

function memberCap(actor: Actor, landId: string): number {
  const land = requireLand(landId);
  return builtinQuota(
    landConfig(),
    world(),
    actor,
    land,
    "members",
    (permission) => holds(actor, permission),
  ).limit;
}

function occupied(landId: string): number {
  return world()
    .membersOf(landId)
    .filter(
      (member) =>
        member.relation === "admin" ||
        member.relation === "member" ||
        member.relation === "trusted",
    ).length;
}

async function saveMember(
  member: MemberState,
  existed: boolean,
  actorId: string,
  revokeAreaRoles = false,
): Promise<void> {
  const revoked = revokeAreaRoles
    ? areaRolesOf(member.landId, member.playerId)
    : [];
  await landTx(async (tx) => {
    for (const role of revoked) await hardDelete(TABLES.areaRole, role.id, tx);
    if (existed) await updateMember(member, tx);
    else await insertMember(member, tx);
  });
  for (const role of revoked)
    world().removeAreaRole(role.areaId, member.playerId, member.landId);
  world().upsertMember(member);
  world().bump(member.landId);
  await afterEvent("land.member.changed", {
    actorId,
    landId: member.landId,
    playerId: member.playerId,
    relation: member.relation,
  });
  await afterEvent("land.permission.changed", {
    actorId,
    landId: member.landId,
    playerId: member.playerId,
    roleId: member.roleId,
    relation: member.relation,
    revokedAreaIds: revoked.map((role) => role.areaId),
  });
}

/** 成员和区域覆盖一起撤销，事务失败时不更新索引、不发送成功通知。 */
async function removeMember(
  member: MemberState,
  actorId: string,
  relation: string,
  revokeAreaRoles = true,
): Promise<void> {
  const revoked = revokeAreaRoles
    ? areaRolesOf(member.landId, member.playerId)
    : [];
  await landTx(async (tx) => {
    await hardDelete(TABLES.member, member.id, tx);
    for (const role of revoked) await hardDelete(TABLES.areaRole, role.id, tx);
  });
  for (const role of revoked)
    world().removeAreaRole(role.areaId, member.playerId, member.landId);
  world().removeMember(member.landId, member.playerId);
  const payload = {
    actorId,
    landId: member.landId,
    playerId: member.playerId,
    relation,
    roleId: "",
    revokedAreaIds: revoked.map((role) => role.areaId),
  };
  await afterEvent("land.member.changed", payload);
  await afterEvent("land.permission.changed", payload);
}

/** 邀请玩家。待接受的邀请不占用成员配额。 */
async function inviteLocked(
  actor: Actor,
  token: string,
  player: { id: string; name: string },
  roleToken?: string,
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "member.manage");
  if (player.id === land.ownerId)
    throw new LandError("no_permission", { reason: "owner" });
  const existing = world().member(land.id, player.id);
  if (existing?.relation === "banned")
    throw new LandError("no_permission", { reason: "banned" });
  const role = roleToken
    ? requireRole(land, roleToken)
    : roleByPreset(world().rolesOf(land.id), "member");
  const now = Date.now();
  await beforeEvent("land.before.member", {
    actorId: actor.id,
    landId: land.id,
    playerId: player.id,
    op: "invite",
  });
  await saveMember(
    {
      id: existing?.id ?? makeId("m"),
      landId: land.id,
      playerId: player.id,
      playerName: player.name,
      relation: "invited",
      roleId: role.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
    Boolean(existing),
    actor.id,
  );
}

/** 接受发给自己的邀请。 */
async function acceptInviteLocked(actor: Actor, token: string): Promise<void> {
  const land = requireLand(token);
  const existing = world().member(land.id, actor.id);
  if (!existing || existing.relation !== "invited")
    throw new LandError("no_permission", { reason: "invited" });
  if (occupied(land.id) >= memberCap(actor, land.id))
    throw new LandError("quota", {
      label: "成员数量",
      limit: memberCap(actor, land.id),
    });
  await saveMember(
    { ...existing, relation: "member", updatedAt: Date.now() },
    true,
    actor.id,
  );
}

/** 拒绝邀请。 */
async function denyInviteLocked(actor: Actor, token: string): Promise<void> {
  const land = requireLand(token);
  const existing = world().member(land.id, actor.id);
  if (!existing || existing.relation !== "invited")
    throw new LandError("no_permission", { reason: "invited" });
  await removeMember(existing, actor.id, "denied", false);
}

/** 直接信任玩家。信任占用成员配额，默认使用访客角色，避免意外给予建造权。 */
async function trustLocked(
  actor: Actor,
  token: string,
  player: { id: string; name: string },
  roleToken?: string,
): Promise<void> {
  await setRelation(
    actor,
    token,
    player,
    "trusted",
    roleToken ??
      roleByPreset(world().rolesOf(requireLand(token).id), "visitor").id,
  );
}

/** 取消信任。 */
async function untrustLocked(
  actor: Actor,
  token: string,
  playerId: string,
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "member.manage");
  if (isActiveTenant(land.id, playerId))
    throw new LandError("delete_blocked", { reason: "对方仍有有效租约" });
  const existing = world().member(land.id, playerId);
  if (!existing || existing.relation !== "trusted")
    throw new LandError("player_not_found", { name: playerId });
  await removeMember(existing, actor.id, "untrusted");
}

/** 移除成员。有效租约的租客不能用移除绕过租约。 */
async function kickLocked(
  actor: Actor,
  token: string,
  playerId: string,
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "member.manage");
  if (playerId === land.ownerId)
    throw new LandError("no_permission", { reason: "owner" });
  if (isActiveTenant(land.id, playerId))
    throw new LandError("delete_blocked", { reason: "对方仍有有效租约" });
  const existing = world().member(land.id, playerId);
  if (!existing) throw new LandError("player_not_found", { name: playerId });
  await removeMember(existing, actor.id, "removed");
}

/** 封禁。普通成员授权和区域角色都不能覆盖封禁。 */
async function banLocked(
  actor: Actor,
  token: string,
  player: { id: string; name: string },
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "member.manage");
  if (player.id === land.ownerId)
    throw new LandError("no_permission", { reason: "owner" });
  if (isActiveTenant(land.id, player.id))
    throw new LandError("delete_blocked", { reason: "请先结束租约" });
  const existing = world().member(land.id, player.id);
  const now = Date.now();
  await saveMember(
    {
      id: existing?.id ?? makeId("m"),
      landId: land.id,
      playerId: player.id,
      playerName: player.name,
      relation: "banned",
      roleId: "",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
    Boolean(existing),
    actor.id,
    true,
  );
}

/** 解除封禁。解除后玩家不再是成员，需要重新邀请。 */
async function unbanLocked(
  actor: Actor,
  token: string,
  playerId: string,
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "member.manage");
  const existing = world().member(land.id, playerId);
  if (!existing || existing.relation !== "banned")
    throw new LandError("player_not_found", { name: playerId });
  await removeMember(existing, actor.id, "unbanned");
}

/** 设置领地级角色。不能用它改变领主身份。 */
async function assignRoleLocked(
  actor: Actor,
  token: string,
  playerId: string,
  roleToken: string,
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "member.manage");
  if (playerId === land.ownerId)
    throw new LandError("no_permission", { reason: "owner" });
  const existing = world().member(land.id, playerId);
  if (
    !existing ||
    existing.relation === "banned" ||
    existing.relation === "invited"
  ) {
    throw new LandError("player_not_found", { name: playerId });
  }
  const role = requireRole(land, roleToken);
  await saveMember(
    { ...existing, roleId: role.id, updatedAt: Date.now() },
    true,
    actor.id,
  );
}

/** 设置区域角色覆盖。未设置时回退到领地级角色。 */
async function assignAreaRoleLocked(
  actor: Actor,
  token: string,
  areaToken: string,
  playerId: string,
  roleToken: string,
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "member.manage");
  await grantAreaRoleLocked(actor, land.id, areaToken, playerId, roleToken);
}

/** 租赁和出售使用的区域授权。已经完成业务校验，不再要求调用者拥有成员管理权限。 */
async function grantAreaRoleLocked(
  actor: Actor,
  landId: string,
  areaToken: string,
  playerId: string,
  roleToken: string,
): Promise<void> {
  const land = requireLand(landId);
  const area = requireArea(land, areaToken);
  if (area.kind === "default") throw new LandError("area_default");
  const role = requireRole(land, roleToken);
  const member = world().member(land.id, playerId);
  if (member?.relation === "banned")
    throw new LandError("no_permission", { reason: "banned" });
  const existing = world().areaRoles.get(`${area.id}|${playerId}`);
  const next: AreaRoleState = {
    id: existing?.id ?? makeId("g"),
    areaId: area.id,
    landId: land.id,
    playerId,
    roleId: role.id,
  };
  if (existing) await updateAreaRole(next);
  else await insertAreaRole(next);
  world().upsertAreaRole(next);
  await afterEvent("land.member.changed", {
    actorId: actor.id,
    landId: land.id,
    playerId,
    areaId: area.id,
    roleId: role.id,
  });
  await afterEvent("land.permission.changed", {
    actorId: actor.id,
    landId: land.id,
    playerId,
    areaId: area.id,
    roleId: role.id,
  });
}

async function setRelation(
  actor: Actor,
  token: string,
  player: { id: string; name: string },
  relation: Relation,
  roleToken: string,
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "member.manage");
  if (player.id === land.ownerId)
    throw new LandError("no_permission", { reason: "owner" });
  const existing = world().member(land.id, player.id);
  if (existing?.relation === "banned")
    throw new LandError("no_permission", { reason: "banned" });
  const counting =
    relation === "admin" || relation === "member" || relation === "trusted";
  const already =
    existing &&
    (existing.relation === "admin" ||
      existing.relation === "member" ||
      existing.relation === "trusted");
  if (counting && !already && occupied(land.id) >= memberCap(actor, land.id)) {
    throw new LandError("quota", {
      label: "成员数量",
      limit: memberCap(actor, land.id),
    });
  }
  const role = requireRole(land, roleToken);
  const now = Date.now();
  await saveMember(
    {
      id: existing?.id ?? makeId("m"),
      landId: land.id,
      playerId: player.id,
      playerName: player.name,
      relation,
      roleId: role.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
    Boolean(existing),
    actor.id,
  );
}

function isActiveTenant(landId: string, playerId: string): boolean {
  for (const lease of world().activeLeases.values()) {
    if (
      lease.landId === landId &&
      lease.tenantId === playerId &&
      lease.status === "active"
    )
      return true;
  }
  return false;
}

function areaRolesOf(landId: string, playerId: string): AreaRoleState[] {
  return [...world().areaRoles.values()].filter(
    (role) => role.landId === landId && role.playerId === playerId,
  );
}

/** 创建自定义角色。 */
async function createRoleLocked(
  actor: Actor,
  token: string,
  rawName: string,
  description = "",
): Promise<RoleState> {
  const land = requireLand(token);
  assertManage(actor, land.id, "role.manage");
  assertBuiltin(
    landConfig(),
    world(),
    actor,
    land,
    "roles",
    "自定义角色",
    (permission) => holds(actor, permission),
  );
  const name = assertDisplayName(rawName, "角色名称");
  if (world().roleByName(land.id, name))
    throw new LandError("name_taken", { name });
  const now = Date.now();
  const role: RoleState = {
    id: makeId("r"),
    landId: land.id,
    name,
    nameKey: nameKey(name),
    description: description.slice(0, 200),
    permissions: [],
    reserved: false,
    preset: "",
    createdAt: now,
    updatedAt: now,
  };
  await insertRole(role);
  world().upsertRole(role);
  return role;
}

/** 重命名角色。授权保存的是角色 ID。 */
async function renameRoleLocked(
  actor: Actor,
  token: string,
  roleToken: string,
  rawName: string,
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "role.manage");
  const role = requireRole(land, roleToken);
  const name = assertDisplayName(rawName, "角色名称");
  const other = world().roleByName(land.id, name);
  if (other && other.id !== role.id)
    throw new LandError("name_taken", { name });
  const next = { ...role, name, nameKey: nameKey(name), updatedAt: Date.now() };
  await updateRole(next);
  world().upsertRole(next);
}

/** 修改角色说明。 */
async function describeRoleLocked(
  actor: Actor,
  token: string,
  roleToken: string,
  description: string,
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "role.manage");
  const role = requireRole(land, roleToken);
  const next = {
    ...role,
    description: description.slice(0, 200),
    updatedAt: Date.now(),
  };
  await updateRole(next);
  world().upsertRole(next);
}

/** 给角色增减权限。未注册的权限不能写入。 */
async function setRolePermissionLocked(
  actor: Actor,
  token: string,
  roleToken: string,
  permission: string,
  granted: boolean,
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "role.manage");
  if (!getPermission(permission))
    throw new LandError("perm_unknown", { name: permission });
  const role = requireRole(land, roleToken);
  const permissions = new Set(role.permissions);
  if (granted) permissions.add(permission);
  else permissions.delete(permission);
  const next = {
    ...role,
    permissions: [...permissions],
    updatedAt: Date.now(),
  };
  await updateRole(next);
  world().upsertRole(next);
  world().bump(land.id);
  await afterEvent("land.permission.changed", {
    actorId: actor.id,
    landId: land.id,
    roleId: role.id,
    permission,
    granted,
  });
}

/**
 * 删除角色。
 * 保留角色不能删。仍有成员、区域授权或有效租约使用时，必须同时给出替换角色。
 */
async function deleteRoleLocked(
  actor: Actor,
  token: string,
  roleToken: string,
  replacementToken?: string,
): Promise<void> {
  const land = requireLand(token);
  assertManage(actor, land.id, "role.manage");
  const role = requireRole(land, roleToken);
  if (role.reserved) throw new LandError("role_reserved");
  const users = world()
    .membersOf(land.id)
    .filter((member) => member.roleId === role.id);
  const areaUsers = [...world().areaRoles.values()].filter(
    (item) => item.roleId === role.id,
  );
  const replacement = replacementToken
    ? requireRole(land, replacementToken)
    : undefined;
  if ((users.length > 0 || areaUsers.length > 0) && !replacement)
    throw new LandError("role_in_use");
  if (replacement?.id === role.id) throw new LandError("role_in_use");
  const updatedAt = Date.now();
  await landTx(async (tx) => {
    if (replacement) {
      for (const member of users)
        await updateMember(
          { ...member, roleId: replacement.id, updatedAt },
          tx,
        );
      for (const areaRole of areaUsers)
        await updateAreaRole({ ...areaRole, roleId: replacement.id }, tx);
    }
    await hardDelete(TABLES.role, role.id, tx);
  });
  if (replacement) {
    for (const member of users)
      world().upsertMember({ ...member, roleId: replacement.id, updatedAt });
    for (const areaRole of areaUsers)
      world().upsertAreaRole({ ...areaRole, roleId: replacement.id });
  }
  world().removeRole(role.id);
  await afterEvent("land.permission.changed", {
    actorId: actor.id,
    landId: land.id,
    roleId: role.id,
    replacementRoleId: replacement?.id ?? "",
    playerIds: [
      ...new Set([
        ...users.map((member) => member.playerId),
        ...areaUsers.map((item) => item.playerId),
      ]),
    ],
    areaIds: [...new Set(areaUsers.map((item) => item.areaId))],
    op: "role_deleted",
  });
}

/** 所有公开写入口共用领地队列；内部组合操作直接调用 Locked 实现，避免重复排队。 */
function serializeWrite<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return (...args) => withTerritoryLock(() => operation(...args));
}

export const invite = serializeWrite(inviteLocked);
export const acceptInvite = serializeWrite(acceptInviteLocked);
export const denyInvite = serializeWrite(denyInviteLocked);
export const trust = serializeWrite(trustLocked);
export const untrust = serializeWrite(untrustLocked);
export const kick = serializeWrite(kickLocked);
export const ban = serializeWrite(banLocked);
export const unban = serializeWrite(unbanLocked);
export const assignRole = serializeWrite(assignRoleLocked);
export const assignAreaRole = serializeWrite(assignAreaRoleLocked);
export const grantAreaRole = serializeWrite(grantAreaRoleLocked);
export const createRole = serializeWrite(createRoleLocked);
export const renameRole = serializeWrite(renameRoleLocked);
export const describeRole = serializeWrite(describeRoleLocked);
export const setRolePermission = serializeWrite(setRolePermissionLocked);
export const deleteRole = serializeWrite(deleteRoleLocked);
