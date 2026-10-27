import { readPackageVersion } from "@/logic/runtime-paths";

import type { RunnerResult } from "./contract";

/**
 * Build metadata injected by `scripts/build.ts` through esbuild `define`.
 * Absent when running from source (tsx/vitest), where it stays undeclared.
 */
interface BuildInfo {
  dirty: boolean;
  revision: string;
}

declare const __WCT_BUILD_INFO__: BuildInfo | undefined;

export const ENGINE_ID = "pagopa-wct";

/**
 * Engine identity for results and capabilities: package version from the
 * package metadata on disk, revision from the trusted build-time constant.
 */
export function engineIdentity(): RunnerResult["engine"] {
  return {
    fork_repository: "https://github.com/ForkbombEu/wallet-conformance-test-fb",
    id: ENGINE_ID,
    revision: buildInfo()?.revision ?? "unknown",
    upstream_repository: "https://github.com/pagopa/wallet-conformance-test",
    version: readPackageVersion(),
  };
}

/** Limitations describing how trustworthy the engine identity is. */
export function engineLimitations(): string[] {
  const info = buildInfo();
  if (!info) {
    return [
      "engine.revision is unknown: running from source without trusted build metadata",
    ];
  }
  return info.dirty
    ? [
        `engine.revision ${info.revision} was built from a working tree with uncommitted changes`,
      ]
    : [];
}

function buildInfo(): BuildInfo | undefined {
  return typeof __WCT_BUILD_INFO__ === "undefined"
    ? undefined
    : __WCT_BUILD_INFO__;
}
