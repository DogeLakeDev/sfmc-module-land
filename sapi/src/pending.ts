/**
 * 空手选点会话与待编辑范围。
 */

import type { Aabb } from "./types.js";

export const pendingBoxes = new Map<string, { box: Aabb; dimension: string }>();
export const selectionSessions = new Map<
  string,
  {
    dimension: string;
    startedAt: number;
    a?: Aabb["min"];
  }
>();
