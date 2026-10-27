import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * True when the module is the process entry script.
 *
 * `moduleName` is the module's own file name without extension. It guards
 * bundled builds: inside a bundle every module shares the bundle's
 * `import.meta.url`, so the URL alone would make an imported module (for
 * example a local server) believe it was launched directly.
 */
export const isMainModule = (metaUrl: string, moduleName: string): boolean => {
  const entrypoint = process.argv[1];
  return (
    typeof entrypoint === "string" &&
    basename(entrypoint, extname(entrypoint)) === moduleName &&
    pathToFileURL(entrypoint).href === metaUrl
  );
};
