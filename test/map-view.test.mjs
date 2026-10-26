import test from "node:test";
import assert from "node:assert/strict";
import harness from "./harness.cjs";

/** harness 在独立 vm 上下文里执行源码，返回值原型来自另一 realm；比较前转成本 realm 的普通对象。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 造一块领地及其默认区域。claimKeys 由 upsertClaim 填充。 */
function landRow(id, name, ownerId) {
  return {
    id,
    name,
    nameKey: name.toLowerCase(),
    description: "",
    ownerId,
    ownerName: `${ownerId}-name`,
    status: "active",
    level: 2,
    spawn: null,
    bankAccount: `land:${id}`,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    nextUpkeepAt: Number.MAX_SAFE_INTEGER,
    graceUntil: 0,
    upkeepDue: 0,
    taxEnabled: false,
    taxAmount: 0,
    taxPeriodMs: 86400000,
    nextTaxAt: Number.MAX_SAFE_INTEGER,
    claimKeys: [],
    defaultAreaId: `default-${id}`,
  };
}

function defaultArea(landId) {
  return {
    id: `default-${landId}`,
    landId,
    name: "Default",
    nameKey: "default",
    description: "",
    kind: "default",
    dimensionId: "",
    box: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function fixture(t) {
  const rig = await harness.createHarness();
  t.after(() => rig.sql.close());
  const { repo, index } = rig;
  for (const land of [landRow("b", "Beta", "u2"), landRow("a", "Alpha", "u1")]) {
    await repo.insertLand(land);
    index.upsertLand(land);
    const area = defaultArea(land.id);
    await repo.insertArea(area);
    index.upsertArea(area);
  }
  const room = {
    ...defaultArea("a"),
    id: "room",
    name: "Room",
    nameKey: "room",
    kind: "box",
    dimensionId: "minecraft:overworld",
    box: { min: { x: 0, y: 60, z: 0 }, max: { x: 8, y: 70, z: 4 } },
  };
  await repo.insertArea(room);
  index.upsertArea(room);
  const claims = [
    ["a", "minecraft:overworld", 0, 0],
    ["a", "minecraft:overworld", 1, 0],
    ["a", "minecraft:nether", -3, 5],
  ];
  for (const [landId, dimensionId, chunkX, chunkZ] of claims) {
    const key = `${dimensionId}|${chunkX}|${chunkZ}`;
    const claim = { id: `claim-${key}`, key, dimensionId, chunkX, chunkZ, landId, createdAt: 1 };
    await repo.insertClaim(claim);
    index.upsertClaim(claim.key, claim.id, claim.landId);
  }
  return { ...rig, mapView: rig.load("services/map-view.ts"), geometry: rig.load("domain/geometry.ts") };
}

test("parseClaimKey reverses claimKey and rejects malformed keys", async (t) => {
  const rig = await fixture(t);
  const { claimKey, parseClaimKey } = rig.geometry;
  assert.deepEqual(plain(parseClaimKey(claimKey("minecraft:overworld", -2, 7))), {
    dimensionId: "minecraft:overworld",
    chunkX: -2,
    chunkZ: 7,
  });
  assert.equal(parseClaimKey("minecraft:overworld|1"), null);
  assert.equal(parseClaimKey("minecraft:overworld|x|1"), null);
  assert.equal(parseClaimKey("|1|2"), null);
});

test("land.map projects claims by dimension and box areas with inclusive bounds", async (t) => {
  const rig = await fixture(t);
  const { lands } = rig.mapView.landMapView(rig.index);
  assert.deepEqual(
    plain(lands.map((land) => land.id)),
    ["a", "b"],
  );
  const alpha = lands[0];
  assert.equal(alpha.name, "Alpha");
  assert.equal(alpha.ownerName, "u1-name");
  assert.equal(alpha.status, "active");
  assert.equal(alpha.level, 2);
  assert.deepEqual(plain(alpha.claims), [
    { dimensionId: "minecraft:nether", chunks: [[-3, 5]] },
    {
      dimensionId: "minecraft:overworld",
      chunks: [
        [0, 0],
        [1, 0],
      ],
    },
  ]);
  assert.deepEqual(plain(alpha.areas), [
    {
      id: "room",
      name: "Room",
      dimensionId: "minecraft:overworld",
      minX: 0,
      minY: 60,
      minZ: 0,
      maxX: 7,
      maxY: 69,
      maxZ: 3,
    },
  ]);
  assert.equal(lands[1].claims.length, 0);
  assert.equal(lands[1].areas.length, 0);
  assert.equal("bankAccount" in alpha, false);
});

test("land.map dimension filter keeps only that dimension and skips empty lands", async (t) => {
  const rig = await fixture(t);
  const nether = rig.mapView.landMapView(rig.index, "minecraft:nether").lands;
  assert.deepEqual(
    plain(nether.map((land) => [land.id, land.claims, land.areas.length])),
    [["a", [{ dimensionId: "minecraft:nether", chunks: [[-3, 5]] }], 0]],
  );
  assert.equal(rig.mapView.landMapView(rig.index, "minecraft:the_end").lands.length, 0);
});
