# @sfmc-bds/module-land

[English](README.en.md) · [文档目录](docs/README.md)

SFMC 的区块领地模块。一个 Land 拥有多个维度中的 Chunk；普通 Area 在占领范围内提供三维区域角色覆盖。通过 `/c:land` 管理领地、成员、自定义角色、Flags，以及现有的银行、维护费、租赁和买卖功能。

当前版本 `1.0.0`，仅命令交互。数据库通过 SFMC SDK 接入，保护事件从内存索引查询。旧版 `sfmc_lands` 租赁数据不会自动迁移。

## 安装条件

- SFMC 平台与 `@sfmc-bds/sdk >=0.5.0`，支持多参数命令和声明式模块服务。
- 已加载 `economy`、`activity-log`，可用的 SFMC 数据库服务。二者在 manifest 中是硬依赖。
- 与项目依赖一致的 SAPI：`@minecraft/server 2.11.0-beta.1.26.51-stable`。具体 BDS 版本与实验选项需按服务器实际环境验证。
- 开发与测试使用 Node `>=22.13.0`、pnpm `10.8.0`。

## 快速使用

按平台模块安装流程加载本包，并将默认配置 [land.json](configs-default/land.json) 合并到服务器的 `configs/land.json`。默认创建价格为 50，维护费从领地银行扣除。

```text
/c:land create 家园
/c:land here
/c:land claim 家园
/c:land deposit 家园 100
/c:land invite 家园 Alice
```

创建占领脚下一个区块；扩张时移动到目标区块再执行 `claim 家园`。受邀者执行 `/c:land accept 家园`。默认访客没有角色，不可建造；管理员模板角色属于领地，不等同于服务器 OP。完整流程见[快速上手](docs/getting-started.md)。

## 文档

| 内容 | 中文 | English |
| --- | --- | --- |
| 安装与快速上手 | [阅读](docs/getting-started.md) | [Installation and quick start](docs/getting-started.en.md) |
| 完整命令参考 | [阅读](docs/commands.md) | [Command reference](docs/commands.en.md) |
| 配置、配额与经济 | [阅读](docs/configuration.md) | [Configuration, quotas, and economy](docs/configuration.en.md) |
| 权限、角色与 Flags | [阅读](docs/permissions.md) | [Permissions, roles, and flags](docs/permissions.en.md) |
| 区块与三维区域 | [阅读](docs/areas.md) | [Chunks and 3D areas](docs/areas.en.md) |
| 架构与性能 | [阅读](docs/architecture.md) | [Architecture and performance](docs/architecture.en.md) |
| 数据模型、迁移与恢复 | [阅读](docs/data-and-recovery.md) | [Data model, migration, and recovery](docs/data-and-recovery.en.md) |
| 公开 API 与事件 | [阅读](docs/api.md) | [Public API and events](docs/api.en.md) |
| 兼容性与已知限制 | [阅读](docs/compatibility.md) | [Compatibility and known limitations](docs/compatibility.en.md) |
| 测试与验证 | [阅读](docs/verify.md) | [Testing and verification](docs/verify.en.md) |

## 验证状态

自动化测试覆盖真实 Repository/Codec、内存 SQLite、领域逻辑、故障回滚、恢复和事件顺序；Minecraft 和经济服务在测试边界替换。最近一次验证（2026-10-20）：36 项自动化测试通过，类型检查与 ESLint 通过。真实 BDS 场景仍未验证，不能据此认定所有保护行为已在游戏中通过。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test
```

## 当前边界

- 活塞、液体和火焰蔓延没有实现保护；敌对生物生成只在生成后移除。
- 爆炸 Flag 过滤受影响方块，不代表取消爆炸的所有实体伤害。
- 公开写服务信任调用方提供的 `actorId`，尚未校验调用方能否代表该玩家；只能由可信集成使用。
- 自定义 Flag 的注册和存储不等于自动实现其保护行为。
- 经济与领地数据库不是跨库原子事务；恢复依赖经济接口的幂等键。

详见[兼容性与已知限制](docs/compatibility.md)。
