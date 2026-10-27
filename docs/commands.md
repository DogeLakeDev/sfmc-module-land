# 完整命令参考

[English](commands.en.md) · [目录](README.md)

以下语法统一省略 `/c:land ` 前缀。`<...>` 必填，`[...]` 可选，`...` 合并剩余字符串参数。子命令后最多六个字符串参数，`confirm` 也占一项。入口要求平台 `land.use`。

领地、区域和角色名使用不带空格的2–32长度名称，按 JavaScript 字符串长度计算；查重忽略大小写和两端空白。领地、区域和角色通常可用名称或稳定ID定位，区域和角色在所属领地内查找。玩家目标使用在线名称/ID或已记录身份；空字符串参数会被过滤。

示例优先显式指定领地。省略可选领地参数时查询玩家脚下领地，因此在荒野扩张必须写 `claim <land>`。控制台仅支持部分查询和管理操作；位置、选区、传送、创建、转让与部分玩家目标命令必须由玩家执行。

## 通用与领地

| 语法 | 授权依据 | 行为 |
| --- | --- | --- |
| `help` | `land.use` | 显示分组帮助。 |
| `create <land> [description...]` | `创建配额 / creation quota` | 创建并占领脚下区块；玩家付创建费用。 |
| `delete <land> confirm` | `领主或服务器管理员 / owner or server admin` | 删除全部从属数据；银行、租约、挂牌和交易先检查。 |
| `rename <land> <name>` | `land.manage` | 重命名，ID 不变。 |
| `describe <land> [text...]` | `land.manage` | 设置或清空介绍。 |
| `info [land]` | `land.use` | 显示指定或脚下领地摘要。 |
| `here [land]` | `land.use` | 玩家位置查询；也接受显式领地。 |
| `list` | `land.use` | 列出自己拥有或有成员关系的领地。 |
| `transfer <land> <player> confirm` | `领主或服务器管理员 / owner or server admin` | 转让所有权；原领主变为管理员。 |
| `map` | `land.use` | 显示当前位置周围 7×7 区块图。 |
| `near` | `land.use` | map 的别名。 |
| `meta <land> <key> [value...]` | `land.manage` | 设置字符串元数据；键为字母开头的字母数字或下划线，最长32。 |
| `lang <zh\|en>` | `land.use` | 设置自己的语言；非 en 输入回退中文。 |

## 区块与出生点

| 语法 | 授权依据 | 行为 |
| --- | --- | --- |
| `claim [land]` | `land.claim` | 占领脚下区块；荒野必须写领地名。 |
| `unclaim [land] confirm` | `land.claim` | 释放脚下区块，不能释放最后一块或有区域的区块。 |
| `claim_rect <land>` | `land.claim` | 用两个选点展开水平区块矩形，受批量和总额限制。 |
| `unclaim_rect <land> confirm` | `land.claim` | 释放选区内本领地的区块。 |
| `spawn_set [land]` | `land.manage` | 将当前位置与视角设为出生点；必须在领地内。 |
| `spawn_show [land]` | `land.use` | 显示保存的出生点。 |
| `spawn_reset [land]` | `land.manage` | 选首个占领区块中心，沿用玩家高度和视角。 |
| `tp [land]` | `land.teleport / public_teleport` | 按权限、公开传送 Flag、冷却和费用传送。 |
| `border [land]` | `land.use` | 周期显示附近领地外轮廓：粒子线、多层矮墙与拐角柱，其他领地用另一种粒子。 |
| `border_stop` | `land.use` | 停止自己的边界显示。 |

## 三维区域与 Flags

| 语法 | 授权依据 | 行为 |
| --- | --- | --- |
| `area_pos1` | `land.use` | 记录玩家当前坐标为选点1。 |
| `area_pos2` | `land.use` | 记录玩家当前坐标为选点2。 |
| `area_create <land> <area>` | `area.manage` | 从选区创建普通 Area。 |
| `area_resize <land> <area>` | `area.manage` | 用选区替换边界，重新校验越界和重叠。 |
| `area_delete <land> <area> confirm` | `area.manage` | 删除普通区域；有效租约或开放挂牌会阻止。 |
| `area_rename <land> <area> <name>` | `area.manage` | 重命名普通区域。 |
| `area_describe <land> <area> [text...]` | `area.manage` | 设置区域介绍。 |
| `area_info <land> <area>` | `land.use` | 显示类型、维度和半开边界。 |
| `area_list [land]` | `land.use` | 列出默认区域和普通区域。 |
| `area_member <land> <area> <player> <role>` | `member.manage` | 设置普通区域的角色覆盖，可为非领地成员授权；player 写 `@public`、`@all` 或 `所有人` 时设置该区域对未加入领地玩家的公共角色（只对世界交互生效）。 |
| `flag <land> <flag> <value>` | `flag.manage` | 设置领地 Flag；不是查询命令。 |
| `area_flag <land> <area> <flag> <value>` | `flag.manage` | 设置普通区域 Flag。 |

## 成员与角色

| 语法 | 授权依据 | 行为 |
| --- | --- | --- |
| `invite <land> <player> [role]` | `member.manage` | 邀请，默认使用成员模板。 |
| `accept <land>` | `自己的待处理邀请 / own invitation` | 接受自己的邀请。 |
| `deny <land>` | `自己的待处理邀请 / own invitation` | 拒绝邀请；不撤销独立区域授权。 |
| `trust <land> <player> [role]` | `member.manage` | 直接设为 trusted；默认访客模板，不默认给予建造权。 |
| `untrust <land> <player> confirm` | `member.manage` | 取消 trusted 关系及区域覆盖；有效租客受保护。 |
| `kick <land> <player> confirm` | `member.manage` | 撤销成员和区域覆盖；不能移除领主或有效租客。 |
| `ban <land> <player> confirm` | `member.manage` | 封禁并撤销区域覆盖；不能封禁领主或有效租客。 |
| `unban <land> <player> confirm` | `member.manage` | 解除封禁，原成员资格不自动恢复。 |
| `members <land>` | `land.use` | 查看领主与成员关系、角色。 |
| `assign <land> <player> <role>` | `member.manage` | 更换现有非邀请、非封禁成员的领地角色。 |
| `role_create <land> <role> [description...]` | `role.manage` | 创建没有权限的自定义角色。 |
| `role_delete <land> <role> [replacement] confirm` | `role.manage` | 有引用时必须提供同领地替代角色；保留角色不可删。 |
| `role_rename <land> <role> <name>` | `role.manage` | 改名保留角色ID和模板键。 |
| `role_describe <land> <role> [text...]` | `role.manage` | 设置角色介绍。 |
| `role_grant <land> <role> <permission>` | `role.manage` | 加入一个已注册权限。 |
| `role_revoke <land> <role> <permission>` | `role.manage` | 移除一个权限。 |
| `role_list <land>` | `land.use` | 列出角色和权限。 |
| `role_info <land> <role>` | `land.use` | 显示角色权限；未找到角色时可能无输出。 |
| `perms` | `land.use` | 查看自己脚下的角色、关系以及 pvp/explosion 值，不是完整权限清单。 |

## 成长、银行与维护

| 语法 | 授权依据 | 行为 |
| --- | --- | --- |
| `level [land]` | `land.use` | 显示等级和下一级费用。 |
| `upgrade <land> confirm` | `economy.manage` | 从领地银行支付升级费，检查区块数、成员数和扩展条件。 |
| `quota [land]` | `land.use` | 查看内置配额使用量和上限。 |
| `bank [land]` | `bank.view` | 查询银行余额。 |
| `deposit [land] <amount>` | `bank.deposit` | 从玩家存入银行；金额为正整数。 |
| `withdraw [land] <amount> confirm` | `bank.withdraw` | 从银行取到玩家账户。 |
| `upkeep [land]` | `land.use` | 显示本期费用、时间和状态。 |
| `upkeep_pay [land]` | `economy.manage` | 尝试结算已到期或欠费的一期；未到期会跳过。 |
| `tax [land]` | `land.use` | 显示成员税设置，不执行扣税。 |
| `tax_set <land> <amount> [hours]` | `economy.manage` | 金额0关闭；周期默认24小时，最短60秒。 |

## 租赁与交易

| 语法 | 授权依据 | 行为 |
| --- | --- | --- |
| `rent_publish <land> <area> <price> <hours>` | `economy.manage` | 发布普通区域出租；周期最短60秒，价格正整数。 |
| `rent_cancel <land> [area]` | `economy.manage` | 取消目标的开放挂牌。 |
| `rent_take <land> <area>` | `非领主且未封禁 / non-owner, not banned` | 支付租金并取得区域租客角色；无 confirm 参数。 |
| `rent_renew <land> <area>` | `租客、领主或控制台 / tenant, owner, console` | 支付下一期并延长结束时间；不是自动续租。 |
| `rent_end <land> <area> confirm` | `租客、领主或控制台 / tenant, owner, console` | 结束租约并撤权，不自动退未使用租金。 |
| `sell_area <land> <area> <price>` | `economy.manage` | 出售区域成员授权，不转让领地所有权。 |
| `sell_land <land> <price>` | `领主或控制台 / owner or console` | 发布整领出售；需空银行且无有效租约、未完成交易。 |
| `buy <land> [area] confirm` | `非当前领主 / not current owner` | 向当前领主付款，购买整领或区域授权。 |
| `unsell <land> [area]` | `economy.manage` | 取消目标的开放挂牌。 |
| `tx [land]` | `land.use` | 列出最多20条非 applied 交易，包括 failed/refunded。 |

## 管理员

| 语法 | 授权依据 | 行为 |
| --- | --- | --- |
| `admin_bypass [off]` | `land.admin` | 无参数开启；off关闭自己的管理绕过。 |
| `admin_diag [land]` | `land.admin` | 只读诊断默认区域、越界/重叠、缺失角色与孤立占领。 |
| `admin_repair [land] confirm` | `land.admin` | 有限修复并续跑交易；不是任意数据修复器。 |
| `admin_tx [land]` | `land.admin` | 列出最多20条非 applied 交易。 |
| `admin_legacy [filter]` | `land.admin` | 列出尚未绑定的旧服占位身份（`xuid:<XUID>`，最多20条）及其名下领地数，可按名字或 XUID 过滤。 |
| `admin_legacy_bind <旧XUID或占位名> <player> confirm` | `land.admin` | 把占位身份名下的领主身份、成员关系与区域授权转给真实玩家；真实玩家已有的关系保留，冲突的占位关系丢弃。 |

## 确认与可见限制

末尾字面量 `confirm` 是明确操作意图，不是预览令牌或两阶段事务ID。当前 `admin_repair` 无参数时路由也会补入确认；实际使用请坚持显式确认形式。公开写服务不经过命令确认层。

`flag` / `area_flag` 只有写入，没有 Flag 列表、读取或恢复继承命令；没有单独清除 Area 角色覆盖的命令。`perms` 只是摘要。`border` 显示附近领地的区块外轮廓，不显示三维区域线框。`map` 每格都是 `■`，只用颜色区分：黄色是玩家所在的中心格，绿色是脚下领地的其他区块，红色是其他占领，灰色是荒野；绿色不表示所有自己拥有的领地。格子符号可通过配置 `messages` 的 `map_cell_self`、`map_cell_here`、`map_cell_other`、`map_cell_wild` 覆盖；覆盖 `map_title` 时须保留 `{rows}`，它会被替换为地图行。

给角色添加 `land.transfer` 不会取代转让和删除的领主检查。部分服务器管理员业务操作不依赖世界保护的会话绕过开关；详见[权限](permissions.md)与[已知限制](compatibility.md)。

实现依据：[router.ts](../sapi/src/commands/router.ts)。
