/**
 * 区块与半开三维区间的纯几何规则。
 * 保护、占领、区域校验和边界显示都走这里，避免各处对负数坐标使用不同的取整方式。
 */

/** 三维整数或实数坐标。区域边界按方块坐标存储。 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 半开轴对齐长方体 [min, max)。接触边界不算重叠，也不把只接触的区块算进区域。 */
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** 一个维度内的区块坐标。 */
export interface ChunkPos {
  dimensionId: string;
  chunkX: number;
  chunkZ: number;
}

/** 区块边长。Minecraft 主世界区块固定为 16。 */
export const CHUNK_SIZE = 16;

/**
 * 方块坐标转区块坐标。
 * 负数必须向下取整：-1 属于区块 -1，-16 仍属于区块 -1，-17 属于区块 -2。
 */
export function blockToChunk(block: number): number {
  return Math.floor(block / CHUNK_SIZE);
}

/** 由方块位置得到区块。 */
export function chunkOf(dimensionId: string, x: number, z: number): ChunkPos {
  return {
    dimensionId,
    chunkX: blockToChunk(x),
    chunkZ: blockToChunk(z),
  };
}

/** 区块占用的全局唯一键。索引和数据库唯一约束都使用它。 */
export function claimKey(dimensionId: string, chunkX: number, chunkZ: number): string {
  return `${dimensionId}|${chunkX}|${chunkZ}`;
}

/**
 * claimKey 的逆运算。从右侧取两段整数，剩余部分作为维度，格式不对时返回 null。
 * 使用场景：land.map 把 LandState.claimKeys 还原成区块坐标供网页地图绘制。
 */
export function parseClaimKey(key: string): ChunkPos | null {
  const zSep = key.lastIndexOf("|");
  const xSep = zSep > 0 ? key.lastIndexOf("|", zSep - 1) : -1;
  if (xSep <= 0) return null;
  const chunkX = Number(key.slice(xSep + 1, zSep));
  const chunkZ = Number(key.slice(zSep + 1));
  if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ)) return null;
  return { dimensionId: key.slice(0, xSep), chunkX, chunkZ };
}

/** 半开区间在某一轴上实际覆盖的区块坐标（含两端）。max 一侧的接触区块不会被算入。 */
export function chunksOnAxis(min: number, max: number): number[] {
  if (!(max > min)) return [];
  const first = blockToChunk(min);
  const last = blockToChunk(max - 1);
  const out: number[] = [];
  for (let chunk = first; chunk <= last; chunk += 1) out.push(chunk);
  return out;
}

/** 区域水平足迹覆盖的全部区块。调用方必须逐个确认它们都属于同一领地。 */
export function chunksCoveredBy(dimensionId: string, box: Aabb): ChunkPos[] {
  const xs = chunksOnAxis(box.min.x, box.max.x);
  const zs = chunksOnAxis(box.min.z, box.max.z);
  const out: ChunkPos[] = [];
  for (const chunkX of xs) {
    for (const chunkZ of zs) out.push({ dimensionId, chunkX, chunkZ });
  }
  return out;
}

/** 把两个选点规范成半开长方体。坐标向下取整到方块，max 侧再加 1，保证选中的方块被包含。 */
export function aabbFromPoints(a: Vec3, b: Vec3): Aabb {
  const minX = Math.floor(Math.min(a.x, b.x));
  const minY = Math.floor(Math.min(a.y, b.y));
  const minZ = Math.floor(Math.min(a.z, b.z));
  const maxX = Math.floor(Math.max(a.x, b.x)) + 1;
  const maxY = Math.floor(Math.max(a.y, b.y)) + 1;
  const maxZ = Math.floor(Math.max(a.z, b.z)) + 1;
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

/** 半开区间是否有体积。零厚度选区不能创建区域。 */
export function hasVolume(box: Aabb): boolean {
  return box.max.x > box.min.x && box.max.y > box.min.y && box.max.z > box.min.z;
}

/**
 * 半开区间重叠。
 * a.max === b.min 只是贴边，返回 false。
 */
export function aabbIntersects(a: Aabb, b: Aabb): boolean {
  return (
    a.min.x < b.max.x &&
    b.min.x < a.max.x &&
    a.min.y < b.max.y &&
    b.min.y < a.max.y &&
    a.min.z < b.max.z &&
    b.min.z < a.max.z
  );
}

/** 方块坐标是否落在半开区间内。 */
export function containsPoint(box: Aabb, x: number, y: number, z: number): boolean {
  return x >= box.min.x && x < box.max.x && y >= box.min.y && y < box.max.y && z >= box.min.z && z < box.max.z;
}

/** 选区体积，用于重叠时挑选更具体的区域。 */
export function aabbVolume(box: Aabb): number {
  return (box.max.x - box.min.x) * (box.max.y - box.min.y) * (box.max.z - box.min.z);
}

/** 由两个方块坐标得到包含两端的区块闭区间。批量占领用。 */
export function chunkRect(a: Vec3, b: Vec3): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const ax = blockToChunk(a.x);
  const bx = blockToChunk(b.x);
  const az = blockToChunk(a.z);
  const bz = blockToChunk(b.z);
  return {
    minX: Math.min(ax, bx),
    maxX: Math.max(ax, bx),
    minZ: Math.min(az, bz),
    maxZ: Math.max(az, bz),
  };
}

/** 展开区块矩形。 */
export function chunksInRect(
  dimensionId: string,
  rect: { minX: number; maxX: number; minZ: number; maxZ: number },
): ChunkPos[] {
  const out: ChunkPos[] = [];
  for (let chunkX = rect.minX; chunkX <= rect.maxX; chunkX += 1) {
    for (let chunkZ = rect.minZ; chunkZ <= rect.maxZ; chunkZ += 1) {
      out.push({ dimensionId, chunkX, chunkZ });
    }
  }
  return out;
}
