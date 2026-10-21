# Installation and quick start

[中文](getting-started.md) · [Index](README.md)

## Installation

1. Install through the existing SFMC module workflow. The entry is `sapi/src/index.ts`, module ID `land`. The package `build` script only type-checks; the platform builds and loads the SAPI behavior pack.
2. Enable `economy`, `activity-log`, and the SFMC database service. The manifest still requires both modules with zero prices.
3. Merge fields from [land.json](../configs-default/land.json) into the server’s `configs/land.json`. Preserve operator settings. Missing legacy fields fall back to new defaults.
4. Reload the module or restart the server. Configuration is loaded in `init()`; there is no live configuration listener.
5. Look for `ready lands=<count> claims=<count>` and run `/c:land help`. While initialization is incomplete, protected player actions are denied and damage/explosions are cancelled.

Installation is not an in-game verification. Use separate owner and visitor accounts with the [verification guide](verify.en.md).

## Create and expand

```text
/c:land create Home
/c:land info Home
/c:land deposit Home 100
```

Creation claims the current 16×16 chunk across its full vertical space and sets the spawn point. It costs 50 from the player account by default. One chunk costs `10 + 2 × 1 = 12` per day in upkeep, paid from `land:<landId>`. Creation does not fund that bank.

Move to another unclaimed chunk before expanding:

```text
/c:land claim Home
/c:land map
/c:land border Home
/c:land border_stop
```

Claims need not be adjacent and may span dimensions. A level-one land has a default cap of 16 chunks, including the initial claim.

## Members

```text
/c:land invite Home Alice
```

Alice accepts with `/c:land accept Home`. The default invitation uses the member template; pending invitations do not grant land permissions. Targets may be online names, stable player IDs, or previously recorded offline identities. An unknown offline name cannot be resolved.

```text
/c:land kick Home Alice confirm
```

## A three-dimensional area

Stand at each corner in the same dimension:

```text
/c:land area_pos1
/c:land area_pos2
/c:land area_create Home Store
/c:land area_info Home Store
```

Selection uses player position, not the crosshair block. Both endpoint blocks are included and converted to `[min,max)` bounds. Every chunk in the horizontal footprint must belong to Home. See [areas](areas.en.md).

```text
/c:land role_create Home Keeper
/c:land role_grant Home Keeper container.open
/c:land area_member Home Store Alice Keeper
```

An area role replaces the whole land role. Keeper does not automatically inherit the member template’s building permissions.

## Release and deletion

```text
/c:land unclaim Home confirm
/c:land delete Home confirm
```

Unclaim releases the current chunk. The last claim and claims used by an area cannot be released. Refunds default to zero. Deletion requires an empty bank, no active leases/open listings, and no pending transaction. Resolve the reported blocker instead of deleting database rows. Transfer retains the former owner as a land administrator.
