/**
 * 区域选点暂存（避免 gui ↔ events 循环依赖）。
 */

import type { Aabb } from "./types.js";

export const pendingBoxes = new Map<string, { box: Aabb; dimension: string }>();
