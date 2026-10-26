/**
 * 领地的地图视图投影。
 * 使用场景：只读服务 land.map，供网页地图（bluemap）绘制领地区块、名称和子区域。
 * 只读内存索引，不访问数据库；只给出地图需要的字段，不暴露成员、角色、旗标和银行账户。
 */

import type { WorldIndex } from "../cache/world-index.js";
import { parseClaimKey } from "../domain/geometry.js";
import type { LandStatus } from "../domain/model.js";

/** 某个维度下一块领地占领的区块，坐标为 [chunkX, chunkZ]。 */
export interface MapClaimGroup {
  dimensionId: string;
  chunks: Array<[number, number]>;
}

/**
 * 子区域的水平投影。坐标是包含两端的方块坐标（内部半开区间的 max 已减 1），
 * 便于地图直接按“从 min 到 max 的方块”绘制；minY/maxY 同样包含两端。
 */
export interface MapLandArea {
  id: string;
  name: string;
  dimensionId: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** land.map 返回的一块领地。 */
export interface MapLand {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  status: LandStatus;
  level: number;
  claims: MapClaimGroup[];
  areas: MapLandArea[];
}

/**
 * 把索引里的领地投影成地图视图，按领地 ID 排序保证输出稳定。
 * dimensionId 非空时只保留该维度的区块和子区域，并跳过在该维度没有任何区块和子区域的领地。
 * 使用场景：api.ts 的 land.map 处理函数；测试直接传入 harness 的索引。
 */
export function landMapView(index: WorldIndex, dimensionId = ""): { lands: MapLand[] } {
  const areasByLand = new Map<string, MapLandArea[]>();
  for (const area of index.areas.values()) {
    if (area.kind !== "box" || !area.box) continue;
    if (dimensionId && area.dimensionId !== dimensionId) continue;
    const list = areasByLand.get(area.landId) ?? [];
    list.push({
      id: area.id,
      name: area.name,
      dimensionId: area.dimensionId,
      minX: area.box.min.x,
      minY: area.box.min.y,
      minZ: area.box.min.z,
      maxX: area.box.max.x - 1,
      maxY: area.box.max.y - 1,
      maxZ: area.box.max.z - 1,
    });
    areasByLand.set(area.landId, list);
  }

  const lands: MapLand[] = [];
  for (const land of index.lands.values()) {
    const groups = new Map<string, Array<[number, number]>>();
    for (const key of land.claimKeys) {
      const chunk = parseClaimKey(key);
      if (!chunk) continue;
      if (dimensionId && chunk.dimensionId !== dimensionId) continue;
      const list = groups.get(chunk.dimensionId) ?? [];
      list.push([chunk.chunkX, chunk.chunkZ]);
      groups.set(chunk.dimensionId, list);
    }
    const areas = (areasByLand.get(land.id) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    if (dimensionId && groups.size === 0 && areas.length === 0) continue;
    lands.push({
      id: land.id,
      name: land.name,
      ownerId: land.ownerId,
      ownerName: land.ownerName,
      status: land.status,
      level: land.level,
      claims: [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dim, chunks]) => ({ dimensionId: dim, chunks })),
      areas,
    });
  }
  lands.sort((a, b) => a.id.localeCompare(b.id));
  return { lands };
}
