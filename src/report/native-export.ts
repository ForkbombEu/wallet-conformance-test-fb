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
  /**
   * Bounded errors that happened outside test bodies (collection, suite
   * hooks, unhandled errors, an interrupted run). Absent when there were none.
   */
  errors?: NativeRunError[];
  phase: Phase;
  runId: string;
  sessionId: string;
  startedAt: string;
  status: "FAILED" | "INCOMPLETE" | "OPEN" | "PASSED";
}

/** Most errors kept in one export, and the longest message kept per error. */
export const MAX_NATIVE_ERRORS = 20;
export const MAX_NATIVE_ERROR_MESSAGE = 2_048;

export interface NativeRunError {
  /** Module ID or suite name the error belongs to, when known. */
  location?: string;
  message: string;
  origin: "module" | "run" | "suite" | "unhandled";
}

export function buildNativeExport(params: {
  assertions: NativeAssertion[];
  closedAt: null | string;
  errors?: NativeRunError[];
  phase: Phase;
  runId: string;
  sessionId: string;
  startedAt: string;
  status: NativeExport["status"];
}): NativeExport {
  return {
    assertions: params.assertions,
    closedAt: params.closedAt,
    ...(params.errors && params.errors.length > 0
      ? { errors: params.errors }
      : {}),
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
