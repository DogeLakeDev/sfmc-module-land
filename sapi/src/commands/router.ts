/**
 * /c:land 命令路由。
 * 参数由平台命令系统解析；这里只做校验并调用领域服务。
 */

import type { Player } from "@minecraft/server";
import { world } from "@minecraft/server";
import { Permission } from "@sfmc-bds/sdk/sapi/runtime";
import { claimKey, chunkOf } from "../domain/geometry.js";
import { chunkPrice, landConfig, rememberPlayer, requireLand, resolvePlayer, world as landWorld } from "../services/shared.js";
import { LandError } from "../domain/errors.js";
import type { Actor } from "../domain/model.js";
import { say, sayError } from "../messages/speak.js";
import { openTransactions, diagnose, repair, setAdminBypass } from "../services/admin.js";
import { bankBalance, deposit, payUpkeep, setTax, upgradeLand, upkeepAmount, withdraw } from "../services/finance.js";
import { nextLevelRule } from "../config.js";
import { builtinQuota } from "../services/quota.js";
import {
  buy,
  cancelListing,
  endLease,
  publishAreaSale,
  publishLandSale,
  publishRent,
  renewLease,
  takeLease,
} from "../services/market.js";
import {
  acceptInvite,
  assignAreaRole,
  assignRole,
  ban,
  createRole,
  deleteRole,
  denyInvite,
  describeRole,
  invite,
  kick,
  renameRole,
  setRolePermission,
  trust,
  unban,
  untrust,
} from "../services/people.js";
import { decide, resolveFlag, resolveRole } from "../services/permission.js";
import { holds } from "../services/shared.js";
import { setFlag } from "../services/flags.js";
import {
  chunksFromSelection,
  claimChunks,
  createArea,
  resizeArea,
  createLand,
  deleteArea,
  deleteLand,
  describeArea,
  describeLand,
  renameArea,
  renameLand,
  setMetadata,
  setSpawn,
  resetSpawn,
  transferLand,
  unclaimChunks,
} from "../services/territory.js";
import { teleportToLand } from "../services/travel.js";
import { hideBorder, showBorder } from "../runtime/loops.js";
import { rememberLocale } from "../messages/speak.js";
import { saveRegistry, listRegistry } from "../store/repo.js";
import { makeId } from "../domain/ids.js";

/** 子命令。顺序会变成原生命令的枚举补全。 */
export const LAND_ACTIONS = [
  "help",
  "create",
  "delete",
  "rename",
  "describe",
  "info",
  "list",
  "transfer",
  "here",
  "map",
  "near",
  "meta",
  "claim",
  "unclaim",
  "claim_rect",
  "unclaim_rect",
  "spawn_set",
  "spawn_show",
  "spawn_reset",
  "tp",
  "border",
  "border_stop",
  "level",
  "upgrade",
  "quota",
  "bank",
  "deposit",
  "withdraw",
  "upkeep",
  "upkeep_pay",
  "tax",
  "tax_set",
  "area_pos1",
  "area_pos2",
  "area_create",
  "area_resize",
  "area_delete",
  "area_rename",
  "area_describe",
  "area_info",
  "area_list",
  "area_member",
  "area_flag",
  "flag",
  "invite",
  "accept",
  "deny",
  "trust",
  "untrust",
  "kick",
  "ban",
  "unban",
  "members",
  "assign",
  "role_create",
  "role_delete",
  "role_rename",
  "role_describe",
  "role_grant",
  "role_revoke",
  "role_list",
  "role_info",
  "perms",
  "rent_publish",
  "rent_cancel",
  "rent_take",
  "rent_renew",
  "rent_end",
  "sell_area",
  "sell_land",
  "buy",
  "unsell",
  "tx",
  "lang",
  "admin_bypass",
  "admin_diag",
  "admin_repair",
  "admin_tx",
] as const;

const selection = new Map<string, { dimensionId?: string; pos1?: { x: number; y: number; z: number }; pos2?: { x: number; y: number; z: number } }>();

function actorOf(player: Player | undefined): Actor {
  if (!player) return { id: "console", name: "console", admin: true, console: true };
  return { id: player.id, name: player.name, admin: Permission.check(player, "land.admin"), console: false };
}

function words(args: unknown[]): string[] {
  return args.filter((arg) => arg !== undefined && String(arg).length > 0).map((arg) => String(arg));
}

function confirmed(args: string[], command: string): string[] {
  if (args[args.length - 1] !== "confirm") throw new LandError("need_confirm", { command });
  return args.slice(0, -1);
}

function hereOf(player: Player) {
  const rotation = player.getRotation();
  return {
    dimensionId: player.dimension.id,
    x: player.location.x,
    y: player.location.y,
    z: player.location.z,
    yaw: rotation.y,
    pitch: rotation.x,
  };
}

function currentLand(player: Player, token?: string) {
  if (token) return requireLand(token);
  const located = landWorld().locate(player.dimension.id, player.location.x, player.location.y, player.location.z);
  if (!located) throw new LandError("wilderness");
  return located.land;
}

/** 执行一条领地命令。返回值保持空，避免平台把返回值再发成成功消息。 */
export async function runLandCommand(player: Player | undefined, action: unknown, ...rest: unknown[]): Promise<void> {
  const name = typeof action === "string" ? action : "help";
  try {
    if (player) await rememberPlayer(player);
    if (name.startsWith("admin_") && player && !Permission.check(player, "land.admin")) {
      throw new LandError("no_permission", { reason: "land.admin" });
    }
    await dispatch(player, actorOf(player), name, words(rest));
  } catch (error) {
    sayError(player, error);
  }
}

async function dispatch(player: Player | undefined, actor: Actor, action: string, args: string[]): Promise<void> {
  switch (action) {
    case "help":
      say(player, "help_hint", {}, "info");
      say(player, "help_land", {}, "tips");
      say(player, "help_area", {}, "tips");
      say(player, "help_people", {}, "tips");
      say(player, "help_money", {}, "tips");
      return;
    case "create": {
      if (!player) throw new LandError("need_player");
      const name = args[0];
      if (!name) throw new LandError("bad_name", { label: "领地名称", name: "" });
      await createLand(actor, name, args.slice(1).join(" "), hereOf(player));
      say(player, "created", { name }, "success");
      return;
    }
    case "delete": {
      const [name] = confirmed(args, `/c:land delete ${args[0] ?? ""} confirm`);
      if (!name) throw new LandError("land_not_found", { name: "" });
      await deleteLand(actor, name);
      say(player, "deleted", { name }, "success");
      return;
    }
    case "rename":
      await renameLand(actor, need(args, 0), need(args, 1));
      say(player, "renamed", { name: need(args, 1) }, "success");
      return;
    case "describe":
      await describeLand(actor, need(args, 0), args.slice(1).join(" "));
      say(player, "described", {}, "success");
      return;
    case "info":
    case "here": {
      if (!player && action === "here") throw new LandError("need_player");
      const land = player ? currentLand(player, args[0]) : requireLand(need(args, 0));
      say(player, "info", { name: land.name, owner: land.ownerName, level: land.level, status: land.status, chunks: land.claimKeys.length }, "info");
      return;
    }
    case "list": {
      const rows = [...landWorld().lands.values()].filter(
        (land) => land.ownerId === actor.id || landWorld().member(land.id, actor.id),
      );
      if (rows.length === 0) say(player, "list_empty", {}, "tips");
      for (const land of rows) {
        const relation = land.ownerId === actor.id ? "owner" : (landWorld().member(land.id, actor.id)?.relation ?? "none");
        say(player, "list_line", { name: land.name, relation, chunks: land.claimKeys.length, status: land.status }, "info");
      }
      return;
    }
    case "transfer": {
      if (!player) throw new LandError("need_player");
      const [name, who] = confirmed(args, `/c:land transfer ${args[0] ?? ""} ${args[1] ?? ""} confirm`);
      const target = resolvePlayer(who ?? "", world.getAllPlayers());
      await transferLand(actor, name ?? "", target);
      say(player, "transferred", { name: name ?? "", player: target.name }, "success");
      return;
    }
    case "map":
    case "near": {
      if (!player) throw new LandError("need_player");
      say(player, "map_title", {}, "info");
      const origin = chunkOf(player.dimension.id, player.location.x, player.location.z);
      const lines: string[] = [];
      for (let dz = -3; dz <= 3; dz += 1) {
        let line = "";
        for (let dx = -3; dx <= 3; dx += 1) {
          const key = claimKey(origin.dimensionId, origin.chunkX + dx, origin.chunkZ + dz);
          const landId = landWorld().claims.get(key);
          line += !landId ? "." : landId === currentOptional(player) ? "#" : "+";
        }
        lines.push(line);
      }
      for (const line of lines) say(player, "map_line", { line }, "tips");
      return;
    }
    case "meta":
      await setMetadata(actor, need(args, 0), need(args, 1), args.slice(2).join(" "));
      say(player, "meta_set", { key: need(args, 1) }, "success");
      return;
    case "claim":
    case "unclaim":
    case "claim_rect":
    case "unclaim_rect":
      await claimCommand(player, actor, action, args);
      return;
    case "spawn_set":
    case "spawn_reset":
    case "spawn_show":
    case "tp":
      await spawnCommand(player, actor, action, args);
      return;
    case "border":
      if (!player) throw new LandError("need_player");
      showBorder(player.id, args[0] ? requireLand(args[0]).id : currentLand(player).id);
      say(player, "border_on", {}, "success");
      return;
    case "border_stop":
      if (player) hideBorder(player.id);
      say(player, "border_off", {}, "success");
      return;
    case "level":
    case "upgrade":
    case "quota":
      await growthCommand(player, actor, action, args);
      return;
    case "bank":
    case "deposit":
    case "withdraw":
    case "upkeep":
    case "upkeep_pay":
    case "tax":
    case "tax_set":
      await moneyCommand(player, actor, action, args);
      return;
    case "area_pos1":
    case "area_pos2":
    case "area_create":
    case "area_resize":
    case "area_delete":
    case "area_rename":
    case "area_describe":
    case "area_info":
    case "area_list":
    case "area_member":
    case "area_flag":
    case "flag":
      await areaCommand(player, actor, action, args);
      return;
    case "invite":
    case "accept":
    case "deny":
    case "trust":
    case "untrust":
    case "kick":
    case "ban":
    case "unban":
    case "members":
    case "assign":
    case "role_create":
    case "role_delete":
    case "role_rename":
    case "role_describe":
    case "role_grant":
    case "role_revoke":
    case "role_list":
    case "role_info":
    case "perms":
      await peopleCommand(player, actor, action, args);
      return;
    case "rent_publish":
    case "rent_cancel":
    case "rent_take":
    case "rent_renew":
    case "rent_end":
    case "sell_area":
    case "sell_land":
    case "buy":
    case "unsell":
    case "tx":
      await tradeCommand(player, actor, action, args);
      return;
    case "lang": {
      if (!player) throw new LandError("need_player");
      const locale = args[0] === "en" ? "en" : "zh";
      rememberLocale(player.id, locale);
      const rows = await listRegistry("locale");
      const existing = rows.find((row) => row.key === `locale|${player.id}`);
      await saveRegistry("locale", player.id, existing?.id ?? makeId("y"), JSON.stringify({ locale }), existing?.id);
      say(player, "lang_set", { locale }, "success");
      return;
    }
    case "admin_bypass":
      setAdminBypass(actor, args[0] !== "off");
      say(player, args[0] === "off" ? "bypass_off" : "bypass_on", {}, "warning");
      return;
    case "admin_diag":
      say(player, "diag", { summary: diagnose(args[0]).join("；") }, "info");
      return;
    case "admin_repair": {
      const body = confirmed(args.length > 0 ? args : ["confirm"], "/c:land admin_repair confirm");
      const summary = await repair(actor, body[0]);
      say(player, "repaired", { summary }, "success");
      return;
    }
    case "admin_tx": {
      const lines = await openTransactions(args[0]);
      if (lines.length === 0) say(player, "tx_missing", { id: "-" }, "tips");
      for (const line of lines) say(player, "tx", { id: line, status: "", amount: "" }, "info");
      return;
    }
    default:
      throw new LandError("unknown_command");
  }
}

function need(args: string[], index: number): string {
  const value = args[index];
  if (!value) throw new LandError("bad_name", { label: "参数", name: "" });
  return value;
}

function currentOptional(player: Player): string {
  return landWorld().locate(player.dimension.id, player.location.x, player.location.y, player.location.z)?.land.id ?? "";
}

function selectionBox(player: Player): {
  dimensionId: string;
  pos1: { x: number; y: number; z: number };
  pos2: { x: number; y: number; z: number };
} {
  const picked = selection.get(player.id);
  if (!picked?.pos1 || !picked.pos2 || !picked.dimensionId) throw new LandError("selection_missing");
  return { dimensionId: picked.dimensionId, pos1: picked.pos1, pos2: picked.pos2 };
}

async function claimCommand(player: Player | undefined, actor: Actor, action: string, args: string[]): Promise<void> {
  if (!player) throw new LandError("need_player");
  const here = hereOf(player);
  const chunk = chunkOf(here.dimensionId, here.x, here.z);
  if (action === "claim" || action === "unclaim") {
    const named = args[0] && args[0] !== "confirm" ? args[0] : undefined;
    const land = currentLand(player, named);
    if (action === "unclaim") {
      confirmed(args, `/c:land unclaim ${land.name} confirm`);
      const count = await unclaimChunks(actor, land.id, [chunk]);
      say(player, "unclaimed", { count }, "success");
      return;
    }
    const count = await claimChunks(actor, land.id, [chunk]);
    say(player, "claimed", { count, amount: count * chunkPrice(landConfig(), land) }, "success");
    return;
  }
  const picked = selectionBox(player);
  const chunks = chunksFromSelection(picked.dimensionId, picked.pos1, picked.pos2);
  const token = need(args, 0);
  if (action === "claim_rect") {
    const count = await claimChunks(actor, token, chunks);
    say(player, "claimed", { count, amount: count * chunkPrice(landConfig(), requireLand(token)) }, "success");
    return;
  }
  confirmed(args, `/c:land unclaim_rect ${token} confirm`);
  const count = await unclaimChunks(actor, token, chunks);
  say(player, "unclaimed", { count }, "success");
}

async function spawnCommand(player: Player | undefined, actor: Actor, action: string, args: string[]): Promise<void> {
  if (!player) throw new LandError("need_player");
  const land = currentLand(player, args[0]);
  if (action === "spawn_show") {
    if (!land.spawn) throw new LandError("spawn_missing");
    say(player, "spawn_set", {}, "info");
    say(player, "info", { name: land.spawn.dimensionId, owner: `${land.spawn.x} ${land.spawn.y} ${land.spawn.z}`, level: "", status: "", chunks: "" }, "tips");
    return;
  }
  if (action === "tp") {
    await teleportToLand(actor, player, land.name);
    say(player, "teleported", { name: land.name }, "success");
    return;
  }
  if (action === "spawn_reset") await resetSpawn(actor, land.id, hereOf(player));
  else await setSpawn(actor, land.id, hereOf(player));
  say(player, "spawn_set", {}, "success");
}

async function growthCommand(player: Player | undefined, actor: Actor, action: string, args: string[]): Promise<void> {
  if (!player && action !== "quota") throw new LandError("need_player");
  const land = player ? currentLand(player, args[0]) : requireLand(need(args, 0));
  if (action === "upgrade") {
    confirmed(args, `/c:land upgrade ${land.name} confirm`);
    const level = await upgradeLand(actor, land.id);
    say(player, "upgraded", { level }, "success");
    return;
  }
  if (action === "quota") {
    for (const id of ["lands", "chunks", "members", "areas", "roles"] as const) {
      const view = builtinQuota(landConfig(), landWorld(), actor, id === "lands" ? undefined : land, id, (permission) => holds(actor, permission));
      say(player, "quota_line", { label: id, used: view.used, limit: view.limit }, "info");
    }
    return;
  }
  const next = nextLevelRule(landConfig(), land.level);
  say(player, "level_line", { level: land.level, need: next ? `L${next.level} 费用 ${next.cost}` : "max" }, "info");
}

function moneyTarget(player: Player | undefined, args: string[]): { landId: string; amount: number; label: string } {
  const amountToken = args.length >= 2 ? args[1] : args[0];
  const landToken = args.length >= 2 ? args[0] : undefined;
  const land = player ? currentLand(player, landToken) : requireLand(landToken ?? "");
  return { landId: land.id, amount: Number(amountToken), label: amountToken ?? "" };
}

async function moneyCommand(player: Player | undefined, actor: Actor, action: string, args: string[]): Promise<void> {
  if (action === "tax_set") {
    const hours = Number(args[2] ?? 24);
    await setTax(actor, need(args, 0), Number(need(args, 1)), hours * 3_600_000);
    say(player, "tax_set", {}, "success");
    return;
  }
  if (action === "deposit" || action === "withdraw") {
    const body = action === "withdraw" ? confirmed(args, `/c:land withdraw ${args[0] ?? ""} ${args[1] ?? ""} confirm`) : args;
    const target = moneyTarget(player, body);
    const balance = action === "deposit" ? await deposit(actor, target.landId, target.amount) : await withdraw(actor, target.landId, target.amount);
    say(player, action === "deposit" ? "deposited" : "withdrawn", { amount: target.label, balance }, "success");
    return;
  }
  const land = player ? currentLand(player, args[0]) : requireLand(need(args, 0));
  if (action === "bank") {
    const balance = await bankBalance(actor, land.id);
    say(player, "bank", { balance }, "info");
    return;
  }
  if (action === "upkeep") {
    say(player, "upkeep", { amount: upkeepAmount(land), when: land.nextUpkeepAt, status: land.status }, "info");
    return;
  }
  if (action === "upkeep_pay") {
    await payUpkeep(actor, land.id);
    say(player, "upkeep_paid", { amount: upkeepAmount(requireLand(land.id)) }, "success");
    return;
  }
  say(player, "tax_set", {}, "info");
  say(player, "info", { name: land.name, owner: String(land.taxAmount), level: land.taxEnabled ? "on" : "off", status: String(land.taxPeriodMs), chunks: "" }, "tips");
}

async function areaCommand(player: Player | undefined, actor: Actor, action: string, args: string[]): Promise<void> {
  if (!player) throw new LandError("need_player");
  if (action === "area_pos1" || action === "area_pos2") {
    const point = { x: player.location.x, y: player.location.y, z: player.location.z };
    const current = selection.get(player.id) ?? {};
    current.dimensionId = player.dimension.id;
    if (action === "area_pos1") current.pos1 = point;
    else current.pos2 = point;
    selection.set(player.id, current);
    say(player, "selection_set", { which: action, x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) }, "success");
    return;
  }
  if (action === "area_list") {
    for (const area of landWorld().areasOf(currentLand(player, args[0]).id)) {
      say(player, "list_line", { name: area.name, relation: area.kind, chunks: "", status: area.dimensionId }, "info");
    }
    return;
  }
  if (action === "area_info") {
    const land = currentLand(player, args[0]);
    const area = landWorld().areaByName(land.id, need(args, 1));
    if (!area) throw new LandError("area_not_found", { name: need(args, 1) });
    const box = area.box;
    say(player, "info", {
      name: area.name,
      owner: area.kind,
      level: box ? `${box.min.x},${box.min.y},${box.min.z}` : "-",
      status: box ? `${box.max.x},${box.max.y},${box.max.z}` : "-",
      chunks: area.dimensionId,
    }, "info");
    return;
  }
  if (action === "area_create" || action === "area_resize") {
    const picked = selectionBox(player);
    const corners = [
      { ...picked.pos1, dimensionId: picked.dimensionId },
      { ...picked.pos2, dimensionId: picked.dimensionId },
    ] as const;
    if (action === "area_create") {
      const area = await createArea(actor, need(args, 0), need(args, 1), corners[0], corners[1]);
      say(player, "area_created", { name: area.name }, "success");
      return;
    }
    await resizeArea(actor, need(args, 0), need(args, 1), corners[0], corners[1]);
    say(player, "area_updated", { name: need(args, 1) }, "success");
    return;
  }
  if (action === "area_delete") {
    const [land, area] = confirmed(args, `/c:land area_delete ${args[0] ?? ""} ${args[1] ?? ""} confirm`);
    await deleteArea(actor, land ?? "", area ?? "");
    say(player, "area_deleted", { name: area ?? "" }, "success");
    return;
  }
  if (action === "area_rename") {
    await renameArea(actor, need(args, 0), need(args, 1), need(args, 2));
    say(player, "area_updated", { name: need(args, 2) }, "success");
    return;
  }
  if (action === "area_describe") {
    await describeArea(actor, need(args, 0), need(args, 1), args.slice(2).join(" "));
    say(player, "area_updated", { name: need(args, 1) }, "success");
    return;
  }
  if (action === "area_member") {
    const target = resolvePlayer(need(args, 2), world.getAllPlayers());
    await assignAreaRole(actor, need(args, 0), need(args, 1), target.id, need(args, 3));
    say(player, "member_updated", { player: target.name }, "success");
    return;
  }
  if (action === "flag") {
    await setFlag(actor, need(args, 0), need(args, 1), need(args, 2));
    say(player, "flag_updated", { name: need(args, 1) }, "success");
    return;
  }
  await setFlag(actor, need(args, 0), need(args, 2), need(args, 3), need(args, 1));
  say(player, "flag_updated", { name: need(args, 2) }, "success");
}

async function peopleCommand(player: Player | undefined, actor: Actor, action: string, args: string[]): Promise<void> {
  if (action === "accept" || action === "deny") {
    if (action === "accept") await acceptInvite(actor, need(args, 0));
    else await denyInvite(actor, need(args, 0));
    say(player, action === "accept" ? "member_accepted" : "member_denied", { name: need(args, 0) }, "success");
    return;
  }
  if (action === "members") {
    const land = requireLand(need(args, 0));
    say(player, "members_line", { name: land.ownerName, relation: "owner", role: "-" }, "info");
    for (const member of landWorld().membersOf(land.id)) {
      const role = landWorld().roles.get(member.roleId);
      say(player, "members_line", { name: member.playerName, relation: member.relation, role: role?.name ?? "-" }, "info");
    }
    return;
  }
  if (action === "perms") {
    if (!player) throw new LandError("need_player");
    const located = landWorld().locate(player.dimension.id, player.location.x, player.location.y, player.location.z);
    if (!located) throw new LandError("wilderness");
    const member = landWorld().member(located.land.id, actor.id);
    const resolved = resolveRole(landWorld(), located, actor.id, member);
    const decision = decide(landWorld(), actor, "block.break", located, false);
    say(player, "perms_line", { where: located.area.name, role: resolved.role?.name ?? decision.reason, relation: decision.relation }, "info");
    say(player, "info", { name: "pvp", owner: String(resolveFlag(landWorld(), located.land, located.area, "pvp")), level: "explosion", status: String(resolveFlag(landWorld(), located.land, located.area, "explosion")), chunks: "" }, "tips");
    return;
  }
  if (action === "role_list" || action === "role_info") {
    const land = requireLand(need(args, 0));
    const roles = action === "role_info" ? [landWorld().roleByName(land.id, need(args, 1))].filter((role) => role !== undefined) : landWorld().rolesOf(land.id);
    for (const role of roles) say(player, "members_line", { name: role.name, relation: role.reserved ? "reserved" : "custom", role: role.permissions.join(",") }, "info");
    return;
  }
  if (action === "role_create") {
    const role = await createRole(actor, need(args, 0), need(args, 1), args.slice(2).join(" "));
    say(player, "role_created", { name: role.name }, "success");
    return;
  }
  if (action === "role_delete") {
    const body = confirmed(args, `/c:land role_delete ${args[0] ?? ""} ${args[1] ?? ""} confirm`);
    await deleteRole(actor, body[0] ?? "", body[1] ?? "", body[2]);
    say(player, "role_deleted", { name: body[1] ?? "" }, "success");
    return;
  }
  if (action === "role_rename") {
    await renameRole(actor, need(args, 0), need(args, 1), need(args, 2));
    say(player, "role_updated", { name: need(args, 2) }, "success");
    return;
  }
  if (action === "role_describe") {
    await describeRole(actor, need(args, 0), need(args, 1), args.slice(2).join(" "));
    say(player, "role_updated", { name: need(args, 1) }, "success");
    return;
  }
  if (action === "role_grant" || action === "role_revoke") {
    await setRolePermission(actor, need(args, 0), need(args, 1), need(args, 2), action === "role_grant");
    say(player, "role_updated", { name: need(args, 1) }, "success");
    return;
  }
  if (!player) throw new LandError("need_player");
  const target = resolvePlayer(need(args, 1), world.getAllPlayers());
  if (action === "invite") {
    await invite(actor, need(args, 0), target, args[2]);
    say(player, "member_invited", { player: target.name }, "success");
    return;
  }
  if (action === "trust") {
    await trust(actor, need(args, 0), target, args[2]);
    say(player, "member_updated", { player: target.name }, "success");
    return;
  }
  if (action === "assign") {
    await assignRole(actor, need(args, 0), target.id, need(args, 2));
    say(player, "member_updated", { player: target.name }, "success");
    return;
  }
  const body = confirmed(args, `/c:land ${action} ${args[0] ?? ""} ${args[1] ?? ""} confirm`);
  const person = resolvePlayer(body[1] ?? "", world.getAllPlayers());
  if (action === "untrust") await untrust(actor, body[0] ?? "", person.id);
  else if (action === "kick") await kick(actor, body[0] ?? "", person.id);
  else if (action === "ban") await ban(actor, body[0] ?? "", person);
  else await unban(actor, body[0] ?? "", person.id);
  say(player, action === "ban" ? "member_banned" : action === "unban" ? "member_unbanned" : "member_removed", { player: person.name }, "success");
}

async function tradeCommand(player: Player | undefined, actor: Actor, action: string, args: string[]): Promise<void> {
  if (action === "rent_publish") {
    const listing = await publishRent(actor, need(args, 0), need(args, 1), Number(need(args, 2)), Number(need(args, 3)) * 3_600_000);
    say(player, "listed", { kind: "rent", price: listing.price }, "success");
    return;
  }
  if (action === "sell_area") {
    const listing = await publishAreaSale(actor, need(args, 0), need(args, 1), Number(need(args, 2)));
    say(player, "listed", { kind: "sale", price: listing.price }, "success");
    return;
  }
  if (action === "sell_land") {
    const listing = await publishLandSale(actor, need(args, 0), Number(need(args, 1)));
    say(player, "listed", { kind: "land", price: listing.price }, "success");
    return;
  }
  if (action === "rent_cancel" || action === "unsell") {
    await cancelListing(actor, need(args, 0), args[1]);
    say(player, "unlisted", {}, "success");
    return;
  }
  if (action === "rent_take") {
    await takeLease(actor, need(args, 0), need(args, 1));
    say(player, "rented", { name: need(args, 1) }, "success");
    return;
  }
  if (action === "rent_renew") {
    await renewLease(actor, need(args, 0), need(args, 1));
    say(player, "renewed", { name: need(args, 1) }, "success");
    return;
  }
  if (action === "rent_end") {
    const body = confirmed(args, `/c:land rent_end ${args[0] ?? ""} ${args[1] ?? ""} confirm`);
    await endLease(actor, body[0] ?? "", body[1] ?? "");
    say(player, "lease_ended", {}, "success");
    return;
  }
  if (action === "buy") {
    const body = confirmed(args, `/c:land buy ${args[0] ?? ""} ${args[1] ?? ""} confirm`);
    await buy(actor, body[0] ?? "", body[1]);
    say(player, "bought", { id: body[0] ?? "" }, "success");
    return;
  }
  const rows = await openTransactions(args[0]);
  for (const line of rows) say(player, "tx", { id: line, status: "", amount: "" }, "info");
}
