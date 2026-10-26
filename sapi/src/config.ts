/**
 * 领地配置。
 * 价格、配额、等级和维护周期都从这里读取，业务代码不写死某一台服务器的数值。
 */

/** 单个等级的上限、费用和升级条件。 */
export interface LevelRule {
  level: number;
  chunks: number;
  members: number;
  areas: number;
  roles: number;
  claimPriceMultiplier: number;
  upkeepMultiplier: number;
  /** 升到该等级时从领地银行扣除的金额。1 级是创建后的初始等级，费用应为 0。 */
  cost: number;
  minChunks: number;
  minMembers: number;
  /** 升级成功后一次性存入领地银行的奖励。重复执行不会再次发放。 */
  reward: number;
}

/** 按权限节点覆盖玩家配额。命中多个节点时取各项的较大值。 */
export interface QuotaGroup {
  /** SFMC 命名权限。玩家等级达到 level 才命中这一组。 */
  permission: string;
  /** 命中所需的最低权限等级，对应 Permission.Any/Member/OP/Admin。 */
  level?: number;
  lands?: number;
  chunks?: number;
  members?: number;
  areas?: number;
  roles?: number;
}

/** 模块运行配置。字段使用驼峰，配置文件使用下划线，由 mergeLandConfig 对齐。 */
export interface LandConfig {
  locale: "zh" | "en";
  claimPrice: number;
  unclaimRefundRatio: number;
  teleportPrice: number;
  teleportCooldownMs: number;
  maxBatchChunks: number;
  upkeepPeriodMs: number;
  upkeepBase: number;
  upkeepPerChunk: number;
  gracePeriodMs: number;
  freezeAfterGrace: boolean;
  wildernessProtected: boolean;
  banEject: boolean;
  borderRadiusChunks: number;
  borderIntervalTicks: number;
  /** border 命令绘制目标领地轮廓的粒子 ID。 */
  borderParticle: string;
  /** 绘制附近其他领地轮廓的粒子 ID；空字符串表示不显示其他领地。 */
  borderOtherParticle: string;
  /** 轮廓线上相邻粒子的间距（方块）。 */
  borderStepBlocks: number;
  /** 轮廓线相对玩家脚底的高度层；多个值即画成多层"矮墙"。 */
  borderHeights: number[];
  /** 拐角粒子柱相对玩家脚底的高度（方块）；0 表示不画拐角柱。 */
  borderPostHeight: number;
  /** 拐角粒子柱上相邻粒子的竖直间距（方块）。 */
  borderPostStep: number;
  /** 每名玩家每轮最多生成的边界粒子数，超出后先保留目标领地。 */
  borderMaxParticles: number;
  scanIntervalTicks: number;
  schedulerIntervalTicks: number;
  quotas: {
    lands: number;
    chunks: number;
    members: number;
    areas: number;
    roles: number;
  };
  levels: LevelRule[];
  quotaGroups: QuotaGroup[];
  /** 管理员覆盖的消息模板。第一层是语言，第二层是消息键。 */
  messages: Record<string, Record<string, string>>;
}

/** 安装时的默认配置。服务器管理员改的是 configs/land.json，不是源码。 */
export const DEFAULT_LAND_CONFIG: LandConfig = {
  locale: "zh",
  claimPrice: 50,
  unclaimRefundRatio: 0,
  teleportPrice: 0,
  teleportCooldownMs: 10_000,
  maxBatchChunks: 48,
  upkeepPeriodMs: 86_400_000,
  upkeepBase: 10,
  upkeepPerChunk: 2,
  gracePeriodMs: 3 * 86_400_000,
  freezeAfterGrace: true,
  wildernessProtected: false,
  banEject: false,
  borderRadiusChunks: 2,
  borderIntervalTicks: 40,
  borderParticle: "minecraft:endrod",
  borderOtherParticle: "minecraft:basic_flame_particle",
  borderStepBlocks: 2,
  borderHeights: [0.2, 1.6],
  borderPostHeight: 3,
  borderPostStep: 0.5,
  borderMaxParticles: 800,
  scanIntervalTicks: 20,
  schedulerIntervalTicks: 6000,
  quotas: { lands: 3, chunks: 16, members: 10, areas: 8, roles: 8 },
  levels: [
    {
      level: 1,
      chunks: 16,
      members: 10,
      areas: 8,
      roles: 8,
      claimPriceMultiplier: 1,
      upkeepMultiplier: 1,
      cost: 0,
      minChunks: 0,
      minMembers: 0,
      reward: 0,
    },
    {
      level: 2,
      chunks: 32,
      members: 20,
      areas: 16,
      roles: 12,
      claimPriceMultiplier: 1.25,
      upkeepMultiplier: 1.1,
      cost: 500,
      minChunks: 8,
      minMembers: 1,
      reward: 0,
    },
    {
      level: 3,
      chunks: 64,
      members: 40,
      areas: 32,
      roles: 16,
      claimPriceMultiplier: 1.5,
      upkeepMultiplier: 1.25,
      cost: 2000,
      minChunks: 24,
      minMembers: 3,
      reward: 100,
    },
  ],
  quotaGroups: [],
  messages: {},
};

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** 字符串配置项；非字符串回退默认值，允许空字符串（用于关闭可选功能）。当前用于 border 粒子 ID。 */
function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/** 数字数组配置项；过滤非有限数字，结果为空时回退默认值。当前用于 border_heights。 */
function nums(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return [...fallback];
  const list = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  return list.length > 0 ? list : [...fallback];
}

function levelRule(raw: unknown, fallback: LevelRule): LevelRule {
  if (!raw || typeof raw !== "object") return fallback;
  const row = raw as Record<string, unknown>;
  return {
    level: num(row.level, fallback.level),
    chunks: num(row.chunks, fallback.chunks),
    members: num(row.members, fallback.members),
    areas: num(row.areas, fallback.areas),
    roles: num(row.roles, fallback.roles),
    claimPriceMultiplier: num(
      row.claim_price_multiplier ?? row.claimPriceMultiplier,
      fallback.claimPriceMultiplier,
    ),
    upkeepMultiplier: num(
      row.upkeep_multiplier ?? row.upkeepMultiplier,
      fallback.upkeepMultiplier,
    ),
    cost: num(row.cost, fallback.cost),
    minChunks: num(row.min_chunks ?? row.minChunks, fallback.minChunks),
    minMembers: num(row.min_members ?? row.minMembers, fallback.minMembers),
    reward: num(row.reward, fallback.reward),
  };
}

/**
 * 把配置文件的松散 JSON 合并成完整配置。
 * 缺项回退到默认值，未知项忽略，避免旧的租赁配置把新模块启动打坏。
 */
export function mergeLandConfig(raw?: unknown): LandConfig {
  const base = DEFAULT_LAND_CONFIG;
  // BDS 脚本引擎（QuickJS）没有 structuredClone；缺省配置按空对象合并，同样得到与默认值无共享引用的新对象
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const quotasRaw = (src.quotas ?? {}) as Record<string, unknown>;
  const levelsRaw = Array.isArray(src.levels) ? src.levels : null;
  const groupsRaw =
    Array.isArray(src.quota_groups) ? src.quota_groups
    : Array.isArray(src.quotaGroups) ? src.quotaGroups
    : [];
  const locale = src.locale === "en" ? "en" : "zh";
  return {
    locale,
    claimPrice: Math.max(0, Math.round(num(src.claim_price, base.claimPrice))),
    unclaimRefundRatio: Math.min(
      1,
      Math.max(0, num(src.unclaim_refund_ratio, base.unclaimRefundRatio)),
    ),
    teleportPrice: Math.max(
      0,
      Math.round(num(src.teleport_price, base.teleportPrice)),
    ),
    teleportCooldownMs: Math.max(
      0,
      num(src.teleport_cooldown_ms, base.teleportCooldownMs),
    ),
    maxBatchChunks: Math.max(
      1,
      Math.round(num(src.max_batch_chunks, base.maxBatchChunks)),
    ),
    upkeepPeriodMs: Math.max(
      60_000,
      num(src.upkeep_period_ms, base.upkeepPeriodMs),
    ),
    upkeepBase: Math.max(0, Math.round(num(src.upkeep_base, base.upkeepBase))),
    upkeepPerChunk: Math.max(
      0,
      Math.round(num(src.upkeep_per_chunk, base.upkeepPerChunk)),
    ),
    gracePeriodMs: Math.max(0, num(src.grace_period_ms, base.gracePeriodMs)),
    freezeAfterGrace: bool(src.freeze_after_grace, base.freezeAfterGrace),
    wildernessProtected: bool(
      src.wilderness_protected,
      base.wildernessProtected,
    ),
    banEject: bool(src.ban_eject, base.banEject),
    borderRadiusChunks: Math.max(
      0,
      Math.round(num(src.border_radius_chunks, base.borderRadiusChunks)),
    ),
    borderIntervalTicks: Math.max(
      10,
      Math.round(num(src.border_interval_ticks, base.borderIntervalTicks)),
    ),
    borderParticle:
      str(src.border_particle, base.borderParticle) || base.borderParticle,
    borderOtherParticle: str(
      src.border_other_particle,
      base.borderOtherParticle,
    ),
    borderStepBlocks: Math.max(
      0.5,
      num(src.border_step_blocks, base.borderStepBlocks),
    ),
    borderHeights: nums(src.border_heights, base.borderHeights),
    borderPostHeight: Math.max(
      0,
      num(src.border_post_height, base.borderPostHeight),
    ),
    borderPostStep: Math.max(
      0.25,
      num(src.border_post_step, base.borderPostStep),
    ),
    borderMaxParticles: Math.max(
      1,
      Math.round(num(src.border_max_particles, base.borderMaxParticles)),
    ),
    scanIntervalTicks: Math.max(
      5,
      Math.round(num(src.scan_interval_ticks, base.scanIntervalTicks)),
    ),
    schedulerIntervalTicks: Math.max(
      200,
      Math.round(
        num(src.scheduler_interval_ticks, base.schedulerIntervalTicks),
      ),
    ),
    quotas: {
      lands: Math.max(0, Math.round(num(quotasRaw.lands, base.quotas.lands))),
      chunks: Math.max(
        1,
        Math.round(num(quotasRaw.chunks, base.quotas.chunks)),
      ),
      members: Math.max(
        0,
        Math.round(num(quotasRaw.members, base.quotas.members)),
      ),
      areas: Math.max(0, Math.round(num(quotasRaw.areas, base.quotas.areas))),
      roles: Math.max(0, Math.round(num(quotasRaw.roles, base.quotas.roles))),
    },
    levels:
      levelsRaw ?
        levelsRaw.map((item, index) =>
          levelRule(
            item,
            base.levels[Math.min(index, base.levels.length - 1)]!,
          ),
        )
      : base.levels.map((item) => ({ ...item })),
    quotaGroups: groupsRaw
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object",
      )
      .map((item) => ({
        permission: typeof item.permission === "string" ? item.permission : "",
        ...(typeof item.level === "number" ? { level: item.level } : {}),
        ...(typeof item.lands === "number" ? { lands: item.lands } : {}),
        ...(typeof item.chunks === "number" ? { chunks: item.chunks } : {}),
        ...(typeof item.members === "number" ? { members: item.members } : {}),
        ...(typeof item.areas === "number" ? { areas: item.areas } : {}),
        ...(typeof item.roles === "number" ? { roles: item.roles } : {}),
      }))
      .filter((item) => item.permission.length > 0),
    messages:
      (
        src.messages &&
        typeof src.messages === "object" &&
        !Array.isArray(src.messages)
      ) ?
        (src.messages as Record<string, Record<string, string>>)
      : {},
  };
}

/** 按等级号查找规则。缺失时使用 1 级，避免坏配置把上限变成无限。 */
export function levelRuleOf(config: LandConfig, level: number): LevelRule {
  return (
    config.levels.find((item) => item.level === level) ??
    config.levels[0] ??
    DEFAULT_LAND_CONFIG.levels[0]!
  );
}

/** 下一等级规则。没有则表示已经满级。 */
export function nextLevelRule(
  config: LandConfig,
  level: number,
): LevelRule | undefined {
  return config.levels
    .filter((item) => item.level > level)
    .sort((a, b) => a.level - b.level)[0];
}
