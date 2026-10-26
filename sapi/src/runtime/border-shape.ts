/**
 * 领地边界形状计算（纯函数，不依赖游戏 API）。
 * 使用场景：border 命令的粒子循环（runtime/loops.ts drawBorders）先用这里算出
 * 玩家附近的领地外轮廓边与拐角，再换算成粒子坐标；单测直接校验几何结果。
 */

import { CHUNK_SIZE } from "../domain/geometry.js";

/** 一条轮廓边：水平线段，两端都落在区块网格线上（方块坐标）。own 表示属于正在查看的目标领地。 */
export interface BorderEdge {
  own: boolean;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

/** 轮廓拐角：区块网格顶点的方块坐标，用于画竖直粒子柱。 */
export interface BorderCorner {
  own: boolean;
  x: number;
  z: number;
}

/** borderShape 的结果：目标领地的边与拐角排在前面，粒子预算不足时优先保留。 */
export interface BorderShape {
  edges: BorderEdge[];
  corners: BorderCorner[];
}

/**
 * 四个区块 [西北, 东北, 西南, 东南] 的归属在共同顶点处是否形成拐角：
 * 1 格或 3 格属于该领地时是凸角/凹角；2 格对角属于时两段轮廓在此相交，也算拐角；
 * 0 格、4 格或 2 格同侧（直线经过）不是拐角。
 */
function isCorner(nw: boolean, ne: boolean, sw: boolean, se: boolean): boolean {
  const count = [nw, ne, sw, se].filter(Boolean).length;
  if (count === 1 || count === 3) return true;
  return count === 2 && nw === se;
}

/**
 * 计算以 center 为中心、半径 radius 个区块的窗口内的领地外轮廓。
 * - landAt：返回区块所属领地 ID，荒野返回 undefined；窗口外的邻居也会被查询，用于判断窗口边缘的轮廓。
 * - targetLandId：正在查看的领地；为 undefined 时所有领地都按目标领地处理（兼容不指定领地的会话）。
 * - includeOthers：是否同时计算其他领地的轮廓。
 * 只输出相邻区块不属于同一领地的边，领地内部区块之间的接缝不画；
 * 目标领地与其他领地共用的边只记给目标领地，避免两种粒子叠在同一条线上。
 */
export function borderShape(
  landAt: (chunkX: number, chunkZ: number) => string | undefined,
  center: { chunkX: number; chunkZ: number },
  radius: number,
  targetLandId: string | undefined,
  includeOthers: boolean,
): BorderShape {
  const isOwn = (landId: string): boolean => targetLandId === undefined || landId === targetLandId;
  const wanted = (landId: string | undefined): landId is string =>
    landId !== undefined && (isOwn(landId) || includeOthers);
  const ownEdges: BorderEdge[] = [];
  const otherEdges: BorderEdge[] = [];
  for (let cx = center.chunkX - radius; cx <= center.chunkX + radius; cx += 1) {
    for (let cz = center.chunkZ - radius; cz <= center.chunkZ + radius; cz += 1) {
      const landId = landAt(cx, cz);
      if (!wanted(landId)) continue;
      const own = isOwn(landId);
      const west = cx * CHUNK_SIZE;
      const north = cz * CHUNK_SIZE;
      const east = west + CHUNK_SIZE;
      const south = north + CHUNK_SIZE;
      const sides = [
        { neighbor: landAt(cx, cz - 1), x1: west, z1: north, x2: east, z2: north },
        { neighbor: landAt(cx, cz + 1), x1: west, z1: south, x2: east, z2: south },
        { neighbor: landAt(cx - 1, cz), x1: west, z1: north, x2: west, z2: south },
        { neighbor: landAt(cx + 1, cz), x1: east, z1: north, x2: east, z2: south },
      ];
      for (const side of sides) {
        if (side.neighbor === landId) continue;
        if (!own && side.neighbor !== undefined && isOwn(side.neighbor)) continue;
        (own ? ownEdges : otherEdges).push({ own, x1: side.x1, z1: side.z1, x2: side.x2, z2: side.z2 });
      }
    }
  }
  const ownCorners: BorderCorner[] = [];
  const otherCorners: BorderCorner[] = [];
  for (let vx = center.chunkX - radius; vx <= center.chunkX + radius + 1; vx += 1) {
    for (let vz = center.chunkZ - radius; vz <= center.chunkZ + radius + 1; vz += 1) {
      const nw = landAt(vx - 1, vz - 1);
      const ne = landAt(vx, vz - 1);
      const sw = landAt(vx - 1, vz);
      const se = landAt(vx, vz);
      let ownCorner = false;
      let otherCorner = false;
      for (const landId of new Set([nw, ne, sw, se])) {
        if (!wanted(landId)) continue;
        if (!isCorner(nw === landId, ne === landId, sw === landId, se === landId)) continue;
        if (isOwn(landId)) ownCorner = true;
        else otherCorner = true;
      }
      const point = { x: vx * CHUNK_SIZE, z: vz * CHUNK_SIZE };
      if (ownCorner) ownCorners.push({ own: true, ...point });
      else if (otherCorner) otherCorners.push({ own: false, ...point });
    }
  }
  return { edges: [...ownEdges, ...otherEdges], corners: [...ownCorners, ...otherCorners] };
}
