/**
 * 领地租赁类型与显示常量。
 */

export type LandStatus = "active" | "dormant" | "terminated";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** 方块坐标范围，含端点；圆柱体沿 Y 轴。 */
export type LandShape = Aabb &
  ({ type: "cuboid" } | { type: "cylinder"; radius: number });

export interface LandRow {
  id: string;
  owner_id: string;
  name: string;
  dimension: string;
  shape_type: LandShape["type"];
  radius: number;
  min_x: number;
  min_y: number;
  min_z: number;
  max_x: number;
  max_y: number;
  max_z: number;
  core_x: number;
  core_y: number;
  core_z: number;
  level: number;
  status: LandStatus;
  daily_rent: number;
  lease_until: number;
  grace_until: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export const DAY_MS = 86_400_000;
