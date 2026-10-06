import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "@minecraft/server" ||
    specifier.startsWith("@sfmc-bds/sdk/")
  ) {
    return {
      url: new URL("./rental-mocks.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (
    specifier.startsWith(".") &&
    specifier.endsWith(".js") &&
    context.parentURL?.startsWith("file:")
  ) {
    const target = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(target)))
      return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}
