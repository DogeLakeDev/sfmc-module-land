/** 默认区域沿用公开事件约定：areaId 为空；子区域用稳定 ID。 */
export interface PresenceScope {
  landId: string;
  areaId: string;
}

export interface PresenceEvent {
  event: "land.left" | "land.entered";
  payload: Record<string, string>;
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
