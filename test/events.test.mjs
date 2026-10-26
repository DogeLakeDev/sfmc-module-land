import test from "node:test";
import assert from "node:assert/strict";
import harness from "./harness.cjs";

const actor = { id: "owner", name: "Owner", admin: false, console: false };
const flush = () => new Promise(setImmediate);

async function fixture(t, relation = "member") {
  const rig = await harness.createHarness();
  t.after(() => rig.sql.close());
  const { repo, index } = rig;
  const land = {
    id: "a",
    name: "A",
    nameKey: "a",
    description: "",
    ownerId: actor.id,
    ownerName: actor.name,
    status: "active",
    level: 1,
    spawn: null,
    bankAccount: "land:a",
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
    defaultAreaId: "default-a",
  };
  const defaultArea = {
    id: "default-a",
    landId: "a",
    name: "Default",
    nameKey: "default",
    description: "",
    kind: "default",
    dimensionId: "",
    box: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const area = {
    ...defaultArea,
    id: "room",
    name: "Room",
    nameKey: "room",
    kind: "box",
    dimensionId: "minecraft:overworld",
    box: { min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 100, z: 8 } },
  };
  const role = {
    id: "role",
    landId: "a",
    name: "Builder",
    nameKey: "builder",
    description: "",
    permissions: ["block.break"],
    reserved: false,
    preset: "",
    createdAt: 1,
    updatedAt: 1,
  };
  const replacement = {
    ...role,
    id: "replacement",
    name: "Visitor",
    nameKey: "visitor",
    permissions: [],
  };
  const member = {
    id: "member",
    landId: "a",
    playerId: "guest",
    playerName: "Guest",
    relation,
    roleId: "role",
    createdAt: 1,
    updatedAt: 1,
  };
  const grant = {
    id: "grant",
    landId: "a",
    areaId: "room",
    playerId: "guest",
    roleId: "role",
  };
  for (const item of [land]) {
    await repo.insertLand(item);
    index.upsertLand(item);
  }
  for (const item of [defaultArea, area]) {
    await repo.insertArea(item);
    index.upsertArea(item);
  }
  for (const item of [role, replacement]) {
    await repo.insertRole(item);
    index.upsertRole(item);
  }
  await repo.insertMember(member);
  index.upsertMember(member);
  await repo.insertAreaRole(grant);
  index.upsertAreaRole(grant);
  const tables = rig.load("store/tables.ts").TABLES;
  return {
    ...rig,
    land,
    area,
    member,
    grant,
    role,
    replacement,
    tables,
    people: rig.load("services/people.ts"),
  };
}

test("kick commits member and area revocation before notifying permission consumers", async (t) => {
  const rig = await fixture(t);
  rig.faults.set("db.commit", () => {
    assert.equal(rig.events.length, 0);
    assert.ok(rig.index.member("a", "guest"));
    assert.ok(rig.index.areaRoles.get("room|guest"));
  });
  await rig.people.kick(actor, "a", "guest");
  assert.equal((await rig.repo.listMembers()).length, 0);
  assert.equal((await rig.repo.listAreaRoles()).length, 0);
  assert.equal(rig.index.member("a", "guest"), undefined);
  assert.equal(rig.index.areaRoles.get("room|guest"), undefined);
  const event = rig.events.find(
    (item) => item.event === "land.permission.changed",
  );
  assert.equal(event.playerId, "guest");
  assert.equal(event.relation, "removed");
  assert.equal(JSON.stringify(event.revokedAreaIds), '["room"]');
});

test("failed multi-step revocation rolls back storage, index and successful notifications", async (t) => {
  const rig = await fixture(t);
  rig.faults.set("db.delete", ({ table }) => {
    if (table === rig.tables.areaRole) throw new Error("area delete failed");
  });
  await assert.rejects(
    rig.people.kick(actor, "a", "guest"),
    /area delete failed/,
  );
  assert.equal((await rig.repo.listMembers()).length, 1);
  assert.equal((await rig.repo.listAreaRoles()).length, 1);
  assert.ok(rig.index.member("a", "guest"));
  assert.ok(rig.index.areaRoles.get("room|guest"));
  assert.equal(rig.events.length, 0);
});

test("untrust and unban notify permission consumers", async (t) => {
  for (const [method, relation, expected] of [
    ["untrust", "trusted", "untrusted"],
    ["unban", "banned", "unbanned"],
  ]) {
    await t.test(method, async (t) => {
      const rig = await fixture(t, relation);
      await rig.people[method](actor, "a", "guest");
      assert.equal(
        rig.events.filter((item) => item.event === "land.permission.changed")
          .length,
        1,
      );
      assert.equal(
        rig.events.find((item) => item.event === "land.permission.changed")
          .relation,
        expected,
      );
    });
  }
});

test("ban failures preserve old member and grants; successful retry revokes them atomically", async (t) => {
  const rig = await fixture(t);
  rig.faults.set("db.update", ({ table }) => {
    if (table === rig.tables.member) throw new Error("member update failed");
  });
  await assert.rejects(
    rig.people.ban(actor, "a", { id: "guest", name: "Guest" }),
    /member update failed/,
  );
  assert.equal((await rig.repo.listMembers())[0].relation, "member");
  assert.equal((await rig.repo.listAreaRoles()).length, 1);
  assert.ok(rig.index.areaRoles.get("room|guest"));
  assert.equal(rig.events.length, 0);
  rig.faults.clear();
  await rig.people.ban(actor, "a", { id: "guest", name: "Guest" });
  assert.equal(rig.index.member("a", "guest").relation, "banned");
  assert.equal((await rig.repo.listAreaRoles()).length, 0);
  assert.equal(
    rig.events.find((item) => item.event === "land.permission.changed")
      .relation,
    "banned",
  );
});

test("deleting a role publishes replacement invalidation only after all assignments commit", async (t) => {
  const rig = await fixture(t);
  rig.faults.set("db.delete", ({ table }) => {
    if (table === rig.tables.role) throw new Error("role delete failed");
  });
  await assert.rejects(
    rig.people.deleteRole(actor, "a", "role", "replacement"),
    /role delete failed/,
  );
  assert.equal((await rig.repo.listMembers())[0].roleId, "role");
  assert.equal((await rig.repo.listAreaRoles())[0].roleId, "role");
  assert.ok(rig.index.roles.get("role"));
  assert.equal(rig.events.length, 0);
  rig.faults.clear();
  await rig.people.deleteRole(actor, "a", "role", "replacement");
  assert.equal(rig.index.roles.has("role"), false);
  assert.equal(rig.index.member("a", "guest").roleId, "replacement");
  assert.equal(rig.index.areaRoles.get("room|guest").roleId, "replacement");
  const event = rig.events.find(
    (item) => item.event === "land.permission.changed",
  );
  assert.equal(event.op, "role_deleted");
  assert.equal(event.replacementRoleId, "replacement");
  assert.equal(JSON.stringify(event.playerIds), '["guest"]');
  assert.equal(JSON.stringify(event.areaIds), '["room"]');
});

test("area role updates notify after success and do not nest the public write lock", async (t) => {
  const rig = await fixture(t);
  rig.faults.set("db.update", ({ table }) => {
    if (table === rig.tables.areaRole) throw new Error("grant update failed");
  });
  await assert.rejects(
    rig.people.assignAreaRole(actor, "a", "room", "guest", "replacement"),
    /grant update failed/,
  );
  assert.equal(rig.index.areaRoles.get("room|guest").roleId, "role");
  assert.equal(rig.events.length, 0);
  rig.faults.clear();
  await rig.people.assignAreaRole(actor, "a", "room", "guest", "replacement");
  const event = rig.events.find(
    (item) => item.event === "land.permission.changed",
  );
  assert.equal(event.playerId, "guest");
  assert.equal(event.areaId, "room");
  assert.equal(event.roleId, "replacement");
});

test("actual presence scan orders adjacent transitions even while a subscriber waits, and cleans up logout", async (t) => {
  const rig = await fixture(t);
  const { repo, index } = rig;
  const otherLand = {
    ...rig.land,
    id: "b",
    name: "B",
    nameKey: "b",
    claimKeys: [],
    defaultAreaId: "default-b",
  };
  const otherDefault = {
    ...rig.area,
    id: "default-b",
    landId: "b",
    kind: "default",
    box: null,
  };
  await repo.insertLand(otherLand);
  index.upsertLand(otherLand);
  await repo.insertArea(otherDefault);
  index.upsertArea(otherDefault);
  for (const [landId, chunkX] of [
    ["a", 0],
    ["b", 1],
  ]) {
    const claim = {
      id: `claim-${landId}`,
      key: `minecraft:overworld|${chunkX}|0`,
      dimensionId: "minecraft:overworld",
      chunkX,
      chunkZ: 0,
      landId,
      createdAt: 1,
    };
    await repo.insertClaim(claim);
    index.upsertClaim(claim.key, claim.id, claim.landId);
  }
  let particles = 0;
  const player = {
    id: "guest",
    dimension: { id: "minecraft:overworld" },
    location: { x: 10, y: 64, z: 2 },
    spawnParticle() {
      particles++;
    },
  };
  rig.players.push(player);
  const loops = rig.load("runtime/loops.ts");
  const stop = loops.startLoops();
  t.after(stop);
  const scan = rig.callbacks.get(0);
  const border = rig.callbacks.get(1);
  scan();
  await flush();
  rig.events.length = 0;
  const gate = harness.deferred();
  const hooks = rig.load("services/hooks.ts");
  const record = hooks.afterEvent;
  hooks.afterEvent = async (event, payload) => {
    if (
      event === "land.left" &&
      payload.landId === "a" &&
      payload.toLandId === "b"
    )
      await gate.promise;
    await record(event, payload);
  };
  player.location.x = 20;
  scan();
  await flush();
  player.location.x = 10;
  scan();
  await flush();
  assert.equal(rig.events.length, 0);
  gate.resolve();
  await flush();
  assert.deepEqual(
    rig.events.map((item) => [item.event, item.landId]),
    [
      ["land.left", "a"],
      ["land.entered", "b"],
      ["land.left", "b"],
      ["land.entered", "a"],
    ],
  );
  rig.events.length = 0;
  player.location.x = 2;
  scan();
  await flush();
  player.location.x = 10;
  scan();
  await flush();
  assert.deepEqual(
    rig.events.map((item) => [item.event, item.areaId]),
    [
      ["land.left", ""],
      ["land.entered", "room"],
      ["land.left", "room"],
      ["land.entered", ""],
    ],
  );
  loops.showBorder("guest");
  rig.events.length = 0;
  rig.players.length = 0;
  scan();
  await flush();
  assert.equal(rig.events.length, 1);
  assert.equal(rig.events[0].event, "land.left");
  assert.equal(rig.events[0].reason, "offline");
  scan();
  await flush();
  assert.equal(rig.events.length, 1);
  rig.players.push(player);
  border();
  assert.equal(particles, 0);
});

test("presence scan shows sub-area enter/leave notices and honours per-scope flags", async (t) => {
  const rig = await fixture(t);
  const { repo, index } = rig;
  const otherLand = { ...rig.land, id: "b", name: "B", nameKey: "b", claimKeys: [], defaultAreaId: "default-b" };
  const otherDefault = { ...rig.area, id: "default-b", landId: "b", kind: "default", box: null };
  const garden = {
    ...rig.area,
    id: "garden",
    name: "Garden",
    nameKey: "garden",
    box: { min: { x: 10, y: 0, z: 0 }, max: { x: 15, y: 100, z: 8 } },
  };
  await repo.insertLand(otherLand);
  index.upsertLand(otherLand);
  for (const item of [otherDefault, garden]) {
    await repo.insertArea(item);
    index.upsertArea(item);
  }
  for (const [landId, chunkX] of [
    ["a", 0],
    ["b", 1],
  ]) {
    const claim = {
      id: `claim-${landId}`,
      key: `minecraft:overworld|${chunkX}|0`,
      dimensionId: "minecraft:overworld",
      chunkX,
      chunkZ: 0,
      landId,
      createdAt: 1,
    };
    await repo.insertClaim(claim);
    index.upsertClaim(claim.key, claim.id, claim.landId);
  }
  const player = { id: "guest", dimension: { id: "minecraft:overworld" }, location: { x: 12, y: 64, z: 12 } };
  rig.players.push(player);
  const loops = rig.load("runtime/loops.ts");
  t.after(loops.startLoops());
  const scan = rig.callbacks.get(0);
  const seen = () =>
    rig.messages
      .splice(0)
      .map((item) => (String(item[0]).startsWith("#") ? item : [item[0], item[1].land, item[1].area, item[2]]));
  const moveTo = async (x, z) => {
    player.location.x = x;
    player.location.z = z;
    scan();
    await flush();
    return seen();
  };

  assert.deepEqual(await moveTo(12, 12), [["entered", "A", "", "info"]]);
  assert.deepEqual(await moveTo(2, 2), [["entered_area", "A", "Room", "tips"]]);
  assert.deepEqual(await moveTo(12, 2), [
    ["left_area", "A", "Room", "tips"],
    ["entered_area", "A", "Garden", "tips"],
  ]);
  assert.deepEqual(await moveTo(12, 12), [["left_area", "A", "Garden", "tips"]]);
  await moveTo(2, 2);
  assert.deepEqual(await moveTo(20, 2), [
    ["left_area", "A", "Room", "tips"],
    ["left", "A", "Room", "tips"],
    ["entered", "B", "", "info"],
  ]);

  // 子区域自定义文案只作用于子区域提示；领地 leave_text 生效；子区域关闭离开提示只影响它自己
  index.setFlag("f1", "garden", "enter_text", "欢迎来到 {area}@{land}（{owner}）");
  index.setFlag("f2", "b", "leave_text", "再见 {land}");
  index.setFlag("f3", "room", "leave_message", false);
  assert.deepEqual(await moveTo(12, 2), [
    ["#tips", "再见 B"],
    ["entered", "A", "Garden", "info"],
    ["#tips", "欢迎来到 Garden@A（Owner）"],
  ]);
  assert.deepEqual(await moveTo(2, 2), [
    ["left_area", "A", "Garden", "tips"],
    ["entered_area", "A", "Room", "tips"],
  ]);
  assert.deepEqual(await moveTo(12, 12), []);
});
