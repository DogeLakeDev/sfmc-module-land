/**
 * 管理员维护（合并领地、按前缀清理子区域、等级重排）的回归测试。
 * 场景与 iland 迁移后的实际数据一致：同一领主的多块相邻小领地，每块带一个整块大小的子区域，部分领地有受信任成员。
 */
import test from "node:test";
import assert from "node:assert/strict";
import harness from "./harness.cjs";

const owner = { id: "owner", name: "甲", admin: false, console: false };
const other = { id: "other", name: "乙", admin: false, console: false };
const friend = { id: "friend", name: "朋友" };
const admin = { id: "console", name: "console", admin: true, console: true };
const overworld = "minecraft:overworld";

/** harness 在独立 vm 上下文里执行源码，比较前转成本 realm 的普通对象。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 在区块 (chunkX, 0) 创建一块领地。 */
function landAt(rig, actor, name, chunkX) {
  return rig.load("services/territory.ts").createLand(actor, name, "", {
    dimensionId: overworld, x: chunkX * 16 + 1, y: 64, z: 1, yaw: 0, pitch: 0,
  });
}

/** 在区块 (chunkX, 0) 内建一个子区域；offset 让同一区块内的多个子区域互不重叠。 */
function areaAt(rig, land, name, chunkX, offset = 0) {
  return rig.load("services/territory.ts").createArea(
    owner,
    land.id,
    name,
    { dimensionId: overworld, x: chunkX * 16 + offset, y: 60, z: 0 },
    { dimensionId: overworld, x: chunkX * 16 + offset + 5, y: 65, z: 5 },
  );
}

/**
 * 主地(0) — 东地(1) — 西地(2) 相连并属于甲；远地(9) 属于甲但不相连；他人地(3) 与西地相邻但属于乙。
 * 东地带“原领地-aaa”与受信任成员朋友；西地带“原领地-bbb”和“小屋”。
 */
async function fixture(t) {
  const rig = await harness.createHarness();
  t.after(() => rig.sql.close());
  // 默认每人 3 块领地，夹具需要甲持有 4 块
  rig.config.quotas.lands = 10;
  rig.economy.balances.set(owner.id, 100000);
  rig.economy.balances.set(other.id, 100000);
  const main = await landAt(rig, owner, "主地", 0);
  const east = await landAt(rig, owner, "东地", 1);
  const west = await landAt(rig, owner, "西地", 2);
  const far = await landAt(rig, owner, "远地", 9);
  const foreign = await landAt(rig, other, "他人地", 3);
  await areaAt(rig, east, "原领地-aaa", 1);
  await areaAt(rig, west, "原领地-bbb", 2);
  await areaAt(rig, west, "小屋", 2, 8);
  // 与线上数据一致：受信任成员持有 member 预设角色
  const memberRole = rig.index.rolesOf(east.id).find((role) => role.preset === "member");
  await rig.load("services/people.ts").trust(owner, east.id, friend, memberRole.id);
  return { rig, main, east, west, far, foreign };
}

test("@connected merges only same-owner lands linked by chunk adjacency", async (t) => {
  const { rig, main, east, west } = await fixture(t);
  const { planMerge } = rig.load("services/consolidate.ts");
  const plan = await planMerge(admin, main.name, "@connected");
  assert.deepEqual(plain(plan.sources.map((land) => land.name)).sort(), ["东地", "西地"]);
  assert.equal(plan.chunks, 3);
  assert.equal(plan.areas.length, 3);
  assert.equal(plan.newAreaRoles.length, 1);
  assert.ok(rig.index.lands.has(east.id) && rig.index.lands.has(west.id), "预览不写入");
});

test("merge moves claims, areas and members into the target and deletes the sources", async (t) => {
  const { rig, main, east, west } = await fixture(t);
  const { mergeLands } = rig.load("services/consolidate.ts");
  await mergeLands(admin, main.id, "@connected");
  const index = rig.index;
  assert.equal(index.lands.has(east.id) || index.lands.has(west.id), false);
  assert.equal(index.lands.get(main.id).claimKeys.length, 3);
  for (const x of [0, 1, 2]) assert.equal(index.claims.get(`${overworld}|${x}|0`), main.id);
  assert.deepEqual(plain(index.areasOf(main.id).filter((area) => area.kind === "box").map((area) => area.name)).sort(), ["原领地-aaa", "原领地-bbb", "小屋"]);
  // 朋友只在东地原有的子区域内保留成员角色，不成为整块合并领地的成员
  assert.equal(index.member(main.id, friend.id), undefined);
  const aaa = index.areaByName(main.id, "原领地-aaa");
  const grant = index.areaRoles.get(`${aaa.id}|${friend.id}`);
  assert.equal(index.roles.get(grant.roleId).landId, main.id);
  assert.equal(index.roles.get(grant.roleId).preset, "member");
  // 数据库与索引一致：来源领地的全部行已删除，区块与子区域改挂到目标
  const count = (sql, ...args) => rig.sql.prepare(sql).get(...args).n;
  assert.equal(count("SELECT COUNT(*) n FROM land2_land WHERE id IN (?, ?)", east.id, west.id), 0);
  assert.equal(count("SELECT COUNT(*) n FROM land2_claim WHERE land_id = ?", main.id), 3);
  assert.equal(count("SELECT COUNT(*) n FROM land2_area WHERE land_id = ?", main.id), 4);
  assert.equal(count("SELECT COUNT(*) n FROM land2_role WHERE land_id IN (?, ?)", east.id, west.id), 0);
  assert.equal(count("SELECT COUNT(*) n FROM land2_member WHERE land_id IN (?, ?)", east.id, west.id), 0);
  assert.equal(count("SELECT COUNT(*) n FROM land2_area_role WHERE land_id = ?", main.id), 1);
  // 重启后从库重建的索引与合并后一致
  const again = await rig.restart();
  assert.equal(again.index.lands.get(main.id).claimKeys.length, 3);
  assert.deepEqual(plain(rig.load("services/admin.ts").diagnose(main.id)), ["未发现一致性问题"]);
  assert.ok(rig.events.some((event) => event.event === "land.merged" && event.landId === main.id));
  assert.equal(rig.events.filter((event) => event.event === "land.deleted" && event.mergedInto === main.id).length, 2);
});

test("merge refuses lands of another owner, itself, and lands with a bank balance", async (t) => {
  const { rig, main, far, foreign } = await fixture(t);
  const { planMerge } = rig.load("services/consolidate.ts");
  await assert.rejects(planMerge(admin, main.id, foreign.id), (error) => error.key === "merge_owner");
  await assert.rejects(planMerge(admin, main.id, main.id), (error) => error.key === "merge_self");
  rig.economy.balances.set(far.bankAccount, 5);
  await assert.rejects(planMerge(admin, main.id, far.id), (error) => error.key === "merge_blocked");
  await assert.rejects(planMerge(owner, main.id, far.id), (error) => error.key === "no_permission");
});

test("merge raises the target to the lowest level that fits the merged chunks, never lowering it", async (t) => {
  const { rig, main } = await fixture(t);
  const { mergeLandConfig } = rig.load("config.ts");
  rig.load("services/shared.ts").replaceConfig(mergeLandConfig({
    levels: [{ level: 1, chunks: 1 }, { level: 2, chunks: 2 }, { level: 3, chunks: 4 }],
  }));
  const plan = await rig.load("services/consolidate.ts").mergeLands(admin, main.id, "@connected");
  assert.equal(plan.level, 3);
  assert.equal(rig.index.lands.get(main.id).level, 3);
  assert.equal(rig.sql.prepare("SELECT level FROM land2_land WHERE id = ?").get(main.id).level, 3);
});

test("prune deletes prefixed areas without own data and keeps those with grants", async (t) => {
  const { rig, main } = await fixture(t);
  const consolidate = rig.load("services/consolidate.ts");
  await consolidate.mergeLands(admin, main.id, "@connected");
  const preview = consolidate.planPrune(admin, main.id, "原领地-");
  assert.deepEqual(plain(preview.removable.map((area) => area.name)), ["原领地-bbb"]);
  assert.deepEqual(plain(preview.kept.map((area) => area.name)), ["原领地-aaa"]);
  await consolidate.pruneAreas(admin, main.id, "原领地-");
  assert.deepEqual(plain(rig.index.areasOf(main.id).filter((area) => area.kind === "box").map((area) => area.name)).sort(), ["原领地-aaa", "小屋"]);
  assert.throws(() => consolidate.planPrune(admin, main.id, " "), (error) => error.key === "bad_name");
});

test("relevel raises only lands whose chunk count exceeds their level cap", async (t) => {
  const { rig, main, far } = await fixture(t);
  const consolidate = rig.load("services/consolidate.ts");
  await rig.load("services/territory.ts").claimChunks(owner, main.id, [{ dimensionId: overworld, chunkX: 0, chunkZ: 1 }]);
  const { mergeLandConfig } = rig.load("config.ts");
  rig.load("services/shared.ts").replaceConfig(mergeLandConfig({
    levels: [{ level: 1, chunks: 1 }, { level: 2, chunks: 2 }, { level: 3, chunks: 4 }],
  }));
  const preview = consolidate.planRelevel(admin);
  assert.deepEqual(plain(preview.map((change) => [change.land.name, change.from, change.to])), [["主地", 1, 2]]);
  await consolidate.relevelLands(admin);
  assert.equal(rig.index.lands.get(main.id).level, 2);
  assert.equal(rig.index.lands.get(far.id).level, 1);
  assert.equal(consolidate.planRelevel(admin).length, 0);
});

test("a level cap of -1 is unlimited for members and areas", async (t) => {
  const { rig, main } = await fixture(t);
  const { mergeLandConfig } = rig.load("config.ts");
  rig.load("services/shared.ts").replaceConfig(mergeLandConfig({
    levels: [{ level: 1, chunks: 16, members: -1, areas: -1, roles: 8 }],
  }));
  const { builtinQuota, isUnlimited } = rig.load("services/quota.ts");
  const config = rig.load("services/shared.ts").landConfig();
  for (const id of ["members", "areas"]) {
    const view = builtinQuota(config, rig.index, owner, rig.index.lands.get(main.id), id);
    assert.ok(isUnlimited(view.limit) && view.ok, id);
  }
  assert.equal(builtinQuota(config, rig.index, owner, rig.index.lands.get(main.id), "roles").limit, 8);
  const people = rig.load("services/people.ts");
  for (let i = 0; i < 12; i += 1) await people.trust(owner, main.id, { id: `p${i}`, name: `玩家${i}` });
  assert.equal(rig.index.membersOf(main.id).filter((member) => member.relation === "trusted").length, 12);
});

test("admin_merge without confirm only previews", async (t) => {
  const { rig, main, east } = await fixture(t);
  const router = rig.load("commands/router.ts");
  await router.execLandCommand(undefined, "admin_merge", [main.name, "@connected"]);
  assert.ok(rig.index.lands.has(east.id));
  assert.ok(rig.messages.some((item) => Array.isArray(item) && item[0] === "merge_preview"));
  await router.execLandCommand(undefined, "admin_merge", [main.name, "@connected", "confirm"]);
  assert.equal(rig.index.lands.has(east.id), false);
  assert.ok(rig.messages.some((item) => Array.isArray(item) && item[0] === "merged"));
});
