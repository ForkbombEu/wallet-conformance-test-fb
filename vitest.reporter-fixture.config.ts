import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = import.meta.dirname;
const builtReporterPath = path.join(
  packageRoot,
  "dist/src/report/reporter.js",
);
const sourceReporterPath = path.join(packageRoot, "src/report/reporter.ts");
const reporterModulePath = existsSync(builtReporterPath)
  ? builtReporterPath
  : sourceReporterPath;

const { ConformanceReporter } = await import(
  pathToFileURL(reporterModulePath).href,
);

export default defineConfig({
  resolve: {
    alias: {
      "#": path.resolve(packageRoot, "./tests"),
      "@": path.resolve(packageRoot, "./src"),
    },
  },
  test: {
    include: ["tests/runner-api/fixtures/reporter-fixture.spec.ts"],
    reporters: ["dot", new ConformanceReporter("issuance")],
  },
});
