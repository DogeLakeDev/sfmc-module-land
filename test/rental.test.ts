import assert from "node:assert/strict";
import { register } from "node:module";
import { it } from "node:test";
register("./fixtures/rental-loader.mjs", import.meta.url);
const {
  reset,
  put,
  tables,
  balances,
  calls,
  runtime,
  world,
  drawnShapes,
  timeouts,
  eventHandlers,
  DebugBox,
  DebugCylinder,
} = await import("./fixtures/rental-mocks.mjs");
const {
  bindLandConfig,
  quoteCreateLease,
  quoteExpandLease,
  handleCreateLease,
  handleRenewLease,
  handleTerminateLease,
  handleRename,
  handleByPos,
} = await import("../sapi/src/services.ts");
const { DEFAULT_LAND_CONFIG } = await import("../sapi/src/config.ts");
const { DAY_MS } = await import("../sapi/src/types.ts");
const { recoverLandOperations } = await import("../sapi/src/mutations.ts");
const { runLeaseScan } = await import("../sapi/src/lease-scanner.ts");
const { bindLandUiConfig, clearLandUiState, landUiServices } =
  await import("../sapi/src/ui-services.ts");
const { clearAllShapes, showLandHighlight } =
  await import("../sapi/src/debug-draw.ts");
const { registerLandSelectionEvents, clearLandSelections } =
  await import("../sapi/src/selection.ts");
const { selectionSessions, pendingBoxes } =
  await import("../sapi/src/pending.ts");
const { defineLandTables } = await import("../sapi/src/store.ts");
let cfg;
async function setup() {
  clearAllShapes();
  clearLandSelections();
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
    shape_type: "cuboid",
    radius: 0,
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
  core: { x: 400, y: 70, z: 400 },
  requestId: id,
  expectedFee: 2513,
});

async function check(name: string, run: () => Promise<void>) {
  await it(name, async () => {
    await setup();
    await run();
  });
}
await check("默认三维选区 7 天报价与实际扣款均为 2513", async () => {
  const q = await quoteCreateLease(request());
  assert.equal(q.fee, 2513);
  const r = await handleCreateLease(request());
  assert.equal(r.fee, 2513);
  assert.equal(balances.get("owner"), 1_000_000 - 2513);
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
  assert.equal(balances.get("owner"), 1_000_000 - 2513);
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
    shape: {
      type: "cuboid",
      min: { x: 291, y: -64, z: 291 },
      max: { x: 339, y: 319, z: 339 },
    },
  });
  assert.ok(q.fee > 0);
  await assert.rejects(
    quoteExpandLease({
      playerId: "owner",
      landId: old.id,
      shape: {
        type: "cuboid",
        min: { x: 301, y: -64, z: 301 },
        max: { x: 331, y: 319, z: 331 },
      },
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
    daysOption: 7,
  });
  world.getAllPlayers()[0].location = { x: 800, y: 70, z: 800 };
  const r = await landUiServices["land.ui.createLease"]({
    playerId: "owner",
    daysOption: 7,
    quoteId: q.quoteId,
  });
  assert.equal(tables.get("sfmc_lands").get(r.landId).core_x, 400);
});
await check("报价后修改天数不扣款", async () => {
  const q = await landUiServices["land.ui.previewLease"]({
    playerId: "owner",
    daysOption: 7,
  });
  await assert.rejects(
    landUiServices["land.ui.createLease"]({
      playerId: "owner",
      daysOption: 14,
      quoteId: q.quoteId,
    }),
    /已变更/,
  );
  assert.equal(balances.size, 0);
});
await check("报价有效期过后不能提交", async () => {
  const q = await landUiServices["land.ui.previewLease"]({
    playerId: "owner",
    daysOption: 7,
  });
  const clock = Date.now;
  try {
    Date.now = () => clock() + 121000;
    await assert.rejects(
      landUiServices["land.ui.createLease"]({
        playerId: "owner",
        daysOption: 7,
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

await check("首次创建自动生成名称，不需要名称输入", async () => {
  const result = await handleCreateLease(request());
  assert.match(String(result.name), /^领地-\d{8}-[A-Z0-9]+$/);
  assert.equal(tables.get("sfmc_lands").get(result.landId).name, result.name);
});

await check("主人后期改名免费且重复提交只修改一次", async () => {
  const old = seed();
  const input = {
    playerId: "owner",
    landId: old.id,
    version: 1,
    name: "新领地",
    requestId: "rename_0001",
  };
  const first = await handleRename(input),
    replay = await handleRename(input);
  assert.deepEqual(first, replay);
  const saved = tables.get("sfmc_lands").get(old.id);
  assert.equal(saved.name, "新领地");
  assert.equal(saved.version, 2);
  assert.equal(saved.lease_until, old.lease_until);
  assert.equal(saved.daily_rent, old.daily_rent);
  assert.equal(
    calls.filter((call) => call.name.startsWith("economy.")).length,
    0,
  );
});

await check("改名拒绝非主人、空名称、过长名称和过期版本", async () => {
  seed();
  for (const patch of [
    { playerId: "outsider", name: "名字" },
    { name: "  " },
    { name: "长".repeat(33) },
    { name: "§a名字" },
    { name: "新\n名称" },
    { name: "名字", version: 2 },
  ])
    await assert.rejects(
      handleRename({
        playerId: "owner",
        landId: "land-a",
        name: "新名称",
        requestId: "rename_0001",
        ...patch,
      }),
    );
  assert.equal(tables.get("sfmc_lands").get("land-a").name, "Home");
});

await check("创建和续租均支持预设档位及自定义天数", async () => {
  for (const days of [7, 14, 30, 90]) {
    const quote = await landUiServices["land.ui.previewLease"]({
      playerId: "owner",
      daysOption: days,
    });
    assert.equal(quote.days, days);
  }
  const old = seed();
  const quote = await landUiServices["land.ui.previewRenew"]({
    playerId: "owner",
    landId: old.id,
    daysOption: 0,
    customDays: "12",
  });
  assert.equal(quote.days, 12);
  await landUiServices["land.ui.renew"]({
    playerId: "owner",
    landId: old.id,
    daysOption: 0,
    customDays: "12",
    quoteId: quote.quoteId,
  });
  assert.equal(
    tables.get("sfmc_lands").get(old.id).lease_until,
    old.lease_until + 12 * DAY_MS,
  );
});

await check("自定义天数拒绝小数、空白、指数及超出 1 至 90 的输入", async () => {
  for (const customDays of ["", "0", "91", "7.5", "1e1", "Infinity", "abc"])
    await assert.rejects(
      landUiServices["land.ui.previewLease"]({
        playerId: "owner",
        daysOption: 0,
        customDays,
      }),
    );
  assert.equal(balances.size, 0);
});

await check("创建页可调整长方体长宽高和位置，并按新体积扣款", async () => {
  const input = {
    playerId: "owner",
    daysOption: 7,
    shapeType: "cuboid",
    x: "1000",
    y: "60",
    z: "2000",
    length: "6",
    width: "4",
    height: "3",
  };
  const quote = await landUiServices["land.ui.previewLease"](input);
  assert.equal(quote.volume, 72);
  assert.equal(quote.fee, 84);
  const result = await landUiServices["land.ui.createLease"]({
    ...input,
    quoteId: quote.quoteId,
  });
  const saved = tables.get("sfmc_lands").get(result.landId);
  assert.deepEqual(
    [
      saved.min_x,
      saved.min_y,
      saved.min_z,
      saved.max_x,
      saved.max_y,
      saved.max_z,
    ],
    [998, 60, 1999, 1003, 62, 2002],
  );
  assert.equal(balances.get("owner"), 1_000_000 - 84);
});

await check("圆柱体创建、查询和体积计费排除外接盒角落", async () => {
  const input = {
    playerId: "owner",
    daysOption: 0,
    customDays: "12",
    shapeType: "cylinder",
    radius: "2",
    height: "3",
    x: "500",
    y: "70",
    z: "500",
  };
  const quote = await landUiServices["land.ui.previewLease"](input);
  assert.equal(quote.volume, 39);
  assert.equal(quote.fee, 132);
  const result = await landUiServices["land.ui.createLease"]({
    ...input,
    quoteId: quote.quoteId,
  });
  const saved = tables.get("sfmc_lands").get(result.landId);
  assert.equal(saved.shape_type, "cylinder");
  assert.equal(saved.radius, 2);
  assert.equal(
    (
      await handleByPos({
        dimension: "minecraft:overworld",
        x: 502,
        y: 71,
        z: 500,
      })
    )?.id,
    result.landId,
  );
  assert.equal(
    await handleByPos({
      dimension: "minecraft:overworld",
      x: 502,
      y: 71,
      z: 502,
    }),
    null,
  );
  const corner = await quoteCreateLease({
    ...request("create_corner"),
    core: undefined,
    shape: {
      type: "cuboid",
      min: { x: 502, y: 70, z: 502 },
      max: { x: 502, y: 72, z: 502 },
    },
  });
  assert.equal(corner.dailyRent, 17);
});

await check("改变形状、尺寸、半径或位置后必须重新报价", async () => {
  const input = {
    playerId: "owner",
    daysOption: 7,
    shapeType: "cylinder",
    radius: "2",
    height: "3",
    x: "500",
    y: "70",
    z: "500",
    length: "5",
    width: "5",
  };
  const quote = await landUiServices["land.ui.previewLease"](input);
  for (const patch of [
    { shapeType: "cuboid" },
    { radius: "3" },
    { height: "4" },
    { x: "501" },
    { y: "71" },
    { z: "501" },
    { length: "7" },
    { width: "7" },
  ])
    await assert.rejects(
      landUiServices["land.ui.createLease"]({
        ...input,
        ...patch,
        quoteId: quote.quoteId,
      }),
      /已变更/,
    );
  assert.equal(balances.size, 0);
});

await check("非法形状、零尺寸和无效坐标不能获得报价", async () => {
  for (const patch of [
    { shapeType: "sphere" },
    { height: "0" },
    { length: "-1" },
    { width: "0" },
    { x: "NaN" },
    { y: "320" },
    { shapeType: "cylinder", radius: "0" },
  ])
    await assert.rejects(
      landUiServices["land.ui.previewLease"]({
        playerId: "owner",
        daysOption: 7,
        ...patch,
      }),
    );
  await assert.rejects(
    quoteCreateLease({
      ...request(),
      shape: {
        type: "cylinder",
        radius: 3,
        min: { x: 498, y: 70, z: 498 },
        max: { x: 502, y: 72, z: 502 },
      },
    }),
    /半径一致/,
  );
});

await check("圆柱体扩建保持形状和高度，不延长租期", async () => {
  const old = seed({
    shape_type: "cylinder",
    radius: 12,
    min_x: 388,
    max_x: 412,
    min_z: 388,
    max_z: 412,
    min_y: 70,
    max_y: 72,
    core_x: 400,
    core_z: 400,
  });
  const quote = await landUiServices["land.ui.previewExpand"]({
    playerId: "owner",
    landId: old.id,
    level: 2,
  });
  await landUiServices["land.ui.expand"]({
    playerId: "owner",
    landId: old.id,
    level: 2,
    quoteId: quote.quoteId,
  });
  const saved = tables.get("sfmc_lands").get(old.id);
  assert.equal(saved.shape_type, "cylinder");
  assert.equal(saved.radius, 24);
  assert.equal(saved.min_y, 70);
  assert.equal(saved.max_y, 72);
  assert.equal(saved.lease_until, old.lease_until);
});

await check(
  "DebugBox 和 DebugCylinder 线框仅本人可见，替换和超时正确清理",
  async () => {
    const box = {
      type: "cuboid" as const,
      min: { x: 0, y: 4, z: 0 },
      max: { x: 4, y: 6, z: 4 },
    };
    await showLandHighlight({
      key: "preview:owner",
      shape: box,
      dimension: "minecraft:overworld",
    });
    const first = drawnShapes[0].shape,
      staleTimeout = [...timeouts.values()][0];
    assert.ok(first instanceof DebugBox);
    assert.deepEqual(first.bound, { x: 5, y: 3, z: 5 });
    assert.deepEqual(first.visibleTo, world.getAllPlayers());
    assert.equal(first.location.dimension.id, "minecraft:overworld");
    await showLandHighlight({
      key: "preview:owner",
      shape: { ...box, type: "cylinder", radius: 2 },
      dimension: "minecraft:overworld",
    });
    const second = drawnShapes[1].shape;
    assert.ok(second instanceof DebugCylinder);
    assert.equal(first.removed, true);
    assert.equal(second.height, 3);
    assert.deepEqual(second.radii, { x: 2.5, y: 2.5 });
    staleTimeout();
    assert.equal(second.removed, false);
    [...timeouts.values()][0]();
    assert.equal(second.removed, true);
    assert.equal(timeouts.size, 0);
  },
);

await check("空手选点仅在开启模式后生效，持物和重复交互不选点", async () => {
  const cleanups: Array<() => void> = [];
  registerLandSelectionEvents(cleanups);
  try {
    const interact = eventHandlers.get("beforeInteract"),
      current = world.getAllPlayers()[0];
    const event = (x: number, itemStack?: object, isFirstEvent = true) => ({
      player: current,
      block: { location: { x, y: 70, z: 410 }, dimension: current.dimension },
      itemStack,
      isFirstEvent,
      cancel: false,
    });
    const ordinary = event(410);
    interact(ordinary);
    assert.equal(ordinary.cancel, false);
    await landUiServices["land.ui.beginSelection"]({ playerId: "owner" });
    const held = event(410, { typeId: "minecraft:golden_pickaxe" });
    interact(held);
    assert.equal(held.cancel, false);
    assert.equal(selectionSessions.get("owner")?.a, undefined);
    const repeated = event(410, undefined, false);
    interact(repeated);
    assert.equal(repeated.cancel, false);
    const first = event(410);
    interact(first);
    assert.equal(first.cancel, true);
    assert.equal(selectionSessions.get("owner")?.a?.x, 410);
    const second = event(414);
    second.block.location.y = 73;
    second.block.location.z = 414;
    interact(second);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(selectionSessions.has("owner"), false);
    assert.deepEqual(pendingBoxes.get("owner")?.box.min, {
      x: 410,
      y: 70,
      z: 410,
    });
    const draft = await landUiServices["land.ui.leaseDraft"]({
      playerId: "owner",
    });
    assert.equal(draft.volume, 100);
    assert.equal(draft.height, 4);
    assert.equal(
      calls.filter((call) => call.name.startsWith("economy.")).length,
      0,
    );
  } finally {
    cleanups.forEach((off) => off());
  }
});

await check("离线清理选点、报价和原生线框", async () => {
  const cleanups: Array<() => void> = [];
  registerLandSelectionEvents(cleanups);
  try {
    const input = { playerId: "owner", daysOption: 7 };
    const quote = await landUiServices["land.ui.previewLease"](input);
    const shape = drawnShapes[0].shape;
    selectionSessions.set("owner", {
      dimension: "minecraft:overworld",
      startedAt: Date.now(),
    });
    eventHandlers.get("afterLeave")({ playerId: "owner" });
    assert.equal(shape.removed, true);
    assert.equal(selectionSessions.has("owner"), false);
    await assert.rejects(
      landUiServices["land.ui.createLease"]({
        ...input,
        quoteId: quote.quoteId,
      }),
      /报价已失效/,
    );
  } finally {
    cleanups.forEach((off) => off());
  }
});

await check(
  "过期草稿不会随玩家移动悄悄改变范围，重新打开后才重置",
  async () => {
    const input = { playerId: "owner", daysOption: 7 };
    await landUiServices["land.ui.leaseDraft"](input);
    const clock = Date.now;
    try {
      Date.now = () => clock() + 301_000;
      world.getAllPlayers()[0].location = { x: 800, y: 70, z: 800 };
      await assert.rejects(
        landUiServices["land.ui.previewLease"](input),
        /草稿已过期/,
      );
      assert.equal(balances.size, 0);
      const draft = await landUiServices["land.ui.leaseDraft"](input);
      assert.equal(draft.x, 800);
      const quote = await landUiServices["land.ui.previewLease"](input);
      const result = await landUiServices["land.ui.createLease"]({
        ...input,
        quoteId: quote.quoteId,
      });
      assert.equal(tables.get("sfmc_lands").get(result.landId).core_x, 800);
    } finally {
      Date.now = clock;
    }
  },
);

await check("尺寸输入含首尾空格时，预览与确认使用一致的输入快照", async () => {
  const input = { playerId: "owner", daysOption: 7, x: " 500 ", length: " 5 " };
  const quote = await landUiServices["land.ui.previewLease"](input);
  assert.equal(quote.quoted_x, input.x);
  assert.equal(quote.quoted_length, input.length);
  const result = await landUiServices["land.ui.createLease"]({
    ...input,
    quoteId: quote.quoteId,
  });
  assert.equal(tables.get("sfmc_lands").get(result.landId).core_x, 500);
});
