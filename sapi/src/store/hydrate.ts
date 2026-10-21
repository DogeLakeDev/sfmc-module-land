/**
 * 把数据库里的领地装进内存索引。
 * 启动和修复后的全量重建都走这里，保护热路径不再查库。
 */

import type { WorldIndex } from "../cache/world-index.js";
import {
  listAreaRoles,
  listAreas,
  listClaims,
  listFlags,
  listIdentities,
  listLands,
  listLeases,
  listListings,
  listMembers,
  listRoles,
} from "./repo.js";

/** 重建索引。调用期间保护逻辑保持未就绪，避免读到半份数据。 */
export async function hydrate(index: WorldIndex): Promise<void> {
  index.clear();
  for (const land of await listLands()) index.upsertLand(land);
  for (const claim of await listClaims()) index.upsertClaim(claim.key, claim.id, claim.landId);
  for (const area of await listAreas()) index.upsertArea(area);
  for (const role of await listRoles()) index.upsertRole(role);
  for (const member of await listMembers()) index.upsertMember(member);
  for (const areaRole of await listAreaRoles()) index.upsertAreaRole(areaRole);
  for (const flag of await listFlags()) index.setFlag(flag.id, flag.scopeId, flag.flagId, flag.value);
  for (const lease of await listLeases()) index.upsertLease(lease);
  for (const listing of await listListings()) index.upsertListing(listing);
  for (const identity of await listIdentities()) index.rememberIdentity(identity.playerId, identity.playerName);
  index.ready = true;
}
