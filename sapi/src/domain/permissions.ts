/**
 * 权限与旗标注册表。
 * 核心逻辑只询问注册表，不把每一种操作写成不可扩展的分支。
 */

import type { FlagScope, FlagValue } from "./model.js";

/** 权限定义。其他模块通过公开 API 追加，不能改核心判断函数。 */
export interface PermissionDef {
  id: string;
  description: string;
}

/** 旗标定义。未注册的旗标不能被玩家写进领地。 */
export interface FlagDef {
  id: string;
  description: string;
  type: "boolean" | "number" | "string";
  scope: FlagScope;
  defaultValue: FlagValue;
  /** 环境规则由保护层执行；角色规则写在角色上；自定义规则只存储并交给注册模块解释。 */
  kind: "role" | "natural" | "custom";
}

/** 本模块实际执行的角色权限。 */
export const CORE_PERMISSIONS: PermissionDef[] = [
  { id: "block.break", description: "破坏方块" },
  { id: "block.place", description: "放置方块" },
  { id: "block.interact", description: "与未单独分类的方块交互" },
  { id: "container.open", description: "打开容器" },
  { id: "door.use", description: "使用门、活板门和栅栏门" },
  { id: "entity.attack", description: "攻击非敌对实体（动物、村民、盔甲架等）" },
  /** 攻击已登记的敌对生物。与 entity.attack 分开，便于对外开放打怪而不开放杀动物；使用场景：保护层伤害判定、iland 迁移映射。 */
  { id: "entity.attack_hostile", description: "攻击敌对生物" },
  { id: "entity.interact", description: "与实体交互" },
  { id: "redstone.interact", description: "使用红石机关" },
  { id: "land.manage", description: "修改领地设置、出生点和基础信息" },
  { id: "land.claim", description: "占领或释放区块" },
  { id: "land.transfer", description: "转让领地。领主关系本身仍不可被角色移除" },
  { id: "land.teleport", description: "传送到领地出生点" },
  { id: "member.manage", description: "邀请、移除、信任和封禁" },
  { id: "role.manage", description: "创建和修改自定义角色" },
  { id: "flag.manage", description: "修改领地或区域旗标" },
  { id: "area.manage", description: "创建和调整三维子区域" },
  { id: "bank.view", description: "查看领地银行" },
  { id: "bank.deposit", description: "向领地银行存款" },
  { id: "bank.withdraw", description: "从领地银行取款" },
  { id: "economy.manage", description: "设置维护、税费、租赁和出售" },
];

/** 环境旗标。只有当前 API 能可靠执行或明确标记为部分支持的项才会被保护层读取。 */
export const CORE_FLAGS: FlagDef[] = [
  {
    id: "explosion",
    description: "允许爆炸破坏领地内方块",
    type: "boolean",
    scope: "both",
    defaultValue: false,
    kind: "natural",
  },
  {
    id: "mob_spawn",
    description: "允许敌对生物在领地内生成。关闭时只能在生成后移除，属于部分支持",
    type: "boolean",
    scope: "both",
    defaultValue: true,
    kind: "natural",
  },
  {
    id: "pvp",
    description: "允许玩家对玩家造成伤害",
    type: "boolean",
    scope: "both",
    defaultValue: false,
    kind: "natural",
  },
  {
    id: "public_teleport",
    description: "允许未被封禁的玩家传送到出生点",
    type: "boolean",
    scope: "land",
    defaultValue: false,
    kind: "natural",
  },
  {
    id: "enter_message",
    description: "进入领地或子区域时发送提示",
    type: "boolean",
    scope: "both",
    defaultValue: true,
    kind: "natural",
  },
  {
    id: "leave_message",
    description: "离开领地或子区域时发送提示",
    type: "boolean",
    scope: "both",
    defaultValue: true,
    kind: "natural",
  },
  {
    id: "enter_text",
    description: "进入提示模板（领地与子区域各用自己的值，不继承），空字符串表示使用全局模板",
    type: "string",
    scope: "both",
    defaultValue: "",
    kind: "natural",
  },
  {
    id: "leave_text",
    description: "离开提示模板（领地与子区域各用自己的值，不继承），空字符串表示使用全局模板",
    type: "string",
    scope: "both",
    defaultValue: "",
    kind: "natural",
  },
];

const permissions = new Map<string, PermissionDef>();
const flags = new Map<string, FlagDef>();
const hostiles = new Set<string>();

for (const item of CORE_PERMISSIONS) permissions.set(item.id, item);
for (const item of CORE_FLAGS) flags.set(item.id, item);

for (const id of [
  "minecraft:zombie",
  "minecraft:skeleton",
  "minecraft:creeper",
  "minecraft:spider",
  "minecraft:cave_spider",
  "minecraft:enderman",
  "minecraft:witch",
  "minecraft:phantom",
  "minecraft:pillager",
  "minecraft:vindicator",
  "minecraft:evoker",
  "minecraft:ravager",
  "minecraft:vex",
  "minecraft:blaze",
  "minecraft:ghast",
  "minecraft:magma_cube",
  "minecraft:slime",
  "minecraft:hoglin",
  "minecraft:zoglin",
  "minecraft:piglin_brute",
  "minecraft:wither",
  "minecraft:ender_dragon",
  "minecraft:guardian",
  "minecraft:elder_guardian",
  "minecraft:shulker",
  "minecraft:silverfish",
  "minecraft:endermite",
  "minecraft:stray",
  "minecraft:husk",
  "minecraft:drowned",
  "minecraft:bogged",
  "minecraft:breeze",
  "minecraft:warden",
]) {
  hostiles.add(id);
}

/** 注册或覆盖权限说明。已有授权仍使用同一个权限 ID。 */
export function registerPermission(def: PermissionDef): void {
  permissions.set(def.id, def);
}

/** 注册旗标。重复注册要求数据类型一致，避免旧值被另一种类型重新解释。 */
export function registerFlag(def: FlagDef): void {
  const prev = flags.get(def.id);
  if (prev && prev.type !== def.type) {
    throw new Error(`旗标 ${def.id} 的类型不能从 ${prev.type} 改成 ${def.type}`);
  }
  flags.set(def.id, def);
}

/** 读取权限定义。未注册返回 undefined，调用方应拒绝授予。 */
export function getPermission(id: string): PermissionDef | undefined {
  return permissions.get(id);
}

/** 全部权限，供角色编辑和文档输出。 */
export function listPermissions(): PermissionDef[] {
  return [...permissions.values()];
}

/** 读取旗标定义。 */
export function getFlag(id: string): FlagDef | undefined {
  return flags.get(id);
}

/** 全部旗标定义。 */
export function listFlags(): FlagDef[] {
  return [...flags.values()];
}

/** 登记敌对生物。关闭生物生成旗标时只移除已登记类型。 */
export function registerHostile(typeId: string): void {
  hostiles.add(typeId);
}

/** 判断是否为已登记的敌对生物。 */
export function isHostile(typeId: string): boolean {
  return hostiles.has(typeId);
}

/** 校验旗标输入并转成存储值。 */
export function coerceFlag(def: FlagDef, raw: string): FlagValue {
  if (def.type === "boolean") {
    if (raw !== "true" && raw !== "false" && raw !== "on" && raw !== "off") {
      throw new Error(`旗标 ${def.id} 需要 true 或 false`);
    }
    return raw === "true" || raw === "on";
  }
  if (def.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`旗标 ${def.id} 需要数字`);
    return value;
  }
  return raw;
}

/**
 * 公共角色的模板键。
 * 使用场景：领地级“所有人”默认权限（非成员回退到该角色）；新建领地和 iland 迁移都会生成一条该模板的角色。
 */
export const PUBLIC_PRESET = "public";

/**
 * 子区域“所有人”覆盖使用的占位玩家 ID。
 * 使用场景：land2_area_role 中 player_id 为该值时，表示该区域对非成员生效的角色；命令里可用 @public / 所有人 指代。
 */
export const PUBLIC_PLAYER_ID = "@public";

/** 预置角色模板。它们只是新领地的初始数据，权限判断不会按这些名字分支。 */
export function presetRoles(): Array<{ key: string; name: string; description: string; permissions: string[]; reserved: boolean }> {
  return [
    {
      key: "admin",
      name: "管理员",
      description: "可管理成员、角色、区域和银行，但不能代替领主转让",
      reserved: true,
      permissions: [
        "block.break",
        "block.place",
        "block.interact",
        "container.open",
        "door.use",
        "entity.attack",
        "entity.attack_hostile",
        "entity.interact",
        "redstone.interact",
        "land.manage",
        "land.claim",
        "land.teleport",
        "member.manage",
        "role.manage",
        "flag.manage",
        "area.manage",
        "bank.view",
        "bank.deposit",
        "bank.withdraw",
        "economy.manage",
      ],
    },
    {
      key: "member",
      name: "成员",
      description: "可在领地内建造和使用容器",
      reserved: false,
      permissions: [
        "block.break",
        "block.place",
        "block.interact",
        "container.open",
        "door.use",
        "entity.attack_hostile",
        "entity.interact",
        "redstone.interact",
        "land.teleport",
        "bank.view",
        "bank.deposit",
      ],
    },
    {
      key: "visitor",
      name: "访客",
      description: "默认可使用门，但不能建造或打开容器",
      reserved: false,
      permissions: ["door.use", "block.interact", "entity.attack_hostile"],
    },
    {
      key: "tenant",
      name: "租客",
      description: "租赁期间的区域权限模板，不包含领地管理权",
      reserved: true,
      permissions: [
        "block.break",
        "block.place",
        "block.interact",
        "container.open",
        "door.use",
        "entity.attack_hostile",
        "entity.interact",
        "redstone.interact",
      ],
    },
    {
      key: PUBLIC_PRESET,
      name: "公共",
      description: "未加入领地的玩家默认拥有的权限，只对世界交互生效",
      reserved: true,
      permissions: ["entity.attack_hostile"],
    },
  ];
}
