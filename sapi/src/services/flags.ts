/**
 * 领地和子区域旗标。
 * 只接受已注册旗标，避免把任意键写进保护规则。
 */

import { LandError } from "../domain/errors.js";
import { makeId } from "../domain/ids.js";
import type { Actor, FlagValue } from "../domain/model.js";
import { coerceFlag, getFlag } from "../domain/permissions.js";
import { upsertFlag } from "../store/repo.js";
import { afterEvent } from "./hooks.js";
import { assertAllowed } from "./permission.js";
import { requireArea, requireLand, world } from "./shared.js";

/**
 * 写入旗标。
 * areaToken 为空时写到领地主记录；否则只覆盖该子区域。
 */
export async function setFlag(
  actor: Actor,
  token: string,
  flagId: string,
  raw: string,
  areaToken?: string,
): Promise<FlagValue> {
  const land = requireLand(token);
  const area = areaToken ? requireArea(land, areaToken) : undefined;
  if (area?.kind === "default") throw new LandError("area_default");
  const def = getFlag(flagId);
  if (!def) throw new LandError("flag_unknown", { name: flagId });
  if (area && def.scope === "land") throw new LandError("flag_unknown", { name: flagId });
  if (!area && def.scope === "area") throw new LandError("flag_unknown", { name: flagId });
  const index = world();
  const located = area
    ? { land, area, specific: true as const }
    : { land, area: index.areas.get(land.defaultAreaId)!, specific: false as const };
  if (!located.area) throw new LandError("not_ready");
  const decision = assertAllowed(index, actor, "flag.manage", located);
  if (!decision.allow && land.ownerId !== actor.id && !actor.console) {
    throw new LandError("no_permission", { reason: decision.reason });
  }
  let value: FlagValue;
  try {
    value = coerceFlag(def, raw);
  } catch {
    throw new LandError("bad_name", { label: def.id, name: raw });
  }
  const scopeId = area?.id ?? land.id;
  const scope = area ? "area" : "land";
  const existingId = index.flagIds.get(`${scopeId}|${flagId}`);
  const id = existingId ?? makeId("f");
  await upsertFlag({ id, scope, scopeId, flagId, value }, existingId);
  index.setFlag(id, scopeId, flagId, value);
  await afterEvent("land.flag.changed", { actorId: actor.id, landId: land.id, areaId: area?.id ?? "", flag: flagId });
  return value;
}
