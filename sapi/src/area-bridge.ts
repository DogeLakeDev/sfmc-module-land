/**
 * 与 area 微内核的挂接：注册/注销领地空间与增益特性。
 */

import type { Player } from "@minecraft/server";
import { debug } from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import { listPerks } from "./store.js";
import {
  ALL_PERKS,
  areaNameForLand,
  perkFeatureKey,
  type LandRow,
  type PerkId,
} from "./types.js";

const featureRegistered = new Set<string>();

async function callArea(name: string, input: Record<string, unknown>): Promise<unknown> {
  return service.call(name, input);
}

function setActionBar(player: Player, text: string): void {
  try {
    player.onScreenDisplay.setActionBar(text);
  } catch {
    /* ignore */
  }
}

/** 启动期注册领地增益特性处理器（幂等）。 */
export async function ensureLandAreaFeatures(): Promise<void> {
  const handlers: Array<{
    id: string;
    onEnter?: (player: Player, ctx: { name: string }, params: Record<string, unknown>) => void;
    onLeave?: (player: Player, ctx: { name: string }, params: Record<string, unknown>) => void;
    onTick?: (ctx: { name: string }, params: Record<string, unknown>) => void;
  }> = [
    {
      id: perkFeatureKey("noboom"),
      // 实际防爆拦截由世界事件侧按 area.byPoint 判定；此处仅作进出提示挂点
    },
    {
      id: perkFeatureKey("peace"),
    },
    {
      id: perkFeatureKey("fireproof"),
    },
    {
      id: perkFeatureKey("heal"),
      onTick(_ctx, _params) {
        /* 周期回血由 scan 侧或后续扩展；占位保持插槽契约 */
      },
    },
    {
      id: perkFeatureKey("nofall"),
    },
    {
      id: "land_core",
      onEnter(player, ctx) {
        setActionBar(player, `§a进入庄园 §f${ctx.name.replace(/^land:/, "")}`);
      },
      onLeave(player) {
        setActionBar(player, "§7离开庄园");
      },
    },
  ];

  for (const h of handlers) {
    if (featureRegistered.has(h.id)) continue;
    try {
      await callArea("area.registerFeature", h as unknown as Record<string, unknown>);
      featureRegistered.add(h.id);
    } catch (err) {
      debug.w(
        "LandArea",
        `registerFeature ${h.id} 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** 根据契约状态与增益开关同步 area 注册。 */
export async function syncLandArea(land: LandRow): Promise<void> {
  const name = areaNameForLand(land.id);
  if (land.status === "terminated") {
    await unregisterLandArea(land.id);
    return;
  }

  const features: Record<string, Record<string, unknown>> = {
    // name 给地图显示领地名称。area 里的区域名仍是 land:id。
    land_core: { landId: land.id, status: land.status, name: land.name },
  };

  // 休眠期暂停增益，但保留 land_core 保护（建筑仍受区域托管）
  if (land.status === "active") {
    try {
      const perks = await listPerks(land.id);
      for (const p of perks) {
        if (p.enabled) {
          features[perkFeatureKey(p.perk_id as PerkId)] = {
            landId: land.id,
            ...(safeJson(p.settings_json) ?? {}),
          };
        }
      }
    } catch {
      /* ignore */
    }
  }

  try {
    await callArea("area.registerArea", {
      name,
      dimension: land.dimension,
      start: [land.min_x, land.min_z],
      end: [land.max_x, land.max_z],
      features,
      dynamic: true,
    });
  } catch (err) {
    debug.w(
      "LandArea",
      `registerArea ${name} 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function unregisterLandArea(landId: string): Promise<void> {
  try {
    await callArea("area.unregisterArea", { name: areaNameForLand(landId) });
  } catch (err) {
    debug.w(
      "LandArea",
      `unregisterArea 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function defaultPerkList(): PerkId[] {
  return [...ALL_PERKS];
}
