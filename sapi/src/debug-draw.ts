/** 在当前维度显示短时粒子边界，预览结束或离线时释放。 */
import { system, world } from "@minecraft/server";
import type { Aabb } from "./types.js";

const previews = new Map<string, number>();
export function clearShapes(key: string): void {
  const id = previews.get(key);
  if (id !== undefined) system.clearRun(id);
  previews.delete(key);
}
export function clearAllShapes(): void {
  for (const key of previews.keys()) clearShapes(key);
}
export async function showLandHighlight(opts: {
  key: string;
  box: Aabb;
  dimension: string;
}): Promise<void> {
  clearShapes(opts.key);
  const render = () => {
    const viewer = world
      .getAllPlayers()
      .find(
        (player) =>
          player.id === opts.key.replace(/^preview:/, "") &&
          player.dimension.id === opts.dimension,
      );
    if (!viewer) return;
    const y = Math.min(
      opts.box.max.y,
      Math.max(opts.box.min.y, Math.floor(viewer.location.y)),
    );
    const dimension = world.getDimension(opts.dimension);
    for (const x of [opts.box.min.x, opts.box.max.x]) {
      for (const z of [opts.box.min.z, opts.box.max.z]) {
        try {
          dimension.spawnParticle("minecraft:basic_flame_particle", {
            x: x + 0.5,
            y: y + 0.5,
            z: z + 0.5,
          });
        } catch {
          /* 未加载的区块无法显示粒子；GUI 仍展示完整范围。 */
        }
      }
    }
  };
  render();
  const id = system.runInterval(render, 40);
  previews.set(opts.key, id);
  system.runTimeout(() => {
    if (previews.get(opts.key) === id) clearShapes(opts.key);
  }, 600);
}
