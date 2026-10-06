/**
 * 日租金、长租折扣与扩建补差（纯逻辑）。
 */

import { footprintBlocks } from "./aabb.js";
import type { LandConfig } from "./config.js";
import { DAY_MS, type Aabb } from "./types.js";

/** 按占地面积计算基础日租金（未乘持有数量倍率）。 */
export function calcBaseDailyRent(box: Aabb, cfg: LandConfig): number {
  const blocks = footprintBlocks(box);
  const areaFee = Math.ceil((blocks / 100) * cfg.rent_per_100_blocks);
  return Math.max(1, Math.ceil(cfg.base_daily_rent + areaFee));
}

/**
 * 持有数量倍率：第 1 块用 multipliers[0]，第 2 块用 [1]…
 * existingCount 为创建前已有有效领地数。
 */
export function landCountMultiplier(
  existingCount: number,
  multipliers: number[],
): number {
  if (multipliers.length === 0) return 1;
  const idx = Math.min(Math.max(0, existingCount), multipliers.length - 1);
  return multipliers[idx] ?? 1;
}

export function calcDailyRent(
  box: Aabb,
  cfg: LandConfig,
  existingLandCount: number,
): number {
  const base = calcBaseDailyRent(box, cfg);
  const mult = landCountMultiplier(
    existingLandCount,
    cfg.land_count_multiplier,
  );
  return Math.max(1, Math.ceil(base * mult));
}

/** 长租折扣：取不超过 days 的最大档位。 */
export function longTermDiscount(
  days: number,
  discounts: Record<string, number>,
): number {
  let best = 1;
  let bestDays = 0;
  for (const [k, v] of Object.entries(discounts)) {
    const d = Number(k);
    if (!Number.isFinite(d) || d <= 0) continue;
    if (days >= d && d >= bestDays) {
      bestDays = d;
      best = typeof v === "number" && v > 0 && v <= 1 ? v : 1;
    }
  }
  return best;
}

/** 首期/续租应付总额（日租金 × 天数 × 折扣，向上取整）。 */
export function calcPeriodRent(
  dailyRent: number,
  days: number,
  cfg: LandConfig,
): number {
  const d = Math.max(1, Math.floor(days));
  const discount = longTermDiscount(d, cfg.long_term_discounts);
  return Math.max(1, Math.ceil(dailyRent * d * discount));
}

/** 剩余有效租期天数（向下取整，至少 0）。 */
export function remainingLeaseDays(
  leaseUntil: number,
  now = Date.now(),
): number {
  return Math.max(0, Math.floor((leaseUntil - now) / DAY_MS));
}

/**
 * 扩建平滑补差：(R_new - R_old) × D_rem。
 * 剩余不足一天按实际时间比例计费，最终金额向上取整。
 */
export function expansionFeeDiff(
  oldDaily: number,
  newDaily: number,
  remainingDays: number,
): number {
  const rem = Math.max(0, remainingDays);
  const delta = newDaily - oldDaily;
  if (delta <= 0 || rem <= 0) return 0;
  return Math.ceil(delta * rem);
}
