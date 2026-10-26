/**
 * 给其他模块调用的领地服务。
 * 读接口不要求操作者；写接口只承认在线玩家自己的身份，不接受调用方自行声明管理员。
 */

import { world } from "@minecraft/server";
import { Permission } from "@sfmc-bds/sdk/sapi/runtime";
import { ServiceError, service } from "@sfmc-bds/sdk/sapi/service";
import { renderMessage } from "./messages/catalog.js";
import { asLandError, LandError } from "./domain/errors.js";
import type { Actor } from "./domain/model.js";
import { claimChunks, createLand, deleteLand } from "./services/territory.js";
import { setFlag } from "./services/flags.js";
import { landMapView } from "./services/map-view.js";
import { assignRole, createRole, deleteRole, invite, setRolePermission } from "./services/people.js";
import { decide } from "./services/permission.js";
import {
  registerStoredFlag,
  registerStoredHostile,
  registerStoredPermission,
  registerStoredQuota,
  registerUpgradeCondition,
  registerUpgradeReward,
} from "./services/registry.js";
import { subscribe, unsubscribe } from "./services/hooks.js";
import { landConfig, requireLand, resolvePlayer, world as landWorld } from "./services/shared.js";
import type { FlagDef, PermissionDef } from "./domain/permissions.js";

const cleanups: Array<() => void> = [];

/** 注册公开服务，并返回可在模块清理时调用的注销函数。 */
export function provideLandApi(): Array<() => void> {
  const entries: Array<[string, (input: unknown) => Promise<unknown>]> = [
    ["land.here", handleHere],
    ["land.get", handleGet],
    ["land.list", handleList],
    ["land.map", handleMap],
    ["land.permission", handlePermission],
    ["land.create", handleCreate],
    ["land.delete", handleDelete],
    ["land.claim", handleClaim],
    ["land.role.create", handleRoleCreate],
    ["land.role.grant", handleRoleGrant],
    ["land.role.revoke", handleRoleRevoke],
    ["land.role.assign", handleRoleAssign],
    ["land.role.delete", handleRoleDelete],
    ["land.flag.set", handleFlag],
    ["land.member.invite", handleInvite],
    ["land.registry.permission", handleRegisterPermission],
    ["land.registry.flag", handleRegisterFlag],
    ["land.registry.quota", handleRegisterQuota],
    ["land.registry.condition", handleRegisterCondition],
    ["land.registry.reward", handleRegisterReward],
    ["land.registry.hostile", handleRegisterHostile],
    ["land.event.subscribe", handleSubscribe],
    ["land.event.unsubscribe", handleUnsubscribe],
  ];
  for (const [name, handler] of entries) {
    cleanups.push(service.provide(name, (input) => guard(handler, input)));
  }
  return cleanups;
}

/** 注销本模块注册的服务。 */
export function releaseLandApi(): void {
  for (const off of cleanups.splice(0, cleanups.length)) off();
}

/**
 * 映射为 HTTP 403 的错误键。
 * 使用场景：guard 把领域错误转成服务错误状态码；rent_owner 是「领主租自己的区域」的专用文案，
 * 语义上仍属权限拒绝，保持与原先 no_permission 相同的 403。
 */
const FORBIDDEN_KEYS = new Set(["no_permission", "rent_owner"]);

async function guard(handler: (input: unknown) => Promise<unknown>, input: unknown): Promise<unknown> {
  try {
    return await handler(input);
  } catch (error) {
    const wrapped = asLandError(error);
    const status = FORBIDDEN_KEYS.has(wrapped.key) ? 403 : wrapped.key.endsWith("not_found") ? 404 : wrapped.key === "internal" ? 500 : 409;
    throw new ServiceError(renderMessage("zh", wrapped.key, wrapped.vars, {}), wrapped.key, status);
  }
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function text(input: unknown, key: string): string {
  const value = record(input)[key];
  return typeof value === "string" ? value : "";
}

function num(input: unknown, key: string): number {
  const value = record(input)[key];
  return typeof value === "number" ? value : Number(value);
}

/** 写操作的操作者。管理员标记来自在线权限，不读取请求体。 */
function actorFrom(input: unknown): Actor {
  const id = text(input, "actorId");
  if (!id) throw new LandError("need_player");
  const online = world.getAllPlayers().find((player) => player.id === id);
  return {
    id,
    name: online?.name ?? (text(input, "actorName") || id),
    admin: online ? Permission.check(online, "land.admin") : false,
    console: false,
  };
}

async function handleHere(input: unknown): Promise<unknown> {
  const located = landWorld().locate(text(input, "dimensionId"), num(input, "x"), num(input, "y"), num(input, "z"));
  if (!located) return { found: false };
  return {
    found: true,
    landId: located.land.id,
    landName: located.land.name,
    ownerId: located.land.ownerId,
    areaId: located.area.id,
    areaName: located.area.name,
    specific: located.specific,
    status: located.land.status,
  };
}

async function handleGet(input: unknown): Promise<unknown> {
  const land = requireLand(text(input, "name") || text(input, "landId"));
  return {
    id: land.id,
    name: land.name,
    ownerId: land.ownerId,
    ownerName: land.ownerName,
    status: land.status,
    level: land.level,
    chunks: land.claimKeys.length,
    description: land.description,
    spawn: land.spawn,
    metadata: land.metadata,
  };
}

async function handleList(input: unknown): Promise<unknown> {
  const ownerId = text(input, "ownerId");
  const rows = [...landWorld().lands.values()].filter((land) => !ownerId || land.ownerId === ownerId);
  return { lands: rows.map((land) => ({ id: land.id, name: land.name, ownerId: land.ownerId, status: land.status, chunks: land.claimKeys.length })) };
}

/**
 * land.map：全部领地的地图视图（区块与子区域水平范围）。可选 dimensionId 只取一个维度。
 * 使用场景：网页地图定时拉取后绘制领地图层。只读，不要求操作者。
 */
async function handleMap(input: unknown): Promise<unknown> {
  return landMapView(landWorld(), text(input, "dimensionId"));
}

async function handlePermission(input: unknown): Promise<unknown> {
  const playerId = text(input, "playerId");
  const online = world.getAllPlayers().find((player) => player.id === playerId);
  const located = landWorld().locate(text(input, "dimensionId"), num(input, "x"), num(input, "y"), num(input, "z"));
  const decision = decide(
    landWorld(),
    { id: playerId, admin: online ? Permission.check(online, "land.admin") : false },
    text(input, "permission"),
    located,
    landConfig().wildernessProtected,
  );
  return decision;
}

async function handleCreate(input: unknown): Promise<unknown> {
  const land = await createLand(actorFrom(input), text(input, "name"), text(input, "description"), {
    dimensionId: text(input, "dimensionId"),
    x: num(input, "x"),
    y: num(input, "y"),
    z: num(input, "z"),
    yaw: num(input, "yaw") || 0,
    pitch: num(input, "pitch") || 0,
  });
  return { id: land.id, name: land.name };
}

async function handleDelete(input: unknown): Promise<unknown> {
  await deleteLand(actorFrom(input), text(input, "land") || text(input, "landId"));
  return { ok: true };
}

async function handleRoleCreate(input: unknown): Promise<unknown> {
  const role = await createRole(actorFrom(input), text(input, "land") || text(input, "landId"), text(input, "name"), text(input, "description"));
  return { id: role.id, name: role.name };
}

async function handleRoleGrant(input: unknown): Promise<unknown> {
  await setRolePermission(actorFrom(input), text(input, "land") || text(input, "landId"), text(input, "role"), text(input, "permission"), true);
  return { ok: true };
}

async function handleRoleRevoke(input: unknown): Promise<unknown> {
  await setRolePermission(actorFrom(input), text(input, "land") || text(input, "landId"), text(input, "role"), text(input, "permission"), false);
  return { ok: true };
}

async function handleRoleAssign(input: unknown): Promise<unknown> {
  await assignRole(actorFrom(input), text(input, "land") || text(input, "landId"), text(input, "playerId"), text(input, "role"));
  return { ok: true };
}

async function handleRoleDelete(input: unknown): Promise<unknown> {
  const replacement = text(input, "replacement");
  await deleteRole(actorFrom(input), text(input, "land") || text(input, "landId"), text(input, "role"), replacement || undefined);
  return { ok: true };
}

async function handleClaim(input: unknown): Promise<unknown> {
  const count = await claimChunks(actorFrom(input), text(input, "land") || text(input, "landId"), [
    { dimensionId: text(input, "dimensionId"), chunkX: num(input, "chunkX"), chunkZ: num(input, "chunkZ") },
  ]);
  return { count };
}

async function handleFlag(input: unknown): Promise<unknown> {
  const area = text(input, "area");
  const value = await setFlag(actorFrom(input), text(input, "land") || text(input, "landId"), text(input, "flag"), text(input, "value"), area || undefined);
  return { value };
}

async function handleInvite(input: unknown): Promise<unknown> {
  const playerId = text(input, "playerId");
  const known = resolvePlayer(playerId, world.getAllPlayers());
  const role = text(input, "role");
  await invite(actorFrom(input), text(input, "land") || text(input, "landId"), known, role || undefined);
  return { ok: true };
}

async function handleRegisterPermission(input: unknown): Promise<unknown> {
  const def = record(input) as unknown as PermissionDef;
  if (!def.id || !def.description) throw new LandError("bad_name", { label: "权限", name: def.id ?? "" });
  await registerStoredPermission({ id: def.id, description: def.description });
  return { ok: true };
}

async function handleRegisterFlag(input: unknown): Promise<unknown> {
  const def = record(input) as unknown as FlagDef;
  if (!def.id || !def.type || !def.scope) throw new LandError("flag_unknown", { name: def.id ?? "" });
  await registerStoredFlag(def);
  return { ok: true };
}

async function handleRegisterQuota(input: unknown): Promise<unknown> {
  const id = text(input, "id");
  const limit = num(input, "limit");
  const usageService = text(input, "usageService");
  await registerStoredQuota(id, limit, usageService || undefined);
  return { ok: true };
}

async function handleRegisterCondition(input: unknown): Promise<unknown> {
  await registerUpgradeCondition(text(input, "id"), text(input, "service"));
  return { ok: true };
}

async function handleRegisterReward(input: unknown): Promise<unknown> {
  await registerUpgradeReward(text(input, "id"), text(input, "service"));
  return { ok: true };
}

async function handleRegisterHostile(input: unknown): Promise<unknown> {
  await registerStoredHostile(text(input, "typeId"));
  return { ok: true };
}

async function handleSubscribe(input: unknown): Promise<unknown> {
  await subscribe(text(input, "event"), text(input, "target"));
  return { ok: true };
}

async function handleUnsubscribe(input: unknown): Promise<unknown> {
  await unsubscribe(text(input, "event"), text(input, "target"));
  return { ok: true };
}
