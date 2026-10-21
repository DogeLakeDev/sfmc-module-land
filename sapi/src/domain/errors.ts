/**
 * 领地领域错误。
 * 命令、公开 API 与恢复流程都用稳定的 key 映射到多语言文案，而不是把句子散落在业务分支里。
 */

/** 占位符值。只接受可直接展示的标量，避免把内部对象漏到聊天栏。 */
export type MessageVars = Record<string, string | number>;

/**
 * 可诊断的业务失败。
 * 使用场景：配额、权限、空间冲突、资金与租约状态不满足时抛出，由命令层翻译后发给玩家。
 */
export class LandError extends Error {
  readonly key: string;
  readonly vars: MessageVars;

  constructor(key: string, vars: MessageVars = {}, text?: string) {
    super(text ?? key);
    this.name = "LandError";
    this.key = key;
    this.vars = vars;
  }
}

/** 把未知异常收成领域错误，保留原始信息供日志和管理员诊断。 */
export function asLandError(error: unknown): LandError {
  if (error instanceof LandError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new LandError("internal", { message }, message);
}
