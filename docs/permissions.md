# 权限、角色与 Flags

[English](permissions.en.md) · [目录](README.md)

## 两套不同的授权

平台权限 `land.use`（Any）和 `land.admin`（OP）控制入口与服务器管理；领地角色通过 `block.break` 等操作ID授权。角色名叫“管理员”不代表拥有平台OP。所有权单独保存在 `ownerId`，不通过普通角色授予或撤销。

世界操作绕过要求 `land.admin` 加 `/c:land admin_bypass`，用 `admin_bypass off` 关闭。删除、转让等所有权业务另行允许已授权的服务器管理员，不全部依赖会话开关。绕过集合仅在内存中，进出扫描不会在玩家退出时清除；使用后显式关闭，不要依赖重新登录自动重置。

## 解析顺序

1. 索引未就绪，拒绝。
2. 具有平台管理员权限且显式开启绕过，允许。
3. 按维度与X/Z定位区块占领；荒野由 `wilderness_protected` 决定。
4. 命中普通区域，否则使用没有固定边界的默认区域。
5. 领主允许，此分支先于封禁和冻结检查。
6. 封禁者拒绝；冻结领地拒绝非领主已识别的世界操作，非活跃领地拒绝继续占领。
7. 有当前区域角色则整体替代领地角色；无覆盖时读取该成员的领地角色。
8. 只有角色包含请求权限才允许；无可用角色则拒绝。

`Decision.allow` 是最终布尔值；`effect` 为 allow/deny。普通区域回退到领地角色时 `resolution` 为 inherit，其余为 explicit。inherit 描述最终结果来源，不能单独当作允许。reason 包括 not_ready、bypass、wilderness、wilderness_protected、owner、banned、frozen、delinquent、role_grant、role_deny。

Flags 由各自的消费者执行；通用玩家解析器不会自动应用所有注册的 role/custom Flag。例如伤害处理器先判断 pvp，再检查 entity.attack；explosion 和 mob_spawn 不依赖玩家主体。

## 内置操作权限

| 权限ID | 含义 |
| --- | --- |
| `block.break` | 破坏方块 |
| `block.place` | 放置方块 |
| `block.interact` | 未独立分类的方块交互 |
| `container.open` | 打开已分类的容器/工作站 |
| `door.use` | 使用门、活板门、栅栏门 |
| `entity.attack` | 玩家对实体造成伤害 |
| `entity.interact` | 与实体交互 |
| `redstone.interact` | 交互已分类红石机关 |
| `land.manage` | 改领地名称、介绍、元数据、出生点 |
| `land.claim` | 占领与释放区块 |
| `land.transfer` | 已注册，但转让业务仍检查所有权 |
| `land.teleport` | 使用领地出生点传送 |
| `member.manage` | 成员关系与角色分配 |
| `role.manage` | 创建、修改、删除角色及权限 |
| `flag.manage` | 设置适用范围的 Flags |
| `area.manage` | 创建、重命名、调整、删除区域 |
| `bank.view` | 查看领地银行 |
| `bank.deposit` | 存入银行 |
| `bank.withdraw` | 从银行取款 |
| `economy.manage` | 税费、维护结算、升级、租赁和挂牌 |

## 角色模板与身份

| 模板键 | 初始名称 | 保留 | 初始权限 |
| --- | --- | --- | --- |
| `admin` | 管理员 | true | 除 land.transfer 外的内置权限。 |
| `member` | 成员 | false | `block.break`, `block.place`, `block.interact`, `container.open`, `door.use`, `entity.interact`, `redstone.interact`, `land.teleport`, `bank.view`, `bank.deposit` |
| `visitor` | 访客 | false | `door.use`, `block.interact` |
| `tenant` | 租客 | true | `block.break`, `block.place`, `block.interact`, `container.open`, `door.use`, `entity.interact`, `redstone.interact` |

每个领地的模板生成独立角色ID；即使选择英文，初始角色名称仍为中文。邀请、转让、租赁依靠稳定 `preset` 键，改名不会改变授权。保留角色不可删除，但名称、介绍和权限仍可修改。“成员”“访客”模板不是保留角色，删除后可能导致默认邀请或区域购买失败，应保留业务依赖的模板角色。

陌生玩家不会自动套用“访客”模板：没有成员关系和区域覆盖时没有可用角色。`trust` 默认直接授予 trusted 关系与访客模板；`invite` 接受后默认使用成员模板。Area 可以给非领地成员独立授权，但封禁优先。

自定义角色初始权限为空。删除被引用的角色时必须指定同领地替代角色，事务内迁移引用。没有角色层级或“只能授予自己已拥有权限”的约束；member.manage 与 role.manage 是较强的委派权限，应只授给可信管理者。

## 区域角色示例

```text
/c:land role_create Home Keeper
/c:land role_grant Home Keeper container.open
/c:land invite Home Alice
/c:land area_member Home Store Alice Keeper
```

Alice 用 `/c:land accept Home` 接受邀请。Store 之外成员角色允许建造；Store 内 Keeper 仅有 container.open，不能建造。当前没有单独清空覆盖、恢复继承的命令；只能改分配角色，或在确有需要时使用支持的成员撤销流程。

## Flags

| ID | Type | Scope | Default | 消费行为与限制 |
| --- | --- | --- | --- | --- |
| `explosion` | `boolean` | `both` | `false` | 过滤爆炸影响方块，不控制所有实体伤害。 |
| `mob_spawn` | `boolean` | `both` | `true` | 关闭后移除已登记敌对生物；生成后处理。 |
| `pvp` | `boolean` | `both` | `false` | 识别到攻击来源和受害者都是玩家时拒绝伤害；开启后仍需 entity.attack。 |
| `public_teleport` | `boolean` | `land` | `false` | 允许公开传送，仍有冷却、费用和封禁限制。 |
| `enter_message` | `boolean` | `both` | `true` | 控制进入提示；设在子区域上时只影响该子区域（子区域值优先，其次领地值）。 |
| `leave_message` | `boolean` | `both` | `true` | 控制离开提示；解析规则同 `enter_message`。 |
| `enter_text` | `string` | `both` | `空 / empty` | 进入提示模板，支持 {land}、{area}、{owner}；领地与子区域各用自己的值，不继承。 |
| `leave_text` | `string` | `both` | `空 / empty` | 离开提示模板，占位符与继承规则同 `enter_text`。 |

both 表示领地或普通区域；land-only Flag 不允许写入Area。有效值按普通区域、领地、注册默认值顺序读取。布尔写入接受 true/false/on/off，数字要求有限值；未知Flag写入拒绝，缺值回退，不自动允许。

命令层没有把已存值重置为 inherit 的入口，也没有通用Flag查询或列表；`perms` 仅摘要显示 pvp/explosion。注册自定义Flag提供定义和存储，不会自动新增保护监听器或任意校验函数。

依据：[解析器](../sapi/src/services/permission.ts)、[注册表与模板](../sapi/src/domain/permissions.ts)、[Flag写入](../sapi/src/services/flags.ts)。
