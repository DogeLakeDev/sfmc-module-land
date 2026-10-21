/**
 * 领域服务共用的运行时入口。
 * 索引、配置和权限探测由模块初始化注入，避免服务之间互相抓取全局玩家对象。
 */

import type { Player } from "@minecraft/server";
import type { WorldIndex } from "../cache/world-index.js";
import type { LandConfig } from "../config.js";
import { levelRuleOf } from "../config.js";
import { LandError } from "../domain/errors.js";
import { makeId, nameKey } from "../domain/ids.js";
import type { Actor, AreaState, LandState, RoleState } from "../domain/model.js";
import { presetRoles } from "../domain/permissions.js";
import { saveIdentity } from "../store/repo.js";

let worldIndex: WorldIndex | undefined;
let currentConfig: LandConfig | undefined;
let permissionHolds: (actor: Actor, permission: string) => boolean = () => false;

/** 模块 init 时绑定。清理时清空，防止热重载后保护层读到旧索引。 */
export function bindShared(
  index: WorldIndex,
  config: LandConfig,
  holds: (actor: Actor, permission: string) => boolean,
): void {
  worldIndex = index;
  currentConfig = config;
  permissionHolds = holds;
}

/** 当前世界索引。未初始化时拒绝业务操作。 */
export function world(): WorldIndex {
  if (!worldIndex?.ready) throw new LandError("not_ready");
  return worldIndex;
}

/** 启动加载过程中的索引。保护层用它判断是否已经可以放行荒野。 */
export function worldOrUndefined(): WorldIndex | undefined {
  return worldIndex;
}

/** 当前配置。 */
export function landConfig(): LandConfig {
  if (!currentConfig) throw new LandError("not_ready");
  return currentConfig;
}

/** 替换配置。配置监听和初始化都走这里。 */
export function replaceConfig(config: LandConfig): void {
  currentConfig = config;
}

/** 判断操作者是否命中某个命名权限。配额组用它提高上限。 */
export function holds(actor: Actor, permission: string): boolean {
  return permissionHolds(actor, permission);
}

/** 按名称或 ID 取领地。 */
export function requireLand(token: string): LandState {
  const index = world();
  const land = index.lands.get(token) ?? index.landByName(token);
  if (!land) throw new LandError("land_not_found", { name: token });
  return land;
}

/** 按名称或 ID 取子区域。 */
export function requireArea(land: LandState, token: string): AreaState {
  const area = world().areaByName(land.id, token);
  if (!area) throw new LandError("area_not_found", { name: token });
  return area;
}

/** 按名称或 ID 取角色。 */
export function requireRole(land: LandState, token: string): RoleState {
  const role = world().roleByName(land.id, token);
  if (!role) throw new LandError("role_not_found", { name: token });
  return role;
}

/** 领地银行账户。 */
export function bankOf(land: LandState): string {
  return land.bankAccount;
}

/** 当前等级的单区块价格。结果是整数，经济接口不接受小数金额。 */
export function chunkPrice(config: LandConfig, land: LandState): number {
  const rule = levelRuleOf(config, land.level);
  return Math.max(0, Math.round(config.claimPrice * rule.claimPriceMultiplier));
}

/** 为新领地生成预置角色。权限来自模板数据，后续判断只看角色上的权限集合。 */
export function presetRoleStates(landId: string, now: number): RoleState[] {
  return presetRoles().map((preset) => ({
    id: makeId("r"),
    landId,
    name: preset.name,
    nameKey: nameKey(preset.name),
    description: preset.description,
    permissions: [...preset.permissions],
    reserved: preset.reserved,
    preset: preset.key,
    createdAt: now,
    updatedAt: now,
  }));
}

/** 按稳定模板键查找预置角色。显示名被改掉后仍然有效。 */
export function roleByPreset(roles: RoleState[], presetKey: string): RoleState {
  const found = roles.find((role) => role.preset === presetKey);
  if (!found) throw new LandError("role_not_found", { name: presetKey });
  return found;
}

/** 记录玩家显示名，供离线邀请时把名字解析回稳定 ID。 */
export async function rememberPlayer(player: Player): Promise<void> {
  await saveIdentity(player.id, player.name, nameKey(player.name));
  worldOrUndefined()?.rememberIdentity(player.id, player.name);
}

/** 在线玩家优先，否则使用已经记录的 ID 或名字。 */
export function resolvePlayer(token: string, online: Player[]): { id: string; name: string } {
  const exact = online.find((player) => player.id === token || player.name === token);
  if (exact) return { id: exact.id, name: exact.name };
  const lower = token.toLowerCase();
  const matches = online.filter((player) => player.name.toLowerCase() === lower);
  if (matches.length === 1) return { id: matches[0]!.id, name: matches[0]!.name };
  const known = world().identityByToken(token);
  if (known) return { id: known.playerId, name: known.playerName };
  throw new LandError("player_not_found", { name: token });
}
