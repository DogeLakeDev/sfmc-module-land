/**
 * 领地界面的声明式 UI 注册与打开入口。
 * 页面 JSON 位于 sapi/src/ui（UI Studio 工程根），在 Studio 中编辑后由这里随模块一起注册。
 * 使用场景：模块 init 注册 feature；/c:land 不带子命令时打开首页。
 */

import type { Player } from "@minecraft/server";
import { debug } from "@sfmc-bds/sdk/sapi/runtime";
import { ui } from "@sfmc-bds/sdk/sapi/ui";
import featureUi from "./ui/feature.ui.json" with { type: "json" };
import adminUi from "./ui/screens/admin.ui.json" with { type: "json" };
import areaUi from "./ui/screens/area.ui.json" with { type: "json" };
import areasUi from "./ui/screens/areas.ui.json" with { type: "json" };
import chunksUi from "./ui/screens/chunks.ui.json" with { type: "json" };
import createUi from "./ui/screens/create.ui.json" with { type: "json" };
import detailUi from "./ui/screens/detail.ui.json" with { type: "json" };
import financeUi from "./ui/screens/finance.ui.json" with { type: "json" };
import flagsUi from "./ui/screens/flags.ui.json" with { type: "json" };
import homeUi from "./ui/screens/home.ui.json" with { type: "json" };
import mapUi from "./ui/screens/map.ui.json" with { type: "json" };
import marketUi from "./ui/screens/market.ui.json" with { type: "json" };
import membersUi from "./ui/screens/members.ui.json" with { type: "json" };
import roleUi from "./ui/screens/role.ui.json" with { type: "json" };
import rolesUi from "./ui/screens/roles.ui.json" with { type: "json" };
import settingsUi from "./ui/screens/settings.ui.json" with { type: "json" };

/** 界面所属模块 ID，与 feature.ui.json 的 moduleId 一致。 */
const UI_MODULE_ID = "land";

/** 首页页面 ID。 */
export const LAND_HOME_SCREEN = "land.home";

/**
 * 注册领地界面，返回注销函数（并入模块 cleanups）。
 * 键为 feature.ui.json 中声明的 file 路径；新增页面时同时在 Studio 的 feature 与这里登记。
 */
export function registerLandUi(): () => void {
  return ui.registerFeature({
    feature: featureUi,
    screens: {
      "screens/home.ui.json": homeUi,
      "screens/create.ui.json": createUi,
      "screens/detail.ui.json": detailUi,
      "screens/settings.ui.json": settingsUi,
      "screens/chunks.ui.json": chunksUi,
      "screens/map.ui.json": mapUi,
      "screens/members.ui.json": membersUi,
      "screens/roles.ui.json": rolesUi,
      "screens/role.ui.json": roleUi,
      "screens/areas.ui.json": areasUi,
      "screens/area.ui.json": areaUi,
      "screens/flags.ui.json": flagsUi,
      "screens/finance.ui.json": financeUi,
      "screens/market.ui.json": marketUi,
      "screens/admin.ui.json": adminUi,
    },
  });
}

/** 为玩家打开领地首页；打开失败只记日志，不影响命令系统。 */
export function openLandUi(player: Player): void {
  void ui.openScreen(player, { moduleId: UI_MODULE_ID, screenId: LAND_HOME_SCREEN }).catch((error: unknown) => {
    debug.w("Land", `打开领地界面失败: ${error instanceof Error ? error.message : String(error)}`);
  });
}
