/**
 * 进出提示、边界粒子和周期结算。
 * 都按玩家或到期时间推进，不会每个 tick 扫描全部区域。
 */

import type { Player } from "@minecraft/server";
import { system, world } from "@minecraft/server";
import type { WorldIndex } from "../cache/world-index.js";
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
  presenceNotices,
  type PresenceNotice,
  type PresenceScope,
  type PresenceEvent,
} from "./presence.js";
import { borderShape } from "./border-shape.js";

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
    for (const notice of presenceNotices(previous, { landId, areaId })) {
      sendNotice(player, index, notice);
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

/**
 * 渲染一条进出提示。
 * 开关：enter_message / leave_message 按 resolveFlag 解析（子区域值优先，其次领地值）。
 * 文案：只读该范围自己的 enter_text / leave_text——领地提示读领地值，子区域提示读子区域值，
 * 互不继承；为空时使用全局文案。自定义文案支持 {land} {area} {owner} 占位符。
 * 范围已被删除（索引中找不到）时不提示。
 * 使用场景：scanPlayers 对 presenceNotices 的每条结果调用。
 */
function sendNotice(player: Player, index: WorldIndex, notice: PresenceNotice): void {
  const land = index.lands.get(notice.scope.landId);
  if (!land) return;
  const area = notice.scope.areaId ? index.areas.get(notice.scope.areaId) : undefined;
  const forArea = notice.kind === "left_area" || notice.kind === "entered_area";
  if (forArea && !area) return;
  const entering = notice.kind === "entered" || notice.kind === "entered_area";
  if (resolveFlag(index, land, area, entering ? "enter_message" : "leave_message") === false) return;
  const vars = { land: land.name, area: area?.name ?? "", owner: land.ownerName };
  const tone = notice.kind === "entered" ? "info" : "tips";
  const custom = index.flag(forArea && area ? area.id : land.id, entering ? "enter_text" : "leave_text");
  if (typeof custom === "string" && custom) {
    Msg[tone](
      custom
        .replaceAll("{land}", vars.land)
        .replaceAll("{area}", vars.area)
        .replaceAll("{owner}", vars.owner),
      player,
    );
    return;
  }
  say(player, notice.kind, vars, tone);
}

/** 已告警过的边界粒子 ID：同一粒子生成失败只记一次日志，避免每轮刷屏。 */
const warnedParticles = new Set<string>();

/**
 * 按配置为开启了 border 的玩家绘制附近领地外轮廓：
 * 轮廓边按 borderStepBlocks 间距、在 borderHeights 各高度层画粒子线，拐角画竖直粒子柱；
 * 目标领地用 borderParticle，其他领地用 borderOtherParticle（为空则不画）。
 * 粒子只发给该玩家本人，每轮受 borderMaxParticles 限制，目标领地优先。
 */
function drawBorders(): void {
  const index = worldOrUndefined();
  if (!index?.ready || borders.size === 0) return;
  const config = landConfig();
  const radius = config.borderRadiusChunks;
  for (const player of world.getAllPlayers()) {
    const session = borders.get(player.id);
    if (!session) continue;
    const origin = chunkOf(
      player.dimension.id,
      player.location.x,
      player.location.z,
    );
    const shape = borderShape(
      (chunkX, chunkZ) =>
        index.claims.get(claimKey(origin.dimensionId, chunkX, chunkZ)),
      origin,
      radius,
      session.landId,
      config.borderOtherParticle.length > 0,
    );
    const feet = player.location.y;
    let budget = config.borderMaxParticles;
    /** 生成一个粒子；预算用尽或生成失败返回 false，调用方据此结束本轮。 */
    const emit = (own: boolean, x: number, y: number, z: number): boolean => {
      if (budget <= 0) return false;
      budget -= 1;
      const particle = own ? config.borderParticle : config.borderOtherParticle;
      try {
        player.spawnParticle(particle, { x, y, z });
        return true;
      } catch (error) {
        if (!warnedParticles.has(particle)) {
          warnedParticles.add(particle);
          debug.w(
            "Land",
            `边界粒子 ${particle} 生成失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return false;
      }
    };
    const drawEdges = (own: boolean): boolean => {
      for (const edge of shape.edges) {
        if (edge.own !== own) continue;
        const length = Math.hypot(edge.x2 - edge.x1, edge.z2 - edge.z1);
        const steps = Math.max(1, Math.round(length / config.borderStepBlocks));
        for (let i = 0; i <= steps; i += 1) {
          const x = edge.x1 + ((edge.x2 - edge.x1) * i) / steps;
          const z = edge.z1 + ((edge.z2 - edge.z1) * i) / steps;
          for (const height of config.borderHeights) {
            if (!emit(own, x, feet + height, z)) return false;
          }
        }
      }
      return true;
    };
    const drawPosts = (own: boolean): boolean => {
      if (config.borderPostHeight <= 0) return true;
      for (const corner of shape.corners) {
        if (corner.own !== own) continue;
        for (let h = 0; h <= config.borderPostHeight; h += config.borderPostStep) {
          if (!emit(own, corner.x, feet + h, corner.z)) return false;
        }
      }
      return true;
    };
    // 目标领地先画，预算不足时优先保证它完整
    if (!drawEdges(true) || !drawPosts(true)) continue;
    if (!drawEdges(false)) continue;
    drawPosts(false);
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
