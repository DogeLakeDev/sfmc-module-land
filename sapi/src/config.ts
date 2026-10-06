/**
 * land 配置类型与默认值。
 */

export interface LandConfig {
  base_daily_rent: number;
  rent_per_100_blocks: number;
  max_lands_per_player: number;
  land_count_multiplier: number[];
  long_term_discounts: Record<string, number>;
  grace_period_days: number;
  claim: {
    initial_radius: number;
    max_level: number;
    level_radius: number[];
  };
}

export const DEFAULT_LAND_CONFIG: LandConfig = {
  base_daily_rent: 10,
  rent_per_100_blocks: 2,
  max_lands_per_player: 5,
  land_count_multiplier: [1.0, 1.5, 2.0, 3.0, 3.0],
  long_term_discounts: {
    "30": 0.9,
    "90": 0.8,
  },
  grace_period_days: 7,
  claim: {
    initial_radius: 16,
    max_level: 5,
    level_radius: [16, 24, 32, 48, 64],
  },
};

/** 合并租赁配置，缺省字段使用默认值。 */
export function mergeLandConfig(
  partial?: Partial<LandConfig> | null,
): LandConfig {
  const merged = {
    base_daily_rent:
      partial?.base_daily_rent ?? DEFAULT_LAND_CONFIG.base_daily_rent,
    rent_per_100_blocks:
      partial?.rent_per_100_blocks ?? DEFAULT_LAND_CONFIG.rent_per_100_blocks,
    max_lands_per_player:
      partial?.max_lands_per_player ?? DEFAULT_LAND_CONFIG.max_lands_per_player,
    grace_period_days:
      partial?.grace_period_days ?? DEFAULT_LAND_CONFIG.grace_period_days,
    claim: {
      initial_radius:
        partial?.claim?.initial_radius ??
        DEFAULT_LAND_CONFIG.claim.initial_radius,
      max_level:
        partial?.claim?.max_level ?? DEFAULT_LAND_CONFIG.claim.max_level,
      level_radius: [
        ...(partial?.claim?.level_radius ??
          DEFAULT_LAND_CONFIG.claim.level_radius),
      ],
    },
    land_count_multiplier: [
      ...(partial?.land_count_multiplier ??
        DEFAULT_LAND_CONFIG.land_count_multiplier),
    ],
    long_term_discounts: {
      ...DEFAULT_LAND_CONFIG.long_term_discounts,
      ...(partial?.long_term_discounts ?? {}),
    },
  };
  for (const value of [merged.base_daily_rent, merged.rent_per_100_blocks]) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error("租金配置须为有限非负数");
  }
  for (const [name, value, min] of [
    ["max_lands_per_player", merged.max_lands_per_player, 1],
    ["grace_period_days", merged.grace_period_days, 0],
    ["max_level", merged.claim.max_level, 1],
    ["initial_radius", merged.claim.initial_radius, 1],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min)
      throw new Error(`${name} 配置无效`);
  }
  if (
    merged.claim.level_radius.length < merged.claim.max_level ||
    merged.land_count_multiplier.length === 0
  )
    throw new Error("等级半径或持有数量倍率配置不完整");
  for (let i = 0; i < merged.claim.level_radius.length; i++) {
    const radius = merged.claim.level_radius[i]!;
    if (
      !Number.isSafeInteger(radius) ||
      radius < 1 ||
      (i > 0 && radius <= merged.claim.level_radius[i - 1]!)
    )
      throw new Error("等级半径须为递增的正整数");
  }
  if (
    merged.claim.initial_radius >
    merged.claim.level_radius[merged.claim.max_level - 1]!
  )
    throw new Error("初始半径不能超过最大等级半径");
  for (const multiplier of merged.land_count_multiplier)
    if (!Number.isFinite(multiplier) || multiplier <= 0)
      throw new Error("持有数量倍率须为有限正数");
  for (const [days, discount] of Object.entries(merged.long_term_discounts)) {
    if (
      !Number.isSafeInteger(Number(days)) ||
      Number(days) <= 0 ||
      !Number.isFinite(discount) ||
      discount <= 0 ||
      discount > 1
    )
      throw new Error("长租折扣配置无效");
  }
  return merged;
}
