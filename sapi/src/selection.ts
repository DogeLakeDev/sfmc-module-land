/** 界面开启选点后，空手点击两个方块；普通交互不启动选地。 */
import { system, world, type Player } from "@minecraft/server";
import { debug, Msg } from "@sfmc-bds/sdk/sapi/runtime";
import { normalizeAabb } from "./aabb.js";
import { clearShapes } from "./debug-draw.js";
import { acceptSelectedRange, clearLandUiState } from "./ui-services.js";
import { pendingBoxes, selectionSessions } from "./pending.js";

export function clearLandSelections(): void {
  selectionSessions.clear();
  pendingBoxes.clear();
}
export function registerLandSelectionEvents(cleanups: Array<() => void>): void {
  const callback = world.beforeEvents.playerInteractWithBlock.subscribe(
    (ev) => {
      const session = selectionSessions.get(ev.player.id);
      if (!session || ev.itemStack || !ev.isFirstEvent) return;
      if (Date.now() - session.startedAt > 300_000) {
        selectionSessions.delete(ev.player.id);
        return;
      }
      ev.cancel = true;
      const player = ev.player,
        loc = { ...ev.block.location },
        dimension = ev.block.dimension.id;
      system.run(() => {
        void selectBlock(player, loc, dimension).catch((error) => {
          debug.w("LandSelection", String(error));
          Msg.error(
            error instanceof Error ? error.message : "选点失败，请重试",
            player,
          );
        });
      });
    },
  );
  cleanups.push(() =>
    world.beforeEvents.playerInteractWithBlock.unsubscribe(callback),
  );
  const leave = world.afterEvents.playerLeave.subscribe((ev) => {
    selectionSessions.delete(ev.playerId);
    pendingBoxes.delete(ev.playerId);
    clearLandUiState(ev.playerId);
    clearShapes(`preview:${ev.playerId}`);
  });
  cleanups.push(() => world.afterEvents.playerLeave.unsubscribe(leave));
}
async function selectBlock(
  player: Player,
  loc: { x: number; y: number; z: number },
  dimension: string,
): Promise<void> {
  const session = selectionSessions.get(player.id);
  if (!session) return;
  if (!session.a || session.dimension !== dimension) {
    selectionSessions.set(player.id, {
      a: loc,
      dimension,
      startedAt: Date.now(),
    });
    Msg.info(
      `已选定点 A (${loc.x},${loc.y},${loc.z})，请空手点击第二个对角点`,
      player,
    );
    return;
  }
  await acceptSelectedRange(
    player,
    normalizeAabb({ min: session.a, max: loc }),
    dimension,
  );
  selectionSessions.delete(player.id);
}
