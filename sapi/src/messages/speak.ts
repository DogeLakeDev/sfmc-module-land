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

/** 渲染给玩家或控制台。 */
export function say(
  player: Player | undefined,
  key: string,
  vars: MessageVars = {},
  tone: "info" | "success" | "error" | "warning" | "tips" = "info",
): string {
  const locale = player ? (locales.get(player.id) ?? currentLocale()) : currentLocale();
  const text = renderMessage(locale, key, vars, currentMessages());
  if (!player) {
    debug.i("Land", text);
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
