import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Phase } from "@/report/types";

export interface NativeAssertion {
  ancestorTitles: string[];
  description: string;
  errorMessage: null | string;
  file: string;
  nativeStatus: "FAIL" | "NOT_REACHED" | "PASS";
  phase: Phase;
  requirementId: null | string;
  timestamp: string;
  title: string;
  vitestStatus: "failed" | "passed" | "pending" | "skipped";
}

export interface NativeExport {
  assertions: NativeAssertion[];
  closedAt: null | string;
  phase: Phase;
  runId: string;
  sessionId: string;
  startedAt: string;
  status: "FAILED" | "INCOMPLETE" | "OPEN" | "PASSED";
}

export function buildNativeExport(params: {
  assertions: NativeAssertion[];
  closedAt: null | string;
  phase: Phase;
  runId: string;
  sessionId: string;
  startedAt: string;
  status: NativeExport["status"];
}): NativeExport {
  return {
    assertions: params.assertions,
    closedAt: params.closedAt,
    phase: params.phase,
    runId: params.runId,
    sessionId: params.sessionId,
    startedAt: params.startedAt,
    status: params.status,
  };
}

export function writeNativeExport(
  outputDir: string,
  data: NativeExport,
): string {
  const target = join(outputDir, "native-results.json");
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, target);
  return target;
}
