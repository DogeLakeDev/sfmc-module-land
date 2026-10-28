/**
 * 空间与权限内存索引。
 * 破坏、放置和进出检测只读这份索引；变更后由领域服务增量更新，启动时可以整表重建。
 */

import {
  aabbVolume,
  chunksCoveredBy,
  claimKey,
  containsPoint,
  chunkOf,
} from "../domain/geometry.js";
import type {
  AreaRoleState,
  AreaState,
  FlagValue,
  LandState,
  LeaseState,
  ListingState,
  Located,
  MemberState,
  RoleState,
} from "../domain/model.js";
import { nameKey } from "../domain/ids.js";

/** 某个玩家在某个区域上的权限缓存项。领地版本变化后自然失效。 */
export interface PermMemo {
  version: number;
  allow: boolean;
  reason: string;
  roleId: string;
  relation: string;
}

/**
 * 运行中的领地世界索引。
 * 使用场景：高频权限检查、区块归属和附近地图。不作为唯一持久化来源。
 */
export class WorldIndex {
  /** 启动加载完成前，保护逻辑按拒绝处理。 */
  ready = false;
  readonly lands = new Map<string, LandState>();
  readonly claims = new Map<string, string>();
  readonly claimIds = new Map<string, string>();
  readonly areas = new Map<string, AreaState>();
  readonly roles = new Map<string, RoleState>();
  readonly members = new Map<string, MemberState>();
  readonly areaRoles = new Map<string, AreaRoleState>();
  readonly flags = new Map<string, Map<string, FlagValue>>();
  readonly flagIds = new Map<string, string>();
  readonly activeLeases = new Map<string, LeaseState>();
  readonly listings = new Map<string, ListingState>();
  readonly names = new Map<string, string>();
  readonly identities = new Map<
    string,
    { playerId: string; playerName: string }
  >();
  readonly permVersion = new Map<string, number>();
  private readonly areaChunks = new Map<string, string[]>();
  private readonly permMemo = new Map<string, PermMemo>();

  /** 清空后重建。修复命令和启动加载使用。 */
  clear(): void {
    this.lands.clear();
    this.claims.clear();
    this.claimIds.clear();
    this.areas.clear();
    this.roles.clear();
    this.members.clear();
    this.areaRoles.clear();
    this.flags.clear();
    this.flagIds.clear();
    this.activeLeases.clear();
    this.listings.clear();
    this.names.clear();
    this.identities.clear();
    this.permVersion.clear();
    this.areaChunks.clear();
    this.permMemo.clear();
    this.ready = false;
  }

  /** 角色、成员、旗标变化后让该领地的权限缓存失效。 */
  bump(landId: string): void {
    this.permVersion.set(landId, (this.permVersion.get(landId) ?? 0) + 1);
    if (this.permMemo.size > 8000) this.permMemo.clear();
  }

  rememberPerm(key: string, memo: PermMemo): void {
    this.permMemo.set(key, memo);
  }

  recallPerm(key: string): PermMemo | undefined {
    return this.permMemo.get(key);
  }

  upsertLand(land: LandState): void {
    const prev = this.lands.get(land.id);
    if (prev) this.names.delete(prev.nameKey);
    this.lands.set(land.id, land);
    this.names.set(land.nameKey, land.id);
  }

  upsertClaim(key: string, id: string, landId: string): void {
    const previousOwner = this.claims.get(key);
    if (previousOwner && previousOwner !== landId) {
      const previousLand = this.lands.get(previousOwner);
      if (previousLand)
        previousLand.claimKeys = previousLand.claimKeys.filter(
          (item) => item !== key,
        );
    }
    this.claims.set(key, landId);
    this.claimIds.set(key, id);
    const land = this.lands.get(landId);
    if (land && !land.claimKeys.includes(key)) land.claimKeys.push(key);
  }

  removeClaim(key: string): void {
    const landId = this.claims.get(key);
    this.claims.delete(key);
    this.claimIds.delete(key);
    const land = landId ? this.lands.get(landId) : undefined;
    if (land) land.claimKeys = land.claimKeys.filter((item) => item !== key);
  }

  upsertArea(area: AreaState): void {
    const prev = this.areas.get(area.id);
    if (prev?.box && prev.kind === "box") this.unlinkArea(prev);
    this.areas.set(area.id, area);
    if (area.kind === "default") {
      const land = this.lands.get(area.landId);
      if (land) land.defaultAreaId = area.id;
      return;
    }
    if (!area.box) return;
    for (const chunk of chunksCoveredBy(area.dimensionId, area.box)) {
      const key = claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ);
      const list = this.areaChunks.get(key) ?? [];
      if (!list.includes(area.id)) list.push(area.id);
      this.areaChunks.set(key, list);
    }
  }

  private unlinkArea(area: AreaState): void {
    if (!area.box) return;
    for (const chunk of chunksCoveredBy(area.dimensionId, area.box)) {
      const key = claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ);
      const list = (this.areaChunks.get(key) ?? []).filter(
        (id) => id !== area.id,
      );
      if (list.length) this.areaChunks.set(key, list);
      else this.areaChunks.delete(key);
    }
  }

  removeArea(areaId: string): void {
    const area = this.areas.get(areaId);
    if (!area) return;
    if (area.kind === "box") this.unlinkArea(area);
    this.areas.delete(areaId);
  }

  upsertRole(role: RoleState): void {
    this.roles.set(role.id, role);
    this.bump(role.landId);
  }

  removeRole(roleId: string): void {
    const role = this.roles.get(roleId);
    if (!role) return;
    this.roles.delete(roleId);
    this.bump(role.landId);
  }

  memberKey(landId: string, playerId: string): string {
    return `${landId}|${playerId}`;
  }

  upsertMember(member: MemberState): void {
    this.members.set(this.memberKey(member.landId, member.playerId), member);
    this.bump(member.landId);
  }

  removeMember(landId: string, playerId: string): void {
    this.members.delete(this.memberKey(landId, playerId));
    this.bump(landId);
  }

  upsertAreaRole(role: AreaRoleState): void {
    this.areaRoles.set(`${role.areaId}|${role.playerId}`, role);
    this.bump(role.landId);
  }

  removeAreaRole(areaId: string, playerId: string, landId: string): void {
    this.areaRoles.delete(`${areaId}|${playerId}`);
    this.bump(landId);
  }

  setFlag(id: string, scopeId: string, flagId: string, value: FlagValue): void {
    const map = this.flags.get(scopeId) ?? new Map<string, FlagValue>();
    map.set(flagId, value);
    this.flags.set(scopeId, map);
    this.flagIds.set(`${scopeId}|${flagId}`, id);
    const land = this.lands.get(scopeId);
    const area = this.areas.get(scopeId);
    this.bump(land?.id ?? area?.landId ?? scopeId);
  }

  removeFlag(scopeId: string, flagId: string): void {
    this.flags.get(scopeId)?.delete(flagId);
    this.flagIds.delete(`${scopeId}|${flagId}`);
  }

  flag(scopeId: string, flagId: string): FlagValue | undefined {
    return this.flags.get(scopeId)?.get(flagId);
  }

  upsertLease(lease: LeaseState): void {
    if (lease.status === "active") this.activeLeases.set(lease.areaId, lease);
    else if (this.activeLeases.get(lease.areaId)?.id === lease.id)
      this.activeLeases.delete(lease.areaId);
  }

  upsertListing(listing: ListingState): void {
    this.listings.set(listing.id, listing);
  }

  rememberIdentity(playerId: string, playerName: string): void {
    this.identities.set(playerId, { playerId, playerName });
    this.identities.set(nameKey(playerName), { playerId, playerName });
  }

  /**
   * 移除一条身份记录（ID 键，以及仍指向它的名字键）。
   * 使用场景：旧服占位身份绑定到真实玩家后清理索引。
   */
  forgetIdentity(playerId: string): void {
    const item = this.identities.get(playerId);
    this.identities.delete(playerId);
    if (item && this.identities.get(nameKey(item.playerName))?.playerId === playerId) {
      this.identities.delete(nameKey(item.playerName));
    }
  }

  /** 按名称或已记录的玩家 ID 查找玩家。同名时要求在线精确匹配由调用方处理。 */
  identityByToken(
    token: string,
  ): { playerId: string; playerName: string } | undefined {
    return this.identities.get(token) ?? this.identities.get(nameKey(token));
  }

  landByName(rawName: string): LandState | undefined {
    const id = this.names.get(nameKey(rawName));
    return id ? this.lands.get(id) : undefined;
  }

  areasOf(landId: string): AreaState[] {
    return [...this.areas.values()].filter((area) => area.landId === landId);
  }

  rolesOf(landId: string): RoleState[] {
    return [...this.roles.values()].filter((role) => role.landId === landId);
  }

  membersOf(landId: string): MemberState[] {
    return [...this.members.values()].filter(
      (member) => member.landId === landId,
    );
  }

  roleByName(landId: string, rawName: string): RoleState | undefined {
    const key = nameKey(rawName);
    return this.rolesOf(landId).find(
      (role) => role.nameKey === key || role.id === rawName,
    );
  }

  areaByName(landId: string, rawName: string): AreaState | undefined {
    const key = nameKey(rawName);
    return this.areasOf(landId).find(
      (area) => area.nameKey === key || area.id === rawName,
    );
  }

  member(landId: string, playerId: string): MemberState | undefined {
    return this.members.get(this.memberKey(landId, playerId));
  }

  /**
   * 定位方块所在的领地和区域。
   * 先用区块键 O(1) 找到领地，再只检查覆盖该区块的子区域。
   */
  locate(
    dimensionId: string,
    x: number,
    y: number,
    z: number,
  ): Located | undefined {
    const chunk = chunkOf(dimensionId, x, z);
    const key = claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ);
    const landId = this.claims.get(key);
    if (!landId) return undefined;
    const land = this.lands.get(landId);
    if (!land) return undefined;
    const candidates = this.areaChunks.get(key) ?? [];
    let best: AreaState | undefined;
    let bestVolume = Number.POSITIVE_INFINITY;
    for (const areaId of candidates) {
      const area = this.areas.get(areaId);
      if (
        !area?.box ||
        area.dimensionId !== dimensionId ||
        area.landId !== landId
      )
        continue;
      if (!containsPoint(area.box, x, y, z)) continue;
      const volume = aabbVolume(area.box);
      if (volume < bestVolume) {
        best = area;
        bestVolume = volume;
      }
    }
    if (best) return { land, area: best, specific: true };
    return { land, area: this.defaultAreaOf(land), specific: false };
  }

  /**
   * 已占领区块必须落到一块区域上。
   * 默认区域记录缺失时合成一块无边界区域，避免把领地当成荒野放行。
   * 使用场景：locate 的回退；领地界面按默认区域计算玩家对整块领地的管理能力。
   */
  defaultAreaOf(land: LandState): AreaState {
    const stored = this.areas.get(land.defaultAreaId);
    if (stored && stored.landId === land.id) return stored;
    for (const area of this.areasOf(land.id)) {
      if (area.kind === "default") return area;
    }
    return {
      id: land.defaultAreaId || land.id,
      landId: land.id,
      name: "默认",
      nameKey: "默认",
      description: "",
      kind: "default",
      dimensionId: "",
      box: null,
      createdAt: land.createdAt,
      updatedAt: land.updatedAt,
    };
  }

  /** 从索引移除整个领地。数据库删除成功后调用。 */
  dropLand(landId: string): void {
    const land = this.lands.get(landId);
    if (land) this.names.delete(land.nameKey);
    for (const key of land?.claimKeys ?? []) {
      this.claims.delete(key);
      this.claimIds.delete(key);
    }
    for (const area of this.areasOf(landId)) this.removeArea(area.id);
    for (const role of this.rolesOf(landId)) this.roles.delete(role.id);
    for (const member of this.membersOf(landId))
      this.members.delete(this.memberKey(landId, member.playerId));
    for (const [key, role] of this.areaRoles) {
      if (role.landId === landId) this.areaRoles.delete(key);
    }
    this.flags.delete(landId);
    this.lands.delete(landId);
    this.bump(landId);
  }
}
