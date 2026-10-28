/**
 * @sfmc-bds/module-land — 区块领地、三维子区域、成员角色与领地银行。
 * 玩家通过 /c:land 子命令或界面（/c:land 不带子命令）操作。其他模块通过 land.* 服务读取或注册扩展。
 */

import { world } from "@minecraft/server";
import { ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { Command, Permission, debug } from "@sfmc-bds/sdk/sapi/runtime";
import { provideLandApi, releaseLandApi } from "./api.js";
import "./economy/appliers.js";
import { WorldIndex } from "./cache/world-index.js";
import { LAND_ACTIONS, runLandCommand } from "./commands/router.js";
import { mergeLandConfig, type LandConfig } from "./config.js";
import type { Actor } from "./domain/model.js";
import { rememberLocale, say } from "./messages/speak.js";
import { bindLegacyOnJoin } from "./services/legacy.js";
import { registerProtection } from "./protection/guard.js";
import { startLoops } from "./runtime/loops.js";
import { loadSubscribers } from "./services/hooks.js";
import { loadExtensions } from "./services/registry.js";
import { bindShared, rememberPlayer, replaceConfig } from "./services/shared.js";
import { hydrate } from "./store/hydrate.js";
import { listRegistry } from "./store/repo.js";
import { defineLandTables } from "./store/tables.js";
import { openLandUi, registerLandUi } from "./ui-feature.js";
import { provideLandUi } from "./ui-services.js";

const MODULE_ID = "land";
const index = new WorldIndex();
let landConfig: LandConfig = mergeLandConfig();
const cleanups: Array<() => void> = [];

/** 配额组使用的命名权限。控制台视为命中，离线玩家不提升配额。 */
function holds(actor: Actor, permission: string): boolean {
  if (actor.console) return true;
  const player = world.getAllPlayers().find((item) => item.id === actor.id);
  return player ? Permission.check(player, permission) : false;
}

Command.register(
  "land",
  "land.use",
  (player, action, a, b, c, d, e, f) => {
    // 玩家不带子命令时打开领地界面；控制台仍按原逻辑输出帮助
    if (action === undefined && player) {
      openLandUi(player);
      return;
    }
    void runLandCommand(player, action, a, b, c, d, e, f);
  },
  "领地：占领、成员、银行和保护（不带子命令打开界面）",
  MODULE_ID,
  undefined,
  {
    parameters: [
      { name: "action", type: "enum", values: [...LAND_ACTIONS], optional: true },
      { name: "a", type: "string", optional: true },
      { name: "b", type: "string", optional: true },
      { name: "c", type: "string", optional: true },
      { name: "d", type: "string", optional: true },
      { name: "e", type: "string", optional: true },
      { name: "f", type: "string", optional: true },
    ],
  },
);

ModuleRegistry.register({
  id: MODULE_ID,
  afterWorldLoad: true,
  lifecycle: {
    registerPermissions() {
      Permission.register("land.use", Permission.Any);
      Permission.register("land.admin", Permission.OP);
    },
    registerEvents() {
      registerProtection(cleanups);
      const spawn = world.afterEvents.playerSpawn.subscribe((event) => {
        if (!event.initialSpawn) return;
        const player = event.player;
        const who = { id: player.id, name: player.name };
        void rememberPlayer(player).catch((error: unknown) => {
          debug.w("Land", `记录玩家身份失败: ${error instanceof Error ? error.message : String(error)}`);
        });
        // 旧服（iland）迁移的占位身份按名字自动绑定到真实 player.id
        void bindLegacyOnJoin(who)
          .then((count) => {
            if (count > 0 && player.isValid) say(player, "legacy_bound", { count }, "success");
          })
          .catch((error: unknown) => {
            debug.w("Land", `绑定旧服身份失败: ${error instanceof Error ? error.message : String(error)}`);
          });
      });
      cleanups.push(() => world.afterEvents.playerSpawn.unsubscribe(spawn));
    },
    async init() {
      landConfig = mergeLandConfig(await config.getAll());
      replaceConfig(landConfig);
      bindShared(index, landConfig, holds);
      for (const group of landConfig.quotaGroups) {
        Permission.register(group.permission, group.level ?? Permission.Member);
      }
      await defineLandTables();
      await hydrate(index);
      await loadExtensions();
      await loadSubscribers();
      for (const row of await listRegistry("locale")) {
        try {
          const parsed = JSON.parse(row.payload) as { locale?: string };
          const playerId = row.key.split("|").slice(1).join("|");
          if (parsed.locale === "zh" || parsed.locale === "en") rememberLocale(playerId, parsed.locale);
        } catch {
          debug.w("Land", `忽略损坏的语言设置 ${row.key}`);
        }
      }
      cleanups.push(...provideLandApi());
      cleanups.push(...provideLandUi());
      cleanups.push(registerLandUi());
      cleanups.push(startLoops());
      debug.i("Land", `ready lands=${index.lands.size} claims=${index.claims.size}`);
    },
    cleanup() {
      for (const off of cleanups.splice(0, cleanups.length)) {
        try {
          off();
        } catch {
          /* 清理失败不阻止模块卸载 */
        }
      }
      releaseLandApi();
      index.clear();
    },
  },
});
