import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readPackageVersion } from "@/logic/runtime-paths";
import {
  getNodeOptionsWithExperimentalWarningDisabled,
  resolveVitestBin,
  resolveVitestConfigPath,
} from "@/logic/test-command";

import type { RunnerResult, RunRequest } from "./contract";
import type { EffectiveConfig } from "./effective-config";
import type {
  ExecuteContext,
  ExecuteFn,
  ExecutionEvidence,
} from "./job-manager";

import { summarizeResult } from "./summarize";

// ---------------------------------------------------------------------------
// Process adapter (injectable for testing)
// ---------------------------------------------------------------------------

export interface ProcessAdapter {
  spawn(command: string, args: string[], options: SpawnOptions): SpawnedProcess;
}

export interface SpawnedProcess {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "exit", listener: (code: null | number) => void): void;
  pid: number | undefined;
}

export interface SpawnOptions {
  cwd: string;
  detached: boolean;
  env: NodeJS.ProcessEnv;
  shell: boolean;
  stdio: "ignore" | "pipe";
}

export const defaultProcessAdapter: ProcessAdapter = {
  spawn(command, args, options) {
    return spawn(command, args, options) as unknown as SpawnedProcess;
  },
};

// ---------------------------------------------------------------------------
// Native executor
// ---------------------------------------------------------------------------

export interface NativeExecutorOptions {
  effectiveConfig: EffectiveConfig;
  processAdapter?: ProcessAdapter;
  request: RunRequest;
}

const ENGINE_INFO = {
  fork_repository: "https://github.com/ForkbombEu/wallet-conformance-test-fb",
  id: "pagopa-wct",
  upstream_repository: "https://github.com/pagopa/wallet-conformance-test",
};

export function createNativeExecutor(
  options: NativeExecutorOptions,
): ExecuteFn {
  const adapter = options.processAdapter ?? defaultProcessAdapter;

  return async (ctx: ExecuteContext): Promise<ExecutionEvidence> => {
    const { runId, runRoot } = ctx;
    const { effectiveConfig, request } = options;

    const resultsDir = join(runRoot, "results");
    const dbPath = join(runRoot, "data", "wct.db");

    // Build env
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: getNodeOptionsWithExperimentalWarningDisabled(
        process.env.NODE_OPTIONS,
      ),
      WCT_DB_PATH: dbPath,
      WCT_RESULTS_DIR: resultsDir,
      WCT_RUN_ID: runId,
    };

    // Determine config file and test target
    const category = effectiveConfig.category;
    const configPath = resolveVitestConfigPath(category);
    const vitestBin = resolveVitestBin();

    // Test selection: pass the test file as a filter pattern
    const args = [
      vitestBin,
      "run",
      "--config",
      configPath,
      effectiveConfig.testFile,
    ];

    const startedAt = new Date().toISOString();

    // Spawn the process
    const child = adapter.spawn(process.execPath, args, {
      cwd: runRoot,
      detached: true,
      env,
      shell: false,
      stdio: "pipe",
    });

    // Wait for exit or abort
    const exitCode = await new Promise<null | number>((resolve, reject) => {
      let settled = false;

      const settle = (code: null | number) => {
        if (!settled) {
          settled = true;
          resolve(code);
        }
      };

      child.on("exit", (code) => settle(code));
      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ctx.abortSignal.addEventListener("abort", () => {
        // Graceful termination then escalate
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            // group may already be gone
          }
          setTimeout(() => {
            if (!settled && child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                // ignore
              }
            }
          }, 2_000);
        }
      });
    });

    const finishedAt = new Date().toISOString();

    // Read native export
    const exportPath = join(resultsDir, "native-results.json");
    interface NativeExportData {
      assertions: RunnerResult["native"]["assertions"];
      closedAt: null | string;
      sessionId: string;
      startedAt: string;
      status: string;
    }
    let nativeExport: NativeExportData | null = null;

    if (existsSync(exportPath)) {
      try {
        const raw = readFileSync(exportPath, "utf-8");
        nativeExport = JSON.parse(raw) as NativeExportData;
      } catch {
        nativeExport = null;
      }
    }

    // Missing/corrupt export → error
    if (!nativeExport) {
      return {
        privateArtifactPaths: [],
        result: buildErrorResult(
          runId,
          request,
          effectiveConfig,
          startedAt,
          finishedAt,
          exitCode,
          "",
        ),
      };
    }

    // Build native section from export
    const assertions = nativeExport.assertions;
    const native: RunnerResult["native"] = {
      assertions,
      coverage_mode: effectiveConfig.coverageMode,
      native_suite_status: nativeExport.status,
      scenario_outcomes: [],
      sessions: [{ id: nativeExport.sessionId, status: nativeExport.status }],
    };

    const execution: RunnerResult["execution"] = {
      exit_code: exitCode ?? undefined,
      finished_at: finishedAt,
      started_at: startedAt,
      status: exitCode === 0 ? "completed" : "completed",
    };

    const summary = summarizeResult(execution, native);

    return {
      privateArtifactPaths: [],
      result: {
        artifacts: [],
        category,
        contract_version: "1.0",
        engine: {
          ...ENGINE_INFO,
          revision: nativeExport.sessionId, // placeholder; real revision from git in production
          version: readPackageVersion(),
        },
        execution,
        limitations: [],
        native,
        profile_id: effectiveConfig.profileId,
        run_id: runId,
        selection: request.selection,
        summary,
        target: request.target,
      },
    };
  };
}

function buildErrorResult(
  runId: string,
  request: RunRequest,
  effectiveConfig: EffectiveConfig,
  startedAt: string,
  finishedAt: string,
  exitCode: null | number,
  stderr: string,
): RunnerResult {
  return {
    artifacts: [],
    category: effectiveConfig.category,
    contract_version: "1.0",
    engine: {
      ...ENGINE_INFO,
      revision: "unknown",
      version: readPackageVersion(),
    },
    execution: {
      error: truncate(stderr, 4096) || "native export missing or corrupt",
      exit_code: exitCode ?? undefined,
      finished_at: finishedAt,
      started_at: startedAt,
      status: "error",
    },
    limitations: ["Native export was missing or unreadable"],
    native: {
      assertions: [],
      coverage_mode: effectiveConfig.coverageMode,
      native_suite_status: "ERROR",
      scenario_outcomes: [],
      sessions: [],
    },
    profile_id: effectiveConfig.profileId,
    run_id: runId,
    selection: request.selection,
    summary: {
      assertion_count: 0,
      native_failed_assertion_count: 0,
      result: "not_tested",
    },
    target: request.target,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
