import test from "node:test";
import assert from "node:assert/strict";
import harness from "./harness.cjs";

/** 用 "x,z" → 领地 ID 的表构造 landAt 查询函数。 */
function lookup(table) {
  return (chunkX, chunkZ) => table[`${chunkX},${chunkZ}`];
}

/** 把边归一化成可比较的字符串，忽略端点方向与输出顺序；Array.from 转成本 realm 数组以便 deepEqual。 */
function edgeKeys(edges, own) {
  return Array.from(edges)
    .filter((edge) => edge.own === own)
    .map((edge) => {
      const a = `${edge.x1},${edge.z1}`;
      const b = `${edge.x2},${edge.z2}`;
      return a < b ? `${a}-${b}` : `${b}-${a}`;
    })
    .sort();
}

function cornerKeys(corners, own) {
  return Array.from(corners)
    .filter((corner) => corner.own === own)
    .map((corner) => `${corner.x},${corner.z}`)
    .sort();
}

test("border outline skips inner seams, marks corners and lets the target own shared edges", async (t) => {
  const rig = await harness.createHarness();
  t.after(() => rig.sql.close());
  const { borderShape } = rig.load("runtime/border-shape.ts");
  const center = { chunkX: 0, chunkZ: 0 };

  await t.test("single chunk has four edges and four corners", () => {
    const shape = borderShape(lookup({ "0,0": "a" }), center, 2, "a", true);
    assert.deepEqual(edgeKeys(shape.edges, true), ["0,0-0,16", "0,0-16,0", "0,16-16,16", "16,0-16,16"]);
    assert.deepEqual(cornerKeys(shape.corners, true), ["0,0", "0,16", "16,0", "16,16"]);
  });

  await t.test("two chunks of one land do not draw the seam between them", () => {
    const shape = borderShape(lookup({ "0,0": "a", "1,0": "a" }), center, 2, "a", true);
    assert.equal(edgeKeys(shape.edges, true).length, 6);
    assert.ok(!edgeKeys(shape.edges, true).includes("16,0-16,16"));
    assert.deepEqual(cornerKeys(shape.corners, true), ["0,0", "0,16", "32,0", "32,16"]);
  });

  await t.test("L shape includes the concave corner", () => {
    const shape = borderShape(lookup({ "0,0": "a", "1,0": "a", "0,1": "a" }), center, 2, "a", true);
    assert.equal(edgeKeys(shape.edges, true).length, 8);
    assert.deepEqual(cornerKeys(shape.corners, true), ["0,0", "0,32", "16,16", "16,32", "32,0", "32,16"]);
  });

  await t.test("shared edge with another land is drawn once as the target", () => {
    const shape = borderShape(lookup({ "0,0": "a", "1,0": "b" }), center, 2, "a", true);
    assert.ok(edgeKeys(shape.edges, true).includes("16,0-16,16"));
    assert.ok(!edgeKeys(shape.edges, false).includes("16,0-16,16"));
    assert.equal(edgeKeys(shape.edges, false).length, 3);
    assert.deepEqual(cornerKeys(shape.corners, false), ["32,0", "32,16"]);
    assert.ok(shape.edges.findIndex((edge) => !edge.own) > shape.edges.findLastIndex((edge) => edge.own));
  });

  await t.test("other lands are omitted when includeOthers is false", () => {
    const shape = borderShape(lookup({ "0,0": "a", "1,0": "b" }), center, 2, "a", false);
    assert.equal(edgeKeys(shape.edges, false).length, 0);
    assert.equal(cornerKeys(shape.corners, false).length, 0);
  });

  await t.test("diagonal chunks meet at a corner", () => {
    const shape = borderShape(lookup({ "0,0": "a", "1,1": "a" }), center, 2, "a", true);
    assert.ok(cornerKeys(shape.corners, true).includes("16,16"));
    assert.equal(edgeKeys(shape.edges, true).length, 8);
  });

  await t.test("without a target every land is treated as the target", () => {
    const shape = borderShape(lookup({ "0,0": "a", "1,0": "b" }), center, 2, undefined, false);
    assert.equal(edgeKeys(shape.edges, false).length, 0);
    assert.equal(edgeKeys(shape.edges, true).length, 8);
  });
});
