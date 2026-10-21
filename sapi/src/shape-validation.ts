/** 三维形状的服务输入校验。 */
import type { LandConfig } from "./config.js";
import type { LandShape } from "./types.js";
import { invalid, validateBox } from "./validation.js";

export function parseShape(
  value: unknown,
  dimension: string,
  cfg: LandConfig,
): LandShape {
  if (!value || typeof value !== "object") invalid("缺少领地形状");
  const raw = value as Record<string, unknown>;
  const box = validateBox(raw.min, raw.max, dimension, cfg);
  if (raw.type === "cuboid") return { type: "cuboid", ...box };
  if (raw.type !== "cylinder") invalid("请选择长方体或圆柱体");
  const radius = raw.radius;
  if (typeof radius !== "number" || !Number.isSafeInteger(radius) || radius < 1)
    invalid("圆柱体半径须为正整数");
  if (
    box.max.x - box.min.x !== radius * 2 ||
    box.max.z - box.min.z !== radius * 2
  )
    invalid("圆柱体范围须与半径一致");
  return { type: "cylinder", ...box, radius };
}
