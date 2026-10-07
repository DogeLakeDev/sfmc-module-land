/** 租赁输入校验与中文显示，供服务和界面共用。 */
import { ServiceError } from "@sfmc-bds/sdk/sapi/service";
import { normalizeAabb } from "./aabb.js";
import type { Aabb, LandRow, LandStatus, Vec3 } from "./types.js";
import type { LandConfig } from "./config.js";
import { DAY_MS } from "./types.js";

import { DIMENSIONS } from "./dimensions.js";
export { DIMENSIONS } from "./dimensions.js";
export function invalid(message: string): never {
  throw new ServiceError(message, "invalid_argument", 400);
}
export function textId(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`缺少 ${name}`);
  return value.trim();
}
export function leaseDays(value: unknown = 7): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 90
  )
    invalid("租期须为 1 至 90 天的整数");
  return value;
}
export function landName(value: unknown, fallback: string): string {
  if (value !== undefined && typeof value !== "string")
    invalid("领地名称须为文本");
  const name =
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!name || [...name].length > 32 || /[\u0000-\u001f\u007f§]/u.test(name))
    invalid("领地名称须为 1 至 32 个字符，不能包含控制符或格式代码");
  return name;
}
export function dimensionId(value: unknown): string {
  const dimension = textId(value, "dimension");
  if (!DIMENSIONS[dimension]) invalid("不支持该维度");
  return dimension;
}
export function vector(value: unknown): Vec3 {
  if (!value || typeof value !== "object") invalid("缺少三维坐标");
  const v = value as Record<string, unknown>;
  for (const key of ["x", "y", "z"])
    if (typeof v[key] !== "number" || !Number.isFinite(v[key]))
      invalid("坐标须包含有限的 x、y、z 数值");
  return {
    x: Math.floor(v.x as number),
    y: Math.floor(v.y as number),
    z: Math.floor(v.z as number),
  };
}
export function validateBox(
  min: unknown,
  max: unknown,
  dimension: string,
  cfg: LandConfig,
): Aabb {
  const box = normalizeAabb({ min: vector(min), max: vector(max) });
  const bounds = DIMENSIONS[dimension];
  if (!bounds) invalid("不支持该维度");
  if (box.min.y < bounds.minY || box.max.y > bounds.maxY)
    invalid(`该维度的高度范围为 ${bounds.minY} 至 ${bounds.maxY}`);
  if (
    Math.max(
      Math.abs(box.min.x),
      Math.abs(box.max.x),
      Math.abs(box.min.z),
      Math.abs(box.max.z),
    ) > 30_000_000
  )
    invalid("领地超出世界坐标范围");
  const radius = cfg.claim.level_radius[cfg.claim.max_level - 1]!;
  if (box.max.x - box.min.x > radius * 2 || box.max.z - box.min.z > radius * 2)
    invalid("领地范围超过配置的最大等级");
  return box;
}
export function leaseState(
  land: LandRow,
  cfg: LandConfig,
  now = Date.now(),
): LandStatus {
  if (land.status === "terminated") return "terminated";
  if (now < land.lease_until) return "active";
  const graceUntil =
    land.grace_until || land.lease_until + cfg.grace_period_days * DAY_MS;
  return now < graceUntil ? "dormant" : "terminated";
}
export function statusText(status: LandStatus): string {
  return { active: "租期内", dormant: "宽限期", terminated: "已结束" }[status];
}
export function rangeText(box: Aabb): string {
  return `(${box.min.x}, ${box.min.y}, ${box.min.z}) → (${box.max.x}, ${box.max.y}, ${box.max.z})`;
}
