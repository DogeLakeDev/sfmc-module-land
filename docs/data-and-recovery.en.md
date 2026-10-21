# Data model, migration and recovery

[中文](data-and-recovery.md) · [Documentation](README.md)

Persistence uses SDK database services. Names below are logical table names; physical paths, prefixes and backup mechanisms belong to SFMC. This module does not maintain a second JSON-file source of business data.

## Tables and relationships

All tables disable soft deletion. The primary key is `id`, except `player_id` in the identity table. Composite business uniqueness uses string keys rather than SQL foreign keys.

| Table | Contents | Unique key / main relationship |
| --- | --- | --- |
| `land2_land` | Name, owner, status, level, description, spawn, financial timestamps, metadata | Globally unique `name_key`; indexed `owner_id` |
| `land2_claim` | Dimension and chunk X/Z ownership | Unique `claim_key`; indexed `land_id` |
| `land2_area` | Default area or dimension-specific AABB | Unique `area_key = landId\|nameKey` |
| `land2_role` | Stable role ID, name, permission array, preset key, reserved flag | Unique `role_key = landId\|nameKey` |
| `land2_member` | Player relation and land role | Unique `member_key = landId\|playerId` |
| `land2_area_role` | Player's area role override | Unique `assign_key = areaId\|playerId` |
| `land2_flag` | Land/area flag value | Unique `flag_key = scope\|scopeId\|flagId` |
| `land2_tx` | Money mode, accounts, amount, payload, status, error, economy transaction ID | Unique `idempotency_key`; status/land/time indexes |
| `land2_lease` | Tenant, area, price, period, start/end, status | Area/land/tenant/end/status indexes |
| `land2_listing` | Land/area sale/rental listing, price, seller, status | Target/land/status indexes |
| `land2_registry` | Extensions, subscriptions, locale records | Unique `item_key = kind\|key` |
| `land2_identity` | Known player ID, name and normalized name | Primary `player_id`; name indexes |
| `land2_reward` | Local completion marker for upgrade rewards | Unique `reward_key = landId\|level\|rewardId` |

Permission arrays, flag values, metadata and transaction payloads use JSON text in database cells. Domain services validate references. No foreign keys or SQL uniqueness constraint express “one active lease per area”; business checks, the queue and transactions enforce these rules.

Land statuses are `active / delinquent / frozen`, lease statuses `active / ended / expired`, and listing statuses `open / sold / closed`. Default areas have no ordinary AABB. Area-role overrides reference a role in the same land. See [permissions](permissions.en.md) and [areas](areas.en.md).

## Money and the local ledger

The land bank account is `land:<landId>`. Its balance belongs to the economy module, not `land2_land`. Ledger money modes are `none / debit / credit / transfer`.

| State | Meaning |
| --- | --- |
| `pending` | Intent saved; the economy call may be unexecuted or executed without a saved acknowledgement |
| `debited` | Economy step confirmed; local business application remains |
| `applied` | Local application completed; some operations also check whether that effect still exists |
| `refunding` | Compensation in progress and eligible for recovery |
| `refunded` | Compensation completed |
| `failed` | Terminal failure, outside the periodic replay set |

The normal path is `pending → debited → applied`; zero-value operations also use ledger logic. Compensable failures enter refund handling. An economy failure and an exception after business commit require different handling.

A stable base key can receive `#` revisions. Recovery checks actor, accounts, amount and mode. Completed transactions are checked against world state so that a historical claim does not satisfy a later claim after release. Economy services must durably deduplicate keys.

### Guarantees and limits

- Purchases commit ownership/area entitlement, sold listing and success marker together. Whole-land transfer retains the bank and leases and makes the former owner an administrator. Area sales grant the area member role only.
- Rentals commit lease, listing closure, tenant override and success marker together. Recovery can complete older partial states containing only a lease.
- Termination/expiry changes lease status and removes the tenant-preset override atomically. Failures remain retryable. Scans also inspect old ended records for leftover tenant overrides; an override manually changed to another role is retained.
- Once an upgrade level is durable, reward failure does not cause a refund. Reward callbacks can repeat; consumers must durably deduplicate `idempotencyKey`.
- Deposit/withdraw command keys contain time. Re-entering a command after a crash is a new request and may move money again; inspect balances and the ledger first.
- A paid teleport may fail at the Minecraft teleport step; no automatic refund covers that failure.
- There is no durable event outbox. Recovery does not guarantee replay of every original after notification; consumers should reconcile on startup.

## Recovery timing

Startup defines tables and hydrates indexes, extensions and subscribers. It does not immediately replay all unfinished transactions. The periodic scheduler defaults to 6000 ticks and attempts upkeep/tax, lease expiry and then transaction recovery. Wall-clock delay depends on tick speed.

Recovery selects `pending / debited / refunding`, rereads each record inside the write queue and continues by kind and persisted payload. Reported counts include attempts and caught failures, not just successful repairs. Inspect logs and final state.

## Admin investigation

Back up first and investigate a test copy. These commands require `land.admin`:

```text
/c:land admin_diag
/c:land admin_tx
/c:land admin_diag Home
/c:land admin_repair Home confirm
/c:land admin_tx Home
```

| Tool | Scope |
| --- | --- |
| `admin_diag [land]` | Read-only checks for default area, area coverage/overlap, member role references, orphan claims |
| `tx [land]`, `admin_tx [land]` | First 20 non-applied records, including failed/refunded; no single-record lookup or pagination |
| `admin_repair [land] confirm` | Removes selected orphan claims, adds missing default areas, attempts transaction recovery; lease expiry scanning remains global |

Overlap diagnostics currently omit a dimension filter and can flag areas in different dimensions; area creation itself distinguishes dimensions. Repair does not reshape overlaps, reconstruct arbitrary roles, reconcile economy balances or force ledger states. No-argument `admin_repair` currently also runs repair, so it does not enforce a mandatory second confirmation. These tools require a ready index; initialization failures need platform/database investigation first.

Do not delete ledger records or mark them applied merely to remove an alert. Compare payloads, economy records, actual ownership, leases and grants before choosing recovery. There is no public force-complete/refund-one-transaction API.

## Migration

The module does not read, rewrite or import the legacy 0.2 `sfmc_lands` table. Old rentals cannot be equated with new ownership. A historical import needs a separate tool with explicit mapping, backup and reconciliation; this repository does not provide it.

For existing `land2_role` data without `preset`, SDK table definition adds the column. Decoding uses a saved preset, then an unchanged template display name, then a unique permission-set match for a reserved role. A reserved role with both name and permissions changed may be unidentifiable; transfer/rental can report `role_not_found`. Verify its original meaning and back up before restoring the appropriate `admin/member/visitor/tenant` preset through database maintenance.

`manifest.schemaVersion: 2` versions the manifest format, not the business database. There is no separate database version table or full migration journal.

## Deletion and backups

Deletion requires a zero bank balance, no active lease, no open listing and no unfinished transaction. It hard-deletes the land, claims, areas, roles, relationships, area grants, flags, leases and listings. Transaction, reward, registry and identity records remain. It does not delete the economy account.

Pause writes or stop the server and back up the SFMC database, module configuration, BDS world and the economy module's authoritative storage together. Restoring Land tables alone can mix money movement and business state from different times. Validate a restored test copy with diagnostics, bank/player balance checks, protection and lease checks; see [verification](verify.en.md).
