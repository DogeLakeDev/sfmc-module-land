/**
 * 领地界面（声明式 UI）使用的窄服务层。
 * 使用场景：sapi/src/ui/screens 下的页面通过 land.ui.* 读取视图数据，并通过 land.ui.exec 执行写操作。
 * 写操作一律复用命令路由 execLandCommand，校验、权限与提示与 /c:land 子命令完全一致；
 * 命令原本发到聊天栏的提示在执行期间被捕获，作为 result.message 回到表单状态行。
 */

import type { Player } from "@minecraft/server";
import { world } from "@minecraft/server";
import { service } from "@sfmc-bds/sdk/sapi/service";
import { landServiceError } from "./api.js";
import { actorOf, execLandCommand, nearbyMapLines, selectionOf, words } from "./commands/router.js";
import { LandError } from "./domain/errors.js";
import { captureSays, phrase } from "./messages/speak.js";
import { bankBalance, upkeepAmount } from "./services/finance.js";
import { legacyOverview } from "./services/legacy.js";
import { holds, landConfig, requireLand, world as landWorld } from "./services/shared.js";
import {
  adminView,
  areasView,
  areaView,
  chunksView,
  detailView,
  financeView,
  flagsView,
  homeView,
  landCaps,
  marketView,
  membersView,
  roleView,
  rolesView,
  type ViewContext,
  type ViewPosition,
} from "./services/ui-views.js";

/** 页面传来的服务入参。 */
type UiInput = Record<string, unknown>;

/** 单个界面服务：已解析出在线玩家后执行。 */
type UiHandler = (player: Player, input: UiInput) => unknown;

/** 读取字符串入参；缺失或非字符串时按空串处理。 */
function text(input: UiInput, key: string): string {
  const value = input[key];
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/** 入参里的 playerId 必须是在线玩家；界面只会替打开它的玩家本人操作。 */
function onlinePlayer(input: UiInput): Player {
  const playerId = text(input, "playerId");
  const player = world.getAllPlayers().find((candidate) => candidate.id === playerId);
  if (!player) throw new LandError("ui_offline");
  return player;
}

/** 为某个玩家构造视图上下文（索引、操作者、语言、配置、配额权限）。 */
function contextOf(player: Player): ViewContext {
  const actor = actorOf(player);
  return {
    index: landWorld(),
    actor,
    label: (key, vars) => phrase(player, key, vars),
    config: landConfig(),
    holds: (permission) => holds(actor, permission),
    now: Date.now(),
  };
}

/** 玩家当前所在位置。 */
function positionOf(player: Player): ViewPosition {
  return { dimensionId: player.dimension.id, x: player.location.x, y: player.location.y, z: player.location.z };
}

/** 除自己以外的在线玩家，按名字排序；用于邀请、封禁与区域授权的下拉框。 */
function othersOnline(player: Player): Array<{ id: string; name: string }> {
  return world
    .getAllPlayers()
    .filter((candidate) => candidate.id !== player.id)
    .map((candidate) => ({ id: candidate.id, name: candidate.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 执行一条领地子命令并返回命令原有的提示文本。
 * 入参：command 子命令名；args 参数数组（空值会被忽略，因此可选参数可直接留空）；
 * 开关型命令可改传 toggle {on, off} 与布尔 value，按 value 选择子命令（如角色权限的授予 / 撤销）。
 */
async function exec(player: Player, input: UiInput): Promise<{ message: string }> {
  const toggle = input.toggle && typeof input.toggle === "object" ? (input.toggle as UiInput) : undefined;
  const command = toggle ? text(toggle, input.value === true ? "on" : "off") : text(input, "command");
  if (!command) throw new LandError("unknown_command");
  const args = words(Array.isArray(input.args) ? input.args : []);
  const { lines } = await captureSays(player.id, () => execLandCommand(player, command, args));
  return { message: lines.length > 0 ? lines.map((line) => line.text).join("\n") : phrase(player, "ui_done") };
}

/** 资金页：无权查看银行或经济服务不可用时余额显示为不可见，其余信息照常展示。 */
async function finance(player: Player, input: UiInput) {
  const ctx = contextOf(player);
  const land = requireLand(text(input, "landId"));
  const balance = landCaps(ctx, land).bankView ? await bankBalance(ctx.actor, land.id).catch(() => null) : null;
  return financeView(ctx, land.id, balance, upkeepAmount(land));
}

/**
 * 全部界面服务。名称需与 manifest.json 的 services.provides 和页面 JSON 中的 service 一致。
 * 使用场景：provideLandUi 统一注册；新增页面数据源时在此追加一项即可。
 */
const UI_HANDLERS: Record<string, UiHandler> = {
  "land.ui.exec": exec,
  "land.ui.home": (player) => homeView(contextOf(player), positionOf(player)),
  "land.ui.detail": (player, input) => detailView(contextOf(player), text(input, "landId")),
  "land.ui.chunks": (player) => chunksView(contextOf(player), positionOf(player), selectionOf(player.id)),
  "land.ui.map": (player) => ({ text: nearbyMapLines(player).join("\n") }),
  "land.ui.members": (player, input) => membersView(contextOf(player), text(input, "landId"), othersOnline(player)),
  "land.ui.roles": (player, input) => rolesView(contextOf(player), text(input, "landId")),
  "land.ui.role": (player, input) => roleView(contextOf(player), text(input, "landId"), text(input, "roleId")),
  "land.ui.areas": (player, input) => areasView(contextOf(player), text(input, "landId"), selectionOf(player.id)),
  "land.ui.area": (player, input) =>
    areaView(contextOf(player), text(input, "landId"), text(input, "areaId"), othersOnline(player), selectionOf(player.id)),
  "land.ui.flags": (player, input) => flagsView(contextOf(player), text(input, "landId"), text(input, "areaId")),
  "land.ui.finance": finance,
  "land.ui.market": (player) => marketView(contextOf(player)),
  "land.ui.admin": (player, input) => adminView(contextOf(player), legacyOverview(text(input, "filter"))),
};

/** 界面服务名列表，供测试核对 manifest 与页面引用。 */
export const LAND_UI_SERVICES = Object.keys(UI_HANDLERS);

/** 解析玩家并执行处理函数；领域错误按该玩家的语言渲染成服务错误，表单 onError 以 result.message 展示。 */
async function guarded(handler: UiHandler, raw: unknown): Promise<unknown> {
  const input = raw && typeof raw === "object" ? (raw as UiInput) : {};
  let player: Player | undefined;
  try {
    player = onlinePlayer(input);
    return await handler(player, input);
  } catch (error) {
    throw landServiceError(error, (wrapped) => phrase(player, wrapped.key, wrapped.vars));
  }
}

/**
 * 注册全部界面服务，返回注销函数列表。
 * 使用场景：模块 init 中调用，返回值并入 cleanups，模块卸载时统一注销。
 */
export function provideLandUi(): Array<() => void> {
  return Object.entries(UI_HANDLERS).map(([name, handler]) => service.provide(name, (input) => guarded(handler, input)));
}
