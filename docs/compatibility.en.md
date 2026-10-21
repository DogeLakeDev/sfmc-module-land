# Compatibility and known limitations

[中文](compatibility.md) · [Documentation](README.md)

Checked on 2026-10-20. API capabilities and module coverage are distinguished below. Compilation and simulated tests do not establish live-server compatibility; all actual BDS results remain pending.

## Version baseline

The project pins `@minecraft/server 2.11.0-beta.1.26.51-stable`, server-net 1.0.0-beta.11940b24, server-ui 2.3.0-beta.1.26.51-stable and vanilla-data 1.26.51. The SDK development range is ^0.5.0, peer range >=0.5.0, and local lockfile baseline 0.5.0.

These are dependency versions, not a guarantee for arbitrary BDS releases. Verify required events, multi-argument commands, BDS build, script modules and experiment settings in the deployment environment. Official experimental API pages evolve; compare them with the lockfile and installed types.

## Protection matrix

Fully Supported refers only to the narrow implemented event path. Partially Supported indicates gaps or after-event handling. Unsupported means this module has no implementation. Live-server verification is **pending for every row**.

| Behavior | Implementation status | Current handling and boundary |
| --- | --- | --- |
| Direct player block breaking | Fully Supported (event scope) | Cancels playerBreakBlock after checking block.break at its target; not all indirect destruction |
| Direct player block placement | Fully Supported (event scope) | Checks block.place at the event block; multi-block structures and cross-boundary effects need testing |
| Doors, containers, blocks, redstone interaction | Partially Supported | Maps block types to permissions and cancels direct interactions; not a universal container/automation/signal boundary |
| Direct player/entity interaction | Fully Supported (event scope) | Checks entity.interact at the target entity |
| Player attacks and PvP | Partially Supported | Checks player damagingEntity and target position. Disabled PvP rejects direct player-to-player damage before role checks; enabled PvP still needs entity.attack. Complete projectile/pet/indirect coverage is unproven |
| Explosion-impacted blocks | Fully Supported (event scope) | Filters each block using explosion; does not cancel every explosion effect |
| Explosion entity damage | Partially Supported | The explosion flag filters blocks only; the damage adapter separately handles player sources, without a complete explosion-damage guarantee |
| Disabling hostile spawning | Partially Supported | Removes registered types after entitySpawn; entities can appear first, and custom types require registration |
| Banned-player movement/entry | Partially Supported | Movement is not canceled; optional ban_eject attempts a later teleport, off by default |
| Pistons, fluid flow, fire spread | Unsupported | No corresponding protection handler |
| Automated transfer, pressure plates, cross-boundary side effects | Unsupported / unverified | No general propagation/automation model; direct-interaction cancellation does not establish coverage |

Official [placement](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/playerplaceblockbeforeevent?view=minecraft-bedrock-experimental), [block interaction](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/playerinteractwithblockbeforeevent?view=minecraft-bedrock-experimental) and [entity interaction](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/playerinteractwithentitybeforeevent?view=minecraft-bedrock-experimental) references describe cancellation for those events. Canceling an event does not cover every game mechanism related to that action.

The [hurt before event](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/entityhurtbeforeevent?view=minecraft-bedrock-experimental) exposes cancellation; the [explosion before event](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/explosionbeforeevent?view=minecraft-bedrock-experimental) exposes an impacted-block setter; [entity spawn](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/entityspawnafterevent?view=minecraft-bedrock-experimental) is an after event. Coverage assessments combine these APIs with this module's handlers; they are not Microsoft certification of the module.

## Startup, wilderness and administration

While the index is unready, break/place/block/entity interactions are rejected. Hurt and explosion callbacks cancel every corresponding event, beyond known land boundaries. The spawn handler skips unready state. Investigate initialization failures promptly to avoid remaining in startup protection.

wilderness_protected affects generic location checks. The hurt adapter returns for targets outside a land, and the explosion adapter keeps wilderness blocks; this setting does not prohibit all wilderness damage and explosions.

Owners pass permission resolution before bans/freezing. Server administrators need land.admin and explicit admin_bypass for world actions. Disabled PvP is checked before role/bypass resolution. The in-memory bypass set is not cleared by offline scanning; use admin_bypass off when needed.

## Other limitations

- Command interface only; no form GUI, nations, warfare or diplomacy.
- Areas are nonoverlapping AABBs without nesting. Border display uses nearby chunk-corner particles rather than a 3D wireframe.
- leave_text is registered/stored but unused. Land entry/exit switches and area messages are not identical.
- No automatic visitor role. Permission management has no role hierarchy or grant ceiling; member.manage/role.manage holders must be trusted.
- Write APIs trust actorId. Flag registration installs no behavior, and custom quotas are not enforced by core limits. See [API](api.en.md).
- No cross-database economy transaction. Reissued deposits/withdrawals, paid teleport failures and reward retries have documented boundaries in [recovery](data-and-recovery.en.md).
- After events have no durable replay guarantee; sampled scans can miss short crossings. Consumers need reconciliation.
- No automatic legacy rental migration. Cross-dimension overlap diagnostics can produce false positives; repair scope is limited.
- No load-test conclusion, minimum TPS or player-capacity promise.

Use [verification](verify.en.md) to record the actual BDS version, configuration, actions and results before deployment.
