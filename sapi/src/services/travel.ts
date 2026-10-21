/**
 * 出生点传送。
 * 和领地数据分开，其他模块可以调用 teleportToLand，而不是复制坐标检查。
 */

import type { Player } from "@minecraft/server";
import { world } from "@minecraft/server";
import { LandError } from "../domain/errors.js";
import type { Actor } from "../domain/model.js";
import { runPaid } from "../economy/ledger.js";
import { decide, resolveFlag } from "./permission.js";
import { landConfig, requireLand, world as worldIndex } from "./shared.js";

const lastTeleport = new Map<string, number>();

/** 传送到领地出生点。费用、冷却和权限都在这里处理。 */
export async function teleportToLand(actor: Actor, player: Player, token: string): Promise<void> {
  const config = landConfig();
  const land = requireLand(token);
  const index = worldIndex();
  const area = index.areas.get(land.defaultAreaId);
  if (!area) throw new LandError("not_ready");
  if (!land.spawn) throw new LandError("spawn_missing");
  const banned = index.member(land.id, actor.id)?.relation === "banned";
  if (banned && !actor.admin) throw new LandError("no_permission", { reason: "banned" });
  const decision = decide(index, actor, "land.teleport", { land, area, specific: false }, false);
  const publicTeleport = resolveFlag(index, land, area, "public_teleport") === true;
  if (!decision.allow && !publicTeleport) throw new LandError("no_permission", { reason: decision.reason });
  const previous = lastTeleport.get(actor.id) ?? 0;
  const remain = config.teleportCooldownMs - (Date.now() - previous);
  if (remain > 0) throw new LandError("teleport_cooldown", { seconds: Math.ceil(remain / 1000) });
  if (config.teleportPrice > 0) {
    await runPaid({
      idempotencyKey: `tp:${land.id}:${actor.id}:${Math.floor(Date.now() / config.teleportCooldownMs)}`,
      kind: "land.teleport",
      landId: land.id,
      actorId: actor.id,
      fromAccount: actor.id,
      toAccount: land.bankAccount,
      amount: config.teleportPrice,
      mode: "transfer",
      payload: {},
    });
  }
  try {
    const dimension = world.getDimension(land.spawn.dimensionId);
    player.teleport(
      { x: land.spawn.x, y: land.spawn.y, z: land.spawn.z },
      { dimension, checkForBlocks: true, rotation: { x: land.spawn.pitch, y: land.spawn.yaw } },
    );
  } catch (error) {
    throw new LandError("teleport_blocked", {}, error instanceof Error ? error.message : String(error));
  }
  lastTeleport.set(actor.id, Date.now());
}
