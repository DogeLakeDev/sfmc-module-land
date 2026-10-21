/**
 * 进出提示、边界粒子和周期结算。
 * 都按玩家或到期时间推进，不会每个 tick 扫描全部区域。
 */

import { system, world } from "@minecraft/server";
import { claimKey, chunkOf } from "../domain/geometry.js";
import { debug, Msg } from "@sfmc-bds/sdk/sapi/runtime";
import { say } from "../messages/speak.js";
import { afterEvent } from "../services/hooks.js";
import { resolveFlag } from "../services/permission.js";
import { settleTax, settleUpkeep } from "../services/finance.js";
import { expireLeases } from "../services/market.js";
import { landConfig, worldOrUndefined } from "../services/shared.js";
import { listTransactions } from "../store/repo.js";
import { recoverTransactions } from "../economy/ledger.js";
import {
  presenceEvents,
  type PresenceScope,
  type PresenceEvent,
} from "./presence.js";

interface Presence extends PresenceScope {
  outside?: { dimensionId: string; x: number; y: number; z: number };
}

interface BorderSession {
  landId?: string;
  areaId?: string;
}

const presence = new Map<string, Presence>();
const borders = new Map<string, BorderSession>();
const notifications = new Map<string, Promise<void>>();
let scheduling = false;

/** 同一玩家的通知按观测顺序发送，异步订阅不会让进入事件越过之前的离开事件。 */
function notifyPresence(playerId: string, events: PresenceEvent[]): void {
  if (events.length === 0) return;
  const pending = (notifications.get(playerId) ?? Promise.resolve())
    .then(async () => {
      for (const item of events) await afterEvent(item.event, item.payload);
    })
    .catch((error: unknown) => {
      debug.w(
        "Land",
        `进出通知失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  notifications.set(playerId, pending);
  void pending.then(() => {
    if (notifications.get(playerId) === pending) notifications.delete(playerId);
  });
}

/** 让一名玩家开始看到领地边界。 */
export function showBorder(
  playerId: string,
  landId?: string,
  areaId?: string,
): void {
  borders.set(playerId, {
    ...(landId ? { landId } : {}),
    ...(areaId ? { areaId } : {}),
  });
}

/** 关闭边界显示。 */
export function hideBorder(playerId: string): void {
  borders.delete(playerId);
}

/** 启动三个低频循环，并返回清理函数。 */
export function startLoops(): () => void {
  const config = () => landConfig();
  const scan = system.runInterval(
    () => scanPlayers(),
    Math.max(5, config().scanIntervalTicks),
  );
  const border = system.runInterval(
    () => drawBorders(),
    Math.max(10, config().borderIntervalTicks),
  );
  const schedule = system.runInterval(
    () => void runSchedule(),
    Math.max(200, config().schedulerIntervalTicks),
  );
  return () => {
    system.clearRun(scan);
    system.clearRun(border);
    system.clearRun(schedule);
    presence.clear();
    borders.clear();
  };
}

function scanPlayers(): void {
  const index = worldOrUndefined();
  if (!index?.ready) return;
  const online = new Set<string>();
  for (const player of world.getAllPlayers()) {
    online.add(player.id);
    let located = index.locate(
      player.dimension.id,
      player.location.x,
      player.location.y,
      player.location.z,
    );
    const previous = presence.get(player.id);
    if (
      located &&
      index.member(located.land.id, player.id)?.relation === "banned" &&
      landConfig().banEject &&
      previous?.outside
    ) {
      const spot = previous.outside;
      try {
        player.teleport(spot, {
          dimension: world.getDimension(spot.dimensionId),
          checkForBlocks: false,
        });
        say(player, "ejected", {}, "warning");
        located = index.locate(
          player.dimension.id,
          player.location.x,
          player.location.y,
          player.location.z,
        );
      } catch {
        say(player, "denied_action", {}, "error");
      }
    }
    const landId = located?.land.id ?? "";
    const areaId = located?.specific ? located.area.id : "";
    notifyPresence(
      player.id,
      presenceEvents(player.id, previous, { landId, areaId }),
    );
    if (previous?.landId && previous.landId !== landId) {
      const previousLand = index.lands.get(previous.landId);
      if (
        previousLand &&
        resolveFlag(
          index,
          previousLand,
          index.areas.get(previous.areaId),
          "leave_message",
        ) !== false
      ) {
        say(player, "left", { land: previousLand.name }, "tips");
      }
    }
    if (located && previous?.landId !== landId) {
      if (
        resolveFlag(index, located.land, located.area, "enter_message") !==
        false
      ) {
        const text = resolveFlag(
          index,
          located.land,
          located.area,
          "enter_text",
        );
        if (typeof text === "string" && text)
          Msg.info(
            text
              .replaceAll("{land}", located.land.name)
              .replaceAll("{owner}", located.land.ownerName),
            player,
          );
        else
          say(
            player,
            "entered",
            { land: located.land.name, owner: located.land.ownerName },
            "info",
          );
      }
    } else if (located && previous?.areaId !== areaId && located.specific) {
      say(
        player,
        "entered_area",
        { land: located.land.name, area: located.area.name },
        "tips",
      );
    }
    if (located) {
      presence.set(player.id, {
        landId,
        areaId,
        ...(previous?.outside ? { outside: previous.outside } : {}),
      });
    } else {
      presence.set(player.id, {
        landId: "",
        areaId: "",
        outside: {
          dimensionId: player.dimension.id,
          x: player.location.x,
          y: player.location.y,
          z: player.location.z,
        },
      });
    }
  }
  for (const [id, previous] of presence) {
    if (online.has(id)) continue;
    notifyPresence(id, presenceEvents(id, previous, undefined, "offline"));
    presence.delete(id);
    borders.delete(id);
  }
  for (const id of borders.keys()) if (!online.has(id)) borders.delete(id);
}

function drawBorders(): void {
  const index = worldOrUndefined();
  if (!index?.ready || borders.size === 0) return;
  const radius = landConfig().borderRadiusChunks;
  for (const player of world.getAllPlayers()) {
    const session = borders.get(player.id);
    if (!session) continue;
    const origin = chunkOf(
      player.dimension.id,
      player.location.x,
      player.location.z,
    );
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const key = claimKey(
          origin.dimensionId,
          origin.chunkX + dx,
          origin.chunkZ + dz,
        );
        const landId = index.claims.get(key);
        if (!landId) continue;
        if (session.landId && landId !== session.landId) continue;
        const x = (origin.chunkX + dx) * 16;
        const z = (origin.chunkZ + dz) * 16;
        const y = player.location.y + 0.2;
        try {
          player.spawnParticle("minecraft:villager_happy", { x, y, z });
          player.spawnParticle("minecraft:villager_happy", {
            x: x + 15,
            y,
            z: z + 15,
          });
        } catch {
          /* 粒子标识在当前版本不可用时保持安静 */
        }
      }
    }
  }
}

async function runSchedule(): Promise<void> {
  const index = worldOrUndefined();
  if (!index?.ready || scheduling) return;
  scheduling = true;
  try {
    const now = Date.now();
    for (const land of index.lands.values()) {
      if (land.nextUpkeepAt <= now || land.status !== "active")
        await settleUpkeep(land);
      if (land.taxEnabled && land.nextTaxAt <= now) await settleTax(land);
    }
    await expireLeases(now);
    await recoverTransactions(await listTransactions());
  } catch (error) {
    debug.w(
      "Land",
      `周期结算失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    scheduling = false;
  }
}
