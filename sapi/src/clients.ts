/** 捕获模块作用域客户端，避免异步任务使用其他模块的身份。 */
import type { ModuleServices } from "@sfmc-bds/sdk/module-loader";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { service } from "@sfmc-bds/sdk/sapi/service";

let landDb: typeof db = db;
let landService: typeof service = service;
export function bindLandClients(clients?: ModuleServices): void {
  landDb = clients?.db ?? db;
  landService = clients?.service ?? service;
}
export function getLandDb(): typeof db {
  return landDb;
}
export function getLandService(): typeof service {
  return landService;
}
