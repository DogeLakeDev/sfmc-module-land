/** 按真实到期时间处理宽限期与租赁结束，避免重启延长租期。 */
import { debug } from "@sfmc-bds/sdk/sapi/runtime";
import type { LandConfig } from "./config.js";
import { clearShapes } from "./debug-draw.js";
import { activityRecord } from "./platform.js";
import {
  listExpiredActive,
  listGraceExpired,
  updateLandFields,
} from "./store.js";
import { serializeLandMutation } from "./mutations.js";
import { DAY_MS } from "./types.js";

export function runLeaseScan(
  cfg: LandConfig,
): Promise<{ dormant: number; terminated: number }> {
  return serializeLandMutation(async () => {
    const now = Date.now();
    let dormant = 0,
      terminated = 0;
    for (;;) {
      const expired = await listExpiredActive(now);
      if (!expired.length) break;
      for (const land of expired) {
        const graceUntil = land.lease_until + cfg.grace_period_days * DAY_MS;
        await updateLandFields(land.id, {
          status: "dormant",
          grace_until: graceUntil,
          version: land.version + 1,
        });
        dormant++;
        await activityRecord({
          eventType: "land.lease.dormant",
          actorId: "system",
          targetId: land.id,
          payload: { graceUntil },
        });
      }
    }
    for (;;) {
      const ended = await listGraceExpired(now);
      if (!ended.length) break;
      for (const land of ended) {
        await updateLandFields(land.id, {
          status: "terminated",
          version: land.version + 1,
        });
        clearShapes(land.id);
        terminated++;
        await activityRecord({
          eventType: "land.lease.terminated",
          actorId: "system",
          targetId: land.id,
          payload: { reason: "grace_expired" },
        });
      }
    }
    if (dormant || terminated)
      debug.i("LandScan", `休眠 ${dormant}，结束 ${terminated}`);
    return { dormant, terminated };
  });
}
