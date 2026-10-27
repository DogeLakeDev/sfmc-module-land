# Permissions, roles, and flags

[中文](permissions.md) · [Index](README.md)

## Two permission systems

Platform permissions `land.use` (Any) and `land.admin` (OP) govern entry and server administration. Per-land roles use operation IDs such as `block.break`; a role named Administrator does not grant platform OP. Ownership is the separate `ownerId` relation and cannot be assigned or revoked through role edits.

World-action bypass requires `land.admin` plus `/c:land admin_bypass`; use `admin_bypass off` to disable it. Ownership-sensitive deletion/transfer also permit a directly authorized server administrator independently of that session flag. The flag is in memory and is not cleared by the presence logout scan; explicitly disable it after use and do not rely on reconnecting to reset it.

## Resolution order

1. If the index is not ready, deny.
2. A server administrator with the explicit bypass is allowed.
3. Locate the chunk claim by dimension and X/Z. Wilderness follows `wilderness_protected`.
4. Find a containing box area, or the land’s boundary-free default area.
5. The owner is allowed, before bans/freeze checks.
6. A banned member is denied. Frozen lands deny recognized world actions for non-owners; non-active lands deny further claims.
7. A matching area role replaces the land role. Without an override, use the existing land member’s role.
8. Non-members (including pending invitees) fall back to the area's "everyone" override (`@public`), then the land's public role (preset `public`). The public role applies only to world actions (`block.*`, `entity.*`, `container.open`, `door.use`, `redstone.interact`) and never grants management permissions. Banned players do not fall back.
9. Allow only when that role includes the requested permission; no usable role means deny.

`Decision.allow` is the final boolean. `effect` is allow/deny; `resolution` is inherit only for a box-area decision resolved from a land role, otherwise explicit. Inherit describes where the final decision came from; it never grants permission by itself. Reasons include not_ready, bypass, wilderness, wilderness_protected, owner, banned, frozen, delinquent, role_grant, and role_deny.

Flags have separate consumers. The generic player resolver does not apply every registered role/custom flag. For example the damage handler evaluates pvp first, then entity.attack_hostile for registered hostile mobs or entity.attack for other entities; explosion and mob_spawn do not need a player actor.

## Built-in operations

| Permission ID | Meaning |
| --- | --- |
| `block.break` | Break blocks |
| `block.place` | Place blocks |
| `block.interact` | Interact with uncategorized blocks |
| `container.open` | Open classified containers/workstations |
| `door.use` | Use doors, trapdoors, and fence gates (including the unprefixed oak `minecraft:trapdoor` and `minecraft:fence_gate`) |
| `entity.attack` | Player-caused damage to non-hostile entities (animals, villagers, armor stands, etc.) |
| `entity.attack_hostile` | Player-caused damage to registered hostile mobs |
| `entity.interact` | Interact with entities |
| `redstone.interact` | Interact with classified redstone controls |
| `land.manage` | Edit land settings, metadata, and spawn |
| `land.claim` | Claim and release chunks |
| `land.transfer` | Registered; ownership checks still govern transfers |
| `land.teleport` | Use land spawn teleportation |
| `member.manage` | Manage membership and role assignments |
| `role.manage` | Manage roles and their permissions |
| `flag.manage` | Set flags in the applicable scope |
| `area.manage` | Manage areas and their bounds |
| `bank.view` | View the land bank |
| `bank.deposit` | Deposit into the bank |
| `bank.withdraw` | Withdraw from the bank |
| `economy.manage` | Manage tax, upkeep, upgrades, rentals, and listings |

## Role templates and identity

| Template key | Initial name | Reserved | Initial grants |
| --- | --- | --- | --- |
| `admin` | 管理员 | true | All built-in operations except land.transfer. |
| `member` | 成员 | false | `block.break`, `block.place`, `block.interact`, `container.open`, `door.use`, `entity.attack_hostile`, `entity.interact`, `redstone.interact`, `land.teleport`, `bank.view`, `bank.deposit` |
| `visitor` | 访客 | false | `door.use`, `block.interact`, `entity.attack_hostile` |
| `tenant` | 租客 | true | `block.break`, `block.place`, `block.interact`, `container.open`, `door.use`, `entity.attack_hostile`, `entity.interact`, `redstone.interact` |
| `public` | 公共 | true | `entity.attack_hostile` (default for players outside the land; world actions only) |

Templates create independent role IDs in each land; the initial names remain Chinese even when the player selects English. Stable `preset` keys are used for invitation/transfer/rental flows. Renaming preserves grants. Reserved roles cannot be deleted; their names, descriptions, and permission sets can still be edited. The non-reserved member/visitor templates can be deleted; deleting a required template can make default invitation or area-purchase flows fail, so retain those template roles.

An unknown player is not assigned the visitor template; they use the land's public role (new lands only allow attacking hostile mobs). Use `area_member <land> <area> @public <role>` to give "everyone" a different role in one area. Lands created before this change have no public role and keep the old behaviour: strangers have no usable role. `trust` directly gives trusted membership and the visitor template by default; `invite` defaults to member after acceptance. Area grants may exist without land membership, but bans override them.

Custom roles start empty. Referenced roles require a same-land replacement before deletion, and assignments are moved transactionally. There is no role hierarchy or “can grant only permissions I already have” rule: member.manage and role.manage are powerful delegation privileges. Grant them only to trusted managers.

## Area-role example

```text
/c:land role_create Home Keeper
/c:land role_grant Home Keeper container.open
/c:land invite Home Alice
/c:land area_member Home Store Alice Keeper
```

Alice accepts the invitation with `/c:land accept Home`. Outside Store the land member role permits building. Inside Store, Keeper only permits container.open; building is denied. There is no command to clear an override back to inheritance alone; choose another role or use the supported member-revocation flow when appropriate.

## Flags

| ID | Type | Scope | Default | Consumer / limit |
| --- | --- | --- | --- | --- |
| `explosion` | `boolean` | `both` | `false` | Filter explosion block impacts, not all entity damage. |
| `mob_spawn` | `boolean` | `both` | `true` | Remove registered hostile entities after spawning when disabled. |
| `pvp` | `boolean` | `both` | `false` | Deny detected player-to-player damage; enabling it still requires entity.attack. |
| `public_teleport` | `boolean` | `land` | `false` | Allow public teleport, subject to cooldown, price, and ban checks. |
| `enter_message` | `boolean` | `both` | `true` | Control entry messages; set on a sub-area it only affects that sub-area (area value first, then land value). |
| `leave_message` | `boolean` | `both` | `true` | Control departure messages; resolved like `enter_message`. |
| `enter_text` | `string` | `both` | `空 / empty` | Entry template with {land}, {area} and {owner}; lands and sub-areas each use their own value, no inheritance. |
| `leave_text` | `string` | `both` | `空 / empty` | Departure template; same placeholders and rules as `enter_text`. |

Scope both means land or box area; land-only flags reject area writes. Box area values override land values, which override registered defaults. Boolean writes accept true/false/on/off; number values must be finite. Unknown flag writes are rejected. No value means fall back, not automatically allow.

The command layer cannot reset a stored value to inherit, and does not provide a general flag query/list. `perms` shows pvp/explosion summaries only. Registering a custom flag supplies its definition/storage, not a new protection listener or arbitrary validation function.

Sources: [resolver](../sapi/src/services/permission.ts), [registry and templates](../sapi/src/domain/permissions.ts), [flag writes](../sapi/src/services/flags.ts).
