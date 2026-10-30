/**
 * 子区域优先于区块归属的回归测试。
 * 场景来自迁移遗留数据：甲的子区域越出甲的区块，延伸进乙的领地和荒野；甲在该子区域内仍保有领主权限。
 */
import test from "node:test";
import assert from "node:assert/strict";
import harness from "./harness.cjs";

const owner = { id: "owner", name: "甲", admin: false, console: false };
const other = { id: "other", name: "乙", admin: false, console: false };
const overworld = "minecraft:overworld";

/** 在区块 (chunkX, 0) 创建一块领地。 */
function landAt(rig, actor, name, chunkX) {
  return rig.load("services/territory.ts").createLand(actor, name, "", {
    dimensionId: overworld, x: chunkX * 16 + 1, y: 64, z: 1, yaw: 0, pitch: 0,
  });
}

/**
 * 甲占区块 0、乙占区块 1，区块 -1 为荒野。
 * 先按正常流程在甲区块内建子区域，再直接改写索引中的边界，模拟迁移留下的越界子区域：X 范围 [-8, 24)。
 */
async function fixture(t) {
  const rig = await harness.createHarness();
  t.after(() => rig.sql.close());
  rig.economy.balances.set(owner.id, 100000);
  rig.economy.balances.set(other.id, 100000);
  const mine = await landAt(rig, owner, "甲地", 0);
  const theirs = await landAt(rig, other, "乙地", 1);
  const area = await rig.load("services/territory.ts").createArea(
    owner,
    mine.id,
    "越界屋",
    { dimensionId: overworld, x: 0, y: 60, z: 0 },
    { dimensionId: overworld, x: 5, y: 65, z: 5 },
  );
  rig.index.upsertArea({
    ...area,
    box: { min: { x: -8, y: 60, z: 0 }, max: { x: 24, y: 66, z: 6 } },
  });
  return { rig, mine, theirs, area };
}

test("an area overflowing into another land is resolved to the area's own land", async (t) => {
  const { rig, mine, area } = await fixture(t);
  const { decide } = rig.load("services/permission.ts");
  const located = rig.index.locate(overworld, 20, 62, 2);
  assert.equal(located.land.id, mine.id);
  assert.equal(located.area.id, area.id);
  assert.equal(located.specific, true);
  assert.equal(decide(rig.index, owner, "block.break", located, false).allow, true);
  assert.equal(decide(rig.index, other, "block.break", located, false).allow, false);
});

test("an area overflowing into wilderness still protects that space", async (t) => {
  const { rig, mine, area } = await fixture(t);
  const located = rig.index.locate(overworld, -4, 62, 2);
  assert.equal(located.land.id, mine.id);
  assert.equal(located.area.id, area.id);
  // 子区域之外的荒野保持原样
  assert.equal(rig.index.locate(overworld, -4, 70, 2), undefined);
});

test("the foreign land keeps its chunk outside the overflowing area", async (t) => {
  const { rig, theirs } = await fixture(t);
  const { decide } = rig.load("services/permission.ts");
  const located = rig.index.locate(overworld, 20, 70, 2);
  assert.equal(located.land.id, theirs.id);
  assert.equal(located.specific, false);
  assert.equal(decide(rig.index, other, "block.break", located, false).allow, true);
  assert.equal(decide(rig.index, owner, "block.break", located, false).allow, false);
});
