/**
 * 按交易种类注册可恢复的业务动作。
 * 模块加载时执行一次；恢复器只按种类和载荷重放，不再记住某一次调用的闭包。
 */

import { registerTxApplier } from "./ledger.js";
import { applyUpgrade } from "../services/finance.js";
import { applyBuy, applyRenew, applyRent } from "../services/market.js";
import { applyClaim, applyCreateLand, applyUnclaim } from "../services/territory.js";

/** 存款、取款和传送的效果就是资金移动本身，业务动作为空。 */
async function moneyOnly(): Promise<void> {
  return undefined;
}

registerTxApplier("land.create", applyCreateLand);
registerTxApplier("land.claim", applyClaim);
registerTxApplier("land.unclaim", applyUnclaim);
registerTxApplier("land.deposit", moneyOnly);
registerTxApplier("land.withdraw", moneyOnly);
registerTxApplier("land.upgrade", applyUpgrade);
registerTxApplier("land.rent", applyRent);
registerTxApplier("land.renew", applyRenew);
registerTxApplier("land.buy", applyBuy);
registerTxApplier("land.buy_area", applyBuy);
registerTxApplier("land.teleport", moneyOnly);
