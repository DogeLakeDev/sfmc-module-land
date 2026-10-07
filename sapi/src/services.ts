import { parseShape } from "./shape-validation.js";
/** land.* 租赁服务。所有写操作校验主人，并使用可重放的请求标识。 */
import { ServiceError } from "@sfmc-bds/sdk/sapi/service";
import {
  defaultShape,
  shapeCenter,
  shapeContains,
  shapesIntersect,
  shapeText,
  shapeVolume,
} from "./geometry.js";
import type { LandConfig } from "./config.js";
import { activityQuery, activityRecord } from "./platform.js";
import {
  calcDailyRent,
  calcPeriodRent,
  expansionFeeDiff,
  remainingLeaseDays,
} from "./rent.js";
import {
  findLandByPos,
  getLandById,
  landToAabb,
  landToShape,
  listLandsByOwner,
  listEffectiveLandsInDimension,
  makeId,
  LANDS_TABLE,
} from "./store.js";
import {
  commitLandOperation,
  replayOperation,
  serializeLandMutation,
} from "./mutations.js";
import { DAY_MS, type LandShape, type LandRow } from "./types.js";
import {
  dimensionId,
  invalid,
  landName,
  leaseDays,
  leaseState,
  statusText,
  textId,
  vector,
} from "./validation.js";
import { clearShapes } from "./debug-draw.js";

let getConfig: () => LandConfig = () => {
  throw new ServiceError("领地配置尚未初始化", "failed_precondition", 503);
};
export function bindLandConfig(getter: () => LandConfig): void {
  getConfig = getter;
}
export function rowToPublic(land: LandRow): Record<string, unknown> {
  const status = leaseState(land, getConfig());
  return {
    id: land.id,
    ownerId: land.owner_id,
    name: land.name,
    dimension: land.dimension,
    shape: landToShape(land),
    shapeText: shapeText(landToShape(land)),
    volume: shapeVolume(landToShape(land)),
    min: landToAabb(land).min,
    max: landToAabb(land).max,
    core: { x: land.core_x, y: land.core_y, z: land.core_z },
    level: land.level,
    status,
    statusText: statusText(status),
    dailyRent: land.daily_rent,
    leaseUntil: land.lease_until,
    graceUntil:
      land.grace_until ||
      land.lease_until + getConfig().grace_period_days * DAY_MS,
    version: land.version,
    createdAt: land.created_at,
    updatedAt: land.updated_at,
  };
}
function pageNumber(v: unknown, fallback: number, max: number): number {
  const value = v === undefined ? fallback : v;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid("分页参数须为非负整数");
  return Math.min(value, max);
}
export async function handleById(
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const land = await getLandById(textId(input.landId, "landId"));
  return land ? rowToPublic(land) : null;
}
export async function handleByPos(
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const dimension = dimensionId(input.dimension);
  const p = vector(input);
  const land = await findLandByPos(dimension, p.x, p.y, p.z);
  return land && leaseState(land, getConfig()) !== "terminated"
    ? rowToPublic(land)
    : null;
}
export async function handleListByOwner(
  input: Record<string, unknown>,
): Promise<{ lands: Record<string, unknown>[] }> {
  const lands = await listLandsByOwner(
    textId(input.ownerId, "ownerId"),
    Math.max(1, pageNumber(input.limit, 50, 100)),
    pageNumber(input.offset, 0, Number.MAX_SAFE_INTEGER),
  );
  return { lands: lands.map(rowToPublic) };
}
async function ownedLand(input: Record<string, unknown>): Promise<LandRow> {
  const ownerId = textId(input.playerId, "playerId");
  const land = await getLandById(textId(input.landId, "landId"));
  if (!land) throw new ServiceError("领地不存在", "not_found", 404);
  if (land.owner_id !== ownerId)
    throw new ServiceError("只能管理自己的领地", "forbidden", 403);
  if (input.version !== undefined && input.version !== land.version)
    throw new ServiceError(
      "领地信息已变更，请刷新后重试",
      "stale_version",
      409,
    );
  return land;
}
async function countEffectiveLands(ownerId: string): Promise<number> {
  const lands = await listLandsByOwner(ownerId, 1000);
  return lands.filter((land) => leaseState(land, getConfig()) !== "terminated")
    .length;
}
async function checkConflict(
  dimension: string,
  shape: LandShape,
  exclude?: string,
): Promise<string | undefined> {
  const lands = await listEffectiveLandsInDimension(dimension);
  for (const land of lands)
    if (
      land.id !== exclude &&
      leaseState(land, getConfig()) !== "terminated" &&
      shapesIntersect(shape, landToShape(land))
    )
      return land.id;
  return undefined;
}
export async function handleValidateShape(
  input: Record<string, unknown>,
): Promise<{ valid: boolean; dailyRent: number; conflict?: string }> {
  const dimension = dimensionId(input.dimension);
  const shape = parseShape(input.shape, dimension, getConfig());
  const exclude =
    typeof input.excludeLandId === "string" ? input.excludeLandId : undefined;
  const ownerId = textId(input.ownerId, "ownerId");
  const count = Math.max(
    0,
    (await countEffectiveLands(ownerId)) - (exclude ? 1 : 0),
  );
  const conflict = await checkConflict(dimension, shape, exclude);
  return {
    valid: !conflict,
    dailyRent: calcDailyRent(shape, getConfig(), count),
    ...(conflict ? { conflict } : {}),
  };
}
export async function quoteCreateLease(input: Record<string, unknown>) {
  const ownerId = textId(input.playerId, "playerId"),
    dimension = dimensionId(input.dimension),
    days = leaseDays(input.days);
  const cfg = getConfig();
  if ((await countEffectiveLands(ownerId)) >= cfg.max_lands_per_player)
    throw new ServiceError("已达个人领地上限", "land_limit", 409);
  const shape = input.shape
    ? parseShape(input.shape, dimension, cfg)
    : parseShape(
        defaultShape(vector(input.core), dimension, cfg),
        dimension,
        cfg,
      );
  const validated = await handleValidateShape({
    dimension,
    shape,
    ownerId,
  });
  if (!validated.valid)
    throw new ServiceError(
      `范围与领地 ${validated.conflict} 重叠`,
      "land_conflict",
      409,
    );
  const core = vector(shapeCenter(shape));
  return {
    ownerId,
    dimension,
    days,
    shape,
    core,
    dailyRent: validated.dailyRent,
    fee: calcPeriodRent(validated.dailyRent, days, cfg),
  };
}
export async function quoteRenewLease(input: Record<string, unknown>) {
  const land = await ownedLand(input),
    days = leaseDays(input.days);
  if (leaseState(land, getConfig()) === "terminated")
    throw new ServiceError("租赁已结束，不能续租", "lease_ended", 409);
  return {
    land,
    days,
    fee: calcPeriodRent(land.daily_rent, days, getConfig()),
  };
}
export async function quoteExpandLease(input: Record<string, unknown>) {
  const land = await ownedLand(input);
  if (leaseState(land, getConfig()) !== "active")
    throw new ServiceError(
      "仅租期内的领地可扩建，请先续租",
      "lease_inactive",
      409,
    );
  const shape = parseShape(input.shape, land.dimension, getConfig()),
    old = landToShape(land);
  if (shape.type !== old.type) invalid("已租用的领地不能更换形状");
  if (!shapeContains(shape, old))
    invalid("扩建范围须包含原领地，不能移动或缩小范围");
  if (shapeVolume(shape) <= shapeVolume(old)) invalid("扩建范围未增加");
  const validated = await handleValidateShape({
    dimension: land.dimension,
    shape,
    excludeLandId: land.id,
    ownerId: land.owner_id,
  });
  if (!validated.valid)
    throw new ServiceError(
      `范围与领地 ${validated.conflict} 重叠`,
      "land_conflict",
      409,
    );
  const dailyRent = Math.max(land.daily_rent, validated.dailyRent);
  const remaining = Math.max(0, (land.lease_until - Date.now()) / DAY_MS);
  const fee = expansionFeeDiff(land.daily_rent, dailyRent, remaining);
  return { land, shape, dailyRent, fee, level: inferLevel(shape) };
}
function checkPrice(input: Record<string, unknown>, fee: number): void {
  if (
    !Number.isSafeInteger(input.expectedFee) ||
    (input.expectedFee as number) < fee
  )
    throw new ServiceError(
      "费用已变更，请重新预览后确认",
      "price_changed",
      409,
    );
}
async function afterMutation(
  landId: string,
  eventType: string,
  actorId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await activityRecord({ eventType, actorId, targetId: landId, payload });
}
function writeOperation(
  type: string,
  input: Record<string, unknown>,
  run: (ownerId: string) => Promise<Record<string, unknown>>,
) {
  return serializeLandMutation(async () => {
    const ownerId = textId(input.playerId, "playerId");
    const replay = await replayOperation(input, ownerId, type);
    return replay ?? (await run(ownerId));
  });
}
export function handleCreateLease(input: Record<string, unknown>) {
  return writeOperation("create", input, async (ownerId) => {
    const quote = await quoteCreateLease(input);
    checkPrice(input, quote.fee);
    const landId = makeId("land");
    const name = `领地-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${landId.split("_").at(-1)!.toUpperCase()}`;
    const result = await commitLandOperation(
      input,
      "create",
      ownerId,
      quote.fee,
      landId,
      async (tx) => {
        const now = Date.now(),
          leaseUntil = now + quote.days * DAY_MS;
        const row: LandRow = {
          id: landId,
          owner_id: ownerId,
          name,
          dimension: quote.dimension,
          shape_type: quote.shape.type,
          radius: quote.shape.type === "cylinder" ? quote.shape.radius : 0,
          min_x: quote.shape.min.x,
          min_y: quote.shape.min.y,
          min_z: quote.shape.min.z,
          max_x: quote.shape.max.x,
          max_y: quote.shape.max.y,
          max_z: quote.shape.max.z,
          core_x: quote.core.x,
          core_y: quote.core.y,
          core_z: quote.core.z,
          level: inferLevel(quote.shape),
          status: "active",
          daily_rent: quote.dailyRent,
          lease_until: leaseUntil,
          grace_until: 0,
          version: 1,
          created_at: now,
          updated_at: now,
        };
        await tx.insert(LANDS_TABLE, row as unknown as Record<string, unknown>);
        return { ok: true, landId, name, leaseUntil, fee: quote.fee };
      },
    );
    await afterMutation(landId, "land.lease.created", ownerId, {
      days: quote.days,
      fee: quote.fee,
    });
    return result;
  });
}
export function handleRenewLease(input: Record<string, unknown>) {
  return writeOperation("renew", input, async (ownerId) => {
    const quote = await quoteRenewLease(input);
    checkPrice(input, quote.fee);
    const result = await commitLandOperation(
      input,
      "renew",
      ownerId,
      quote.fee,
      quote.land.id,
      async (tx) => {
        const newExpiry =
          Math.max(Date.now(), quote.land.lease_until) + quote.days * DAY_MS;
        await tx.update(LANDS_TABLE, quote.land.id, {
          lease_until: newExpiry,
          grace_until: 0,
          status: "active",
          version: quote.land.version + 1,
          updated_at: Date.now(),
        });
        return { ok: true, newExpiry, fee: quote.fee };
      },
    );
    await afterMutation(quote.land.id, "land.lease.renewed", ownerId, {
      days: quote.days,
      fee: quote.fee,
    });
    return result;
  });
}
export function handleExpandLease(input: Record<string, unknown>) {
  return writeOperation("expand", input, async (ownerId) => {
    const quote = await quoteExpandLease(input);
    checkPrice(input, quote.fee);
    const result = await commitLandOperation(
      input,
      "expand",
      ownerId,
      quote.fee,
      quote.land.id,
      async (tx) => {
        await tx.update(LANDS_TABLE, quote.land.id, {
          min_x: quote.shape.min.x,
          min_y: quote.shape.min.y,
          min_z: quote.shape.min.z,
          max_x: quote.shape.max.x,
          max_y: quote.shape.max.y,
          max_z: quote.shape.max.z,
          radius: quote.shape.type === "cylinder" ? quote.shape.radius : 0,
          daily_rent: quote.dailyRent,
          level: quote.level,
          version: quote.land.version + 1,
          updated_at: Date.now(),
        });
        return { ok: true, feeDiff: quote.fee, dailyRent: quote.dailyRent };
      },
    );
    clearShapes(quote.land.id);
    await afterMutation(quote.land.id, "land.lease.expanded", ownerId, {
      fee: quote.fee,
      dailyRent: quote.dailyRent,
    });
    return result;
  });
}
export function handleTerminateLease(input: Record<string, unknown>) {
  return writeOperation("terminate", input, async (ownerId) => {
    const land = await ownedLand(input);
    const result = await commitLandOperation(
      input,
      "terminate",
      ownerId,
      0,
      land.id,
      async (tx) => {
        await tx.update(LANDS_TABLE, land.id, {
          status: "terminated",
          grace_until: 0,
          version: land.version + 1,
          updated_at: Date.now(),
        });
        return { ok: true };
      },
    );
    clearShapes(land.id);
    await activityRecord({
      eventType: "land.lease.terminated",
      actorId: ownerId,
      targetId: land.id,
      payload: { reason: "manual" },
    });
    return result;
  });
}
export function handleRename(input: Record<string, unknown>) {
  return writeOperation("rename", input, async (ownerId) => {
    const land = await ownedLand(input);
    if (leaseState(land, getConfig()) === "terminated")
      throw new ServiceError("租赁已结束，不能改名", "lease_ended", 409);
    const name = landName(input.name, "");
    const result = await commitLandOperation(
      input,
      "rename",
      ownerId,
      0,
      land.id,
      async (tx) => {
        await tx.update(LANDS_TABLE, land.id, {
          name,
          version: land.version + 1,
          updated_at: Date.now(),
        });
        return { ok: true, name };
      },
    );
    await afterMutation(land.id, "land.lease.renamed", ownerId, { name });
    return result;
  });
}
export async function handleLeaseStatus(input: Record<string, unknown>) {
  const land = await getLandById(textId(input.landId, "landId"));
  if (!land) throw new ServiceError("领地不存在", "not_found", 404);
  const view = rowToPublic(land);
  return {
    ...view,
    remainingDays: remainingLeaseDays(land.lease_until),
    isGracePeriod: view.status === "dormant",
  };
}
export async function handleAuditLog(input: Record<string, unknown>) {
  const land = await ownedLand(input);
  return activityQuery({
    targetId: land.id,
    eventTypePrefix: "land.",
    limit: Math.max(1, pageNumber(input.limit, 50, 100)),
    offset: pageNumber(input.offset, 0, Number.MAX_SAFE_INTEGER),
  });
}
function inferLevel(box: LandShape): number {
  const half = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
  let level = 1;
  getConfig()
    .claim.level_radius.slice(0, getConfig().claim.max_level)
    .forEach((r, i) => {
      if (half >= r) level = i + 1;
    });
  return level;
}
