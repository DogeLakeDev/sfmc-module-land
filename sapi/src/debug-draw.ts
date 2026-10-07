/** 原生线框预览；仅选地玩家可见，提交、离线或超时后移除。 */
import {
  DebugBox,
  DebugCylinder,
  debugDrawer,
  type DebugShape,
} from "@minecraft/debug-utilities";
import { system, world } from "@minecraft/server";
import { debug } from "@sfmc-bds/sdk/sapi/runtime";
import { shapeCenter } from "./geometry.js";
import type { LandShape } from "./types.js";

const previews = new Map<string, { shape: DebugShape; timeout: number }>();
export function clearShapes(key: string): void {
  const preview = previews.get(key);
  if (!preview) return;
  previews.delete(key);
  system.clearRun(preview.timeout);
  try {
    preview.shape.remove();
  } catch (error) {
    // 原生持续时间可能已经结束，清理不能影响已完成的租赁结果。
    debug.w("LandPreview", String(error));
  }
}
export function clearAllShapes(): void {
  for (const key of previews.keys()) clearShapes(key);
}
export async function showLandHighlight(opts: {
  key: string;
  shape: LandShape;
  dimension: string;
}): Promise<void> {
  clearShapes(opts.key);
  const viewer = world
    .getAllPlayers()
    .find((player) => player.id === opts.key.replace(/^preview:/, ""));
  if (!viewer) return;
  const center = shapeCenter(opts.shape);
  const location = {
    ...center,
    x: center.x + 0.5,
    y: center.y + 0.5,
    z: center.z + 0.5,
    dimension: world.getDimension(opts.dimension),
  };
  let shape: DebugShape;
  if (opts.shape.type === "cuboid") {
    const box = new DebugBox(location);
    box.bound = {
      x: opts.shape.max.x - opts.shape.min.x + 1,
      y: opts.shape.max.y - opts.shape.min.y + 1,
      z: opts.shape.max.z - opts.shape.min.z + 1,
    };
    shape = box;
  } else {
    const cylinder = new DebugCylinder(location);
    cylinder.height = opts.shape.max.y - opts.shape.min.y + 1;
    cylinder.radii = { x: opts.shape.radius + 0.5, y: opts.shape.radius + 0.5 };
    cylinder.numSegments = 64;
    shape = cylinder;
  }
  shape.color = { red: 0.2, green: 1, blue: 0.5, alpha: 1 };
  shape.visibleTo = [viewer];
  shape.timeLeft = 30;
  debugDrawer.addShape(shape, location.dimension);
  const timeout = system.runTimeout(() => {
    if (previews.get(opts.key)?.shape === shape) clearShapes(opts.key);
  }, 600);
  previews.set(opts.key, { shape, timeout });
}
