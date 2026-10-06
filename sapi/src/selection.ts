/** 金镐选定领地范围，不自动提交或扣款。 */
import { world, type Player } from "@minecraft/server";
import { debug, Msg } from "@sfmc-bds/sdk/sapi/runtime";
import { normalizeAabb } from "./aabb.js";
import { showLandHighlight, clearShapes } from "./debug-draw.js";
import { clearLandUiState } from "./ui-services.js";
import { pendingBoxes } from "./pending.js";
import { openLandUi } from "./ui.js";

type Selection = {
  a?: { x: number; y: number; z: number };
  dimension?: string;
};

const selections = new Map<string, Selection>();

export function clearLandSelections(): void {
  selections.clear();
  pendingBoxes.clear();
}
export function registerLandSelectionEvents(cleanups: Array<() => void>): void {
  const callback = world.afterEvents.playerInteractWithBlock.subscribe((ev) => {
    void selectBlock(ev.player, ev.block.location, ev.block.dimension.id).catch(
      (error) => {
        debug.w("LandSelection", String(error));
        Msg.error("选点失败，请重试", ev.player);
      },
    );
  });
  cleanups.push(() =>
    world.afterEvents.playerInteractWithBlock.unsubscribe(callback),
  );
  const leave = world.afterEvents.playerLeave.subscribe((ev) => {
    selections.delete(ev.playerId);
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
  const inv = player.getComponent("minecraft:inventory");
  const slotIndex =
    typeof (player as { selectedSlotIndex?: number }).selectedSlotIndex ===
    "number"
      ? (player as { selectedSlotIndex: number }).selectedSlotIndex
      : 0;
  const slot = inv?.container?.getItem(slotIndex);
  if (slot?.typeId !== "minecraft:golden_pickaxe") return;

  const sel = selections.get(player.id) ?? {};
  if (!sel.a || sel.dimension !== dimension) {
    selections.set(player.id, { a: loc, dimension });
    Msg.info(
      `已选定点 A (${loc.x},${loc.y},${loc.z})，再点一次设定点 B`,
      player,
    );
    return;
  }

  const box = normalizeAabb({
    min: { x: sel.a.x, y: sel.a.y, z: sel.a.z },
    max: { x: loc.x, y: loc.y, z: loc.z },
  });
  selections.delete(player.id);
  clearLandUiState(player.id);
  pendingBoxes.set(player.id, { box, dimension });
  await showLandHighlight({
    key: `preview:${player.id}`,
    box,
    dimension,
  });
  Msg.info("预览已挂载。请在「租用领地」中预览费用并确认。", player);
  void openLandUi(player, "land.lease").catch((error) => {
    debug.w(
      "LandSelection",
      `打开租用界面失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
