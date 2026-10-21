/**
 * 行与领域对象之间的转换。
 * 数据库只保存标量；权限集合、旗标和元数据在边界处解析。
 */

import { nameKey } from "../domain/ids.js";
import { presetRoles } from "../domain/permissions.js";
import type { Aabb } from "../domain/geometry.js";
import type {
  AreaRoleState,
  AreaState,
  FlagValue,
  LandState,
  LeaseState,
  ListingState,
  MemberState,
  Relation,
  RoleState,
  SpawnPoint,
  TxState,
  TxStatus,
} from "../domain/model.js";

/** 数据库行。平台返回的值在运行时是标量，这里集中读取。 */
export type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jsonObject(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    }
    return out;
  } catch {
    return {};
  }
}

function jsonStringList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function spawnOf(row: Row): SpawnPoint | null {
  const dimensionId = str(row, "spawn_dim");
  if (!dimensionId) return null;
  return {
    dimensionId,
    x: num(row, "spawn_x"),
    y: num(row, "spawn_y"),
    z: num(row, "spawn_z"),
    yaw: num(row, "spawn_yaw"),
    pitch: num(row, "spawn_pitch"),
  };
}

/** 领地行转内存对象。区块列表由索引另存。 */
export function landFromRow(row: Row): LandState {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    nameKey: str(row, "name_key"),
    description: str(row, "description"),
    ownerId: str(row, "owner_id"),
    ownerName: str(row, "owner_name"),
    status: (str(row, "status") || "active") as LandState["status"],
    level: num(row, "level") || 1,
    spawn: spawnOf(row),
    bankAccount: str(row, "bank_account"),
    metadata: jsonObject(str(row, "metadata_json")),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
    nextUpkeepAt: num(row, "next_upkeep_at"),
    graceUntil: num(row, "grace_until"),
    upkeepDue: num(row, "upkeep_due"),
    taxEnabled: num(row, "tax_enabled") === 1,
    taxAmount: num(row, "tax_amount"),
    taxPeriodMs: num(row, "tax_period_ms"),
    nextTaxAt: num(row, "next_tax_at"),
    claimKeys: [],
    defaultAreaId: "",
  };
}

/** 领地对象转可写入的行。 */
export function landToRow(land: LandState): Row {
  return {
    id: land.id,
    name: land.name,
    name_key: land.nameKey,
    description: land.description,
    owner_id: land.ownerId,
    owner_name: land.ownerName,
    status: land.status,
    level: land.level,
    spawn_dim: land.spawn?.dimensionId ?? "",
    spawn_x: land.spawn?.x ?? 0,
    spawn_y: land.spawn?.y ?? 0,
    spawn_z: land.spawn?.z ?? 0,
    spawn_yaw: land.spawn?.yaw ?? 0,
    spawn_pitch: land.spawn?.pitch ?? 0,
    bank_account: land.bankAccount,
    metadata_json: JSON.stringify(land.metadata),
    next_upkeep_at: land.nextUpkeepAt,
    grace_until: land.graceUntil,
    upkeep_due: land.upkeepDue,
    tax_enabled: land.taxEnabled ? 1 : 0,
    tax_amount: land.taxAmount,
    tax_period_ms: land.taxPeriodMs,
    next_tax_at: land.nextTaxAt,
    created_at: land.createdAt,
    updated_at: land.updatedAt,
  };
}

/** 子区域行。 */
export function areaFromRow(row: Row): AreaState {
  const kind = str(row, "kind") === "default" ? "default" : "box";
  const box: Aabb | null =
    kind === "box"
      ? {
          min: { x: num(row, "min_x"), y: num(row, "min_y"), z: num(row, "min_z") },
          max: { x: num(row, "max_x"), y: num(row, "max_y"), z: num(row, "max_z") },
        }
      : null;
  return {
    id: str(row, "id"),
    landId: str(row, "land_id"),
    name: str(row, "name"),
    nameKey: str(row, "name_key"),
    description: str(row, "description"),
    kind,
    dimensionId: str(row, "dimension_id"),
    box,
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

/** 子区域写入行。 */
export function areaToRow(area: AreaState): Row {
  return {
    id: area.id,
    land_id: area.landId,
    name: area.name,
    name_key: area.nameKey,
    area_key: `${area.landId}|${area.nameKey}`,
    description: area.description,
    kind: area.kind,
    dimension_id: area.dimensionId,
    min_x: area.box?.min.x ?? 0,
    min_y: area.box?.min.y ?? 0,
    min_z: area.box?.min.z ?? 0,
    max_x: area.box?.max.x ?? 0,
    max_y: area.box?.max.y ?? 0,
    max_z: area.box?.max.z ?? 0,
    created_at: area.createdAt,
    updated_at: area.updatedAt,
  };
}

/** 角色行。 */
export function roleFromRow(row: Row): RoleState {
  return {
    id: str(row, "id"),
    landId: str(row, "land_id"),
    name: str(row, "name"),
    nameKey: str(row, "name_key"),
    description: str(row, "description"),
    permissions: jsonStringList(str(row, "permissions_json")),
    reserved: num(row, "reserved") === 1,
    preset: presetOf(row),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

/** 旧行没有 preset 时，先按原模板名识别，再按保留角色的权限集合识别。 */
function presetOf(row: Row): string {
  const stored = str(row, "preset");
  if (stored) return stored;
  const named = presetRoles().find((item) => nameKey(item.name) === nameKey(str(row, "name")));
  if (named) return named.key;
  if (num(row, "reserved") !== 1) return "";
  const permissions = jsonStringList(str(row, "permissions_json"));
  const matches = presetRoles().filter(
    (item) => item.reserved && item.permissions.length === permissions.length && item.permissions.every((permission) => permissions.includes(permission)),
  );
  return matches.length === 1 ? matches[0]!.key : "";
}

/** 角色写入行。 */
export function roleToRow(role: RoleState): Row {
  return {
    id: role.id,
    land_id: role.landId,
    name: role.name,
    name_key: role.nameKey,
    role_key: `${role.landId}|${role.nameKey}`,
    description: role.description,
    permissions_json: JSON.stringify(role.permissions),
    preset: role.preset,
    reserved: role.reserved ? 1 : 0,
    created_at: role.createdAt,
    updated_at: role.updatedAt,
  };
}

/** 成员行。 */
export function memberFromRow(row: Row): MemberState {
  return {
    id: str(row, "id"),
    landId: str(row, "land_id"),
    playerId: str(row, "player_id"),
    playerName: str(row, "player_name"),
    relation: str(row, "relation") as Relation,
    roleId: str(row, "role_id"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

/** 成员写入行。 */
export function memberToRow(member: MemberState): Row {
  return {
    id: member.id,
    land_id: member.landId,
    player_id: member.playerId,
    player_name: member.playerName,
    member_key: `${member.landId}|${member.playerId}`,
    relation: member.relation,
    role_id: member.roleId,
    created_at: member.createdAt,
    updated_at: member.updatedAt,
  };
}

/** 区域角色覆盖。 */
export function areaRoleFromRow(row: Row): AreaRoleState {
  return {
    id: str(row, "id"),
    areaId: str(row, "area_id"),
    landId: str(row, "land_id"),
    playerId: str(row, "player_id"),
    roleId: str(row, "role_id"),
  };
}

/** 区域角色写入行。 */
export function areaRoleToRow(role: AreaRoleState): Row {
  return {
    id: role.id,
    area_id: role.areaId,
    land_id: role.landId,
    player_id: role.playerId,
    role_id: role.roleId,
    assign_key: `${role.areaId}|${role.playerId}`,
  };
}

/** 旗标值。损坏的 JSON 回退为空字符串，由解析器再用默认值。 */
export function flagValueFromJson(raw: string): FlagValue {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "boolean" || typeof parsed === "number" || typeof parsed === "string") return parsed;
  } catch {
    /* 使用空字符串表示无法解析 */
  }
  return "";
}

/** 交易行。 */
export function txFromRow(row: Row): TxState {
  return {
    id: str(row, "id"),
    idempotencyKey: str(row, "idempotency_key"),
    kind: str(row, "kind"),
    status: (str(row, "status") || "pending") as TxStatus,
    landId: str(row, "land_id"),
    actorId: str(row, "actor_id"),
    fromAccount: str(row, "from_account"),
    toAccount: str(row, "to_account"),
    amount: num(row, "amount"),
    payloadJson: str(row, "payload_json") || "{}",
    error: str(row, "error"),
    economyTxId: str(row, "economy_tx_id"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

/** 租约行。 */
export function leaseFromRow(row: Row): LeaseState {
  const status = str(row, "status");
  return {
    id: str(row, "id"),
    areaId: str(row, "area_id"),
    landId: str(row, "land_id"),
    tenantId: str(row, "tenant_id"),
    tenantName: str(row, "tenant_name"),
    price: num(row, "price"),
    periodMs: num(row, "period_ms"),
    startAt: num(row, "start_at"),
    endAt: num(row, "end_at"),
    status: status === "ended" || status === "expired" ? status : "active",
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

/** 挂牌行。 */
export function listingFromRow(row: Row): ListingState {
  const status = str(row, "status");
  return {
    id: str(row, "id"),
    targetType: str(row, "target_type") === "land" ? "land" : "area",
    targetId: str(row, "target_id"),
    landId: str(row, "land_id"),
    kind: str(row, "kind") === "rent" ? "rent" : "sale",
    price: num(row, "price"),
    periodMs: num(row, "period_ms"),
    status: status === "closed" || status === "sold" ? status : "open",
    sellerId: str(row, "seller_id"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}
