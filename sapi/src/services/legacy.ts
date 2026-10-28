/**
 * 旧服身份占位与绑定。
 * SAPI 取不到 XUID，iland 迁移时把领主、成员、区域授权的玩家 ID 写成 `xuid:<XUID>` 占位，
 * 并在 land2_identity 记录旧服名字。玩家首次进入新服时按名字把占位 ID 换成真实 player.id；
 * 名字对不上（改名、未知玩家）时由管理员用 admin_legacy_bind 手动绑定。
 */

import { debug } from "@sfmc-bds/sdk/sapi/runtime";
import { LandError } from "../domain/errors.js";
import { nameKey } from "../domain/ids.js";
import type { AreaRoleState, LandState, MemberState } from "../domain/model.js";
import { hardDelete, landTx, patchLand, rebindAreaRole, updateMember } from "../store/repo.js";
import { TABLES } from "../store/tables.js";
import { afterEvent } from "./hooks.js";
import { withTerritoryLock } from "./lock.js";
import { world } from "./shared.js";

/** 占位玩家 ID 前缀。使用场景：iland 迁移写入、绑定时识别、诊断列表过滤。 */
export const LEGACY_PREFIX = "xuid:";

/** 是否为尚未绑定的旧服占位 ID。 */
export function isLegacyId(playerId: string): boolean {
  return playerId.startsWith(LEGACY_PREFIX);
}

/**
 * 列出尚未绑定的占位身份（按玩家 ID 去重）。
 * 使用场景：自动绑定时按名字查找；admin_legacy 命令列出待处理项。
 */
export function legacyIdentities(): Array<{ playerId: string; playerName: string }> {
  const seen = new Map<string, { playerId: string; playerName: string }>();
  for (const item of world().identities.values()) {
    if (isLegacyId(item.playerId)) seen.set(item.playerId, item);
  }
  return [...seen.values()];
}

/** 待绑定旧服身份的一行概览：身份与其名下领地数。 */
export interface LegacyRow {
  playerId: string;
  playerName: string;
  lands: number;
}

/**
 * 按名字或 XUID 片段（不区分大小写）过滤待绑定身份，返回总数和前 limit 行。
 * 使用场景：admin_legacy 命令逐行输出；领地界面的管理员页列出待绑定身份。
 */
export function legacyOverview(filter = "", limit = 20): { total: number; rows: LegacyRow[] } {
  const needle = filter.toLowerCase();
  const matched = legacyIdentities().filter(
    (item) => !needle || item.playerId.toLowerCase().includes(needle) || item.playerName.toLowerCase().includes(needle),
  );
  const lands = [...world().lands.values()];
  const rows = matched.slice(0, limit).map((item) => ({
    playerId: item.playerId,
    playerName: item.playerName,
    lands: lands.filter((land) => land.ownerId === item.playerId).length,
  }));
  return { total: matched.length, rows };
}

/**
 * 玩家进入时尝试自动绑定。只有名字唯一匹配一个占位身份时才执行，避免同名旧账号被错误合并。
 * 使用场景：playerSpawn（initialSpawn）回调。返回受影响的领地数量，0 表示没有可绑定的占位。
 */
export async function bindLegacyOnJoin(player: { id: string; name: string }): Promise<number> {
  if (isLegacyId(player.id)) return 0;
  const key = nameKey(player.name);
  const matches = legacyIdentities().filter((item) => nameKey(item.playerName) === key);
  if (matches.length === 0) return 0;
  if (matches.length > 1) {
    debug.w("Land", `玩家 ${player.name} 同名匹配到 ${matches.length} 个旧服身份，需管理员手动绑定`);
    return 0;
  }
  return bindLegacy(matches[0]!.playerId, player, player.id);
}

/**
 * 把一个占位身份名下的领主身份、成员关系和区域授权全部转给真实玩家，并删除占位身份记录。
 * 使用场景：自动绑定与管理员手动绑定。返回受影响的领地数量。
 */
export function bindLegacy(legacyId: string, target: { id: string; name: string }, actorId: string): Promise<number> {
  return withTerritoryLock(() => bindLegacyLocked(legacyId, target, actorId));
}

async function bindLegacyLocked(legacyId: string, target: { id: string; name: string }, actorId: string): Promise<number> {
  const index = world();
  if (!isLegacyId(legacyId)) throw new LandError("player_not_found", { name: legacyId });
  if (isLegacyId(target.id)) throw new LandError("player_not_found", { name: target.name });
  const now = Date.now();
  const owned = [...index.lands.values()].filter((land) => land.ownerId === legacyId);
  const ownedIds = new Set(owned.map((land) => land.id));
  const movedMembers: MemberState[] = [];
  const droppedMembers: MemberState[] = [];
  for (const member of index.members.values()) {
    if (member.playerId !== legacyId) continue;
    const ownerAfter = ownedIds.has(member.landId) ? target.id : index.lands.get(member.landId)?.ownerId;
    // 真实玩家已是领主或已有成员关系时保留现状，丢弃占位关系，避免成员唯一键冲突
    if (ownerAfter === target.id || index.member(member.landId, target.id)) droppedMembers.push(member);
    else movedMembers.push({ ...member, playerId: target.id, playerName: target.name, updatedAt: now });
  }
  const movedRoles: AreaRoleState[] = [];
  const droppedRoles: AreaRoleState[] = [];
  for (const role of index.areaRoles.values()) {
    if (role.playerId !== legacyId) continue;
    if (index.areaRoles.has(`${role.areaId}|${target.id}`)) droppedRoles.push(role);
    else movedRoles.push({ ...role, playerId: target.id });
  }
  const nextLands: LandState[] = owned.map((land) => ({ ...land, ownerId: target.id, ownerName: target.name, updatedAt: now }));
  await landTx(async (tx) => {
    for (const land of nextLands) await patchLand(land.id, { ownerId: land.ownerId, ownerName: land.ownerName, updatedAt: now }, tx);
    for (const member of droppedMembers) await hardDelete(TABLES.member, member.id, tx);
    for (const member of movedMembers) await updateMember(member, tx);
    for (const role of droppedRoles) await hardDelete(TABLES.areaRole, role.id, tx);
    for (const role of movedRoles) await rebindAreaRole(role, tx);
    await hardDelete(TABLES.identity, legacyId, tx);
  });
  for (const land of nextLands) index.upsertLand(land);
  for (const member of [...droppedMembers, ...movedMembers]) index.removeMember(member.landId, legacyId);
  for (const member of movedMembers) index.upsertMember(member);
  for (const role of [...droppedRoles, ...movedRoles]) index.removeAreaRole(role.areaId, legacyId, role.landId);
  for (const role of movedRoles) index.upsertAreaRole(role);
  index.forgetIdentity(legacyId);
  const affected = new Set<string>([
    ...ownedIds,
    ...droppedMembers.map((item) => item.landId),
    ...movedMembers.map((item) => item.landId),
    ...droppedRoles.map((item) => item.landId),
    ...movedRoles.map((item) => item.landId),
  ]);
  for (const landId of affected) {
    await afterEvent("land.permission.changed", { actorId, landId, playerId: target.id, legacyId, op: "legacy_bound" });
  }
  debug.i("Land", `旧服身份 ${legacyId} 已绑定到 ${target.name}(${target.id})，涉及 ${affected.size} 块领地`);
  return affected.size;
}

/**
 * 按占位 ID、XUID 或旧服名字查找占位身份。
 * 使用场景：admin_legacy_bind 命令的第一个参数。
 */
export function findLegacy(token: string): { playerId: string; playerName: string } {
  const all = legacyIdentities();
  const id = isLegacyId(token) ? token : `${LEGACY_PREFIX}${token}`;
  const byId = all.find((item) => item.playerId === id);
  if (byId) return byId;
  const key = nameKey(token);
  const byName = all.filter((item) => nameKey(item.playerName) === key);
  if (byName.length === 1) return byName[0]!;
  throw new LandError("player_not_found", { name: token });
}
