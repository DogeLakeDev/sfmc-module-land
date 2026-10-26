# 公开 API 与事件

[English](api.en.md) · [文档目录](README.md)

本模块通过 SDK 服务总线提供以下 **23 个服务**。清单中的输入/输出仅声明为 object，本页给出当前实际契约。不要通过导入内部服务文件绕过业务校验。

## 接入与身份边界

消费模块在自己的 SAPI 清单中声明依赖、调用权限与所需服务。以下是合并进清单的片段，不是完整模块清单：

```json
{
  "requires": ["land"],
  "permissions": [
    "service:land.here",
    "service:land.permission"
  ],
  "services": {
    "requires": [
      { "name": "land.here" },
      { "name": "land.permission" }
    ]
  }
}
```

运行时使用平台为当前模块绑定的 `ServiceClient`；在模块初始化完成、Land 已可用后调用。对其他服务同样添加对应的 `service:<名称>` 权限与服务声明。回调服务需要消费模块声明提供，Land 调用该目标也需满足平台服务访问权限；登记回调不会自动授予权限。

**当前写接口信任调用模块提供的非空 `actorId`，没有验证它就是请求的登录玩家，也不要求该玩家在线。** 在线查询只用于取名字与判断 `land.admin`，请求体的 `admin` 字段不会生效。调用方必须从经过验证的会话/玩家事件获得 ID，不能直接转发客户端自报 ID。注册与订阅接口也属于可信模块边界。

命令中的 `confirm` 不属于公开 API 输入。删除、角色删除等 API 会直接执行领域校验和修改；消费方负责自己的用户确认流程。

## 通用输入与返回类型

`?` 表示可选，未标类型的标识符/名称均为 string。写接口的 `land` 可用领地名称或 ID，优先于 `landId`；务必提供其中一个。角色与区域参数在支持的接口中可用名称或 ID。建议保存稳定 ID。

坐标使用有限数值，`chunkX/chunkZ` 必须是整数，采用玩家 `dimension.id` 的规范维度字符串，例如 `minecraft:overworld`。维度别名不是统一规范化存储的契约，不要混用 `overworld` 与 `minecraft:overworld`。

```ts
type ActorLand = {
  actorId: string;
  actorName?: string;
  land?: string;   // Name or ID; takes precedence over landId.
  landId?: string; // Supply at least one of land / landId.
};
type SpawnPoint = {
  dimensionId: string;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
};
type LandSummary = {
  id: string; name: string; ownerId: string;
  status: "active" | "delinquent" | "frozen"; chunks: number;
};
type LandView = LandSummary & {
  ownerName: string; level: number; description: string;
  spawn: SpawnPoint | null; metadata: Record<string, string>;
};
type Decision = {
  allow: boolean; effect: "allow" | "deny";
  resolution: "explicit" | "inherit"; reason: string;
  permission: string; relation: string;
  landId: string; areaId: string; roleId: string; roleName: string;
};
type FlagDef = {
  id: string; description: string;
  type: "boolean" | "number" | "string";
  scope: "land" | "area" | "both";
  defaultValue: boolean | number | string;
  kind: "role" | "natural" | "custom";
};
```

这些类型是消费方示例，当前包未单独导出一套 API 类型入口。`land.get` 返回的 `spawn/metadata` 在本地服务总线路径可能是内部引用；调用方应视为只读，不可就地修改。

## 查询服务

| 服务 | 输入 | 输出 |
| --- | --- | --- |
| land.here | `{dimensionId,x,y,z}` | `{found:false}` 或下述位置结果 |
| land.get | `{name? , landId?}` | `LandView` |
| land.list | `{ownerId?}` | `{lands:LandSummary[]}` |
| land.map | `{dimensionId?}` | `{lands:MapLand[]}` |
| land.permission | `{playerId,dimensionId,x,y,z,permission}` | `Decision` |

位置结果为 `{found:true,landId,landName,ownerId,areaId,areaName,specific,status}`。`specific` 表示命中普通三维区域，false 表示默认区域；`areaId` 此处是默认区域的真实 ID。`land.get` 若同时给 name 与 landId，name 优先。`land.list` 不分页。

`land.map` 给网页地图等展示用途，返回全部领地的区块与子区域水平范围，按领地 ID 排序、不分页。给出 `dimensionId` 时只保留该维度的数据，并跳过在该维度没有区块和子区域的领地。不包含成员、角色、旗标与银行信息。子区域坐标是**包含两端**的方块坐标（内部半开区间的 max 已减 1）：

```ts
type MapLand = {
  id: string; name: string; ownerId: string; ownerName: string;
  status: "active" | "delinquent" | "frozen"; level: number;
  claims: { dimensionId: string; chunks: [chunkX: number, chunkZ: number][] }[];
  areas: {
    id: string; name: string; dimensionId: string;
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
  }[];
};
```

`Decision.allow` 是最终布尔结果，`effect` 与它一致；`resolution:"inherit"` 表示子区域回退到领地角色，不是可直接当作允许使用的第三种结果。可能的 reason 为 `not_ready, bypass, wilderness, wilderness_protected, owner, banned, frozen, delinquent, role_grant, role_deny`。

```ts
import type { ServiceClient } from "@sfmc-bds/sdk/sapi/service";

type Decision = {
  allow: boolean;
  reason: string;
  landId: string;
  areaId: string;
};

export async function mayBuild(
  services: ServiceClient,
  playerId: string,
  position: { dimensionId: string; x: number; y: number; z: number },
): Promise<boolean> {
  const result = await services.call<Decision>("land.permission", {
    playerId,
    ...position,
    permission: "block.place",
  });
  return result.allow;
}
```

该示例做一次权限查询；执行真实动作前应按消费模块自身的并发与事件时机重新校验。它不会替代内置事件适配中的 PvP、爆炸等 Flag 检查。

## 写服务

| 服务 | 输入 | 成功输出 |
| --- | --- | --- |
| land.create | `{actorId,actorName?,name,description?,dimensionId,x,y,z,yaw?,pitch?}` | `{id,name}` |
| land.delete | `ActorLand` | `{ok:true}` |
| land.claim | `ActorLand & {dimensionId,chunkX,chunkZ}` | `{count:number}` |
| land.role.create | `ActorLand & {name,description?}` | `{id,name}` |
| land.role.grant | `ActorLand & {role,permission}` | `{ok:true}` |
| land.role.revoke | `ActorLand & {role,permission}` | `{ok:true}` |
| land.role.assign | `ActorLand & {playerId,role}` | `{ok:true}` |
| land.role.delete | `ActorLand & {role,replacement?}` | `{ok:true}` |
| land.flag.set | `ActorLand & {area?,flag,value:string}` | `{value:boolean\|number\|string}` |
| land.member.invite | `ActorLand & {playerId,role?}` | `{ok:true}` |

- `land.create` 在指定位置创建并占领首个区块，价格和配额照常生效；不强制操作者实际站在该位置。
- `land.claim` 每次输入一个区块；`count` 是本次实际新增数。
- `land.role.assign` 的 playerId 为已有有效成员的稳定 ID，不执行按名称查找。`land.member.invite` 的 playerId 字段会经过已知玩家解析，可接受可识别的名称/ID；不认识的离线玩家会失败。
- `land.role.delete` 删除被引用角色时需要同领地的 replacement；保留角色不可删除。
- `land.flag.set` 的 value 必须是**字符串**，例如 `"false"`、`"10"`。JSON 布尔值 false 不能代替字符串。area 缺省为领地 Flag；提供 area 时检查定义的适用范围。

当前没有公开的放弃区块、区域 CRUD、清除区域授权、成员列表或 Flag 查询服务。勿将命令能力等同于 API 能力；需要新增服务时应扩展清单与处理器。

## 扩展注册与订阅

以下服务成功均返回 `{ok:true}`。注册项与订阅会保存并在重启后加载。

| 服务 | 输入 | 语义 |
| --- | --- | --- |
| land.registry.permission | `{id,description}` | 注册权限 ID；消费模块自行执行动作检查。 |
| land.registry.flag | `FlagDef` | 保存 Flag 定义；没有任意验证函数或枚举约束。 |
| land.registry.quota | `{id,limit:number,usageService?}` | 登记扩展配额；当前未接入核心配额执行，也无公开查询接口。 |
| land.registry.condition | `{id,service}` | 升级前调用条件服务。 |
| land.registry.reward | `{id,service}` | 等级写入后调用奖励服务，接收方必须去重。 |
| land.registry.hostile | `{typeId}` | 加入关闭 mob_spawn 时生成后移除的类型集合。 |
| land.event.subscribe | `{event,target}` | 按完整事件名登记回调服务，持久化且同组合去重。 |
| land.event.unsubscribe | `{event,target}` | 移除对应订阅。 |

建议使用模块前缀命名，避免覆盖其他模块或内置定义。权限注册不提供独立所有权命名空间；Flag 重注册禁止改变既有类型，但相同类型仍可能覆盖定义。Flag 定义只支持上述基本类型与范围；`kind` 是分类，不会自动安装保护行为。

条件服务收到 `{landId,targetLevel,conditionId}`，应显式返回 `{ok:true}` 或 `{ok:false,reason}`。不可用/抛错会阻止升级；当前空对象并不会表示失败，不要依赖这一宽松行为。

奖励服务收到 `{landId,level,rewardId,idempotencyKey}`。键形如 `reward:<landId>|<level>|<rewardId>`。服务正常返回后 Land 才保存奖励标记；返回内容不按 ok 检查，失败应抛错。若奖励已发但确认丢失，Land 会重试，接收方必须持久去重。

## 事件订阅

订阅按完整字符串精确匹配，不支持通配符。回调收到 `{event,phase,...payload}`，phase 为 before 或 after。执行前拒绝返回 `{ok:false,reason}`；执行后返回值不能撤销业务。源码注释中“.before 结尾”的描述不是实际事件命名，使用下表的完整名字。

```ts
import type { ServiceClient } from "@sfmc-bds/sdk/sapi/service";

export async function install(services: ServiceClient): Promise<() => void> {
  const off = services.provide("example.land.beforeCreate", (input) => {
    if (typeof input.name === "string" && input.name.startsWith("staff_")) {
      return { ok: false, reason: "Reserved name" };
    }
    return { ok: true };
  });
  await services.call("land.event.subscribe", {
    event: "land.before.created",
    target: "example.land.beforeCreate",
  });
  return off;
}
```

示例函数返回的清理器只注销当前进程的回调处理器。订阅本身是持久化的；如要永久停用，在回调仍可访问时调用 `land.event.unsubscribe`。接收服务重新加载时要重新 provide，重复 subscribe 不会增加同组合订阅。

### 执行前事件

| 事件 | 载荷字段 |
| --- | --- |
| land.before.created | `actorId, name, landId` |
| land.before.deleted | `actorId, landId` |
| land.before.claimed | `actorId, landId, count` |
| land.before.area | `actorId, landId, areaId, op:"create"` |
| land.before.member | `actorId, landId, playerId, op:"invite"` |
| land.before.transferred | `actorId, landId, to` |
| land.before.upgraded | `actorId, landId, level` |
| land.before.lease | `actorId, landId, areaId` |
| land.before.sale | `actorId, landId, listingId` |

`land.before.area` 只覆盖创建，`land.before.member` 只覆盖邀请，不能假定所有同类写操作都存在前置事件。前置服务缺失、超时或普通异常会记录并继续操作，不能用它作为必须成功执行的安全门禁。

部分回调在写入队列内等待，禁止在回调中 await 另一项 Land 写操作；先返回，另行安排后续工作。

### 执行后事件

| 事件 | 主要载荷字段 |
| --- | --- |
| land.created | `actorId, actorName, landId, name` |
| land.deleted | `actorId, landId, name` |
| land.claimed / land.unclaimed | `actorId, landId, count` |
| land.area.changed | `actorId, landId, areaId, op:"create"\|"resize"\|"delete"` |
| land.transferred | `actorId, landId, to` |
| land.member.changed | `landId, playerId`，附操作相关字段 |
| land.permission.changed | 见下文 |
| land.flag.changed | `actorId, landId, areaId, flag` |
| land.upkeep.paid / land.upkeep.delinquent / land.upkeep.frozen | `actorId, landId, amount` |
| land.tax.failed | `landId, playerId, message` |
| land.upgraded | `actorId, landId, level` |
| land.lease.started | `actorId, landId, areaId, leaseId` |
| land.lease.ended | `landId, areaId, playerId, status:"ended"\|"expired"` |
| land.sale.completed | `actorId, landId, listingId` |
| land.entered / land.left | 见下文 |

`land.member.changed` 和 `land.permission.changed` 的附加字段随操作不同，不是每条都包含 actorId。权限通知可能包含 `playerId,roleId,permission,granted,areaId,relation,revokedAreaIds`；角色删除替换包含 `op:"role_deleted",replacementRoleId,playerIds,areaIds`。消费方应按 landId 失效相关缓存，检查可选字段后再细化处理。

领地 Flag 的 areaId 为 `""`。区域改名与描述修改当前不发 `land.area.changed`。after 通知会先尝试写入 activity.record，再调用订阅者；任一步失败只记日志。没有持久重试队列、全局顺序或恰好一次保证，不能将事件流当作完整事实数据库。

### 进入与离开

范围由 `{landId,areaId}` 表示；**presence 事件的默认区域 areaId 为 `""`，与 land.here/Decision 的真实默认区域 ID 不同**。

- entered：`{playerId,landId,areaId,fromLandId,fromAreaId,reason}`。
- left：`{playerId,landId,areaId,toLandId,toAreaId,reason}`。
- reason 为 `movement` 或 `offline`。第一次扫描到玩家已在领地内会发 entered，离线会发一次 left。
- 相邻领地或同领地不同区域切换，先 left 再 entered；同一玩家按观测顺序投递。默认 20 tick 扫描，短暂经过可能漏掉。

## 错误

业务失败抛出 SDK `ServiceError`，读取 `code/status/message`，不要靠中文 message 分支。Land API 当前以中文渲染错误消息：`no_permission → 403`、以 `not_found` 结尾的键 → 404、`internal → 500`，其他业务错误 → 409（包括 not_ready）。平台还可能抛出鉴权、服务不可用或网络错误。

成功响应的 `{ok:true}` 不是统一业务错误封装；失败不会统一返回 `{ok:false}`。错误处理与重试时必须考虑[账本边界](data-and-recovery.md)，尤其不能盲目重试存取款等带时间键的命令。
