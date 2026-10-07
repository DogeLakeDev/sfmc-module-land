import { parseShape } from "./shape-validation.js";
/** 租赁 GUI：三维选区编辑、租期档位、报价确认与后期改名。 */
import { world, type Player } from "@minecraft/server";
import { Msg } from "@sfmc-bds/sdk/sapi/runtime";
import { ServiceError } from "@sfmc-bds/sdk/sapi/service";
import type { LandConfig } from "./config.js";
import { clearShapes, showLandHighlight } from "./debug-draw.js";
import {
  boxShape,
  defaultShape,
  shapeCenter,
  shapeText,
  shapeVolume,
} from "./geometry.js";
import { pendingBoxes, selectionSessions } from "./pending.js";
import { fingerprint } from "./mutations.js";
import {
  quoteCreateLease,
  quoteExpandLease,
  quoteRenewLease,
  handleById,
  handleCreateLease,
  handleExpandLease,
  handleRenewLease,
  handleTerminateLease,
  handleRename,
} from "./services.js";
import { makeId } from "./store.js";
import { openLandUi } from "./ui.js";
import {
  DIMENSIONS,
  invalid,
  leaseDays,
  rangeText,
  vector,
} from "./validation.js";
import type { Aabb, LandShape } from "./types.js";

type Draft = { shape: LandShape; dimension: string; expiresAt: number };
type Quote = {
  kind: string;
  playerId: string;
  landId?: string;
  input: Record<string, unknown>;
  expiresAt: number;
  editorKey?: string;
};
const drafts = new Map<string, Draft>();
const quotes = new Map<string, Quote>();
const QUOTE_MS = 120_000;
export const TERM_OPTIONS = [7, 14, 30, 90] as const;
export const EDITOR_FIELDS = [
  "x",
  "y",
  "z",
  "length",
  "width",
  "height",
  "radius",
] as const;
let getConfig: () => LandConfig;
export function bindLandUiConfig(getter: () => LandConfig): void {
  getConfig = getter;
}
export function clearLandUiState(playerId?: string): void {
  if (!playerId) {
    drafts.clear();
    quotes.clear();
    return;
  }
  drafts.delete(playerId);
  for (const [key, quote] of quotes)
    if (quote.playerId === playerId) quotes.delete(key);
}
function player(input: Record<string, unknown>) {
  const current = world.getAllPlayers().find((p) => p.id === input.playerId);
  if (!current) throw new ServiceError("玩家不在线", "not_found", 404);
  return current;
}
async function ownedLand(input: Record<string, unknown>) {
  const current = player(input),
    land = await handleById({ landId: input.landId });
  if (!land) throw new ServiceError("领地不存在", "not_found", 404);
  if (land.ownerId !== current.id)
    throw new ServiceError("只能管理自己的领地", "forbidden", 403);
  return { current, land };
}
function integer(value: unknown, label: string): number {
  if (typeof value === "string" && !/^-?\d+$/.test(value.trim()))
    invalid(`${label}须为整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) invalid(`${label}须为整数`);
  return number;
}
export function selectedDays(input: Record<string, unknown>): number {
  const option = integer(input.daysOption ?? 7, "租期档位");
  if (option === 0) return leaseDays(integer(input.customDays, "自定义天数"));
  if (!TERM_OPTIONS.some((days) => days === option))
    invalid("请选择有效租期档位");
  return leaseDays(option);
}
function editorValues(input: Record<string, unknown>) {
  return Object.fromEntries(
    ["shapeType", ...EDITOR_FIELDS].map((key) => [
      key,
      String(input[key] ?? (key === "shapeType" ? "cuboid" : "")),
    ]),
  );
}
function editorKey(input: Record<string, unknown>): string {
  return fingerprint({ ...editorValues(input), days: selectedDays(input) });
}
function saveQuote(
  kind: string,
  playerId: string,
  input: Record<string, unknown>,
  fee: number,
  landId?: string,
  key?: string,
) {
  for (const [id, quote] of quotes)
    if (quote.expiresAt <= Date.now()) quotes.delete(id);
  const id = makeId(kind);
  quotes.set(id, {
    kind,
    playerId,
    landId,
    input: { ...input, requestId: id, expectedFee: fee },
    expiresAt: Date.now() + QUOTE_MS,
    editorKey: key,
  });
  return id;
}
function readQuote(input: Record<string, unknown>, kind: string): Quote {
  const current = player(input),
    quote = quotes.get(String(input.quoteId ?? ""));
  if (
    !quote ||
    quote.playerId !== current.id ||
    quote.kind !== kind ||
    quote.expiresAt <= Date.now() ||
    (quote.landId && quote.landId !== input.landId)
  )
    throw new ServiceError(
      "报价已失效，请重新预览后提交",
      "quote_expired",
      409,
    );
  return quote;
}
function draft(input: Record<string, unknown>, openingPage = false): Draft {
  const current = player(input),
    selected = pendingBoxes.get(current.id);
  const cached = drafts.get(current.id);
  if (cached && cached.expiresAt > Date.now() && !selected) return cached;
  if (cached && cached.expiresAt <= Date.now() && !selected && !openingPage)
    throw new ServiceError(
      "选区草稿已过期，请重新打开租用页面",
      "draft_expired",
      409,
    );
  const shape = selected
    ? parseShape(boxShape(selected.box), selected.dimension, getConfig())
    : parseShape(
        defaultShape(
          vector(current.location),
          current.dimension.id,
          getConfig(),
        ),
        current.dimension.id,
        getConfig(),
      );
  const value = {
    shape,
    dimension: selected?.dimension ?? current.dimension.id,
    expiresAt: Date.now() + 300_000,
  };
  pendingBoxes.delete(current.id);
  drafts.set(current.id, value);
  return value;
}
function defaults(shape: LandShape) {
  const center = shapeCenter(shape);
  return {
    x: Math.floor(center.x),
    y: shape.min.y,
    z: Math.floor(center.z),
    length: shape.max.x - shape.min.x + 1,
    width: shape.max.z - shape.min.z + 1,
    height: shape.max.y - shape.min.y + 1,
    radius:
      shape.type === "cylinder"
        ? shape.radius
        : Math.max(
            1,
            Math.floor(
              Math.min(shape.max.x - shape.min.x, shape.max.z - shape.min.z) /
                2,
            ),
          ),
  };
}
function editedShape(
  input: Record<string, unknown>,
  selected: Draft,
): LandShape {
  const base = defaults(selected.shape);
  const field = (key: keyof typeof base) =>
    input[key] === undefined || String(input[key]).trim() === ""
      ? base[key]
      : integer(
          input[key],
          {
            x: "中心 X",
            y: "底部 Y",
            z: "中心 Z",
            length: "长",
            width: "宽",
            height: "高度",
            radius: "半径",
          }[key],
        );
  const x = field("x"),
    y = field("y"),
    z = field("z"),
    height = field("height");
  if (height < 1) invalid("高度须为正整数");
  const type = String(input.shapeType ?? "cuboid");
  let shape: LandShape;
  if (type === "cylinder") {
    const radius = field("radius");
    if (radius < 1) invalid("半径须为正整数");
    shape = {
      type,
      radius,
      min: { x: x - radius, y, z: z - radius },
      max: { x: x + radius, y: y + height - 1, z: z + radius },
    };
  } else if (type === "cuboid") {
    const length = field("length"),
      width = field("width");
    if (length < 1 || width < 1) invalid("长和宽须为正整数");
    const min = {
      x: x - Math.floor((length - 1) / 2),
      y,
      z: z - Math.floor((width - 1) / 2),
    };
    shape = {
      type,
      min,
      max: { x: min.x + length - 1, y: y + height - 1, z: min.z + width - 1 },
    };
  } else invalid("请选择长方体或圆柱体");
  return parseShape(shape, selected.dimension, getConfig());
}
async function leaseDraft(input: Record<string, unknown>) {
  const selected = draft(input, true);
  return {
    ...defaults(selected.shape),
    shapeType: selected.shape.type,
    dimensionText: DIMENSIONS[selected.dimension]!.name,
    rangeText: rangeText(selected.shape),
    shapeText: shapeText(selected.shape),
    volume: shapeVolume(selected.shape),
  };
}
async function highlight(
  shape: LandShape,
  dimension: string,
  playerId: string,
) {
  await showLandHighlight({ key: `preview:${playerId}`, shape, dimension });
}
async function beginSelection(input: Record<string, unknown>) {
  const current = player(input);
  clearLandUiState(current.id);
  pendingBoxes.delete(current.id);
  clearShapes(`preview:${current.id}`);
  selectionSessions.set(current.id, {
    dimension: current.dimension.id,
    startedAt: Date.now(),
  });
  return {
    ok: true,
    message: "已开启选点，请空手点击两个方块作为对角点。五分钟内有效。",
  };
}
export async function acceptSelectedRange(
  current: Player,
  box: Aabb,
  dimension: string,
): Promise<void> {
  const shape = parseShape(boxShape(box), dimension, getConfig());
  clearLandUiState(current.id);
  pendingBoxes.set(current.id, { box: shape, dimension });
  await highlight(shape, dimension, current.id);
  Msg.info("范围已选定，可调整形状、尺寸和位置后预览费用。", current);
  await openLandUi(current, "land.lease");
}
async function previewLease(input: Record<string, unknown>) {
  const current = player(input),
    selected = draft(input),
    shape = editedShape(input, selected);
  const params = {
    playerId: current.id,
    dimension: selected.dimension,
    shape,
    days: selectedDays(input),
  };
  const quote = await quoteCreateLease(params);
  const quoteId = saveQuote(
    "create",
    current.id,
    params,
    quote.fee,
    undefined,
    editorKey(input),
  );
  await highlight(shape, selected.dimension, current.id);
  return {
    quoteId,
    fee: quote.fee,
    dailyRent: quote.dailyRent,
    days: quote.days,
    ...Object.fromEntries(
      Object.entries(editorValues(input)).map(([key, value]) => [
        `quoted_${key}`,
        value,
      ]),
    ),
    quotedDaysOption: Number(input.daysOption ?? 7),
    quotedCustomDays: String(input.customDays ?? ""),
    shapeText: shapeText(shape),
    rangeText: rangeText(shape),
    volume: shapeVolume(shape),
    message: `${shapeText(shape)}，体积 ${shapeVolume(shape)} 方块；租用 ${quote.days} 天，共 ${quote.fee} 货币。报价有效期 2 分钟。`,
  };
}
async function createLease(input: Record<string, unknown>) {
  const quote = readQuote(input, "create"),
    current = player(input);
  if (editorKey(input) !== quote.editorKey)
    throw new ServiceError(
      "选区或租期已变更，请重新预览",
      "quote_changed",
      409,
    );
  const result = await handleCreateLease(quote.input);
  pendingBoxes.delete(current.id);
  drafts.delete(current.id);
  clearShapes(`preview:${current.id}`);
  return result;
}
async function detail(input: Record<string, unknown>) {
  const { land } = await ownedLand(input),
    status = String(land.status);
  return {
    ...land,
    leaseUntilText: new Date(Number(land.leaseUntil)).toLocaleString(),
    graceUntilText: new Date(Number(land.graceUntil)).toLocaleString(),
    dimensionText: DIMENSIONS[String(land.dimension)]!.name,
    rangeText: rangeText(land.shape as LandShape),
    expandLevels: getConfig()
      .claim.level_radius.slice(0, getConfig().claim.max_level)
      .map((radius, index) => ({
        value: index + 1,
        label: `${index + 1} 级 · 半径 ${radius}`,
      })),
    terminateRequestId: makeId("terminate"),
    renameRequestId: makeId("rename"),
    canRenew: status !== "terminated",
    canRename: status !== "terminated",
    canExpand:
      status === "active" && Number(land.level) < getConfig().claim.max_level,
    maxLevel: getConfig().claim.max_level,
  };
}
async function previewRenew(input: Record<string, unknown>) {
  const { current, land } = await ownedLand(input);
  const params = {
    playerId: current.id,
    landId: land.id,
    version: land.version,
    days: selectedDays(input),
  };
  const quote = await quoteRenewLease(params),
    quoteId = saveQuote(
      "renew",
      current.id,
      params,
      quote.fee,
      String(land.id),
    );
  return {
    quoteId,
    fee: quote.fee,
    days: quote.days,
    quotedDaysOption: Number(input.daysOption ?? 7),
    quotedCustomDays: String(input.customDays ?? ""),
    message: `续租 ${quote.days} 天，共 ${quote.fee} 货币。报价有效期 2 分钟。`,
  };
}
async function renew(input: Record<string, unknown>) {
  const quote = readQuote(input, "renew");
  if (selectedDays(input) !== quote.input.days)
    throw new ServiceError("天数已变更，请重新预览", "quote_changed", 409);
  return handleRenewLease(quote.input);
}
async function previewExpand(input: Record<string, unknown>) {
  const { current, land } = await ownedLand(input),
    cfg = getConfig();
  const level = Number(input.level);
  if (
    !Number.isInteger(level) ||
    level <= Number(land.level) ||
    level > cfg.claim.max_level
  )
    throw new ServiceError(
      "请选择高于当前等级的有效扩建等级",
      "invalid_argument",
      400,
    );
  const old = land.shape as LandShape,
    core = vector(land.core),
    radius = cfg.claim.level_radius[level - 1]!;
  const shape = parseShape(
    {
      type: old.type,
      radius,
      min: { x: core.x - radius, y: old.min.y, z: core.z - radius },
      max: { x: core.x + radius, y: old.max.y, z: core.z + radius },
    },
    String(land.dimension),
    cfg,
  );
  const params = {
    playerId: current.id,
    landId: land.id,
    version: land.version,
    shape,
  };
  const quote = await quoteExpandLease(params),
    quoteId = saveQuote(
      "expand",
      current.id,
      { ...params, level },
      quote.fee,
      String(land.id),
    );
  await highlight(shape, String(land.dimension), current.id);
  return {
    quoteId,
    level,
    fee: quote.fee,
    dailyRent: quote.dailyRent,
    message: `扩建至 ${level} 级，体积 ${shapeVolume(shape)} 方块；补差 ${quote.fee} 货币，新日租 ${quote.dailyRent}。`,
  };
}
async function expand(input: Record<string, unknown>) {
  const quote = readQuote(input, "expand");
  if (Number(input.level) !== quote.input.level)
    throw new ServiceError("等级已变更，请重新预览", "quote_changed", 409);
  const result = await handleExpandLease(quote.input);
  clearShapes(`preview:${quote.playerId}`);
  return result;
}
async function terminate(input: Record<string, unknown>) {
  const { current, land } = await ownedLand(input);
  return handleTerminateLease({
    playerId: current.id,
    landId: land.id,
    version: land.version,
    requestId: input.requestId,
    expectedFee: 0,
  });
}
async function rename(input: Record<string, unknown>) {
  const { current, land } = await ownedLand(input);
  return handleRename({
    playerId: current.id,
    landId: land.id,
    version: input.version,
    name: input.name,
    requestId: input.requestId,
  });
}
export const landUiServices: Record<
  string,
  (input: Record<string, unknown>) => unknown | Promise<unknown>
> = {
  "land.ui.detail": detail,
  "land.ui.previewRenew": previewRenew,
  "land.ui.renew": renew,
  "land.ui.previewExpand": previewExpand,
  "land.ui.expand": expand,
  "land.ui.terminate": terminate,
  "land.ui.rename": rename,
  "land.ui.beginSelection": beginSelection,
  "land.ui.leaseDraft": leaseDraft,
  "land.ui.previewLease": previewLease,
  "land.ui.createLease": createLease,
};
