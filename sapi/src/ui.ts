/** 领地声明式页面的注册与打开入口。 */

import type { Player } from "@minecraft/server";
import { ui } from "@sfmc-bds/sdk/sapi/ui";
import featureUi from "./ui/feature.ui.json" with { type: "json" };
import detailUi from "./ui/screens/detail.ui.json" with { type: "json" };
import homeUi from "./ui/screens/home.ui.json" with { type: "json" };
import leaseUi from "./ui/screens/lease.ui.json" with { type: "json" };
import listUi from "./ui/screens/list.ui.json" with { type: "json" };
import statusUi from "./ui/screens/status.ui.json" with { type: "json" };
import renameUi from "./ui/screens/rename.ui.json" with { type: "json" };

const MODULE_ID = "land";
let unregisterUi: (() => void) | undefined;

export function registerLandUi(): void {
  unregisterLandUi();
  unregisterUi = ui.registerFeature({
    feature: featureUi,
    screens: {
      "screens/home.ui.json": homeUi,
      "screens/list.ui.json": listUi,
      "screens/detail.ui.json": detailUi,
      "screens/lease.ui.json": leaseUi,
      "screens/status.ui.json": statusUi,
      "screens/rename.ui.json": renameUi,
    },
  });
}

export function unregisterLandUi(): void {
  unregisterUi?.();
  unregisterUi = undefined;
}

export function openLandUi(
  player: Player,
  screenId = "land.home",
  params: Record<string, unknown> = {},
): Promise<void> {
  return ui.openScreen(player, {
    moduleId: MODULE_ID,
    screenId,
    params,
  });
}
