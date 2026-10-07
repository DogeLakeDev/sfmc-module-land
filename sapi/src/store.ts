/**
 * land 私有表定义与基础读写。
 */

import { getLandDb } from "./clients.js";
import type { Aabb, LandShape } from "./types.js";
import type { LandRow } from "./types.js";
import { pointInShape } from "./geometry.js";

export const LANDS_TABLE = "sfmc_lands";
export const OPS_TABLE = "sfmc_land_operations";

export async function defineLandTables(): Promise<void> {
  await getLandDb().defineTable(LANDS_TABLE, {
    id: { type: "TEXT", primary: true },
    owner_id: { type: "TEXT", notNull: true, index: true },
    name: { type: "TEXT", default: "" },
    dimension: { type: "TEXT", notNull: true, index: true },
    shape_type: { type: "TEXT", notNull: true },
    radius: { type: "INTEGER", notNull: true, default: 0 },
    min_x: { type: "REAL", notNull: true },
    min_y: { type: "REAL", notNull: true },
    min_z: { type: "REAL", notNull: true },
    max_x: { type: "REAL", notNull: true },
    max_y: { type: "REAL", notNull: true },
    max_z: { type: "REAL", notNull: true },
    core_x: { type: "REAL", default: 0 },
    core_y: { type: "REAL", default: 0 },
    core_z: { type: "REAL", default: 0 },
    level: { type: "INTEGER", default: 1 },
    status: { type: "TEXT", notNull: true, index: true },
    daily_rent: { type: "INTEGER", notNull: true, default: 1 },
    lease_until: { type: "INTEGER", notNull: true, index: true },
    grace_until: { type: "INTEGER", default: 0 },
    version: { type: "INTEGER", default: 1 },
    created_at: { type: "INTEGER", notNull: true },
    updated_at: { type: "INTEGER", notNull: true },
  });

  await getLandDb().defineTable(OPS_TABLE, {
    request_id: { type: "TEXT", primary: true },
    operation_type: { type: "TEXT", notNull: true },
    status: { type: "TEXT", notNull: true },
    response_json: { type: "TEXT", default: "{}" },
    created_at: { type: "INTEGER", notNull: true, index: true },
  });
}

export function landToAabb(row: LandRow): Aabb {
  return {
    min: { x: row.min_x, y: row.min_y, z: row.min_z },
    max: { x: row.max_x, y: row.max_y, z: row.max_z },
  };
}

export function landToShape(row: LandRow): LandShape {
  const box = landToAabb(row);
  return row.shape_type === "cylinder"
    ? { type: "cylinder", ...box, radius: row.radius }
    : { type: "cuboid", ...box };
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function getLandById(id: string): Promise<LandRow | null> {
  const row = await getLandDb().get(LANDS_TABLE, id);
  return (row as unknown as LandRow | undefined) ?? null;
}

export async function listLandsByOwner(
  ownerId: string,
  limit = 50,
  offset = 0,
): Promise<LandRow[]> {
  const rows = await getLandDb().query(LANDS_TABLE, {
    where: {
      and: [{ eq: ["owner_id", ownerId] }, { ne: ["status", "terminated"] }],
    },
    orderBy: { field: "created_at", dir: "desc" },
    limit,
    offset,
  });
  return rows as unknown as LandRow[];
}

/** 同维度全部有效（active|dormant）租赁，供三维形状碰撞。 */
export async function listEffectiveLandsInDimension(
  dimension: string,
): Promise<LandRow[]> {
  const lands: LandRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const rows = await getLandDb().query(LANDS_TABLE, {
      where: {
        and: [
          { eq: ["dimension", dimension] },
          { in: ["status", ["active", "dormant"]] },
        ],
      },
      orderBy: { field: "id", dir: "asc" },
      limit: 500,
      offset,
    });
    lands.push(...(rows as unknown as LandRow[]));
    if (rows.length < 500) return lands;
  }
}

export async function findLandByPos(
  dimension: string,
  x: number,
  y: number,
  z: number,
): Promise<LandRow | null> {
  const lands = await listEffectiveLandsInDimension(dimension);
  for (const land of lands) {
    if (pointInShape({ x, y, z }, landToShape(land))) {
      return land;
    }
  }
  return null;
}

export async function updateLandFields(
  id: string,
  fields: Partial<LandRow>,
): Promise<void> {
  await getLandDb().update(LANDS_TABLE, id, {
    ...fields,
    updated_at: Date.now(),
  });
}

export async function listExpiredActive(now: number): Promise<LandRow[]> {
  const rows = await getLandDb().query(LANDS_TABLE, {
    where: {
      and: [{ eq: ["status", "active"] }, { lte: ["lease_until", now] }],
    },
    limit: 1000,
  });
  return rows as unknown as LandRow[];
}

export async function listGraceExpired(now: number): Promise<LandRow[]> {
  const rows = await getLandDb().query(LANDS_TABLE, {
    where: {
      and: [{ eq: ["status", "dormant"] }, { lte: ["grace_until", now] }],
    },
    limit: 1000,
  });
  return rows as unknown as LandRow[];
}
