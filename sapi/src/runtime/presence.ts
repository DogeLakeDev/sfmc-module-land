/** 默认区域沿用公开事件约定：areaId 为空；子区域用稳定 ID。 */
export interface PresenceScope {
  landId: string;
  areaId: string;
}

export interface PresenceEvent {
  event: "land.left" | "land.entered";
  payload: Record<string, string>;
}

/** 进出提示的种类，与文案键同名：left_area / left / entered / entered_area。 */
export type PresenceNoticeKind = "left_area" | "left" | "entered" | "entered_area";

/**
 * 一条玩家可见的进出提示。
 * scope：离开类提示指旧范围，进入类提示指新范围。
 */
export interface PresenceNotice {
  kind: PresenceNoticeKind;
  scope: PresenceScope;
}

/**
 * 计算玩家可见的进出提示，顺序为：离开子区域 → 离开领地 → 进入领地 → 进入子区域。
 * 默认区域不单独提示；跨领地且起点/终点在子区域里时，领地与子区域提示都会给出。
 * 使用场景：loops.ts 的 scanPlayers 每轮扫描后按结果渲染提示。
 * 与 presenceEvents（对外事件，默认区域进出也要报告）分开，避免两种语义互相牵制。
 */
export function presenceNotices(
  previous: PresenceScope | undefined,
  next: PresenceScope | undefined,
): PresenceNotice[] {
  const from = previous ?? { landId: "", areaId: "" };
  const to = next ?? { landId: "", areaId: "" };
  const landChanged = from.landId !== to.landId;
  const areaChanged = landChanged || from.areaId !== to.areaId;
  const notices: PresenceNotice[] = [];
  if (from.areaId && areaChanged) notices.push({ kind: "left_area", scope: from });
  if (from.landId && landChanged) notices.push({ kind: "left", scope: from });
  if (to.landId && landChanged) notices.push({ kind: "entered", scope: to });
  if (to.areaId && areaChanged) notices.push({ kind: "entered_area", scope: to });
  return notices;
}

/** 有效管理范围变化时，先离开旧范围，再进入新范围。荒野不产生进入事件。 */
export function presenceEvents(
  playerId: string,
  previous: PresenceScope | undefined,
  next: PresenceScope | undefined,
  reason = "movement",
): PresenceEvent[] {
  const from = previous ?? { landId: "", areaId: "" };
  const to = next ?? { landId: "", areaId: "" };
  if (from.landId === to.landId && from.areaId === to.areaId) return [];
  const events: PresenceEvent[] = [];
  if (from.landId) {
    events.push({
      event: "land.left",
      payload: {
        playerId,
        ...from,
        toLandId: to.landId,
        toAreaId: to.areaId,
        reason,
      },
    });
  }
  if (to.landId) {
    events.push({
      event: "land.entered",
      payload: {
        playerId,
        ...to,
        fromLandId: from.landId,
        fromAreaId: from.areaId,
        reason,
      },
    });
  }
  return events;
}
