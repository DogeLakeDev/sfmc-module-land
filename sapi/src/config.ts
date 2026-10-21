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
  if (!raw || typeof raw !== "object") return structuredClone(base);
  const src = raw as Record<string, unknown>;
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
