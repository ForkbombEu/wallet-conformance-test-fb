import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { isMainModule } from "@/logic/entrypoint";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
});

describe("isMainModule", () => {
  it("detects the current ESM entrypoint", () => {
    const entrypoint = path.join(process.cwd(), "src/servers/ta-server.ts");
    process.argv[1] = entrypoint;

    expect(isMainModule(pathToFileURL(entrypoint).href, "ta-server")).toBe(
      true,
    );
  });

  it("returns false for imported modules", () => {
    process.argv[1] = path.join(process.cwd(), "tests/global-setup.ts");

    expect(
      isMainModule(
        pathToFileURL(path.join(process.cwd(), "src/servers/ta-server.ts"))
          .href,
        "ta-server",
      ),
    ).toBe(false);
  });

  it("returns false inside a bundle whose entry is another file", () => {
    // In a bundle every module shares the bundle URL (dist/cli.js here).
    const bundle = path.join(process.cwd(), "dist/cli.js");
    process.argv[1] = bundle;

    expect(isMainModule(pathToFileURL(bundle).href, "ta-server")).toBe(false);
  });
});
