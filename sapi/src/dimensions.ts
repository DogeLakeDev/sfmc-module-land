/** 内置维度的可用方块高度。 */
export const DIMENSIONS: Record<
  string,
  { name: string; minY: number; maxY: number }
> = {
  "minecraft:overworld": { name: "主世界", minY: -64, maxY: 319 },
  "minecraft:nether": { name: "下界", minY: 0, maxY: 127 },
  "minecraft:the_end": { name: "末地", minY: 0, maxY: 255 },
};
