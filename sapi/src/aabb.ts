/**
 * AABB 归一化与三维碰撞检测（纯逻辑，可单测）。
 */

import type { Aabb, Vec3 } from "./types.js";

/** 保证 min ≤ max 各轴。 */
export function normalizeAabb(box: Aabb): Aabb {
  return {
    min: {
      x: Math.min(box.min.x, box.max.x),
      y: Math.min(box.min.y, box.max.y),
      z: Math.min(box.min.z, box.max.z),
    },
    max: {
      x: Math.max(box.min.x, box.max.x),
      y: Math.max(box.min.y, box.max.y),
      z: Math.max(box.min.z, box.max.z),
    },
  };
}

/** 体积（含端点方块数）。 */
export function blockVolume(box: Aabb): number {
  const b = normalizeAabb(box);
  const dx = Math.floor(b.max.x) - Math.floor(b.min.x) + 1;
  const dy = Math.floor(b.max.y) - Math.floor(b.min.y) + 1;
  const dz = Math.floor(b.max.z) - Math.floor(b.min.z) + 1;
  return Math.max(0, dx) * Math.max(0, dy) * Math.max(0, dz);
}

/** 水平占地面积（含端点）。 */
export function footprintBlocks(box: Aabb): number {
  const b = normalizeAabb(box);
  const dx = Math.floor(b.max.x) - Math.floor(b.min.x) + 1;
  const dz = Math.floor(b.max.z) - Math.floor(b.min.z) + 1;
  return Math.max(0, dx) * Math.max(0, dz);
}

/** 两 AABB 是否相交（含边界相贴视为冲突）。 */
export function aabbIntersects(a: Aabb, b: Aabb): boolean {
  const A = normalizeAabb(a);
  const B = normalizeAabb(b);
  return (
    A.min.x <= B.max.x &&
    A.max.x >= B.min.x &&
    A.min.y <= B.max.y &&
    A.max.y >= B.min.y &&
    A.min.z <= B.max.z &&
    A.max.z >= B.min.z
  );
}

/** 点是否在 AABB 内（含边界）。 */
export function pointInAabb(p: Vec3, box: Aabb): boolean {
  const b = normalizeAabb(box);
  return (
    p.x >= b.min.x &&
    p.x <= b.max.x &&
    p.y >= b.min.y &&
    p.y <= b.max.y &&
    p.z >= b.min.z &&
    p.z <= b.max.z
  );
}

/** 由中心与半径生成竖直通天领地盒。 */
export function verticalBoxFromCore(
  core: Vec3,
  radius: number,
  yMin = -64,
  yMax = 319,
): Aabb {
  return normalizeAabb({
    min: { x: core.x - radius, y: yMin, z: core.z - radius },
    max: { x: core.x + radius, y: yMax, z: core.z + radius },
  });
}
