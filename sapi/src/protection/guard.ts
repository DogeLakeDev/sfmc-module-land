/**
 * 世界保护。
 * 能取消的事件在回调里同步拒绝；不能取消的行为不会被说成已经完整保护。
 */

import type { Player } from "@minecraft/server";
import { system, world } from "@minecraft/server";
import { permissionForBlock } from "../domain/blocks.js";
import { isHostile } from "../domain/permissions.js";
import { Permission } from "@sfmc-bds/sdk/sapi/runtime";
import { say } from "../messages/speak.js";
import { decide, resolveFlag } from "../services/permission.js";
import { landConfig, worldOrUndefined } from "../services/shared.js";

const recentDeny = new Map<string, number>();

function deny(player: Player, reason: string): void {
  const now = Date.now();
  const last = recentDeny.get(player.id) ?? 0;
  if (now - last < 2000) return;
  recentDeny.set(player.id, now);
  say(player, reason === "not_ready" ? "not_ready" : "denied_action", {}, "error");
}

function allowAction(player: Player, permission: string, x: number, y: number, z: number, dimensionId: string): boolean {
  const index = worldOrUndefined();
  if (!index?.ready) {
    deny(player, "not_ready");
    return false;
  }
  const located = index.locate(dimensionId, x, y, z);
  if (!located && !landConfig().wildernessProtected) return true;
  const decision = decide(
    index,
    { id: player.id, admin: Permission.check(player, "land.admin") },
    permission,
    located,
    landConfig().wildernessProtected,
  );
  if (!decision.allow) deny(player, decision.reason);
  return decision.allow;
}

/**
 * 订阅可以取消的保护事件。
 * admin 绕过由 decide 读取会话标记，这里不把玩家权限等级直接当成领地领主。
 */
export function registerProtection(cleanups: Array<() => void>): void {
  const breakEvent = world.beforeEvents.playerBreakBlock.subscribe((event) => {
    const block = event.block;
    if (!allowAction(event.player, "block.break", block.location.x, block.location.y, block.location.z, event.dimension.id)) {
      event.cancel = true;
    }
  });
  cleanups.push(() => world.beforeEvents.playerBreakBlock.unsubscribe(breakEvent));

  const placeEvent = world.beforeEvents.playerPlaceBlock.subscribe((event) => {
    const block = event.block;
    if (!allowAction(event.player, "block.place", block.location.x, block.location.y, block.location.z, event.dimension.id)) {
      event.cancel = true;
    }
  });
  cleanups.push(() => world.beforeEvents.playerPlaceBlock.unsubscribe(placeEvent));

  const interactEvent = world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const block = event.block;
    const permission = permissionForBlock(block.typeId);
    if (!allowAction(event.player, permission, block.location.x, block.location.y, block.location.z, block.dimension.id)) {
      event.cancel = true;
    }
  });
  cleanups.push(() => world.beforeEvents.playerInteractWithBlock.unsubscribe(interactEvent));

  const entityEvent = world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
    // 目标实体已被移除时读 location/dimension 会抛 InvalidEntityError，此时也无可交互对象
    if (!event.target.isValid) return;
    const location = event.target.location;
    if (!allowAction(event.player, "entity.interact", location.x, location.y, location.z, event.target.dimension.id)) {
      event.cancel = true;
    }
  });
  cleanups.push(() => world.beforeEvents.playerInteractWithEntity.unsubscribe(entityEvent));

  const hurtEvent = world.beforeEvents.entityHurt.subscribe((event) => {
    const index = worldOrUndefined();
    if (!index?.ready) {
      event.cancel = true;
      return;
    }
    const hurt = event.hurtEntity;
    if (!hurt.isValid) return;
    const located = index.locate(hurt.dimension.id, hurt.location.x, hurt.location.y, hurt.location.z);
    if (!located) return;
    const source = event.damageSource.damagingEntity;
    const pvp = resolveFlag(index, located.land, located.area, "pvp") === true;
    if (!pvp && source?.typeId === "minecraft:player" && hurt.typeId === "minecraft:player") {
      event.cancel = true;
      return;
    }
    if (source?.typeId === "minecraft:player") {
      const player = source as Player;
      const permission = isHostile(hurt.typeId) ? "entity.attack_hostile" : "entity.attack";
      if (!allowAction(player, permission, hurt.location.x, hurt.location.y, hurt.location.z, hurt.dimension.id)) {
        event.cancel = true;
      }
    }
  });
  cleanups.push(() => world.beforeEvents.entityHurt.unsubscribe(hurtEvent));

  const explosionEvent = world.beforeEvents.explosion.subscribe((event) => {
    const index = worldOrUndefined();
    if (!index?.ready) {
      event.cancel = true;
      return;
    }
    const kept = event.getImpactedBlocks().filter((block) => {
      const located = index.locate(event.dimension.id, block.location.x, block.location.y, block.location.z);
      if (!located) return true;
      return resolveFlag(index, located.land, located.area, "explosion") === true;
    });
    event.setImpactedBlocks(kept);
  });
  cleanups.push(() => world.beforeEvents.explosion.unsubscribe(explosionEvent));

  const spawnEvent = world.afterEvents.entitySpawn.subscribe((event) => {
    const index = worldOrUndefined();
    const entity = event.entity;
    // afterEvents 在 tick 末尾派发，实体可能已被消失/其他附加包移除，读 dimension 会抛 InvalidEntityError
    if (!index?.ready || !entity?.isValid || entity.typeId === "minecraft:player" || !isHostile(entity.typeId)) return;
    const located = index.locate(entity.dimension.id, entity.location.x, entity.location.y, entity.location.z);
    if (!located) return;
    if (resolveFlag(index, located.land, located.area, "mob_spawn") === true) return;
    system.run(() => {
      try {
        entity.remove();
      } catch {
        /* 实体可能已经消失 */
      }
    });
  });
  cleanups.push(() => world.afterEvents.entitySpawn.unsubscribe(spawnEvent));
}
