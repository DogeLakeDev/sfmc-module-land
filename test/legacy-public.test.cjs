/**
 * 公共角色（未入伙玩家的默认权限）与旧服占位身份绑定的回归测试。
 * 使用场景：iland 迁移依赖这两项扩展；迁移写入的数据形态与这里构造的行一致。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./harness.cjs");

const owner = { id: "owner", name: "甲", admin: false, console: false };
const stranger = { id: "stranger", name: "路人", admin: false, console: false };
const here = { dimensionId: "minecraft:overworld", x: 1, y: 64, z: 1, yaw: 0, pitch: 0 };
/** 子区域内、默认区域内的两个测试点。 */
const inside = [2, 62, 2];
const outside = [10, 62, 10];

async function fixture(t) {
  const rig = await createHarness();
  t.after(() => rig.sql.close());
  rig.economy.balances.set(owner.id, 10000);
  rig.economy.balances.set("xuid:111", 10000);
  return rig;
}

/** 创建一块领地并在其区块内 (0,60,0)-(5,65,5) 偏移 shift 格处建一个子区域；shift 用于让多块领地落在不同区块。 */
async function landWithArea(rig, actor = owner, name = "测试领地", shift = 0) {
  const territory = rig.load("services/territory.ts");
  const land = await territory.createLand(actor, name, "", { ...here, x: here.x + shift });
  const area = await territory.createArea(
    actor,
    land.id,
    "子区域",
    { dimensionId: here.dimensionId, x: shift, y: 60, z: 0 },
    { dimensionId: here.dimensionId, x: shift + 5, y: 65, z: 5 },
  );
  return { land, area };
}

function decideAt(rig, actor, permission, [x, y, z]) {
  const { decide } = rig.load("services/permission.ts");
  return decide(rig.index, actor, permission, rig.index.locate(here.dimensionId, x, y, z), false);
}

/** 直接写入一个角色（迁移脚本同样直接写 land2_role）。 */
async function addRole(rig, landId, key, permissions) {
  const role = {
    id: `role-${key}`,
    landId,
    name: key,
    nameKey: key,
    description: "",
    permissions,
    reserved: false,
    preset: "",
    createdAt: 1,
    updatedAt: 1,
  };
  await rig.repo.insertRole(role);
  rig.index.upsertRole(role);
  return role;
}

async function addAreaRole(rig, area, playerId, roleId) {
  const item = { id: `ar-${area.id}-${playerId}`, areaId: area.id, landId: area.landId, playerId, roleId };
  await rig.repo.insertAreaRole(item);
  rig.index.upsertAreaRole(item);
  return item;
}

async function addMember(rig, landId, playerId, playerName, roleId, relation = "member") {
  const member = { id: `m-${landId}-${playerId}`, landId, playerId, playerName, relation, roleId, createdAt: 1, updatedAt: 1 };
  await rig.repo.insertMember(member);
  rig.index.upsertMember(member);
  return member;
}

function presetRole(rig, landId, preset) {
  return rig.index.rolesOf(landId).find((role) => role.preset === preset);
}

test("new lands get a reserved public role that only lets strangers attack hostile mobs", async (t) => {
  const rig = await fixture(t);
  const { land } = await landWithArea(rig);
  const role = presetRole(rig, land.id, "public");
  assert.ok(role);
  assert.equal(role.reserved, true);
  assert.deepEqual(role.permissions, ["entity.attack_hostile"]);
  const hostile = decideAt(rig, stranger, "entity.attack_hostile", outside);
  assert.equal(hostile.allow, true);
  assert.equal(hostile.roleId, role.id);
  assert.equal(decideAt(rig, stranger, "entity.attack", outside).allow, false);
  assert.equal(decideAt(rig, stranger, "block.break", outside).allow, false);
});

test("the hurt guard checks entity.attack_hostile for hostile mobs and entity.attack for everything else", async (t) => {
  const rig = await fixture(t);
  await landWithArea(rig);
  rig.load("protection/guard.ts").registerProtection([]);
  const hurt = rig.callbacks.get("entityHurt");
  const attacker = { ...stranger, typeId: "minecraft:player" };
  const strike = (typeId) => {
    const event = {
      cancel: false,
      hurtEntity: { typeId, isValid: true, dimension: { id: here.dimensionId }, location: { x: 10, y: 62, z: 10 } },
      damageSource: { damagingEntity: attacker },
    };
    hurt(event);
    return event.cancel;
  };
  assert.equal(strike("minecraft:zombie"), false);
  assert.equal(strike("minecraft:cow"), true);
});

test("oak trapdoors, oak fence gates and note blocks use their real Bedrock IDs", async (t) => {
  const rig = await fixture(t);
  const { permissionForBlock } = rig.load("domain/blocks.ts");
  for (const id of ["minecraft:trapdoor", "minecraft:spruce_trapdoor", "minecraft:iron_trapdoor", "minecraft:fence_gate", "minecraft:birch_fence_gate", "minecraft:wooden_door", "minecraft:iron_door"]) {
    assert.equal(permissionForBlock(id), "door.use", id);
  }
  assert.equal(permissionForBlock("minecraft:noteblock"), "redstone.interact");
  assert.equal(permissionForBlock("minecraft:trapped_chest"), "container.open");
  assert.equal(permissionForBlock("minecraft:crafting_table"), "block.interact");
});

test("the public role never grants management permissions even if they are added to it", async (t) => {
  const rig = await fixture(t);
  const { land } = await landWithArea(rig);
  const role = presetRole(rig, land.id, "public");
  const widened = { ...role, permissions: [...role.permissions, "block.break", "member.manage", "bank.withdraw"] };
  rig.index.upsertRole(widened);
  assert.equal(decideAt(rig, stranger, "block.break", outside).allow, true);
  assert.equal(decideAt(rig, stranger, "member.manage", outside).allow, false);
  assert.equal(decideAt(rig, stranger, "bank.withdraw", outside).allow, false);
});

test("an area @public override replaces the land public role only inside that area", async (t) => {
  const rig = await fixture(t);
  const { land, area } = await landWithArea(rig);
  const open = await addRole(rig, land.id, "开放", ["container.open"]);
  await addAreaRole(rig, area, "@public", open.id);
  const inArea = decideAt(rig, stranger, "container.open", inside);
  assert.equal(inArea.allow, true);
  assert.equal(inArea.resolution, "explicit");
  assert.equal(decideAt(rig, stranger, "entity.attack_hostile", inside).allow, false);
  assert.equal(decideAt(rig, stranger, "container.open", outside).allow, false);
  assert.equal(decideAt(rig, stranger, "entity.attack_hostile", outside).allow, true);
});

test("members keep their own role and banned players never fall back to the public role", async (t) => {
  const rig = await fixture(t);
  const { land, area } = await landWithArea(rig);
  const open = await addRole(rig, land.id, "开放", ["container.open"]);
  await addAreaRole(rig, area, "@public", open.id);
  const visitor = presetRole(rig, land.id, "visitor");
  const friend = { id: "friend", name: "朋友", admin: false, console: false };
  await addMember(rig, land.id, friend.id, friend.name, visitor.id, "visitor");
  assert.equal(decideAt(rig, friend, "container.open", inside).allow, false);
  assert.equal(decideAt(rig, friend, "door.use", inside).allow, true);
  await addMember(rig, land.id, stranger.id, stranger.name, "", "banned");
  assert.equal(decideAt(rig, stranger, "entity.attack_hostile", outside).allow, false);
  assert.equal(decideAt(rig, stranger, "container.open", inside).allow, false);
});

test("lands without a public role keep the old deny-all behaviour for strangers", async (t) => {
  const rig = await fixture(t);
  const { land } = await landWithArea(rig);
  rig.index.removeRole(presetRole(rig, land.id, "public").id);
  assert.equal(decideAt(rig, stranger, "entity.attack_hostile", outside).allow, false);
});

test("legacy placeholder ownership, membership and area grants move to the real player on join", async (t) => {
  const rig = await fixture(t);
  const legacyOwner = { id: "xuid:111", name: "老甲", admin: false, console: false };
  const { land: legacyLand } = await landWithArea(rig, legacyOwner, "旧领地");
  const { land, area } = await landWithArea(rig, owner, "别人的领地", 32);
  const member = presetRole(rig, land.id, "member");
  await addMember(rig, land.id, "xuid:111", "老甲", member.id, "trusted");
  await addAreaRole(rig, area, "xuid:111", member.id);
  await rig.repo.saveIdentity("xuid:111", "老甲", "老甲");
  rig.index.rememberIdentity("xuid:111", "老甲");

  const legacy = rig.load("services/legacy.ts");
  assert.equal(await legacy.bindLegacyOnJoin({ id: "-2955", name: "老甲" }), 2);

  assert.equal(rig.index.lands.get(legacyLand.id).ownerId, "-2955");
  assert.equal(rig.index.member(land.id, "-2955").relation, "trusted");
  assert.equal(rig.index.member(land.id, "xuid:111"), undefined);
  assert.equal(rig.index.areaRoles.get(`${area.id}|-2955`).roleId, member.id);
  assert.equal(legacy.legacyIdentities().length, 0);
  assert.equal(rig.events.filter((item) => item.op === "legacy_bound").length, 2);

  const restarted = await rig.restart();
  assert.equal(restarted.index.lands.get(legacyLand.id).ownerId, "-2955");
  assert.equal(restarted.index.lands.get(legacyLand.id).ownerName, "老甲");
  assert.equal(restarted.index.member(land.id, "-2955").playerName, "老甲");
  assert.ok(restarted.index.areaRoles.get(`${area.id}|-2955`));
  assert.equal(restarted.index.identities.get("xuid:111"), undefined);
  assert.equal(await restarted.load("services/legacy.ts").bindLegacyOnJoin({ id: "-2955", name: "老甲" }), 0);
});

test("binding drops placeholder grants that would collide with the real player's existing ones", async (t) => {
  const rig = await fixture(t);
  const { land, area } = await landWithArea(rig);
  const member = presetRole(rig, land.id, "member");
  const visitor = presetRole(rig, land.id, "visitor");
  await addMember(rig, land.id, "xuid:222", "老乙", member.id);
  await addAreaRole(rig, area, "xuid:222", member.id);
  await addMember(rig, land.id, "real", "新乙", visitor.id, "visitor");
  await addAreaRole(rig, area, "real", visitor.id);
  await rig.repo.saveIdentity("xuid:222", "老乙", "老乙");
  rig.index.rememberIdentity("xuid:222", "老乙");

  const legacy = rig.load("services/legacy.ts");
  assert.equal(await legacy.bindLegacy(legacy.findLegacy("222").playerId, { id: "real", name: "新乙" }, "admin"), 1);
  assert.equal(rig.index.member(land.id, "real").roleId, visitor.id);
  assert.equal(rig.index.areaRoles.get(`${area.id}|real`).roleId, visitor.id);
  const members = await rig.repo.listMembers();
  assert.equal(members.filter((item) => item.playerId === "xuid:222").length, 0);
  const grants = await rig.repo.listAreaRoles();
  assert.equal(grants.filter((item) => item.playerId === "xuid:222").length, 0);
});

test("auto binding skips ambiguous names and never binds to another placeholder", async (t) => {
  const rig = await fixture(t);
  const legacy = rig.load("services/legacy.ts");
  for (const id of ["xuid:1", "xuid:2"]) {
    await rig.repo.saveIdentity(id, "同名", "同名");
    rig.index.rememberIdentity(id, "同名");
  }
  assert.equal(await legacy.bindLegacyOnJoin({ id: "p", name: "同名" }), 0);
  assert.equal(legacy.legacyIdentities().length, 2);
  assert.throws(() => legacy.findLegacy("同名"));
  await assert.rejects(legacy.bindLegacy("xuid:1", { id: "xuid:2", name: "同名" }, "admin"));
});
