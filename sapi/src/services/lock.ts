/**
 * 领地写入临界区。
 * 脚本在 await 之后会穿插其他命令，重叠和配额检查必须与落库串行执行。
 */

let chain: Promise<void> = Promise.resolve();

/** 排队执行一块领地变更。前一次失败不会挡住后续操作。 */
export function withTerritoryLock<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
