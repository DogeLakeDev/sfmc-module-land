/** 租赁 GUI 适配：固定范围草稿、准确报价、报价有效期及重复提交去重。 */
import { world } from "@minecraft/server";
import { ServiceError } from "@sfmc-bds/sdk/sapi/service";
import { verticalBoxFromCore } from "./aabb.js";
import type { LandConfig } from "./config.js";
import { clearShapes, showLandHighlight } from "./debug-draw.js";
import { pendingBoxes } from "./pending.js";
import {
  quoteCreateLease,
  quoteExpandLease,
  quoteRenewLease,
  handleById,
  handleCreateLease,
  handleExpandLease,
  handleRenewLease,
  handleTerminateLease,
} from "./services.js";
import { makeId } from "./store.js";
import { DIMENSIONS, leaseDays, rangeText, vector } from "./validation.js";
import type { Aabb } from "./types.js";

type Draft = {
  box?: Aabb;
  core?: { x: number; y: number; z: number };
  dimension: string;
  expiresAt: number;
};
type Quote = {
  kind: string;
  playerId: string;
  landId?: string;
  input: Record<string, unknown>;
  expiresAt: number;
};
const drafts = new Map<string, Draft>();
const quotes = new Map<string, Quote>();
const QUOTE_MS = 120_000;
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
function saveQuote(
  kind: string,
  playerId: string,
  input: Record<string, unknown>,
  fee: number,
  landId?: string,
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
  ) {
    throw new ServiceError(
      "报价已失效，请重新预览后提交",
      "quote_expired",
      409,
    );
  }
  return quote;
}
function draft(input: Record<string, unknown>): Draft {
  const current = player(input),
    selected = pendingBoxes.get(current.id);
  const cached = drafts.get(current.id);
  if (cached && cached.expiresAt > Date.now() && !selected) return cached;
  const value: Draft = selected
    ? {
        box: selected.box,
        dimension: selected.dimension,
        expiresAt: Date.now() + 300_000,
      }
    : {
        core: vector(current.location),
        dimension: current.dimension.id,
        expiresAt: Date.now() + 300_000,
      };
  drafts.set(current.id, value);
  return value;
}
function draftInput(input: Record<string, unknown>) {
  const current = player(input),
    selected = draft(input);
  return {
    playerId: current.id,
    dimension: selected.dimension,
    days: leaseDays(input.days),
    name: String(input.name ?? "").trim() || `${current.name}的领地`,
    ...(selected.box
      ? { min: selected.box.min, max: selected.box.max }
      : { core: selected.core }),
  };
}
async function leaseDraft(input: Record<string, unknown>) {
  const current = player(input),
    selected = draft(input),
    bounds = DIMENSIONS[selected.dimension]!;
  const box =
    selected.box ??
    verticalBoxFromCore(
      selected.core!,
      getConfig().claim.initial_radius,
      bounds.minY,
      bounds.maxY,
    );
  return {
    mode: selected.box ? "选点范围" : "当前位置范围",
    description: "范围固定在打开页面时的位置；修改选点后请重新预览。",
    suggestedName: `${current.name}的领地`,
    dimensionText: bounds.name,
    rangeText: rangeText(box),
  };
}
async function highlight(box: Aabb, dimension: string, playerId: string) {
  await showLandHighlight({
    key: `preview:${playerId}`,
    box,
    dimension,
  });
}
async function previewLease(input: Record<string, unknown>) {
  const params = draftInput(input),
    quote = await quoteCreateLease(params);
  const quoteId = saveQuote("create", params.playerId, params, quote.fee);
  await highlight(quote.box, quote.dimension, params.playerId);
  return {
    quoteId,
    fee: quote.fee,
    dailyRent: quote.dailyRent,
    days: quote.days,
    quotedName: String(input.name ?? ""),
    name: quote.name,
    rangeText: rangeText(quote.box),
    message: `租用 ${quote.days} 天，共 ${quote.fee} 货币。报价有效期 2 分钟。`,
  };
}
async function createLease(input: Record<string, unknown>) {
  const quote = readQuote(input, "create"),
    current = player(input);
  const name = String(input.name ?? "").trim() || `${current.name}的领地`;
  if (Number(input.days) !== quote.input.days || name !== quote.input.name)
    throw new ServiceError(
      "名称或天数已变更，请重新预览",
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
    dimensionText:
      DIMENSIONS[String(land.dimension)]?.name ?? String(land.dimension),
    rangeText: rangeText({ min: land.min, max: land.max } as Aabb),
    expandLevels: getConfig()
      .claim.level_radius.slice(0, getConfig().claim.max_level)
      .map((radius, index) => ({
        value: index + 1,
        label: `${index + 1} 级 · 半径 ${radius}`,
      })),
    terminateRequestId: makeId("terminate"),
    canRenew: status !== "terminated",
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
    days: leaseDays(Number(input.days)),
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
    message: `续租 ${quote.days} 天，共 ${quote.fee} 货币。报价有效期 2 分钟。`,
  };
}
async function renew(input: Record<string, unknown>) {
  const quote = readQuote(input, "renew");
  if (Number(input.days) !== quote.input.days)
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
  const core = vector(land.core),
    bounds = DIMENSIONS[String(land.dimension)]!;
  const box = verticalBoxFromCore(
    core,
    cfg.claim.level_radius[level - 1]!,
    bounds.minY,
    bounds.maxY,
  );
  const params = {
    playerId: current.id,
    landId: land.id,
    version: land.version,
    newMin: box.min,
    newMax: box.max,
  };
  const quote = await quoteExpandLease(params),
    quoteId = saveQuote(
      "expand",
      current.id,
      { ...params, level },
      quote.fee,
      String(land.id),
    );
  await highlight(box, String(land.dimension), current.id);
  return {
    quoteId,
    level,
    fee: quote.fee,
    dailyRent: quote.dailyRent,
    message: `扩建至 ${level} 级，补差 ${quote.fee} 货币，新日租 ${quote.dailyRent}。`,
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
  "land.ui.leaseDraft": leaseDraft,
  "land.ui.previewLease": previewLease,
  "land.ui.createLease": createLease,
};
