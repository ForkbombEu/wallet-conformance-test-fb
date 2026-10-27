import path from "node:path";
import process from "node:process";
import { configDefaults, defineConfig } from "vitest/config";

const nodeMajor = Number(process.versions.node.split(".")[0]);
const needsSqliteFlag = nodeMajor < 23;

export default defineConfig({
  resolve: {
    alias: {
      "#": path.resolve(import.meta.dirname, "./tests"),
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    exclude: configDefaults.exclude,
    globalSetup: ["tests/runner-api/build-once.global-setup.ts"],
    include: ["tests/runner-api/**/*.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: needsSqliteFlag ? ["--experimental-sqlite"] : [],
      },
    },
  },
});
