# Command reference

[中文](commands.md) · [Index](README.md)

All syntax below follows `/c:land `. `<...>` is required, `[...]` optional, and `...` consumes the remaining string slots. The action accepts at most six following string arguments, including `confirm`. Commands require platform `land.use`.

Use names without spaces; land, area, and role names are 2–32 JavaScript string units and compared case-insensitively after trimming. Land/area/role tokens generally accept names or stable IDs within the appropriate scope. Player targets accept online names/IDs or recorded identities. Empty argument strings are discarded.

Canonical examples include an explicit land. Optional-land commands resolve the land under the player when omitted. `claim` in wilderness therefore needs an explicit land. Only some informational/administrative commands support console; location, selection, travel, create, transfer, and player-target commands need a player.

## General and land

| Syntax | Authorization | Behavior |
| --- | --- | --- |
| `help` | `land.use` | Show grouped help. |
| `create <land> [description...]` | `创建配额 / creation quota` | Create and claim the current chunk; creation cost is paid by the player. |
| `delete <land> confirm` | `领主或服务器管理员 / owner or server admin` | Delete the graph after bank/lease/listing/transaction checks. |
| `rename <land> <name>` | `land.manage` | Rename without changing the ID. |
| `describe <land> [text...]` | `land.manage` | Set or clear the description. |
| `info [land]` | `land.use` | Show a named/current land summary. |
| `here [land]` | `land.use` | Player position query; an explicit land is also accepted. |
| `list` | `land.use` | List lands owned by or related to the caller. |
| `transfer <land> <player> confirm` | `领主或服务器管理员 / owner or server admin` | Transfer ownership and retain the former owner as administrator. |
| `map` | `land.use` | Show a 7×7 chunk map around the player. |
| `near` | `land.use` | Alias of map. |
| `meta <land> <key> [value...]` | `land.manage` | Set string metadata; keys begin with a letter and allow alphanumerics/underscore, up to 32 characters. |
| `lang <zh\|en>` | `land.use` | Set the caller’s language; values other than en select Chinese. |

## Claims and spawn

| Syntax | Authorization | Behavior |
| --- | --- | --- |
| `claim [land]` | `land.claim` | Claim the current chunk; specify the land when standing in wilderness. |
| `unclaim [land] confirm` | `land.claim` | Release the current chunk, excluding the last claim or chunks used by areas. |
| `claim_rect <land>` | `land.claim` | Claim the chunk rectangle from both selection points, subject to batch and total caps. |
| `unclaim_rect <land> confirm` | `land.claim` | Release this land’s claims within the selection. |
| `spawn_set [land]` | `land.manage` | Set the spawn to the current position/rotation inside the land. |
| `spawn_show [land]` | `land.use` | Show the stored spawn. |
| `spawn_reset [land]` | `land.manage` | Use the first claimed chunk’s center with the caller’s Y/rotation. |
| `tp [land]` | `land.teleport / public_teleport` | Teleport subject to permission/public flag, cooldown, and price. |
| `border [land]` | `land.use` | Periodically show nearby land outlines as particle lines, layered walls and corner posts; other lands use another particle. |
| `border_stop` | `land.use` | Stop the caller’s border display. |

## 3D areas and flags

| Syntax | Authorization | Behavior |
| --- | --- | --- |
| `area_pos1` | `land.use` | Record player position as point 1. |
| `area_pos2` | `land.use` | Record player position as point 2. |
| `area_create <land> <area>` | `area.manage` | Create a box area from the selection. |
| `area_resize <land> <area>` | `area.manage` | Replace bounds from the selection and revalidate containment/overlap. |
| `area_delete <land> <area> confirm` | `area.manage` | Delete a box area unless an active lease/open listing blocks it. |
| `area_rename <land> <area> <name>` | `area.manage` | Rename a box area. |
| `area_describe <land> <area> [text...]` | `area.manage` | Set an area description. |
| `area_info <land> <area>` | `land.use` | Show kind, dimension, and half-open bounds. |
| `area_list [land]` | `land.use` | List default and box areas. |
| `area_member <land> <area> <player> <role>` | `member.manage` | Assign an area role override, including to a non-member. Use `@public`, `@all`, or `所有人` as player to set the area's public role for players outside the land (world interaction only). |
| `flag <land> <flag> <value>` | `flag.manage` | Set a land flag; this is not a query command. |
| `area_flag <land> <area> <flag> <value>` | `flag.manage` | Set a box area flag. |

## Members and roles

| Syntax | Authorization | Behavior |
| --- | --- | --- |
| `invite <land> <player> [role]` | `member.manage` | Invite using the member template unless a role is supplied. |
| `accept <land>` | `自己的待处理邀请 / own invitation` | Accept an invitation addressed to the caller. |
| `deny <land>` | `自己的待处理邀请 / own invitation` | Decline an invitation without revoking independent area grants. |
| `trust <land> <player> [role]` | `member.manage` | Grant trusted membership directly; default visitor template does not grant building. |
| `untrust <land> <player> confirm` | `member.manage` | Remove trusted membership and area overrides; active tenants are protected. |
| `kick <land> <player> confirm` | `member.manage` | Revoke membership and overrides, excluding owner/active tenant. |
| `ban <land> <player> confirm` | `member.manage` | Ban and revoke overrides, excluding owner/active tenant. |
| `unban <land> <player> confirm` | `member.manage` | Unban without restoring former membership. |
| `members <land>` | `land.use` | List the owner, relations, and roles. |
| `assign <land> <player> <role>` | `member.manage` | Change the land role of an existing non-invited, non-banned member. |
| `role_create <land> <role> [description...]` | `role.manage` | Create a custom role with no permissions. |
| `role_delete <land> <role> [replacement] confirm` | `role.manage` | Referenced roles need a same-land replacement; reserved roles cannot be deleted. |
| `role_rename <land> <role> <name>` | `role.manage` | Rename while preserving the role ID and template key. |
| `role_describe <land> <role> [text...]` | `role.manage` | Set a role description. |
| `role_grant <land> <role> <permission>` | `role.manage` | Add a registered permission. |
| `role_revoke <land> <role> <permission>` | `role.manage` | Remove a permission. |
| `role_list <land>` | `land.use` | List roles and their permissions. |
| `role_info <land> <role>` | `land.use` | Show role permissions; an unknown role may produce no output. |
| `perms` | `land.use` | Show the caller’s current role/relation and pvp/explosion values, not a complete permission dump. |

## Growth, banking, and upkeep

| Syntax | Authorization | Behavior |
| --- | --- | --- |
| `level [land]` | `land.use` | Show level and next upgrade cost. |
| `upgrade <land> confirm` | `economy.manage` | Upgrade using the land bank after chunk/member/extension checks. |
| `quota [land]` | `land.use` | Show built-in quota usage/caps. |
| `bank [land]` | `bank.view` | Read the land bank balance. |
| `deposit [land] <amount>` | `bank.deposit` | Transfer a positive integer from the caller to the bank. |
| `withdraw [land] <amount> confirm` | `bank.withdraw` | Transfer bank funds to the caller. |
| `upkeep [land]` | `land.use` | Show upkeep amount, due time, and status. |
| `upkeep_pay [land]` | `economy.manage` | Attempt a due/overdue settlement; an active future period is skipped. |
| `tax [land]` | `land.use` | Show member tax settings without charging. |
| `tax_set <land> <amount> [hours]` | `economy.manage` | Set member tax; zero disables it, default period 24 hours, minimum 60 seconds. |

## Rentals and sales

| Syntax | Authorization | Behavior |
| --- | --- | --- |
| `rent_publish <land> <area> <price> <hours>` | `economy.manage` | List a box area for rent with positive integer price and a period of at least 60 seconds. |
| `rent_cancel <land> [area]` | `economy.manage` | Cancel the target’s open listing. |
| `rent_take <land> <area>` | `非领主且未封禁 / non-owner, not banned` | Pay rent and receive a tenant area role; no confirm parameter. |
| `rent_renew <land> <area>` | `租客、领主或控制台 / tenant, owner, console` | Pay for another period and extend the end time; no auto-renewal. |
| `rent_end <land> <area> confirm` | `租客、领主或控制台 / tenant, owner, console` | End the lease and revoke its grant without prorated refunds. |
| `sell_area <land> <area> <price>` | `economy.manage` | Sell an area member-role grant, not land ownership. |
| `sell_land <land> <price>` | `领主或控制台 / owner or console` | List the whole land with empty bank and no active lease/open transaction. |
| `buy <land> [area] confirm` | `非当前领主 / not current owner` | Pay the owner for whole-land ownership or an area grant. |
| `unsell <land> [area]` | `economy.manage` | Cancel the target’s open listing. |
| `tx [land]` | `land.use` | List up to 20 non-applied transactions, including failed/refunded. |

## Administration

| Syntax | Authorization | Behavior |
| --- | --- | --- |
| `admin_bypass [off]` | `land.admin` | Enable the caller’s bypass; off disables it. |
| `admin_diag [land]` | `land.admin` | Diagnose default areas, containment/overlap, missing roles, and orphan claims. |
| `admin_repair [land] confirm` | `land.admin` | Perform limited repairs and transaction recovery, not arbitrary data repair. |
| `admin_tx [land]` | `land.admin` | List up to 20 non-applied transactions. |
| `admin_legacy [filter]` | `land.admin` | List up to 20 unbound legacy placeholder identities (`xuid:<XUID>`) with their land counts; filter by name or XUID. |
| `admin_legacy_bind <legacy XUID or name> <player> confirm` | `land.admin` | Move a placeholder's ownership, memberships, and area grants to the real player; the player's existing relations win and conflicting placeholder relations are dropped. |

## Confirmation and observable limits

The final literal `confirm` is a deliberate command acknowledgement, not a preview token or two-step transaction ID. `admin_repair` currently also runs without arguments because the router inserts confirmation; use the explicit documented form. Public write services do not have this command confirmation layer.

`flag`/`area_flag` only write values; there is no flag-list/reset command. There is no command to remove an area-role override alone. `perms` is a summary, and `border` shows nearby land chunk outlines, not 3D area wireframes. `map` draws every cell as `■` and distinguishes them only by color: yellow is the player's center cell, green is other chunks of the land under the player, red is other claims, and gray is wilderness. Override the cells through the `messages` keys `map_cell_self`, `map_cell_here`, `map_cell_other` and `map_cell_wild`; an override of `map_title` must keep `{rows}`, which is replaced by the map rows.

Ownership checks for deletion/transfer remain stricter than granting `land.transfer` to a role. Some server-admin business actions do not require the session world-protection bypass. See [permissions](permissions.en.md) and [known limitations](compatibility.en.md).

Source: [router.ts](../sapi/src/commands/router.ts).
