/**
 * 领地界面（声明式 UI）的回归测试。
 * 覆盖：UI Studio 编译器校验页面工程；页面引用的服务与 manifest、实现三方一致；
 * 页面只执行已存在的子命令；视图投影的能力开关与旗标层级；命令执行入口的抛错契约。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileUiProject } from "@sfmc-bds/sdk/validation";
import harness from "./harness.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(root, "sapi/src/ui");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** harness 在独立 vm 上下文里执行源码，返回值原型来自另一 realm；比较前转成本 realm 的普通对象。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 读取 feature 与全部页面，键为 feature 中声明的 file。 */
function loadUiProject() {
  const feature = readJson(path.join(uiRoot, "feature.ui.json"));
  const screens = Object.fromEntries(feature.screens.map((item) => [item.file, readJson(path.join(uiRoot, item.file))]));
  return { feature, screens };
}

/** manifest 声明提供的服务名。 */
function providedServices() {
  return readJson(path.join(root, "sapi/manifest.json")).services.provides.map((item) => item.name);
}

/** 深度遍历 JSON，收集满足条件的对象。 */
function collect(value, pick, out = []) {
  if (Array.isArray(value)) for (const item of value) collect(item, pick, out);
  else if (value && typeof value === "object") {
    if (pick(value)) out.push(value);
    for (const item of Object.values(value)) collect(item, pick, out);
  }
  return out;
}

const owner = { id: "owner", name: "甲", admin: false, console: false };
const stranger = { id: "stranger", name: "路人", admin: false, console: false };
const here = { dimensionId: "minecraft:overworld", x: 1, y: 64, z: 1, yaw: 0, pitch: 0 };

async function fixture(t) {
  const rig = await harness.createHarness();
  t.after(() => rig.sql.close());
  rig.economy.balances.set(owner.id, 10000);
  return rig;
}

/** 视图上下文：文案函数原样返回消息键，便于断言。 */
function ctxOf(rig, actor) {
  return { index: rig.index, actor, label: (key) => key, config: rig.config, holds: () => false, now: Date.now() };
}

test("UI Studio compiles the land screens against the manifest services", () => {
  const { feature, screens } = loadUiProject();
  const result = compileUiProject({ feature, screens, services: providedServices() });
  assert.deepEqual(result.ok ? [] : result.errors, []);
});

test("every land.ui service is declared in the manifest, implemented, and used by a screen", async (t) => {
  const rig = await fixture(t);
  const implemented = [...rig.load("ui-services.ts").LAND_UI_SERVICES].sort();
  const declared = providedServices().filter((name) => name.startsWith("land.ui.")).sort();
  const { screens } = loadUiProject();
  const used = [...new Set(collect(screens, (node) => typeof node.service === "string").map((node) => node.service))].sort();
  assert.deepEqual(implemented, declared);
  assert.deepEqual(used, declared);
  const permissions = readJson(path.join(root, "sapi/manifest.json")).permissions;
  for (const name of declared) assert.ok(permissions.includes(`service:${name}`), `${name} 缺少 service 权限声明`);
});

test("screens only run existing /c:land subcommands", async (t) => {
  const rig = await fixture(t);
  const actions = new Set(rig.load("commands/router.ts").LAND_ACTIONS);
  const { screens } = loadUiProject();
  const calls = collect(screens, (node) => node.service === "land.ui.exec").map((node) => node.input ?? {});
  assert.ok(calls.length > 0);
  const commands = calls.flatMap((input) => (input.toggle ? [input.toggle.on, input.toggle.off] : [input.command]));
  for (const command of commands) assert.ok(actions.has(command), `未知子命令 ${command}`);
  // 旗标页通过 data.view.command 选择子命令，视图只会给出这两种
  assert.ok(actions.has("flag") && actions.has("area_flag"));
});

/** 只组织子节点、自身不渲染控件的节点类型（spacer 自身也不需要再前置 spacer）。 */
const NON_LEAF = new Set(["when", "each", "spacer"]);

/**
 * 检查一个节点数组：每个叶子节点前必须紧跟一个可见条件相同的 spacer，并递归 when / each。
 * 用途：DDUI 中文排版拥挤，页面约定所有控件与文本之间（含页面标题之后）都有留白。
 */
function missingSpacers(nodes, where, out = []) {
  if (!Array.isArray(nodes)) return out;
  nodes.forEach((node, index) => {
    if (node.type === "when") missingSpacers(node.content, where, out);
    if (node.type === "each") {
      missingSpacers(node.template, where, out);
      missingSpacers(node.empty, where, out);
    }
    if (NON_LEAF.has(node.type)) return;
    const previous = nodes[index - 1];
    const ok = previous?.type === "spacer" && JSON.stringify(previous.visibleWhen) === JSON.stringify(node.visibleWhen);
    if (!ok) out.push(`${where}#${node.id}`);
  });
  return out;
}

test("every rendered node is preceded by a spacer for DDUI CJK layout", () => {
  const { screens } = loadUiProject();
  const missing = Object.entries(screens).flatMap(([file, screen]) => missingSpacers(screen.body, file));
  assert.deepEqual(missing, []);
});

test("views expose owner capabilities and hide them from strangers", async (t) => {
  const rig = await fixture(t);
  const views = rig.load("services/ui-views.ts");
  const land = await rig.load("services/territory.ts").createLand(owner, "测试领地", "简介", here);

  const mine = plain(views.homeView(ctxOf(rig, owner), here));
  assert.equal(mine.inLand, true);
  assert.equal(mine.landCount, 1);
  assert.equal(mine.lands[0].relationLabel, "rel_owner");
  assert.deepEqual(mine.landQuota.used, 1);

  const theirs = plain(views.homeView(ctxOf(rig, stranger), here));
  assert.equal(theirs.landCount, 0);
  assert.equal(theirs.here.relationLabel, "rel_none");

  const ownerCaps = plain(views.detailView(ctxOf(rig, owner), land.id).caps);
  assert.ok(Object.entries(ownerCaps).every(([key, value]) => key === "teleport" || value === true), JSON.stringify(ownerCaps));
  const strangerCaps = plain(views.detailView(ctxOf(rig, stranger), land.name).caps);
  assert.equal(strangerCaps.manage, false);
  assert.equal(strangerCaps.transfer, false);
  assert.equal(strangerCaps.members, false);
});

test("flag view switches subcommand and scope between land and area", async (t) => {
  const rig = await fixture(t);
  const views = rig.load("services/ui-views.ts");
  const territory = rig.load("services/territory.ts");
  const land = await territory.createLand(owner, "测试领地", "", here);
  const area = await territory.createArea(
    owner,
    land.id,
    "子区域",
    { dimensionId: here.dimensionId, x: 0, y: 60, z: 0 },
    { dimensionId: here.dimensionId, x: 5, y: 65, z: 5 },
  );

  const landFlags = plain(views.flagsView(ctxOf(rig, owner), land.id, ""));
  assert.equal(landFlags.command, "flag");
  assert.equal(landFlags.area, null);
  assert.ok(landFlags.toggles.some((item) => item.id === "public_teleport"));
  assert.ok(landFlags.inputs.some((item) => item.id === "enter_text"));

  const areaFlags = plain(views.flagsView(ctxOf(rig, owner), land.id, area.id));
  assert.equal(areaFlags.command, "area_flag");
  assert.equal(areaFlags.area.name, "子区域");
  assert.ok(!areaFlags.toggles.some((item) => item.id === "public_teleport"), "仅领地级旗标不应出现在子区域");
});

test("role view lists every registered permission with its granted state", async (t) => {
  const rig = await fixture(t);
  const views = rig.load("services/ui-views.ts");
  const land = await rig.load("services/territory.ts").createLand(owner, "测试领地", "", here);
  const role = rig.index.rolesOf(land.id).find((item) => item.preset === "visitor");
  const result = plain(views.roleView(ctxOf(rig, owner), land.id, role.id));
  const all = rig.load("domain/permissions.ts").listPermissions();
  assert.equal(result.permissions.length, all.length);
  const granted = result.permissions.filter((item) => item.granted).map((item) => item.id).sort();
  assert.deepEqual(granted, [...role.permissions].sort());
  assert.ok(!result.replacements.some((item) => item.id === role.id));
});

test("execLandCommand throws domain errors that runLandCommand turns into chat messages", async (t) => {
  const rig = await fixture(t);
  const router = rig.load("commands/router.ts");
  await assert.rejects(router.execLandCommand(undefined, "no_such_command", []), (error) => error.key === "unknown_command");
  await router.runLandCommand(undefined, "no_such_command");
  assert.deepEqual(plain(rig.messages.at(-1)), { error: "unknown_command" });
});
