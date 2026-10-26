# Public API and events

[中文](api.md) · [Documentation](README.md)

The SDK service bus exposes these **23 services**. Manifest schemas currently declare object inputs/outputs only; this page documents the implemented contract. Do not bypass validation by importing internal service files.

## Integration and identity boundary

Declare module dependencies, service permissions and required services in the consumer manifest. Merge this fragment into a complete SAPI manifest:

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

Use the platform-bound `ServiceClient` after module initialization and Land availability. Declare equivalent permissions for every other service used. Callback services must be provided by the consumer, and Land must have platform permission to call them. Registration does not grant service access.

**Write services trust the caller's nonempty actorId. They do not authenticate it as the logged-in requester or require the player to be online.** Online lookup supplies the name and checks land.admin; an input admin field has no effect. Consumers must obtain IDs from authenticated sessions/player events rather than forward client-declared IDs. Registry and subscription services also belong to the trusted-module boundary.

Command confirmation tokens are not API inputs. Delete and role-delete calls execute after domain checks; consumers own their user confirmation flow.

## Shared types and inputs

`?` means optional. Identifiers/names are strings unless specified otherwise. Writes accept a land name or ID in land, taking precedence over landId; supply one. Supported role/area parameters accept names or IDs. Prefer stable IDs.

Use finite coordinates and integer chunkX/chunkZ. Use the canonical player's dimension.id, such as minecraft:overworld. Dimension aliases are not uniformly normalized for storage; do not mix overworld and minecraft:overworld.

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

These are consumer-side example types, not a separately exported API type package. land.get spawn/metadata may be internal references on the local bus; treat them as read-only.

## Read services

| Service | Input | Output |
| --- | --- | --- |
| land.here | `{dimensionId,x,y,z}` | `{found:false}` or the located result below |
| land.get | `{name? , landId?}` | `LandView` |
| land.list | `{ownerId?}` | `{lands:LandSummary[]}` |
| land.map | `{dimensionId?}` | `{lands:MapLand[]}` |
| land.permission | `{playerId,dimensionId,x,y,z,permission}` | `Decision` |

A located result is `{found:true,landId,landName,ownerId,areaId,areaName,specific,status}`. specific distinguishes a box area from the default area. areaId here is the actual default-area ID. name takes precedence over landId in land.get. land.list is not paginated.

land.map is meant for web maps and other displays. It returns every land's claimed chunks and the horizontal extent of its box areas, sorted by land ID and not paginated. With dimensionId it keeps only that dimension and skips lands that have no chunks or areas there. Members, roles, flags and bank data are not included. Area coordinates are **inclusive** block coordinates (the internal half-open max minus 1):

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

Decision.allow is final and agrees with effect. resolution:inherit means an area fell back to a land role, not an independently allowed third result. Reasons are `not_ready, bypass, wilderness, wilderness_protected, owner, banned, frozen, delinquent, role_grant, role_deny`.

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

This example performs one query. Recheck before a real action according to the consumer's event and concurrency model. It does not replace PvP/explosion flag checks in the built-in adapters.

## Write services

| Service | Input | Success |
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

- land.create creates and claims the first chunk at the supplied position, subject to price and quota. It does not require the actor to stand there.
- land.claim accepts one chunk and returns the number newly claimed.
- land.role.assign takes the stable ID of an existing eligible member, without name lookup. The playerId field of land.member.invite uses known-player resolution and can accept a recognized name or ID; unknown offline players fail.
- Deleting a referenced role needs a replacement in the same land. Reserved roles cannot be deleted.
- land.flag.set value must be a **string**, such as `"false"` or `"10"`, not a JSON boolean/number. Omitting area sets a land flag; an area input is checked against the flag scope.

There is no public unclaim, area CRUD, clear-area-override, member-list or flag-query service. Command coverage is wider than API coverage.

## Extension and subscription services

All return `{ok:true}` on success. Registrations/subscriptions persist across restarts.

| Service | Input | Meaning |
| --- | --- | --- |
| land.registry.permission | `{id,description}` | Registers an ID; consumers implement action checks. |
| land.registry.flag | `FlagDef` | Stores a definition; no arbitrary validator or enum constraint. |
| land.registry.quota | `{id,limit:number,usageService?}` | Records a custom quota; not enforced by core operations and no public query endpoint. |
| land.registry.condition | `{id,service}` | Registers a pre-upgrade condition service. |
| land.registry.reward | `{id,service}` | Registers a post-level-update reward service; receiver must deduplicate. |
| land.registry.hostile | `{typeId}` | Adds a type to the post-spawn removal set used when mob_spawn is false. |
| land.event.subscribe | `{event,target}` | Persists an exact-event subscription, deduplicated by event and target. |
| land.event.unsubscribe | `{event,target}` | Removes that subscription. |

Use a module prefix to avoid collisions. Permissions have no separate ownership namespace. Flag re-registration cannot change an existing type, but can overwrite definitions of the same type. Only the basic types/scopes above are supported; kind does not install protection behavior.

Condition services receive `{landId,targetLevel,conditionId}` and should explicitly return `{ok:true}` or `{ok:false,reason}`. Unavailable/throwing conditions block upgrade. An empty object currently does not fail; do not rely on that permissiveness.

Reward services receive `{landId,level,rewardId,idempotencyKey}`, with keys shaped as `reward:<landId>|<level>|<rewardId>`. Land records completion after a normal return; it does not inspect an ok field. Throw on failure. Lost acknowledgements cause retries, so receivers must durably deduplicate.

## Subscriptions

Event names match exactly, without wildcards. Callbacks receive `{event,phase,...payload}`. Before callbacks can reject with `{ok:false,reason}`; after callbacks cannot undo commits. Use the names below; the source comment describing a .before suffix does not match actual names.

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

The returned cleanup removes only the current process's callback handler. The subscription persists. To permanently stop it, call land.event.unsubscribe while the callback is still available. Re-provide handlers on module load; repeating subscribe does not duplicate an event/target pair.

### Before events

| Event | Payload fields |
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

land.before.area covers creation only; land.before.member covers invitation only. Do not assume equivalent before hooks for every related mutation. Missing services, timeouts and ordinary exceptions are logged and allow the operation to continue. These hooks are not a mandatory security gate.

Some callbacks are awaited inside the write queue. Do not await another Land write inside them; return first and schedule follow-up work separately.

### After events

| Event | Main payload fields |
| --- | --- |
| land.created | `actorId, actorName, landId, name` |
| land.deleted | `actorId, landId, name` |
| land.claimed / land.unclaimed | `actorId, landId, count` |
| land.area.changed | `actorId, landId, areaId, op:"create"\|"resize"\|"delete"` |
| land.transferred | `actorId, landId, to` |
| land.member.changed | `landId, playerId` plus operation-dependent fields |
| land.permission.changed | See below |
| land.flag.changed | `actorId, landId, areaId, flag` |
| land.upkeep.paid / land.upkeep.delinquent / land.upkeep.frozen | `actorId, landId, amount` |
| land.tax.failed | `landId, playerId, message` |
| land.upgraded | `actorId, landId, level` |
| land.lease.started | `actorId, landId, areaId, leaseId` |
| land.lease.ended | `landId, areaId, playerId, status:"ended"\|"expired"` |
| land.sale.completed | `actorId, landId, listingId` |
| land.entered / land.left | See below |

Additional member/permission fields depend on the operation, and actorId is not always present. Permission changes may include `playerId,roleId,permission,granted,areaId,relation,revokedAreaIds`. Role deletion/replacement includes `op:"role_deleted",replacementRoleId,playerIds,areaIds`. Invalidate by landId and check optional fields before finer handling.

Land-level flag changes use an empty areaId. Area rename/description changes currently emit no land.area.changed event. After notifications attempt activity.record first, then subscribers. Failures are logged. There is no durable retry queue, global ordering or exactly-once delivery guarantee; reconcile from current state rather than treating events as a complete database.

### Presence

Scopes are `{landId,areaId}`. **Presence uses an empty areaId for the default area, unlike land.here/Decision, which return its actual ID.**

- entered: `{playerId,landId,areaId,fromLandId,fromAreaId,reason}`.
- left: `{playerId,landId,areaId,toLandId,toAreaId,reason}`.
- reason is movement or offline. First observation inside a land emits entered; going offline emits one left.
- Adjacent lands or areas in one land emit left before entered, ordered per player observation. Default scans are 20 ticks apart and can miss brief crossings.

## Errors

Business failures throw SDK ServiceError with code, status and message. Branch on code rather than localized text. Land currently renders API errors in Chinese: no_permission maps to 403, keys ending in not_found to 404, internal to 500, and other business errors to 409, including not_ready. Platform authorization, availability and network errors can also occur.

Success objects are not a unified error envelope; failures do not consistently return ok:false. Consult [ledger boundaries](data-and-recovery.en.md) before retries, particularly for time-keyed deposit/withdraw commands.
