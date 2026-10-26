# Chunks and three-dimensional areas

[中文](areas.md) · [Index](README.md)

## Claims define ownership

A claim is `(dimensionId, chunkX, chunkZ, landId)`. The lookup key is `dimensionId|chunkX|chunkZ`, with a database uniqueness constraint on claim_key. Lands may be disconnected and span dimensions. Their claims cover the full vertical space; a land is not one enclosing box.

```text
chunkX = floor(blockX / 16)
chunkZ = floor(blockZ / 16)
```

| Block X/Z | Chunk |
| --- | --- |
| -17 | -2 |
| -16 | -1 |
| -1 | -1 |
| 0–15 | 0 |
| 16 | 1 |

Pass the canonical ID returned by `player.dimension.id`/`dimension.id` to public services. Validating that getDimension accepts an alias does not normalize the stored claim key.

## Default and box areas

Every land has one boundary-free default area (`kind: default`, `box: null`). It handles claimed positions outside box areas. Its empty dimension field does not mean wilderness. A box area belongs to one land/dimension and has a 3D AABB. Ownership always comes from the enclosing chunk claims.

Stored bounds are half-open: include min, exclude max. Both selection endpoint blocks are included, so selecting block positions (0,60,0) and (15,69,15) stores min=(0,60,0), max=(16,70,16). Integer conversion floors each coordinate.

Two areas overlap only if all three axes have positive-length intersection. Touching a face, edge, or corner is allowed. Different dimensions never overlap for creation/resize. There is no nesting or priority layering; normal overlap is rejected.

## Complete footprint validation

For integer half-open bounds, each axis covers floor(min/16) through floor((max-1)/16). Every X/Z pair must be claimed by the same land. Testing only two corners would miss holes and is not used. A box [0,48) in X crosses chunks 0,1,2; owning 0 and 2 is insufficient. A box [0,16) touches chunk 1 at its boundary but does not include it.

Creation and resize recheck containment/overlap inside the write queue. Unclaim rejects any claim used by a box area and never permits the land’s final claim to be released. To shrink ownership, delete or resize dependent areas first.

## Selection workflow and limits

```text
/c:land area_pos1
/c:land area_pos2
/c:land area_create Home Store
/c:land area_info Home Store
/c:land area_member Home Store Alice Keeper
```

Both points use player position, not the block being looked at. Re-select both points after changing dimension: the current selection buffer has one dimension field and does not retain each point’s original dimension. Selection is in memory and must not be assumed durable across reloads. The current domain validates nonzero volume/claim coverage but has no separate dimension-height or maximum-volume policy.

`area_info` exposes stored bounds and dimension. `border` currently renders nearby land chunk outlines relative to the player’s height, not a box wireframe. There is no public area-bounds service or direct box-creation service; `land.here` returns only the effective area ID/name.

Sources: [geometry](../sapi/src/domain/geometry.ts), [territory](../sapi/src/services/territory.ts), [index](../sapi/src/cache/world-index.ts).
