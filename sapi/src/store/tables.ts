/**
 * 领地表结构。
 * 使用 land2_ 前缀，避免和 0.2 租赁表 sfmc_lands 的列定义互相改写。
 * 关闭软删除，使区块唯一键在释放后可以再次占领。
 */

import { db } from "@sfmc-bds/sdk/sapi/db";

/** 本模块逻辑表名。db-server 按 manifest 的 db:read/write 授权。 */
export const TABLES = {
  land: "land2_land",
  claim: "land2_claim",
  area: "land2_area",
  role: "land2_role",
  member: "land2_member",
  areaRole: "land2_area_role",
  flag: "land2_flag",
  tx: "land2_tx",
  lease: "land2_lease",
  listing: "land2_listing",
  registry: "land2_registry",
  identity: "land2_identity",
  reward: "land2_reward",
} as const;

/** 声明全部表。重复调用且列一致时平台会跳过。 */
export async function defineLandTables(): Promise<void> {
  const text = { type: "TEXT" as const };
  const req = { type: "TEXT" as const, notNull: true };
  const int = { type: "INTEGER" as const, notNull: true, default: 0 };
  const real = { type: "REAL" as const, notNull: true, default: 0 };
  const opt = { softDelete: false };

  await db.defineTable(
    TABLES.land,
    {
      id: { ...req, primary: true },
      name: req,
      name_key: { ...req, unique: true },
      description: { ...text, default: "" },
      owner_id: { ...req, index: true },
      owner_name: { ...text, default: "" },
      status: { ...req, index: true, default: "active" },
      level: int,
      spawn_dim: { ...text, default: "" },
      spawn_x: real,
      spawn_y: real,
      spawn_z: real,
      spawn_yaw: real,
      spawn_pitch: real,
      bank_account: req,
      metadata_json: { ...text, default: "{}" },
      next_upkeep_at: int,
      grace_until: int,
      upkeep_due: int,
      tax_enabled: int,
      tax_amount: int,
      tax_period_ms: int,
      next_tax_at: int,
      created_at: { ...int, index: true },
      updated_at: int,
    },
    opt,
  );

  await db.defineTable(
    TABLES.claim,
    {
      id: { ...req, primary: true },
      claim_key: { ...req, unique: true },
      dimension_id: { ...req, index: true },
      chunk_x: int,
      chunk_z: int,
      land_id: { ...req, index: true },
      created_at: int,
    },
    opt,
  );

  await db.defineTable(
    TABLES.area,
    {
      id: { ...req, primary: true },
      land_id: { ...req, index: true },
      name: req,
      name_key: { ...req, index: true },
      area_key: { ...req, unique: true },
      description: { ...text, default: "" },
      kind: req,
      dimension_id: { ...text, default: "" },
      min_x: real,
      min_y: real,
      min_z: real,
      max_x: real,
      max_y: real,
      max_z: real,
      created_at: int,
      updated_at: int,
    },
    opt,
  );

  await db.defineTable(
    TABLES.role,
    {
      id: { ...req, primary: true },
      land_id: { ...req, index: true },
      name: req,
      name_key: { ...req, index: true },
      role_key: { ...req, unique: true },
      description: { ...text, default: "" },
      permissions_json: { ...text, default: "[]" },
      preset: { ...text, default: "" },
      reserved: int,
      created_at: int,
      updated_at: int,
    },
    opt,
  );

  await db.defineTable(
    TABLES.member,
    {
      id: { ...req, primary: true },
      land_id: { ...req, index: true },
      player_id: { ...req, index: true },
      player_name: { ...text, default: "" },
      member_key: { ...req, unique: true },
      relation: req,
      role_id: { ...text, default: "" },
      created_at: int,
      updated_at: int,
    },
    opt,
  );

  await db.defineTable(
    TABLES.areaRole,
    {
      id: { ...req, primary: true },
      area_id: { ...req, index: true },
      land_id: { ...req, index: true },
      player_id: { ...req, index: true },
      role_id: req,
      assign_key: { ...req, unique: true },
    },
    opt,
  );

  await db.defineTable(
    TABLES.flag,
    {
      id: { ...req, primary: true },
      scope: req,
      scope_id: { ...req, index: true },
      flag_id: req,
      flag_key: { ...req, unique: true },
      value_json: req,
    },
    opt,
  );

  await db.defineTable(
    TABLES.tx,
    {
      id: { ...req, primary: true },
      idempotency_key: { ...req, unique: true },
      kind: req,
      status: { ...req, index: true },
      land_id: { ...text, default: "", index: true },
      actor_id: { ...text, default: "" },
      from_account: { ...text, default: "" },
      to_account: { ...text, default: "" },
      amount: int,
      payload_json: { ...text, default: "{}" },
      error: { ...text, default: "" },
      economy_tx_id: { ...text, default: "" },
      created_at: { ...int, index: true },
      updated_at: int,
    },
    opt,
  );

  await db.defineTable(
    TABLES.lease,
    {
      id: { ...req, primary: true },
      area_id: { ...req, index: true },
      land_id: { ...req, index: true },
      tenant_id: { ...req, index: true },
      tenant_name: { ...text, default: "" },
      price: int,
      period_ms: int,
      start_at: int,
      end_at: { ...int, index: true },
      status: { ...req, index: true },
      created_at: int,
      updated_at: int,
    },
    opt,
  );

  await db.defineTable(
    TABLES.listing,
    {
      id: { ...req, primary: true },
      target_type: req,
      target_id: { ...req, index: true },
      land_id: { ...req, index: true },
      kind: req,
      price: int,
      period_ms: int,
      status: { ...req, index: true },
      seller_id: { ...text, default: "" },
      created_at: int,
      updated_at: int,
    },
    opt,
  );

  await db.defineTable(
    TABLES.registry,
    {
      id: { ...req, primary: true },
      kind: { ...req, index: true },
      item_key: { ...req, unique: true },
      payload_json: { ...text, default: "{}" },
      updated_at: int,
    },
    opt,
  );

  await db.defineTable(
    TABLES.identity,
    {
      player_id: { ...req, primary: true },
      player_name: { ...req, index: true },
      name_key: { ...req, index: true },
      updated_at: int,
    },
    opt,
  );

  await db.defineTable(
    TABLES.reward,
    {
      id: { ...req, primary: true },
      reward_key: { ...req, unique: true },
      land_id: { ...req, index: true },
      level: int,
      reward_id: req,
      created_at: int,
    },
    opt,
  );
}
