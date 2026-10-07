/**
 * land 纯逻辑单元测试（不依赖 Minecraft 运行时）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  aabbIntersects,
  blockVolume,
  normalizeAabb,
} from "../sapi/src/aabb.ts";
import { DEFAULT_LAND_CONFIG, mergeLandConfig } from "../sapi/src/config.ts";
import {
  calcDailyRent,
  calcPeriodRent,
  expansionFeeDiff,
  landCountMultiplier,
  longTermDiscount,
  remainingLeaseDays,
} from "../sapi/src/rent.ts";
import {
  boxShape,
  defaultShape,
  shapeVolume,
  pointInShape,
  shapesIntersect,
  shapeContains,
} from "../sapi/src/geometry.ts";
import { DAY_MS } from "../sapi/src/types.ts";
import { compileUiProject } from "@sfmc-bds/sdk/validation";

describe("land aabb", () => {
  it("normalizeAabb 纠正对角", () => {
    const b = normalizeAabb({
      min: { x: 5, y: 10, z: 5 },
      max: { x: 1, y: 0, z: 1 },
    });
    assert.equal(b.min.x, 1);
    assert.equal(b.max.x, 5);
    assert.equal(b.min.y, 0);
    assert.equal(b.max.y, 10);
  });

  it("aabbIntersects 边界相贴视为冲突", () => {
    const a = normalizeAabb({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 10, z: 10 },
    });
    const b = normalizeAabb({
      min: { x: 10, y: 0, z: 0 },
      max: { x: 20, y: 10, z: 10 },
    });
    assert.equal(aabbIntersects(a, b), true);
  });

  it("体积包含三维端点", () => {
    assert.equal(
      blockVolume({ min: { x: 0, y: 4, z: -1 }, max: { x: 2, y: 5, z: 1 } }),
      18,
    );
  });
});

describe("land rent", () => {
  it("长租折扣取最大适用档", () => {
    assert.equal(
      longTermDiscount(7, DEFAULT_LAND_CONFIG.long_term_discounts),
      1,
    );
    assert.equal(
      longTermDiscount(30, DEFAULT_LAND_CONFIG.long_term_discounts),
      0.9,
    );
    assert.equal(
      longTermDiscount(90, DEFAULT_LAND_CONFIG.long_term_discounts),
      0.8,
    );
    assert.equal(
      longTermDiscount(120, DEFAULT_LAND_CONFIG.long_term_discounts),
      0.8,
    );
  });

  it("持有数量倍率", () => {
    const m = DEFAULT_LAND_CONFIG.land_count_multiplier;
    assert.equal(landCountMultiplier(0, m), 1.0);
    assert.equal(landCountMultiplier(1, m), 1.5);
    assert.equal(landCountMultiplier(4, m), 3.0);
    assert.equal(landCountMultiplier(99, m), 3.0);
  });

  it("日租金含三维体积与倍率", () => {
    const cfg = mergeLandConfig();
    const box = defaultShape({ x: 0, y: 64, z: 0 }, "minecraft:overworld", cfg);
    const r0 = calcDailyRent(box, cfg, 0);
    const r1 = calcDailyRent(box, cfg, 1);
    assert.ok(r0 >= cfg.base_daily_rent);
    assert.ok(r1 > r0);
  });

  it("首期租金应用折扣", () => {
    const fee7 = calcPeriodRent(10, 7, DEFAULT_LAND_CONFIG);
    const fee30 = calcPeriodRent(10, 30, DEFAULT_LAND_CONFIG);
    assert.equal(fee7, 70);
    assert.equal(fee30, Math.ceil(10 * 30 * 0.9));
  });

  it("扩建补差仅收差额×剩余天", () => {
    assert.equal(expansionFeeDiff(10, 15, 10), 50);
    assert.equal(expansionFeeDiff(15, 10, 10), 0);
    assert.equal(expansionFeeDiff(10, 15, 0), 0);
  });

  it("剩余租期天数向下取整", () => {
    const now = Date.UTC(2026, 8, 4, 12, 0, 0);
    const until = now + 2.9 * DAY_MS;
    assert.equal(remainingLeaseDays(until, now), 2);
  });
});

describe("land manifest", () => {
  it("租赁界面不依赖额外 gui 模块", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../sapi/manifest.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      requires: string[];
      permissions: string[];
      services: { requires: Array<{ name: string }> };
    };
    assert.ok(!manifest.requires.includes("gui"));
    assert.ok(
      !manifest.services.requires.some((item) => item.name.startsWith("gui.")),
    );
    assert.ok(
      !manifest.permissions.some((item) => item.startsWith("service:gui.")),
    );
  });
});

describe("租赁配置与边界", () => {
  it("缺省配置的嵌套数组不会共享可变引用", () => {
    const cfg = mergeLandConfig();
    cfg.claim.level_radius[0] = 99;
    assert.equal(DEFAULT_LAND_CONFIG.claim.level_radius[0], 16);
  });
  it("无效租金、数量和等级配置在启动时拒绝", () => {
    assert.throws(() => mergeLandConfig({ base_daily_rent: NaN }));
    assert.throws(() => mergeLandConfig({ max_lands_per_player: -1 }));
    assert.throws(() =>
      mergeLandConfig({
        claim: {
          initial_radius: 16,
          initial_height: 16,
          max_level: 3,
          level_radius: [16, 16, 32],
        },
      }),
    );
  });
  it("默认 33×16×33 范围七天费用为 2513", () => {
    const box = defaultShape(
      { x: 0, y: 70, z: 0 },
      "minecraft:overworld",
      DEFAULT_LAND_CONFIG,
    );
    assert.equal(
      calcPeriodRent(
        calcDailyRent(box, DEFAULT_LAND_CONFIG, 0),
        7,
        DEFAULT_LAND_CONFIG,
      ),
      2513,
    );
  });
  it("最后半天扩建仍收取按比例计算的补差", () => {
    assert.equal(expansionFeeDiff(10, 15, 0.5), 3);
  });
});

describe("声明式租赁 GUI", () => {
  it("页面、跳转、动作和服务通过 SDK 的完整工程校验", () => {
    const read = (path: string) =>
      JSON.parse(
        readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"),
      );
    const feature = read("../sapi/src/ui/feature.ui.json");
    const manifest = read("../sapi/manifest.json");
    const screens = Object.fromEntries(
      feature.screens.map((screen: { file: string }) => [
        screen.file,
        read(`../sapi/src/ui/${screen.file}`),
      ]),
    );
    const result = compileUiProject({
      feature,
      screens,
      services: manifest.services.provides.map(
        (item: { name: string }) => item.name,
      ),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  });
});

describe("三维形状", () => {
  const cylinder = (x = 0, z = 0, radius = 2) => ({
    type: "cylinder" as const,
    radius,
    min: { x: x - radius, y: 0, z: z - radius },
    max: { x: x + radius, y: 2, z: z + radius },
  });
  it("圆柱体按实际方块柱计体积，排除外接盒角落", () => {
    const shape = cylinder();
    assert.equal(shapeVolume(shape), 13 * 3);
    assert.equal(pointInShape({ x: 2, y: 1, z: 2 }, shape), false);
    assert.equal(pointInShape({ x: 2, y: 1, z: 0 }, shape), true);
  });
  it("圆柱体与长方体、圆柱体的相交判断不使用外接盒代替", () => {
    const a = cylinder();
    assert.equal(shapesIntersect(a, cylinder(3, 3)), false);
    assert.equal(shapesIntersect(a, cylinder(2, 0)), true);
    const corner = boxShape({
      min: { x: 2, y: 0, z: 2 },
      max: { x: 2, y: 2, z: 2 },
    });
    assert.equal(shapesIntersect(a, corner), false);
    assert.equal(
      shapesIntersect(
        a,
        boxShape({ min: { x: 0, y: 3, z: 0 }, max: { x: 0, y: 5, z: 0 } }),
      ),
      false,
    );
  });
  it("扩建包含判断同时检查高度和圆柱体实际截面", () => {
    assert.equal(shapeContains(cylinder(0, 0, 3), cylinder()), true);
    assert.equal(shapeContains(cylinder(), cylinder(1, 0)), false);
    assert.equal(
      shapeContains(
        { ...cylinder(0, 0, 3), min: { x: -3, y: 1, z: -3 } },
        cylinder(),
      ),
      false,
    );
  });
  it("增加高度会增加租金", () => {
    const low = cylinder(),
      high = { ...low, max: { ...low.max, y: 20 } };
    assert.ok(
      calcDailyRent(high, DEFAULT_LAND_CONFIG, 0) >
        calcDailyRent(low, DEFAULT_LAND_CONFIG, 0),
    );
  });
});
