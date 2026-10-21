/**
 * 方块交互分类。
 * 保护事件先查这张表，再交给统一权限解析，避免在事件回调里堆特殊判断。
 */

/** 容器方块。彩色潜影盒用后缀识别。 */
const CONTAINERS = new Set<string>([
  "minecraft:chest",
  "minecraft:trapped_chest",
  "minecraft:barrel",
  "minecraft:ender_chest",
  "minecraft:hopper",
  "minecraft:dropper",
  "minecraft:dispenser",
  "minecraft:furnace",
  "minecraft:smoker",
  "minecraft:blast_furnace",
  "minecraft:brewing_stand",
  "minecraft:anvil",
  "minecraft:chipped_anvil",
  "minecraft:damaged_anvil",
  "minecraft:enchanting_table",
  "minecraft:beacon",
  "minecraft:cartography_table",
  "minecraft:grindstone",
  "minecraft:loom",
  "minecraft:stonecutter_block",
  "minecraft:smithing_table",
  "minecraft:crafter",
  "minecraft:decorated_pot",
  "minecraft:lectern",
  "minecraft:chiseled_bookshelf",
  "minecraft:shulker_box",
]);

/** 明确的红石机关。按钮和压力板另按后缀识别。 */
const REDSTONE = new Set<string>([
  "minecraft:lever",
  "minecraft:repeater",
  "minecraft:comparator",
  "minecraft:daylight_detector",
  "minecraft:daylight_detector_inverted",
  "minecraft:tripwire_hook",
  "minecraft:note_block",
  "minecraft:jukebox",
  "minecraft:bell",
  "minecraft:sculk_sensor",
  "minecraft:calibrated_sculk_sensor",
]);

/**
 * 玩家右键方块时需要的权限。
 * 未单独分类的方块走 block.interact，例如床和重生锚。
 */
export function permissionForBlock(typeId: string): string {
  if (CONTAINERS.has(typeId) || typeId.endsWith("_shulker_box")) return "container.open";
  if (typeId.endsWith("_door") || typeId.endsWith("_trapdoor") || typeId.endsWith("_fence_gate")) return "door.use";
  if (REDSTONE.has(typeId) || typeId.endsWith("_button") || typeId.endsWith("_pressure_plate")) {
    return "redstone.interact";
  }
  return "block.interact";
}
