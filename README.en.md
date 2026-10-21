# @sfmc-bds/module-land

[中文](README.md) · [Documentation](docs/README.md)

Chunk-based land ownership for SFMC. A Land claims chunks across dimensions; box Areas inside those claims override member roles in 3D space. `/c:land` manages lands, custom roles, flags, banks, upkeep, rentals, and sales.

Version `1.0.0` uses commands only, the SFMC database abstraction, and an in-memory protection index. Legacy `sfmc_lands` lease rows are not migrated.

## Requirements

- SFMC with SDK `>=0.5.0`, including multi-parameter commands and module services.
- The `economy` and `activity-log` modules and an available SFMC database service; both modules are mandatory manifest dependencies.
- The project SAPI dependency is `@minecraft/server 2.11.0-beta.1.26.51-stable`. Validate the actual BDS build and experimental settings separately.
- Development: Node `>=22.13.0`, pnpm `10.8.0`.

## Quick start

Install through the platform module workflow and merge [default configuration](configs-default/land.json) into the server’s `configs/land.json`. Creation costs 50 by default; upkeep is paid by the land bank.

```text
/c:land create Home
/c:land here
/c:land claim Home
/c:land deposit Home 100
/c:land invite Home Alice
```

Creation claims the chunk under the player. Move to an unclaimed target chunk before `claim Home`. The invitee runs `/c:land accept Home`. An unassigned visitor has no role and cannot build. A land administrator role is separate from server OP privileges. See [getting started](docs/getting-started.en.md).

## Documentation

| Topic | English | 中文 |
| --- | --- | --- |
| Installation and quick start | [Read](docs/getting-started.en.md) | [安装与快速上手](docs/getting-started.md) |
| Command reference | [Read](docs/commands.en.md) | [完整命令参考](docs/commands.md) |
| Configuration, quotas, and economy | [Read](docs/configuration.en.md) | [配置、配额与经济](docs/configuration.md) |
| Permissions, roles, and flags | [Read](docs/permissions.en.md) | [权限、角色与 Flags](docs/permissions.md) |
| Chunks and 3D areas | [Read](docs/areas.en.md) | [区块与三维区域](docs/areas.md) |
| Architecture and performance | [Read](docs/architecture.en.md) | [架构与性能](docs/architecture.md) |
| Data model, migration, and recovery | [Read](docs/data-and-recovery.en.md) | [数据模型、迁移与恢复](docs/data-and-recovery.md) |
| Public API and events | [Read](docs/api.en.md) | [公开 API 与事件](docs/api.md) |
| Compatibility and known limitations | [Read](docs/compatibility.en.md) | [兼容性与已知限制](docs/compatibility.md) |
| Testing and verification | [Read](docs/verify.en.md) | [测试与验证](docs/verify.md) |

## Verification

Last checked on 2026-10-20: the regression suite has 36 passing tests using production repositories/codecs, in-memory SQLite, domain services, failure injection, and event ordering. Minecraft and economy boundaries are substituted. Type checking and ESLint pass. Real BDS scenarios have not been verified.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test
```

## Boundaries

Pistons, fluids, and fire spread are unprotected. Spawn denial removes registered hostile entities after spawning. Explosion flags filter block impacts, not all entity damage. Public write services trust caller-supplied `actorId` and are for trusted integrations; they do not authenticate player delegation. Custom flags need their own consumers. Economy and SQLite have no distributed transaction. See [compatibility and limitations](docs/compatibility.en.md).
