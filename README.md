# 领地 / land

`@sfmc-bds/module-land` 是 SFMC 的领地租赁模块，标识与配置命名空间为 `land`，玩家入口为 `!land`。

## 功能与玩家流程

1. **创建选区**：使用当前位置的初始长方体，或点击「空手重新选点」，关闭界面后空手点击两个方块作为对角点。选点模式五分钟内有效；持有物品或普通空手交互不会选地。
2. **编辑形状**：可选择长方体或沿 Y 轴的圆柱体。长方体可调整长、宽、高；圆柱体可调整半径、高度；两种形状均可调整定位中心 X/Z 和底部 Y。长宽为偶数时，中心定位方块的正方向多占一个方块。选区范围及尺寸以方块计，坐标含端点。
3. **选择租期**：创建与续租都提供 7、14、30、90 天档位，最后一项为「自定义」，输入 1～90 的整数天数。
4. **预览与付款**：点击「预览线框并估价」，核对形状、完整坐标范围、三维体积、日租和本次费用。报价有效期两分钟；更改选区或租期后须重新预览。确认后扣款并创建租赁，名称自动生成。
5. **管理领地**：「我的领地」进入管理页；点击「状态」查看状态、形状、体积、维度、坐标、等级、日租、到期与宽限期截止时间。名称可通过「修改名称」免费修改，限制 1～32 个字符。
6. **续租与扩建**：先报价再确认。续租在未到期时追加至原到期时间，宽限期内从当前时间开始。扩建按等级增加水平范围，保持已有形状与高度；新范围须包含原选区，不能移动、缩小或与其他有效租赁重叠。扩建不延长租期。
7. **解除与到期**：解除前须确认，范围立即释放，剩余租金不退还。到期进入宽限期，宽限期内仍占用范围；宽限期结束释放范围。启动及约每五分钟执行扫描，宽限期按实际到期时间计算。

支持主世界、下界与末地，按维度校验高度和坐标。同维度范围的重叠判断、坐标查询、扩建包含判断与计费使用同一套三维方块集合。圆柱体按圆形截面内实际方块柱计算体积，不使用外接长方体的体积；例如半径 2、高 3，占用 13×3＝39 个方块。

## 线框运行环境

长方体使用 [DebugBox](https://sapi.dogelake.cn/debug-utilities/classes/DebugBox.html)，圆柱体使用 DebugCylinder，均通过 debugDrawer 显示完整线框，仅选地玩家可见，预览持续约 30 秒。重新预览、提交、离线及模块清理会移除旧线框。

宿主 BDS 必须支持相应 Beta API，启用 Beta APIs 实验，并在宿主行为包 `manifest.json` 的 `dependencies` 中声明：

```json
{
  "module_name": "@minecraft/debug-utilities",
  "version": "1.0.0-beta"
}
```

模块依赖 `economy` 和 `activity-log`。经济余额与领地数据通过补偿流程衔接：领地及成功结果在同一事务中提交；重复请求去重，写入失败退款，未完成的扣款或退款在启动及定期扫描时恢复。

## 配置与计费

默认配置见 `configs-default/land.json`，运行配置为 `configs/land.json`。

| 配置项                  | 默认值与用途                               |
| ----------------------- | ------------------------------------------ |
| `base_daily_rent`       | 10，基础日租                               |
| `rent_per_100_blocks`   | 2，每 100 个三维占用方块的日租系数         |
| `max_lands_per_player`  | 5，每位玩家有效租赁上限，含宽限期          |
| `land_count_multiplier` | 第 1～5 块的倍率：1、1.5、2、3、3          |
| `long_term_discounts`   | 本次租期达到 30 天九折、90 天八折          |
| `grace_period_days`     | 7，到期后的宽限期                          |
| `claim.initial_radius`  | 16，初始水平半径，即长宽均为 33            |
| `claim.initial_height`  | 16，初始高度，可设置为 1～128              |
| `claim.max_level`       | 5，扩建等级上限                            |
| `claim.level_radius`    | 16、24、32、48、64，须为 1～512 的递增整数 |

体积费用先向上取整，加基础日租后再向上取整，最后乘持有数量倍率并向上取整。本次租金按日租×天数×折扣计算并向上取整。扩建补差按日租增加额×实际剩余租期计算，不足一天按时间比例收费。

默认第一块长方体为 **33×16×33＝17,424 方块**，日租 **359**，租用七天共 **2,513**。租金基于三维体积，增加高度会增加费用。

## 服务接口

| 服务                  | 主要输入                                   | 用途                   |
| --------------------- | ------------------------------------------ | ---------------------- |
| `land.byId`           | `landId`                                   | 查询领地及形状、体积   |
| `land.byPos`          | `dimension,x,y,z`                          | 按实际形状查询坐标归属 |
| `land.listByOwner`    | `ownerId,limit?,offset?`                   | 查询玩家领地           |
| `land.validateShape`  | `ownerId,dimension,shape,excludeLandId?`   | 校验形状、重叠与日租   |
| `land.createLease`    | `playerId,dimension,days,shape`，或 `core` | 自动命名并创建租赁     |
| `land.rename`         | `playerId,landId,name`                     | 主人后期改名，免费     |
| `land.renewLease`     | `playerId,landId,days`                     | 续租                   |
| `land.expandLease`    | `playerId,landId,shape`                    | 扩建，保持已有形状     |
| `land.terminateLease` | `playerId,landId`                          | 解除租赁               |
| `land.leaseStatus`    | `landId`                                   | 查询租期状态           |
| `land.auditLog`       | `playerId,landId,limit?,offset?`           | 查询主人操作记录       |

`shape` 为 `{type:"cuboid",min,max}` 或 `{type:"cylinder",min,max,radius}`；圆柱体 min/max 的 X、Z 跨度均须为两倍半径。省略形状而传入 `core` 时，根据初始半径和高度创建默认长方体。

所有写服务要求 `requestId`，有费用的服务还要求 `expectedFee`（玩家确认的最高费用）。管理服务可传 `version`，防止过期信息提交。重复请求须保留相同 ID 和完整输入，调用方须从真实玩家上下文提供 `playerId`。

`land.ui.*` 提供 GUI 适配：选点模式、选区草稿、详情、各报价与确认、改名。创建确认核对完整选区输入；续租、扩建核对天数或等级；报价均绑定玩家、领地、有效期及版本。草稿五分钟后失效，须重新打开创建页面，不会随着玩家移动自动更换选区。

## 开发与验证

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test
sfmc mod install land --from dir:. --link
```

测试覆盖三维几何、配置、GUI 契约，以及重复提交、并发、报价修改与失效、改名、空手选点、原生线框清理、经济失败恢复和到期扫描。BDS 实机界面及 Beta API 渲染仍需联调。

模块仅管理租赁与范围占用，不包含方块破坏、放置或容器交互保护。旧数据与旧接口不提供兼容迁移。
