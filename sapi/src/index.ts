/** land — SFMC 领地租赁模块。 */
import { system, type Player } from "@minecraft/server";
import { ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { Command, Msg, Permission, debug } from "@sfmc-bds/sdk/sapi/runtime";
import { bindLandClients, getLandService } from "./clients.js";
import { mergeLandConfig, type LandConfig } from "./config.js";
import { clearAllShapes } from "./debug-draw.js";
import {
  clearLandSelections,
  registerLandSelectionEvents,
} from "./selection.js";
import { runLeaseScan } from "./lease-scanner.js";
import { recoverLandOperations, serializeLandMutation } from "./mutations.js";
import {
  bindLandConfig,
  handleAuditLog,
  handleById,
  handleByPos,
  handleCreateLease,
  handleExpandLease,
  handleLeaseStatus,
  handleListByOwner,
  handleRenewLease,
  handleTerminateLease,
  handleValidateBox,
} from "./services.js";
import { defineLandTables } from "./store.js";
import {
  bindLandUiConfig,
  clearLandUiState,
  landUiServices,
} from "./ui-services.js";
import { openLandUi, registerLandUi, unregisterLandUi } from "./ui.js";

const MODULE_ID = "land";
const unprovide: Array<() => void> = [],
  eventCleanups: Array<() => void> = [];
let landConfig: LandConfig = mergeLandConfig();
let scanRunId: number | undefined;
const getConfig = () => landConfig;
Command.register(
  "land",
  "land.use",
  (player?: Player) => {
    if (!player) {
      debug.i("Land", "该指令须由玩家执行");
      return;
    }
    void openLandUi(player).catch((error) => {
      debug.w("Land", String(error));
      Msg.error("打开领地界面失败，请稍后重试", player);
    });
  },
  "打开领地租赁管理",
  MODULE_ID,
);
ModuleRegistry.register({
  id: MODULE_ID,
  afterWorldLoad: true,
  lifecycle: {
    registerPermissions() {
      Permission.register("land.use", Permission.Any);
    },
    registerEvents(clients) {
      bindLandClients(clients);
      registerLandSelectionEvents(eventCleanups);
    },
    async init(clients) {
      bindLandClients(clients);
      const raw = await (clients?.config ?? config).getAll<
        Record<string, unknown>
      >();
      landConfig = mergeLandConfig(raw as Partial<LandConfig>);
      bindLandConfig(getConfig);
      bindLandUiConfig(getConfig);
      await defineLandTables();
      await serializeLandMutation(recoverLandOperations);
      await runLeaseScan(getConfig());
      const handlers = {
        "land.byId": handleById,
        "land.byPos": handleByPos,
        "land.listByOwner": handleListByOwner,
        "land.validateBox": handleValidateBox,
        "land.createLease": handleCreateLease,
        "land.renewLease": handleRenewLease,
        "land.expandLease": handleExpandLease,
        "land.terminateLease": handleTerminateLease,
        "land.leaseStatus": handleLeaseStatus,
        "land.auditLog": handleAuditLog,
        ...landUiServices,
      };
      for (const [name, handler] of Object.entries(handlers))
        unprovide.push(getLandService().provide(name, handler));
      registerLandUi();
      scanRunId = system.runInterval(() => {
        void serializeLandMutation(recoverLandOperations)
          .then(() => runLeaseScan(getConfig()))
          .catch((error) => debug.w("LandScan", String(error)));
      }, 6000);
      debug.i("Land", "领地租赁初始化完成");
    },
    cleanup() {
      unregisterLandUi();
      for (const off of unprovide.splice(0)) off();
      for (const off of eventCleanups.splice(0)) off();
      if (scanRunId !== undefined) system.clearRun(scanRunId);
      scanRunId = undefined;
      clearAllShapes();
      clearLandSelections();
      clearLandUiState();
    },
  },
});
