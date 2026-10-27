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

import { validateAndAdaptNativeExport } from "./native-result-adapter";
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
    const dataDir = join(runRoot, "data");
    const dbPath = join(dataDir, "wct.db");

    // Build env with per-run isolation and effective config
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: getNodeOptionsWithExperimentalWarningDisabled(
        process.env.NODE_OPTIONS,
      ),
      CONFIG_FILE_INI: effectiveConfig.profileConfigPath,
      CONFIG_ISSUANCE_TESTS_DIR: join(runRoot, "tests"),
      WCT_DB_PATH: dbPath,
      WCT_RESULTS_DIR: resultsDir,
      WCT_RUN_ID: runId,
    };

    // Apply typed overrides to child env
    if (request.parameters?.issuer_url) {
      env.CONFIG_CREDENTIAL_ISSUER_URI = request.parameters.issuer_url;
    }
    if (request.parameters?.credential_offer_uri) {
      env.CONFIG_CREDENTIAL_OFFER_URI = request.parameters.credential_offer_uri;
    }
    if (request.parameters?.authorization_interaction) {
      env.CONFIG_AUTHORIZATION_INTERACTION =
        request.parameters.authorization_interaction;
    }

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

    // Read and validate native export
    const exportPath = join(resultsDir, "native-results.json");
    let adapted: null | ReturnType<typeof validateAndAdaptNativeExport> = null;

    if (existsSync(exportPath)) {
      try {
        const raw = readFileSync(exportPath, "utf-8");
        const parsed = JSON.parse(raw);
        adapted = validateAndAdaptNativeExport(parsed, {
          expectedRunId: runId,
        });
      } catch {
        adapted = null;
      }
    }

    // Missing/corrupt/mismatched export → error
    if (!adapted) {
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

    // Build native section from adapted assertions
    const native: RunnerResult["native"] = {
      assertions: adapted.assertions,
      coverage_mode: effectiveConfig.coverageMode,
      native_suite_status: adapted.status,
      scenario_outcomes: [],
      sessions: [{ id: adapted.sessionId, status: adapted.status }],
    };

    const execution: RunnerResult["execution"] = {
      exit_code: exitCode ?? undefined,
      finished_at: finishedAt,
      started_at: startedAt,
      status: exitCode === 0 ? "completed" : "completed",
    };

    const summary = summarizeResult(execution, native);

    // Register native export as an artifact
    const artifactId = `${runId}:native-export`;
    const nativeExportPath = join(resultsDir, "native-results.json");

    return {
      privateArtifactPaths: [nativeExportPath],
      result: {
        artifacts: [
          {
            artifact_id: artifactId,
            download_url: `/v1/runs/${runId}/artifacts/${encodeURIComponent(artifactId)}`,
            filename: "native-results.json",
            mime_type: "application/json",
            sha256: "", // computed by ArtifactStore at registration
            size_bytes: 0, // computed by ArtifactStore at registration
          },
        ],
        category,
        contract_version: "1.0",
        engine: {
          ...ENGINE_INFO,
          revision: "unknown",
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
