/** 统一三维选区：计费、坐标查询、碰撞与扩建均使用相同的方块集合。 */
import type { LandConfig } from "./config.js";
import type { Aabb, LandShape, Vec3 } from "./types.js";
import { DIMENSIONS } from "./dimensions.js";
import { aabbIntersects, blockVolume, pointInAabb } from "./aabb.js";

export function defaultShape(
  core: Vec3,
  dimension: string,
  cfg: LandConfig,
): LandShape {
  const radius = cfg.claim.initial_radius;
  const bounds = DIMENSIONS[dimension];
  if (!bounds) throw new RangeError("不支持该维度");
  const y = Math.max(
    bounds.minY,
    Math.min(core.y, bounds.maxY - cfg.claim.initial_height + 1),
  );
  return {
    type: "cuboid",
    min: { x: core.x - radius, y, z: core.z - radius },
    max: {
      x: core.x + radius,
      y: y + cfg.claim.initial_height - 1,
      z: core.z + radius,
    },
  };
}

export function shapeCenter(shape: LandShape): Vec3 {
  return {
    x: (shape.min.x + shape.max.x) / 2,
    y: (shape.min.y + shape.max.y) / 2,
    z: (shape.min.z + shape.max.z) / 2,
  };
}

/** 一个 X 方块列内占用的 Z 闭区间。 */
function column(shape: LandShape, x: number): [number, number] | undefined {
  if (x < shape.min.x || x > shape.max.x) return undefined;
  if (shape.type === "cuboid") return [shape.min.z, shape.max.z];
  const center = shapeCenter(shape);
  const square = shape.radius ** 2 - (x - center.x) ** 2;
  if (square < 0) return undefined;
  const span = Math.floor(Math.sqrt(square));
  return [center.z - span, center.z + span];
}

export function shapeVolume(shape: LandShape): number {
  if (shape.type === "cuboid") return blockVolume(shape);
  let area = 0;
  for (let x = shape.min.x; x <= shape.max.x; x++) {
    const range = column(shape, x);
    if (range) area += range[1] - range[0] + 1;
  }
  return area * (shape.max.y - shape.min.y + 1);
}

export function pointInShape(point: Vec3, shape: LandShape): boolean {
  const x = Math.floor(point.x),
    y = Math.floor(point.y),
    z = Math.floor(point.z);
  if (shape.type === "cuboid") return pointInAabb({ x, y, z }, shape);
  if (y < shape.min.y || y > shape.max.y) return false;
  const range = column(shape, x);
  return !!range && z >= range[0] && z <= range[1];
}

export function shapesIntersect(a: LandShape, b: LandShape): boolean {
  if (a.type === "cuboid" && b.type === "cuboid") return aabbIntersects(a, b);
  if (a.min.y > b.max.y || a.max.y < b.min.y) return false;
  for (
    let x = Math.max(a.min.x, b.min.x);
    x <= Math.min(a.max.x, b.max.x);
    x++
  ) {
    const ca = column(a, x),
      cb = column(b, x);
    if (ca && cb && ca[0] <= cb[1] && ca[1] >= cb[0]) return true;
  }
  return false;
}

export function shapeContains(outer: LandShape, inner: LandShape): boolean {
  if (outer.min.y > inner.min.y || outer.max.y < inner.max.y) return false;
  for (let x = inner.min.x; x <= inner.max.x; x++) {
    const a = column(outer, x),
      b = column(inner, x);
    if (b && (!a || a[0] > b[0] || a[1] < b[1])) return false;
  }
  return true;
}

export function shapeText(shape: LandShape): string {
  const height = shape.max.y - shape.min.y + 1;
  return shape.type === "cylinder"
    ? `圆柱体 · 半径 ${shape.radius} · 高 ${height}`
    : `长方体 · 长 ${shape.max.x - shape.min.x + 1} × 宽 ${shape.max.z - shape.min.z + 1} × 高 ${height}`;
}

export function boxShape(box: Aabb): LandShape {
  return { type: "cuboid", ...box };
}
