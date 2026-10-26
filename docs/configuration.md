# 配置、配额与经济

[English](configuration.en.md) · [目录](README.md)

默认配置见 [configs-default/land.json](../configs-default/land.json)。服务器通过平台配置键 `land` 在模块初始化时读取 `configs/land.json`。修改后重新加载模块或重启；没有热更新监听。配置文件使用下划线字段名。

## 字段

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `locale` | `zh` | 默认语言，en 或 zh；玩家 lang 设置优先。 |
| `claim_price` | `50` | 基础单区块价格；创建和扩张由操作者付款。 |
| `unclaim_refund_ratio` | `0` | 释放返还比例，限定0–1；按当前等级价格计算。 |
| `teleport_price` | `0` | 传送从玩家转入领地银行；0不收费。 |
| `teleport_cooldown_ms` | `10000` | 传送成功后冷却，毫秒。 |
| `max_batch_chunks` | `48` | 一次新增占领区块数量上限；仍受领地配额限制。 |
| `upkeep_period_ms` | `86400000` | 维护周期，毫秒；最小60000。 |
| `upkeep_base` | `10` | 每期领地基础维护费。 |
| `upkeep_per_chunk` | `2` | 每期每个区块维护费。 |
| `grace_period_ms` | `259200000` | 首次欠费后的宽限期，默认3天。 |
| `freeze_after_grace` | `true` | 宽限期后仍未结清则冻结；不会自动删除。 |
| `wilderness_protected` | `false` | 玩家世界操作在荒野的默认拒绝开关；不把自然事件都变成保护。 |
| `ban_eject` | `false` | 扫描时将封禁者送回记录过的荒野位置；事后处理。 |
| `border_radius_chunks` | `2` | 粒子扫描半径，单位区块。 |
| `border_interval_ticks` | `40` | 边界粒子间隔，最小10 tick。 |
| `border_particle` | `"minecraft:endrod"` | 目标领地轮廓的粒子 ID；空字符串回退默认值。 |
| `border_other_particle` | `"minecraft:basic_flame_particle"` | 附近其他领地轮廓的粒子 ID；空字符串表示不显示其他领地。 |
| `border_step_blocks` | `2` | 轮廓线上粒子间距，单位方块，最小0.5。 |
| `border_heights` | `[0.2, 1.6]` | 轮廓线相对玩家脚底的高度层，多个值画成多层矮墙。 |
| `border_post_height` | `3` | 拐角粒子柱高度，单位方块；0 表示不画拐角柱。 |
| `border_post_step` | `0.5` | 拐角粒子柱竖直间距，最小0.25。 |
| `border_max_particles` | `800` | 每名玩家每轮最多生成的边界粒子数；超出时优先保留目标领地。 |
| `scan_interval_ticks` | `20` | 玩家范围检测间隔，最小5 tick。 |
| `scheduler_interval_ticks` | `6000` | 维护、税费、到期和交易恢复周期，最小200 tick。 |
| `quotas.lands` | `3` | 每位操作者的领地拥有数量上限。 |
| `quotas.chunks / members / areas / roles` | `16 / 10 / 8 / 8` | 兼容字段；当前实际领地容量读取 levels，不应只改这里。 |
| `levels` | `见下表 / below` | 等级容量、成本、条件与奖励。 |
| `quota_groups` | `[]` | 按平台命名权限提高配额；不会降低等级上限。 |
| `messages` | `{}` | 按 zh/en 和消息键覆盖模板。 |

在20 TPS下，20 tick约1秒，6000 tick约5分钟；服务器降速会延迟按tick执行的任务，账单到期时间使用实际毫秒时间。

## 等级与上限

| Level | Chunks | Members | Areas | Roles* | Claim multiplier | Upkeep multiplier | Upgrade cost | Min chunks / members | Bank reward |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 16 | 10 | 8 | 8 | 1 | 1 | 0 | 0 / 0 | 0 |
| 2 | 32 | 20 | 16 | 12 | 1.25 | 1.1 | 500 | 8 / 1 | 0 |
| 3 | 64 | 40 | 32 | 16 | 1.5 | 1.25 | 2000 | 24 / 3 | 100 |

*角色配额统计所有非保留角色，包含预置“成员”和“访客”。默认1级上限8时，这两个模板已占2个名额。成员统计 admin/member/trusted 关系，待接受邀请不计数；区域配额不计默认区域。

拥有数量使用 `quotas.lands`；区块、成员、区域、角色容量使用当前 `levels` 项。找不到等级时回退第一条。请配置有限非负数、唯一且递增的等级；解析器没有完整校验等级和权限组的约束。

## 权限组提升配额

```json
{
  "quota_groups": [
    { "permission": "land.quota.operator", "level": 2, "lands": 10, "chunks": 128 }
  ]
}
```

模块按配置的平台等级注册命名权限，缺省为 Member/1；多个命中组取最大值。平台等级为0 Any、1 Member、2 OP、3 Admin。配额依据执行操作的人检查，不总是领主；接受邀请时操作者是受邀者。这不是按玩家UUID列出的单独白名单。

## 费用与维护

```text
chunkPrice = max(0, round(claim_price × level.claim_price_multiplier))
claimCost = chunkPrice × newChunkCount
unclaimRefund = round(chunkPrice × unclaim_refund_ratio) × releasedChunkCount
upkeep = max(0, round((upkeep_base + upkeep_per_chunk × claimedChunks) × level.upkeep_multiplier))
```

金额是经济模块的整数单位。默认1/2/3级区块价为50/63/75。创建使用配置中第一条等级的价格倍率；扩张扣操作者的钱，升级和维护扣领地银行。释放返款给操作者，使用当前价格而非历史买入成本。

到期扣款失败将 active 改为 delinquent 并设置宽限期，宽限后可变为 frozen，不自动删地。权限解析先放行领主再检查冻结，因此冻结不是对领主的全面禁用。`upkeep_pay` 尝试结算到期或欠费一期，未到期的活跃账期跳过；离线时间不会逐期追扣，成功后从本次结算时间安排下一期。

## 税费、租赁与买卖

税费默认关闭。`tax_set` 设置正金额后，每期向 admin/member/trusted 成员扣款并转入银行；失败只记录事件，不踢人，账期仍前移。租金进入银行；整领和区域买卖款付给当前领主。区域购买只授予“成员”模板，不产生独立土地所有权。提前结束租约不按剩余时长退租金。

## 消息模板

```json
{
  "locale": "zh",
  "messages": {
    "zh": { "created": "已创建 {name}" },
    "en": { "created": "Created {name}" }
  }
}
```

使用 [catalog.ts](../sapi/src/messages/catalog.ts) 中现有键和占位符。玩家语言偏好会持久化。`enter_text` / `leave_text` 支持 `{land}`、`{area}` 与 `{owner}`；领地和子区域各自读取自己的模板，为空时使用全局文案（`entered` / `left` / `entered_area` / `left_area`）。

如需零价格玩法，除圈地、维护、传送价格外，还应调整各级升级成本和奖励。manifest 仍硬依赖 economy 与 activity-log，删除始终检查银行。
