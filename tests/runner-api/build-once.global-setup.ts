import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Builds dist/ once before the runner-api suite. Tests that exercise the
 * compiled runner (distribution, production composition) and the reporter
 * fixture config (which prefers the built reporter) all read this build;
 * none of them rebuilds, so no test deletes dist/ while another loads it.
 */
export default function setup(): void {
  execFileSync("pnpm", ["build"], {
    cwd: resolve(import.meta.dirname, "../.."),
    stdio: "pipe",
  });
}
