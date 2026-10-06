# 领地 / land

`@sfmc-bds/module-land` 是 SFMC 的领地租赁模块。模块标识和配置命名空间均为 `land`，玩家入口为 `!land`。

## 功能

- 租用领地：使用当前位置的初始半径，或用金镐点击两个方块选定范围。
- 租赁管理：查看领地状态、范围、日租、到期时间和宽限期；续租、扩建及解除租赁。
- 租金结算：面积计价、持有数量倍率、长租折扣，以及按剩余时间计算的扩建补差。
- 到期处理：到期进入宽限期，宽限期结束释放范围。解除租赁不退还剩余租金。
- 操作记录：请求去重、事务内提交领地与结果、扣款失败恢复和退款补偿。

模块依赖 `economy` 和 `activity-log`。经济余额由经济模块管理；领地数据与经济余额使用补偿流程衔接。未提交操作在启动及每五分钟扫描时恢复。

## 玩家流程

1. 打开 `!land`，选择「租用领地」。当前位置范围在打开页面时固定；金镐选点优先使用所选范围。
2. 输入名称及 1 至 90 天租期，点击「预览并估价」。预览显示范围、实际日租和应付金额，报价有效期为两分钟。
3. 确认租用后进入详情。续租与扩建均先取得报价，再确认付款；修改天数或等级后须重新预览。
4. 解除租赁前确认领地名称、剩余租金不退还和范围释放提示。

范围支持主世界、下界和末地，按维度校验高度；同维度领地不能重叠。扩建须包含原领地，不能缩小或移动范围。

## 配置

默认值见 `configs-default/land.json`，运行配置为 `configs/land.json`。

| 配置项                  | 用途                             |
| ----------------------- | -------------------------------- |
| `base_daily_rent`       | 基础日租                         |
| `rent_per_100_blocks`   | 每 100 个水平占地方块的日租系数  |
| `max_lands_per_player`  | 每位玩家有效租赁数量上限         |
| `land_count_multiplier` | 第 1、2、3…块领地的租金倍率      |
| `long_term_discounts`   | 租期天数与折扣档位               |
| `grace_period_days`     | 到期后的宽限期天数               |
| `claim.initial_radius`  | 当前位置起租的初始半径           |
| `claim.max_level`       | 扩建等级上限                     |
| `claim.level_radius`    | 各等级的水平半径，须为递增正整数 |

初始半径 16 包含中心方块，占地为 33×33；默认第一块领地日租 32，租用七天共 224。

## 服务命名与输入

| 服务                  | 主要输入                                           | 用途               |
| --------------------- | -------------------------------------------------- | ------------------ |
| `land.byId`           | `landId`                                           | 查询领地           |
| `land.byPos`          | `dimension,x,y,z`                                  | 查询坐标所在领地   |
| `land.listByOwner`    | `ownerId,limit?,offset?`                           | 查询玩家领地       |
| `land.validateBox`    | `ownerId,dimension,min,max,excludeLandId?`         | 校验范围并计算日租 |
| `land.createLease`    | `playerId,dimension,days,name?,min,max`，或 `core` | 创建租赁           |
| `land.renewLease`     | `playerId,landId,days`                             | 续租               |
| `land.expandLease`    | `playerId,landId,newMin,newMax`                    | 扩建               |
| `land.terminateLease` | `playerId,landId`                                  | 解除租赁           |
| `land.leaseStatus`    | `landId`                                           | 查询租期状态       |
| `land.auditLog`       | `playerId,landId,limit?,offset?`                   | 查询主人操作记录   |

所有写服务要求 `requestId`，有费用的服务还要求 `expectedFee`（玩家确认的最高金额）；管理写服务可传 `version` 防止基于过期信息提交。重复请求必须保留相同 ID 和完整输入。调用模块应从真实玩家上下文提供 `playerId`。

`land.ui.*` 是界面适配服务：详情、选地草稿、租用报价、续租报价、扩建报价和各确认操作。报价返回 `quoteId`；确认服务核对报价所属玩家、领地、有效期及输入，再复用同一操作标识提交。

## 开发与验证

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test
sfmc mod install land --from dir:. --link
```

测试覆盖租金计算、配置与声明式界面契约，以及使用隔离替身的重复提交、并发、余额不足、事务失败、退款恢复、报价失效和到期扫描。发布前仍需在 BDS 中联调玩家界面与经济模块。
