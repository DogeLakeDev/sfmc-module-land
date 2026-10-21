/**
 * 领地模块的内存与持久化共享模型。
 * 关系状态和角色分开存放：关系表示成员资格，角色只表示权限集合。
 */

import type { Aabb } from "./geometry.js";

/** 领地生命周期。欠费和冻结都不会直接删除领地。 */
export type LandStatus = "active" | "delinquent" | "frozen";

/**
 * 玩家与领地的关系。
 * owner 不写入成员表，由领地的 ownerId 表达。
 */
export type Relation = "admin" | "member" | "trusted" | "visitor" | "invited" | "banned";

/** 旗标值。自定义旗标也只能是这三种，避免把任意对象写进规则。 */
export type FlagValue = boolean | number | string;

/** 旗标适用层级。 */
export type FlagScope = "land" | "area" | "both";

/** 出生点。保存维度和完整坐标，不只用 x/y/z。 */
export interface SpawnPoint {
  dimensionId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** 主领地。水平范围由区块集合决定，不退化成一个大长方体。 */
export interface LandState {
  id: string;
  name: string;
  nameKey: string;
  description: string;
  ownerId: string;
  ownerName: string;
  status: LandStatus;
  level: number;
  spawn: SpawnPoint | null;
  bankAccount: string;
  metadata: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  nextUpkeepAt: number;
  graceUntil: number;
  upkeepDue: number;
  taxEnabled: boolean;
  taxAmount: number;
  taxPeriodMs: number;
  nextTaxAt: number;
  claimKeys: string[];
  defaultAreaId: string;
}

/** 普通子区域或默认区域。默认区域没有三维边界。 */
export interface AreaState {
  id: string;
  landId: string;
  name: string;
  nameKey: string;
  description: string;
  kind: "default" | "box";
  dimensionId: string;
  box: Aabb | null;
  createdAt: number;
  updatedAt: number;
}

/** 某个领地自己的角色。不同领地的同名角色互不影响。 */
export interface RoleState {
  id: string;
  landId: string;
  name: string;
  nameKey: string;
  description: string;
  permissions: string[];
  reserved: boolean;
  /** 预置模板键。显示名可以改，转让和租赁仍用 admin、member、visitor、tenant 查找。 */
  preset: string;
  createdAt: number;
  updatedAt: number;
}

/** 成员、邀请、信任或封禁记录。授权绑定玩家 ID 和角色 ID。 */
export interface MemberState {
  id: string;
  landId: string;
  playerId: string;
  playerName: string;
  relation: Relation;
  roleId: string;
  createdAt: number;
  updatedAt: number;
}

/** 子区域对成员角色的覆盖。未配置时回退到领地级角色。 */
export interface AreaRoleState {
  id: string;
  areaId: string;
  landId: string;
  playerId: string;
  roleId: string;
}

/** 已解析的位置。权限和提示都从这里开始，不再各自扫描全表。 */
export interface Located {
  land: LandState;
  area: AreaState;
  /** 命中的是普通区域还是默认区域。 */
  specific: boolean;
}

/** 交易状态。资金动作和领地动作分开记录，便于重启后续跑。 */
export type TxStatus = "pending" | "debited" | "applied" | "refunding" | "refunded" | "failed";

/** 本地交易账本行。 */
export interface TxState {
  id: string;
  idempotencyKey: string;
  kind: string;
  status: TxStatus;
  landId: string;
  actorId: string;
  fromAccount: string;
  toAccount: string;
  amount: number;
  payloadJson: string;
  error: string;
  economyTxId: string;
  createdAt: number;
  updatedAt: number;
}

/** 租赁合约。 */
export interface LeaseState {
  id: string;
  areaId: string;
  landId: string;
  tenantId: string;
  tenantName: string;
  price: number;
  periodMs: number;
  startAt: number;
  endAt: number;
  status: "active" | "ended" | "expired";
  createdAt: number;
  updatedAt: number;
}

/** 出租或出售挂牌。 */
export interface ListingState {
  id: string;
  targetType: "area" | "land";
  targetId: string;
  landId: string;
  kind: "rent" | "sale";
  price: number;
  periodMs: number;
  status: "open" | "closed" | "sold";
  sellerId: string;
  createdAt: number;
  updatedAt: number;
}

/** 命令与 API 的操作者。 */
export interface Actor {
  id: string;
  name: string;
  /** 已通过 land.admin 的服务器管理员。 */
  admin: boolean;
  /** 没有对应玩家的控制台执行。 */
  console: boolean;
}
