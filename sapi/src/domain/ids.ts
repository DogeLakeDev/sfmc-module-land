/**
 * 短标识生成。
 * 领地银行账户会变成计分板假名 `land.<id>`，因此标识保持短且只含字母数字。
 */

import { LandError } from "./errors.js";

let sequence = 0;

/** 生成模块内稳定主键。prefix 用来在日志里区分领地、区域、交易等对象。 */
export function makeId(prefix: string): string {
  sequence = (sequence + 1) % 1296;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  const seq = sequence.toString(36).padStart(2, "0");
  return `${prefix}${time}${rand}${seq}`;
}

/** 名称的比较键。重命名与查重都使用它，避免大小写和首尾空白造成重复领地。 */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 校验玩家输入的显示名。
 * 使用场景：领地、区域、角色的创建与重命名。
 */
export function assertDisplayName(name: string, label: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 32) {
    throw new LandError("bad_name", { label, name: trimmed });
  }
  if (/[\u0000-\u001f]/.test(trimmed)) {
    throw new LandError("bad_name", { label, name: trimmed });
  }
  return trimmed;
}
