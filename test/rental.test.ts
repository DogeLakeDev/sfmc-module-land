import assert from "node:assert/strict";
import { register } from "node:module";
import { it } from "node:test";
register("./fixtures/rental-loader.mjs", import.meta.url);
const { reset, put, tables, balances, calls, runtime, world } =
  await import("./fixtures/rental-mocks.mjs");
const {
  bindLandConfig,
  quoteCreateLease,
  quoteExpandLease,
  handleCreateLease,
  handleRenewLease,
  handleTerminateLease,
} = await import("../sapi/src/services.ts");
const { DEFAULT_LAND_CONFIG } = await import("../sapi/src/config.ts");
const { DAY_MS } = await import("../sapi/src/types.ts");
const { recoverLandOperations } = await import("../sapi/src/mutations.ts");
const { runLeaseScan } = await import("../sapi/src/lease-scanner.ts");
const { bindLandUiConfig, clearLandUiState, landUiServices } =
  await import("../sapi/src/ui-services.ts");
const { defineLandTables } = await import("../sapi/src/store.ts");
let cfg;
async function setup() {
  reset();
  clearLandUiState();
  cfg = structuredClone(DEFAULT_LAND_CONFIG);
  bindLandConfig(() => cfg);
  bindLandUiConfig(() => cfg);
  await defineLandTables();
  world.getAllPlayers()[0].location = { x: 400, y: 70, z: 400 };
}
function seed(overrides = {}) {
  const row = {
    id: "land-a",
    owner_id: "owner",
    name: "Home",
    dimension: "minecraft:overworld",
    min_x: 300,
    min_y: -64,
    min_z: 300,
    max_x: 330,
    max_y: 319,
    max_z: 330,
    core_x: 315,
    core_y: 70,
    core_z: 315,
    level: 1,
    status: "active",
    daily_rent: 32,
    lease_until: Date.now() + 20 * DAY_MS,
    grace_until: 0,
    version: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
  put("sfmc_lands", row);
  return row;
}
const request = (id = "create_0001") => ({
  playerId: "owner",
  dimension: "minecraft:overworld",
  days: 7,
  name: "领地",
  core: { x: 400, y: 70, z: 400 },
  requestId: id,
  expectedFee: 224,
});

async function check(name: string, run: () => Promise<void>) {
  await it(name, async () => {
    await setup();
    await run();
  });
}
await check("默认 7 天报价与实际扣款均为 224", async () => {
  const q = await quoteCreateLease(request());
  assert.equal(q.fee, 224);
  const r = await handleCreateLease(request());
  assert.equal(r.fee, 224);
  assert.equal(balances.get("owner"), 1_000_000 - 224);
});
await check("相同请求重复提交只扣款一次并返回同一领地", async () => {
  const [a, b] = await Promise.all([
    handleCreateLease(request()),
    handleCreateLease(request()),
  ]);
  assert.deepEqual(a, b);
  assert.equal(tables.get("sfmc_lands").size, 1);
  assert.equal(calls.filter((c) => c.name.endsWith("debit")).length, 1);
});
await check("同一请求号改变坐标被拒绝", async () => {
  await handleCreateLease(request());
  await assert.rejects(
    handleCreateLease({ ...request(), core: { x: 500, y: 70, z: 500 } }),
    /其他请求/,
  );
});
await check("并发重复范围只创建一个领地", async () => {
  const r = await Promise.allSettled([
    handleCreateLease(request("create_0001")),
    handleCreateLease(request("create_0002")),
  ]);
  assert.equal(r.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(tables.get("sfmc_lands").size, 1);
});
await check("并发不同范围不能突破个人上限", async () => {
  cfg.max_lands_per_player = 1;
  const r = await Promise.allSettled([
    handleCreateLease(request("create_0001")),
    handleCreateLease({
      ...request("create_0002"),
      core: { x: 500, y: 70, z: 500 },
    }),
  ]);
  assert.equal(r.filter((v) => v.status === "fulfilled").length, 1);
});
await check("不同请求的并发续租不会丢失已付款天数", async () => {
  const old = seed();
  await Promise.all(
    [1, 2].map((i) =>
      handleRenewLease({
        playerId: "owner",
        landId: old.id,
        days: 7,
        requestId: `renew_000${i}`,
        expectedFee: 224,
      }),
    ),
  );
  assert.equal(
    tables.get("sfmc_lands").get(old.id).lease_until,
    old.lease_until + 14 * DAY_MS,
  );
  assert.equal(balances.get("owner"), 1_000_000 - 448);
});
await check("旧版本续租被拒绝且不会再次扣款", async () => {
  seed();
  const p = {
    playerId: "owner",
    landId: "land-a",
    days: 7,
    version: 1,
    expectedFee: 224,
  };
  await handleRenewLease({ ...p, requestId: "renew_0001" });
  await assert.rejects(
    handleRenewLease({ ...p, requestId: "renew_0002" }),
    /已变更/,
  );
  assert.equal(balances.get("owner"), 1_000_000 - 224);
});
await check("创建写入失败回滚领地并补偿退款", async () => {
  runtime.failInsert = "sfmc_lands";
  await assert.rejects(handleCreateLease(request()), /已退款/);
  assert.equal(tables.get("sfmc_lands").size, 0);
  assert.equal(balances.get("owner"), 1_000_000);
  assert.equal(
    tables.get("sfmc_land_operations").get("create_0001").status,
    "rolled_back",
  );
});
await check("退款失败保留待处理状态并能恢复，恢复不重复退款", async () => {
  runtime.failInsert = "sfmc_lands";
  runtime.failCredit = true;
  await assert.rejects(handleCreateLease(request()), /退款尚待处理/);
  assert.equal(
    tables.get("sfmc_land_operations").get("create_0001").status,
    "refund_pending",
  );
  runtime.failCredit = false;
  await recoverLandOperations();
  await recoverLandOperations();
  assert.equal(balances.get("owner"), 1_000_000);
});
await check("事务提交应答丢失不会把已创建领地的资金退回", async () => {
  runtime.commitReplyLost = true;
  const r = await handleCreateLease(request());
  assert.equal(r.ok, true);
  assert.equal(balances.get("owner"), 1_000_000 - 224);
  assert.equal(calls.filter((c) => c.name.endsWith("credit")).length, 0);
});
await check("续租写入失败不改变租期，费用退回", async () => {
  const old = seed();
  const update = (await import("./fixtures/rental-mocks.mjs")).db.update;
  const db = (await import("./fixtures/rental-mocks.mjs")).db;
  db.update = async (table, ...args) => {
    if (table === "sfmc_lands") throw new Error("write failure");
    return update(table, ...args);
  };
  try {
    await assert.rejects(
      handleRenewLease({
        playerId: "owner",
        landId: old.id,
        days: 7,
        requestId: "renew_0001",
        expectedFee: 224,
      }),
      /已退款/,
    );
    assert.equal(
      tables.get("sfmc_lands").get(old.id).lease_until,
      old.lease_until,
    );
    assert.equal(balances.get("owner"), 1_000_000);
  } finally {
    db.update = update;
  }
});
await check("非主人续租及字符串管理员绕过均被拒绝", async () => {
  seed();
  await assert.rejects(
    handleRenewLease({
      playerId: "outsider",
      landId: "land-a",
      days: 7,
      requestId: "renew_0001",
      expectedFee: 224,
    }),
    /自己的领地/,
  );
  await assert.rejects(
    handleTerminateLease({
      playerId: "outsider",
      landId: "land-a",
      forceAdmin: "yes",
      requestId: "end_00001",
    }),
    /自己的领地/,
  );
  assert.equal(calls.filter((c) => c.name.endsWith("debit")).length, 0);
});
await check("不足一天的扩建收费，且不能缩小或移动领地", async () => {
  const old = seed({ lease_until: Date.now() + 0.5 * DAY_MS });
  const q = await quoteExpandLease({
    playerId: "owner",
    landId: old.id,
    newMin: { x: 291, y: -64, z: 291 },
    newMax: { x: 339, y: 319, z: 339 },
  });
  assert.ok(q.fee > 0);
  await assert.rejects(
    quoteExpandLease({
      playerId: "owner",
      landId: old.id,
      newMin: { x: 301, y: -64, z: 301 },
      newMax: { x: 331, y: 319, z: 331 },
    }),
    /不能移动或缩小/,
  );
});
await check("30 天前到期的租赁立即结束，不重新获得宽限期", async () => {
  const old = seed({ lease_until: Date.now() - 30 * DAY_MS });
  await runLeaseScan(cfg);
  assert.equal(tables.get("sfmc_lands").get(old.id).status, "terminated");
});
await check("超过 1000 条到期租赁全部处理", async () => {
  for (let i = 0; i < 1201; i++)
    seed({ id: `land-${i}`, lease_until: Date.now() - 30 * DAY_MS });
  const r = await runLeaseScan(cfg);
  assert.equal(r.terminated, 1201);
});
await check("缺失、非有限坐标、非法维度和无效天数全部拒绝", async () => {
  for (const patch of [
    { core: { x: NaN, y: 70, z: 400 } },
    { dimension: "invalid:world" },
    { days: Infinity },
    { days: 0 },
    { days: 7.5 },
    { core: { x: 400, z: 400 } },
  ])
    await assert.rejects(quoteCreateLease({ ...request(), ...patch }));
});
await check("固定页面草稿，移动玩家后仍租用报价中的范围", async () => {
  await landUiServices["land.ui.leaseDraft"]({ playerId: "owner" });
  const q = await landUiServices["land.ui.previewLease"]({
    playerId: "owner",
    days: 7,
    name: "领地",
  });
  world.getAllPlayers()[0].location = { x: 800, y: 70, z: 800 };
  const r = await landUiServices["land.ui.createLease"]({
    playerId: "owner",
    days: 7,
    name: "领地",
    quoteId: q.quoteId,
  });
  assert.equal(tables.get("sfmc_lands").get(r.landId).core_x, 400);
});
await check("报价后修改天数不扣款", async () => {
  const q = await landUiServices["land.ui.previewLease"]({
    playerId: "owner",
    days: 7,
    name: "领地",
  });
  await assert.rejects(
    landUiServices["land.ui.createLease"]({
      playerId: "owner",
      days: 8,
      name: "领地",
      quoteId: q.quoteId,
    }),
    /已变更/,
  );
  assert.equal(balances.size, 0);
});
await check("报价有效期过后不能提交", async () => {
  const q = await landUiServices["land.ui.previewLease"]({
    playerId: "owner",
    days: 7,
    name: "领地",
  });
  const clock = Date.now;
  try {
    Date.now = () => clock() + 121000;
    await assert.rejects(
      landUiServices["land.ui.createLease"]({
        playerId: "owner",
        days: 7,
        name: "领地",
        quoteId: q.quoteId,
      }),
      /报价已失效/,
    );
  } finally {
    Date.now = clock;
  }
  assert.equal(balances.size, 0);
});
await check("余额不足不会创建领地或发放退款", async () => {
  runtime.failDebit = true;
  await assert.rejects(handleCreateLease(request()), /insufficient/);
  await recoverLandOperations();
  assert.equal(tables.get("sfmc_lands").size, 0);
  assert.equal(balances.size, 0);
});
