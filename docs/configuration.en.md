# Configuration, quotas, and economy

[中文](configuration.md) · [Index](README.md)

Source configuration: [configs-default/land.json](../configs-default/land.json). The server reads `configs/land.json` through the platform config key `land` during module initialization. Reload/restart after editing; there is no live listener. Use snake_case configuration keys.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `locale` | `zh` | Default language (en or zh); the player preference wins. |
| `claim_price` | `50` | Base price per chunk, charged to the creator/claiming actor. |
| `unclaim_refund_ratio` | `0` | Unclaim refund fraction, clamped to 0–1; based on the current level price. |
| `teleport_price` | `0` | Teleport price transferred from player to land bank; zero is free. |
| `teleport_cooldown_ms` | `10000` | Cooldown after a successful teleport, milliseconds. |
| `max_batch_chunks` | `48` | Maximum fresh claims in one batch; the total land cap still applies. |
| `upkeep_period_ms` | `86400000` | Upkeep period in milliseconds; minimum 60000. |
| `upkeep_base` | `10` | Base upkeep per land per period. |
| `upkeep_per_chunk` | `2` | Upkeep per chunk per period. |
| `grace_period_ms` | `259200000` | Grace after first failed settlement, three days by default. |
| `freeze_after_grace` | `true` | Freeze an unpaid land after grace; never auto-delete it. |
| `wilderness_protected` | `false` | Default-deny player world actions in wilderness; not a blanket environmental protection. |
| `ban_eject` | `false` | On scans, return banned players to a recorded wilderness position; reactive. |
| `border_radius_chunks` | `2` | Particle scan radius in chunks. |
| `border_interval_ticks` | `40` | Border particle interval; minimum 10 ticks. |
| `border_particle` | `"minecraft:endrod"` | Particle ID for the target land outline; an empty string falls back to the default. |
| `border_other_particle` | `"minecraft:basic_flame_particle"` | Particle ID for nearby other lands; an empty string hides other lands. |
| `border_step_blocks` | `2` | Spacing between particles along an outline, in blocks; minimum 0.5. |
| `border_heights` | `[0.2, 1.6]` | Outline heights relative to the player's feet; several values draw a low wall. |
| `border_post_height` | `3` | Corner post height in blocks; 0 disables corner posts. |
| `border_post_step` | `0.5` | Vertical spacing on corner posts; minimum 0.25. |
| `border_max_particles` | `800` | Maximum border particles per player per round; the target land is kept first. |
| `scan_interval_ticks` | `20` | Presence scan interval; minimum 5 ticks. |
| `scheduler_interval_ticks` | `6000` | Upkeep/tax/expiry/recovery schedule interval; minimum 200 ticks. |
| `quotas.lands` | `3` | Base ownership cap per player. |
| `quotas.chunks / members / areas / roles` | `16 / 10 / 8 / 8` | Compatibility fields; actual per-land caps come from levels, so changing only these is ineffective. |
| `levels` | `见下表 / below` | Per-level capacity, cost, conditions, and rewards. |
| `quota_groups` | `[]` | Increase caps through named platform permissions; never reduce base level caps. |
| `messages` | `{}` | Override templates by zh/en and message key. |

At 20 TPS, 20 ticks is roughly one second and 6000 ticks is five minutes. Tick-based work is delayed when the server slows; due times use wall-clock milliseconds.

## Levels and limits

| Level | Chunks | Members | Areas | Roles* | Claim multiplier | Upkeep multiplier | Upgrade cost | Min chunks / members | Bank reward |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 16 | 10 | 8 | 8 | 1 | 1 | 0 | 0 / 0 | 0 |
| 2 | 32 | 20 | 16 | 12 | 1.25 | 1.1 | 500 | 8 / 1 | 0 |
| 3 | 64 | 40 | 32 | 16 | 1.5 | 1.25 | 2000 | 24 / 3 | 100 |

*Roles count all non-reserved roles, including the initial member and visitor templates. With the default level-one cap of 8, those two consume two slots. Members count admin/member/trusted relations; pending invitations do not count. A normal area excludes the default area.

Ownership uses `quotas.lands`; chunk/member/area/role capacity uses the current entry in `levels`. Missing level entries fall back to the first rule. Configure finite non-negative values and unique increasing levels; the parser does not comprehensively validate level/group constraints.

## Permission-based increases

```json
{
  "quota_groups": [
    { "permission": "land.quota.operator", "level": 2, "lands": 10, "chunks": 128 }
  ]
}
```

The module registers the named permission at the given platform level (default Member/1). Multiple matching groups take the maximum cap. Levels follow the platform constants: 0 Any, 1 Member, 2 OP, 3 Admin. Capacity checks use the actor performing the operation, not always the owner; an invitee accepting an invitation is also an actor. This is not a per-player UUID allowlist.

## Prices and upkeep

```text
chunkPrice = max(0, round(claim_price × level.claim_price_multiplier))
claimCost = chunkPrice × newChunkCount
unclaimRefund = round(chunkPrice × unclaim_refund_ratio) × releasedChunkCount
upkeep = max(0, round((upkeep_base + upkeep_per_chunk × claimedChunks) × level.upkeep_multiplier))
```

Amounts use integer economy units. Default prices are 50/63/75 per chunk at levels 1/2/3. Creation uses the first configured level multiplier. Expanding charges the acting player; upgrade and upkeep charge the land bank. Releasing claims refunds the acting player using the current price, not historical purchase cost.

A failed due settlement makes an active land delinquent and records a grace deadline. After grace it may become frozen. No automatic land deletion occurs. The owner is allowed before freeze checks; do not interpret frozen as a universal owner lockout. `upkeep_pay` retries a due/debt period and skips an active future period. Offline time is not replayed as one charge per missed period; successful settlement schedules the next period from the settlement time.

## Taxes, rentals, and sales

Tax defaults off. `tax_set` enables a positive amount and charges each admin/member/trusted member into the bank at the chosen period. Failure records an event and does not kick the member; the period still advances. Rentals pay the bank. Whole-land and area purchases pay the current owner. Area purchase grants the member template only; it is not separate land ownership. Ending a lease has no prorated refund.

## Messages

```json
{
  "locale": "zh",
  "messages": {
    "zh": { "created": "已创建 {name}" },
    "en": { "created": "Created {name}" }
  }
}
```

Use existing keys and placeholders from [catalog.ts](../sapi/src/messages/catalog.ts). Player language preferences are persisted. `enter_text` / `leave_text` support `{land}`, `{area}` and `{owner}`; lands and sub-areas each read their own template and fall back to the global messages (`entered` / `left` / `entered_area` / `left_area`) when empty.

For a zero-price setup, set claim/upkeep/teleport prices to zero and review upgrade costs/rewards too. The manifest still requires economy and activity-log, and deletion always checks the bank.
