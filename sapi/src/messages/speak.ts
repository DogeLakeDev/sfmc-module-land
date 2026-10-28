/**
 * 玩家可见消息。
 * 语言优先用玩家选择，其次用配置，缺失翻译回退到中文再回退到键名。
 */

import type { Player } from "@minecraft/server";
import { debug, Msg } from "@sfmc-bds/sdk/sapi/runtime";
import { asLandError, type MessageVars } from "../domain/errors.js";
import { renderMessage } from "./catalog.js";
import { landConfig } from "../services/shared.js";

const locales = new Map<string, "zh" | "en">();

/** 配置尚未绑定时仍能发出启动失败提示。 */
function currentLocale(): "zh" | "en" {
  try {
    return landConfig().locale;
  } catch {
    return "zh";
  }
}

/** 配置里的文案覆盖。未初始化时没有覆盖。 */
function currentMessages(): Record<string, Record<string, string>> {
  try {
    return landConfig().messages;
  } catch {
    return {};
  }
}

/** 恢复或切换某个玩家的语言。 */
export function rememberLocale(playerId: string, locale: "zh" | "en"): void {
  locales.set(playerId, locale);
}

/**
 * 按玩家语言渲染文案但不发送。
 * 当前用于 map 命令拼装格子与地图行，以及 say 的渲染。
 */
export function phrase(player: Player | undefined, key: string, vars: MessageVars = {}): string {
  const locale = player ? (locales.get(player.id) ?? currentLocale()) : currentLocale();
  return renderMessage(locale, key, vars, currentMessages());
}

/** say 的提示色调，与 Msg 的方法名一致。 */
export type SayTone = "info" | "success" | "error" | "warning" | "tips";

/** 一条被捕获的提示。 */
export interface CapturedLine {
  text: string;
  tone: SayTone;
}

/**
 * 正在被捕获的玩家提示缓冲，键为玩家 ID。
 * 使用场景：land.ui.exec 执行命令期间，把 say 的输出收进缓冲作为表单状态行，而不是同时刷到聊天栏。
 */
const captures = new Map<string, CapturedLine[]>();

/**
 * 在 run 执行期间捕获发给该玩家的全部 say 输出，结束（含抛错）后恢复直发。
 * 同一玩家已在捕获中时复用外层缓冲，内层返回空数组。
 * 使用场景：land.ui.exec 把命令的原有提示文本带回界面。
 */
export async function captureSays<T>(playerId: string, run: () => Promise<T>): Promise<{ value: T; lines: CapturedLine[] }> {
  if (captures.has(playerId)) return { value: await run(), lines: [] };
  const lines: CapturedLine[] = [];
  captures.set(playerId, lines);
  try {
    return { value: await run(), lines };
  } finally {
    captures.delete(playerId);
  }
}

/** 渲染给玩家或控制台。 */
export function say(
  player: Player | undefined,
  key: string,
  vars: MessageVars = {},
  tone: SayTone = "info",
): string {
  const text = phrase(player, key, vars);
  if (!player) {
    debug.i("Land", text);
    return text;
  }
  const buffer = captures.get(player.id);
  if (buffer) {
    buffer.push({ text, tone });
    return text;
  }
  Msg[tone](text, player);
  return text;
}

/** 把领域错误翻译成玩家能看懂的失败原因。 */
export function sayError(player: Player | undefined, error: unknown): void {
  const wrapped = asLandError(error);
  say(player, wrapped.key, wrapped.vars, "error");
  if (wrapped.key === "internal") debug.w("Land", wrapped.message);
}
