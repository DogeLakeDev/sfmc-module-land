# 兼容性与已知限制

[English](compatibility.en.md) · [文档目录](README.md)

核对日期：2026-10-20。下表将“接口能做什么”和“本模块做了什么”分开说明。编译与模拟测试通过不等于实服通过；当前真实 BDS 验证均待执行。

## 版本基线

项目锁定 `@minecraft/server 2.11.0-beta.1.26.51-stable`，另有 `server-net 1.0.0-beta.11940b24`、`server-ui 2.3.0-beta.1.26.51-stable` 与 vanilla-data 1.26.51。SDK 开发依赖为 ^0.5.0，peer 为 >=0.5.0，本地锁文件基线为 0.5.0。

这些是项目依赖版本，不是“任意 BDS 版本均可运行”的保证。服务器必须提供用到的事件和多参数命令能力；具体 BDS 构建、脚本模块版本与实验设置需在部署环境确认。下列官方实验版文档随 API 演进，部署时同时对照锁文件与本地类型。

## 保护矩阵

Fully Supported 仅表示指定事件覆盖的窄范围已实现；Partially Supported 表示存在覆盖缺口或事后处理；Unsupported 表示本模块没有实现。所有行的实服结果目前均为 **待验证**。

| 行为 | 实现状态 | 当前处理及边界 |
| --- | --- | --- |
| 玩家直接破坏目标方块 | Fully Supported（事件范围） | playerBreakBlock 前置回调按目标方块检查 block.break 并取消；不涵盖一切间接破坏 |
| 玩家直接放置目标方块 | Fully Supported（事件范围） | playerPlaceBlock 前置回调按事件方块检查 block.place；多方块结构与跨界副作用待实测 |
| 门、容器、普通方块、红石交互 | Partially Supported | 按方块类型映射权限并取消直接交互；不是所有容器访问、自动化或红石信号的总拦截 |
| 玩家直接实体交互 | Fully Supported（事件范围） | playerInteractWithEntity 按目标实体位置检查 entity.interact |
| 玩家攻击实体、PvP | Partially Supported | 检查 damagingEntity 为玩家的伤害与目标位置；关闭 PvP 时直接玩家对玩家伤害先拒绝，开启后还需 entity.attack。未证明所有投射物、宠物或间接来源覆盖完整 |
| 爆炸影响的方块 | Fully Supported（事件范围） | 按每个受影响方块的 explosion Flag 过滤列表；不是取消所有爆炸效果 |
| 爆炸实体伤害 | Partially Supported | explosion Flag 本身只过滤方块；伤害入口另行处理玩家来源，不能保证阻止全部爆炸伤害 |
| 关闭敌对生物生成 | Partially Supported | 对已登记类型的 entitySpawn after 事件安排移除；可能先出现再消失，不是前置取消，未覆盖所有自定义生物 |
| 封禁玩家行走/进入 | Partially Supported | 不能取消移动；可选 ban_eject 扫描后尝试传送，默认关闭 |
| 活塞、液体流动、火焰蔓延 | Unsupported | 当前没有对应保护处理器；不宣称可靠防护 |
| 自动化搬运、压力板、各类跨界副作用 | Unsupported / 未验证 | 没有通用传播/自动化边界模型，不能由“直接交互可取消”推导已覆盖 |

相关官方接口：[方块放置前置事件](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/playerplaceblockbeforeevent?view=minecraft-bedrock-experimental)、[方块交互前置事件](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/playerinteractwithblockbeforeevent?view=minecraft-bedrock-experimental)、[实体交互前置事件](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/playerinteractwithentitybeforeevent?view=minecraft-bedrock-experimental)说明对应事件的取消能力。取消一个事件不等同于覆盖该行为的所有游戏机制。

[伤害前置事件](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/entityhurtbeforeevent?view=minecraft-bedrock-experimental)提供取消字段；[爆炸前置事件](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/explosionbeforeevent?view=minecraft-bedrock-experimental)提供受影响方块列表设置；[实体生成后置事件](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/entityspawnafterevent?view=minecraft-bedrock-experimental)发生在生成之后。表中的覆盖判断结合这些接口与本模块处理器，不是官方对本模块的认证。

## 启动、荒野与管理员

索引未就绪时，破坏、放置、方块/实体交互拒绝，entityHurt 与 explosion 回调直接取消全部对应事件，影响不限于已知领地。敌对生物生成回调在未就绪时跳过。初始化失败应及时查日志，避免长期停留在启动保护状态。

`wilderness_protected` 作用于通用位置权限检查；当前伤害入口在目标不属于领地时直接返回，爆炸入口保留荒野方块，因此不能理解为荒野的一切伤害和爆炸也都被禁止。

领主在权限解析中先于封禁/冻结放行；服务器管理员的世界操作需要持有 land.admin 并显式打开 admin_bypass。PvP 关闭检查发生在角色/绕过检查之前，不能依赖 bypass 越过它。绕过集合在内存中，离线扫描不清除；需要时执行 admin_bypass off。

## 其他当前限制

- 只有命令界面，没有表单 GUI、国家、战争或外交系统。
- 区域是无重叠 AABB，不能嵌套；border 为附近区块角粒子，不是三维线框。
- leave_text 已注册保存但未消费；进入/离开文字开关和区域提示不完全等价。
- 没有自动访客角色；权限管理没有等级层级或授权上限，拥有 member.manage/role.manage 的人应是可信管理者。
- API 写接口信任 actorId；Flag 注册不自动执行行为，扩展配额未参与核心额度检查。详见 [API](api.md)。
- 经济没有跨库原子事务；存取款重新输入、收费传送失败和奖励重试有边界，见[恢复手册](data-and-recovery.md)。
- after 事件没有持久补发保证；扫描可能漏过短暂进出。缓存消费者需主动校准。
- 不自动迁移旧租赁数据。管理重叠诊断可能把不同维度区域误判为重叠，自动修复范围有限。
- 当前没有性能压测结论、最低可用 TPS 或玩家容量承诺。

将这些限制纳入部署验收；已实现路径按[验证指南](verify.md)记录实际 BDS 版本、配置、操作和结果。
