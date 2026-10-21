/**
 * 管理员诊断和修复。
 * 绕过保护必须先通过 land.admin，再由玩家显式打开；不能靠领地里的旗标。
 */

import type { WorldIndex } from "../cache/world-index.js";
import { chunksCoveredBy, claimKey } from "../domain/geometry.js";
import { aabbIntersects } from "../domain/geometry.js";
import { LandError } from "../domain/errors.js";
import { makeId, nameKey } from "../domain/ids.js";
import type { Actor, AreaState } from "../domain/model.js";
import { setBypass } from "./permission.js";
import { requireLand, world } from "./shared.js";
import { expireLeases } from "./market.js";
import { hardDelete, insertArea, listTransactions } from "../store/repo.js";
import { TABLES } from "../store/tables.js";
import { recoverTransactions } from "../economy/ledger.js";

/** 打开或关闭当前会话的管理绕过。 */
export function setAdminBypass(actor: Actor, enabled: boolean): void {
  if (!actor.admin && !actor.console) throw new LandError("no_permission", { reason: "land.admin" });
  if (actor.console) return;
  setBypass(actor.id, enabled);
}

/** 汇总一块领地或全服的一致性问题。 */
export function diagnose(token?: string): string[] {
  const index = world();
  const lands = token ? [requireLand(token)] : [...index.lands.values()];
  const notes: string[] = [];
  for (const land of lands) {
    if (!land.defaultAreaId || !index.areas.get(land.defaultAreaId)) notes.push(`${land.name}: 缺少默认区域`);
    for (const area of index.areasOf(land.id)) {
      if (area.kind !== "box" || !area.box) continue;
      for (const chunk of chunksCoveredBy(area.dimensionId, area.box)) {
        if (index.claims.get(claimKey(chunk.dimensionId, chunk.chunkX, chunk.chunkZ)) !== land.id) {
          notes.push(`${land.name}/${area.name}: 越出已占领区块`);
          break;
        }
      }
      for (const other of index.areasOf(land.id)) {
        if (other.id === area.id || other.kind !== "box" || !other.box || !area.box) continue;
        if (area.id < other.id && aabbIntersects(area.box, other.box)) notes.push(`${land.name}: ${area.name} 与 ${other.name} 重叠`);
      }
    }
    for (const member of index.membersOf(land.id)) {
      if (member.roleId && !index.roles.get(member.roleId)) notes.push(`${land.name}: 成员 ${member.playerName} 的角色丢失`);
    }
  }
  for (const [key, landId] of index.claims) {
    if (!index.lands.get(landId)) notes.push(`孤立区块 ${key}`);
  }
  if (notes.length === 0) notes.push("未发现一致性问题");
  return notes;
}

/** 修复可以安全自动处理的问题：孤立区块、缺失默认区域、过期租约和卡住的退款。 */
export async function repair(actor: Actor, token?: string): Promise<string> {
  if (!actor.admin && !actor.console) throw new LandError("no_permission", { reason: "land.admin" });
  const index = world();
  let claims = 0;
  let areas = 0;
  const landFilter = token ? requireLand(token).id : undefined;
  for (const [key, landId] of [...index.claims]) {
    if (landFilter && landId !== landFilter) continue;
    if (index.lands.get(landId)) continue;
    const id = index.claimIds.get(key);
    if (id) await hardDelete(TABLES.claim, id);
    index.removeClaim(key);
    claims += 1;
  }
  for (const land of index.lands.values()) {
    if (landFilter && land.id !== landFilter) continue;
    if (land.defaultAreaId && index.areas.get(land.defaultAreaId)) continue;
    const area: AreaState = {
      id: makeId("a"),
      landId: land.id,
      name: "默认",
      nameKey: nameKey("默认"),
      description: "未被普通子区域覆盖的空间",
      kind: "default",
      dimensionId: "",
      box: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await insertArea(area);
    index.upsertArea(area);
    areas += 1;
  }
  const expired = await expireLeases();
  const txs = await listTransactions();
  const recovered = await recoverTransactions(landFilter ? txs.filter((tx) => tx.landId === landFilter) : txs);
  return `区块 ${claims}，默认区域 ${areas}，到期租约 ${expired}，交易续跑 ${recovered}`;
}

/** 列出未完成交易，供管理员对照经济流水。 */
export async function openTransactions(token?: string): Promise<string[]> {
  const landId = token ? requireLand(token).id : undefined;
  const rows = await listTransactions();
  return rows
    .filter((tx) => (!landId || tx.landId === landId) && tx.status !== "applied")
    .slice(0, 20)
    .map((tx) => `${tx.id} ${tx.kind} ${tx.status} ${tx.amount} ${tx.error}`);
}

/** 启动加载用的索引引用检查，避免修复函数在索引未就绪时被调度器调用。 */
export function indexReady(index: WorldIndex | undefined): index is WorldIndex {
  return Boolean(index?.ready);
}
