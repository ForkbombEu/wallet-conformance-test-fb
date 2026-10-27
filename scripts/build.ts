import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { glob, rm } from "node:fs/promises";

const production = process.argv.includes("--production");

await rm("dist", { force: true, recursive: true });

/**
 * Trusted build metadata compiled into the runner as `__WCT_BUILD_INFO__`.
 * The revision is the git commit being built (or WCT_BUILD_REVISION when
 * building outside a git checkout, e.g. from a release tarball pipeline).
 * Without either, the constant is not defined and the runner reports
 * `unknown` with a limitation.
 */
function readBuildInfo(): undefined | { dirty: boolean; revision: string } {
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf-8", stdio: "pipe" }).trim();
  try {
    return {
      dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
      revision: git("rev-parse", "HEAD"),
    };
  } catch {
    const revision = process.env.WCT_BUILD_REVISION;
    return revision && /^[0-9a-f]{7,40}$/.test(revision)
      ? { dirty: false, revision }
      : undefined;
  }
}

const buildInfo = readBuildInfo();

const common = {
  bundle: true,
  format: "esm",
  logLevel: "info",
  platform: "node",
  sourcemap: !production,
  target: "node22",
  tsconfig: "tsconfig.json",
} satisfies esbuild.BuildOptions;

await esbuild.build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  packages: "external",
});

// Credimi runner: `node <package>/dist/runner-api/main.js` (bin: wct-runner)
await esbuild.build({
  ...common,
  define: buildInfo
    ? { __WCT_BUILD_INFO__: JSON.stringify(buildInfo) }
    : {},
  entryPoints: ["src/runner-api/main.ts"],
  outfile: "dist/runner-api/main.js",
  packages: "external",
});

const entryPoints = await Array.fromAsync(
  glob([
    "tests/conformance/**/*.spec.ts",
    "tests/credimi/**/*.spec.ts",
    "tests/global-setup.ts",
    "tests/setup-tls.ts",
    "src/report/reporter.ts",
  ]),
);

await esbuild.build({
  ...common,
  entryNames: "[dir]/[name]",
  entryPoints,
  external: ["vitest"],
  outbase: ".",
  outdir: "dist",
  packages: "external",
});
