import type { Readable } from "node:stream";

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

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

import { engineIdentity, engineLimitations } from "./engine";
import {
  clearNativeChildMarkerIfGone,
  writeNativeChildMarker,
} from "./native-child-marker";
import { validateAndAdaptNativeExport } from "./native-result-adapter";
import { materializeRunIni } from "./run-ini";
import { summarizeResult } from "./summarize";
import { settlesWithin } from "./timing";

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
  stderr?: null | Readable;
  stdout?: null | Readable;
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

/** Bytes of each child stream retained on disk; the rest is drained. */
export const NATIVE_LOG_CAP_BYTES = 4 * 1024 * 1024;
const KILL_ESCALATION_MS = 2_000;
const DRAIN_GRACE_MS = 5_000;
const ERROR_TAIL_BYTES = 4_096;

/**
 * Environment prefixes owned by the native loader/reporter. Values inherited
 * from the runner's own environment must never leak into a run.
 */
const NATIVE_ENV_PREFIXES = ["CONFIG_", "WCT_"];

/** Runner secrets the native child (and operator driver code) never sees. */
const RUNNER_SECRET_KEYS = new Set(["CREDIMI_RUNNER_TOKEN"]);

// ---------------------------------------------------------------------------
// Native executor
// ---------------------------------------------------------------------------

export interface NativeExecutorOptions {
  effectiveConfig: EffectiveConfig;
  processAdapter?: ProcessAdapter;
  request: RunRequest;
}

type AdaptedExport = ReturnType<typeof validateAndAdaptNativeExport>;

interface DrainedStream {
  done: Promise<void>;
  tail(): string;
}

/**
 * Builds the native child environment: inherited CONFIG_* / WCT_* / TESTS
 * values are removed, then the run's effective INI, discovery root, typed
 * overrides and per-run writable paths are set explicitly.
 */
export function buildNativeEnv(
  effectiveConfig: EffectiveConfig,
  paths: {
    deadline?: string;
    effectiveIni: string;
    resultsDir: string;
    runId: string;
  },
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (RUNNER_SECRET_KEYS.has(key) || key === "TESTS") continue;
    if (NATIVE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }

  const overrides = effectiveConfig.overrides;
  env.NODE_OPTIONS = getNodeOptionsWithExperimentalWarningDisabled(
    baseEnv.NODE_OPTIONS,
  );
  env.CONFIG_FILE_INI = paths.effectiveIni;
  env[
    effectiveConfig.category === "issuance"
      ? "CONFIG_ISSUANCE_TESTS_DIR"
      : "CONFIG_PRESENTATION_TESTS_DIR"
  ] = dirname(effectiveConfig.testFile);
  env.CONFIG_CREDENTIAL_ISSUER_URI = effectiveConfig.target.issuerIdentifier;
  env.CONFIG_AUTHORIZATION_INTERACTION =
    effectiveConfig.authorizationInteraction;
  if (effectiveConfig.credentialConfigurationIds.length > 0) {
    env.CONFIG_CREDENTIAL_TYPES =
      effectiveConfig.credentialConfigurationIds.join(",");
  }
  if (overrides.credential_offer_uri) {
    env.CONFIG_CREDENTIAL_OFFER_URI = overrides.credential_offer_uri;
  }
  if (effectiveConfig.authorizationDriver) {
    env.WCT_AUTHORIZATION_DRIVER_MODULE =
      effectiveConfig.authorizationDriver.modulePath;
  }
  if (paths.deadline) {
    env.WCT_RUN_DEADLINE = paths.deadline;
  }
  env.WCT_RUNNER_MODE = "1";
  env.WCT_DB_PATH = effectiveConfig.writablePaths.db;
  env.WCT_RESULTS_DIR = paths.resultsDir;
  env.WCT_RUN_ID = paths.runId;
  return env;
}

export function createNativeExecutor(
  options: NativeExecutorOptions,
): ExecuteFn {
  const adapter = options.processAdapter ?? defaultProcessAdapter;

  return async (ctx: ExecuteContext): Promise<ExecutionEvidence> => {
    const { runId, runRoot } = ctx;
    const { effectiveConfig, request } = options;

    // A cancelled/expired run must never spawn.
    ctx.abortSignal.throwIfAborted();

    const testFile = effectiveConfig.testFile;
    assertRunnable(effectiveConfig, runRoot);

    const resultsDir = join(runRoot, "results");
    const logsDir = join(runRoot, "logs");
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    const effectiveIni = materializeRunIni({
      initializedAssets: effectiveConfig.initializedAssets,
      operatorIni: effectiveConfig.profileConfigPath,
      runRoot,
      writablePaths: effectiveConfig.writablePaths,
    });
    const env = buildNativeEnv(effectiveConfig, {
      deadline: ctx.deadline,
      effectiveIni,
      resultsDir,
      runId,
    });

    const category = effectiveConfig.category;
    const configPath = resolveVitestConfigPath(category);
    const vitestBin = resolveVitestBin();

    // The include root is the selection's parent; the positional filter
    // narrows discovery to the selected file inside it.
    const args = [vitestBin, "run", "--config", configPath, testFile];

    const startedAt = new Date().toISOString();

    ctx.abortSignal.throwIfAborted();
    const child = adapter.spawn(process.execPath, args, {
      cwd: runRoot,
      detached: true,
      env,
      shell: false,
      stdio: "pipe",
    });

    const { exitCode, stderrTail } = await superviseChild(
      child,
      runRoot,
      logsDir,
      ctx.abortSignal,
    );

    const finishedAt = new Date().toISOString();

    const exportPath = join(resultsDir, "native-results.json");
    const { adapted, problem: exportProblem } = readNativeExport(
      exportPath,
      runId,
      exitCode,
    );

    // Missing/corrupt/mismatched export → error (raw bytes still published)
    if (!adapted) {
      return {
        privateArtifactPaths: existsSync(exportPath) ? [exportPath] : [],
        result: buildErrorResult(
          runId,
          request,
          effectiveConfig,
          startedAt,
          finishedAt,
          exitCode,
          stderrTail,
          exportProblem,
        ),
      };
    }

    // The artifact layer (publishRunEvidence) builds the manifest entries
    // from the exact bytes; the worker only declares private files.
    return {
      privateArtifactPaths: [exportPath],
      result: buildCompletedResult({
        adapted,
        effectiveConfig,
        exitCode,
        finishedAt,
        request,
        runId,
        startedAt,
      }),
    };
  };
}

/** Checks a run can start before anything is spawned. */
function assertRunnable(effectiveConfig: EffectiveConfig, runRoot: string) {
  const testFile = effectiveConfig.testFile;
  if (!isAbsolute(testFile) || !existsSync(testFile)) {
    throw new Error(`Selected native test file not found: ${testFile}`);
  }
  if (!existsSync(effectiveConfig.profileConfigPath)) {
    throw new Error(
      `Profile INI not found: ${effectiveConfig.profileConfigPath}`,
    );
  }
  for (const writable of Object.values(effectiveConfig.writablePaths)) {
    if (!writable.startsWith(`${runRoot}/`)) {
      throw new Error(
        `Writable path ${writable} is outside the run workspace ${runRoot}`,
      );
    }
  }
}

/** Builds the result of a run whose native export was readable. */
function buildCompletedResult(input: {
  adapted: AdaptedExport;
  effectiveConfig: EffectiveConfig;
  exitCode: null | number;
  finishedAt: string;
  request: RunRequest;
  runId: string;
  startedAt: string;
}): RunnerResult {
  const { adapted, effectiveConfig, exitCode, request } = input;
  const native: RunnerResult["native"] = {
    assertions: adapted.assertions,
    coverage_mode: effectiveConfig.coverageMode,
    native_suite_status: adapted.status,
    scenario_outcomes: [],
    sessions: [{ id: adapted.sessionId, status: adapted.status }],
  };

  // An OPEN session was never closed by the reporter: the child stopped
  // mid-suite. Its assertions are kept, but the execution is incomplete.
  const sessionClosed = adapted.status !== "OPEN";
  const execution: RunnerResult["execution"] = {
    ...(sessionClosed
      ? {}
      : { error: "native session did not close; the suite was interrupted" }),
    exit_code: exitCode ?? undefined,
    finished_at: input.finishedAt,
    started_at: input.startedAt,
    status: sessionClosed ? "completed" : "error",
  };

  let summary = summarizeResult(execution, native);
  // Every collected assertion passed, but the native suite itself did not
  // (hook failure, unhandled error, nonzero exit): never publish `pass`.
  const suiteClean = adapted.status === "PASSED" && exitCode === 0;
  const downgraded = summary.result === "pass" && !suiteClean;
  if (downgraded) {
    summary = { ...summary, result: "partial" };
  }

  const limitations: string[] = [];
  if (downgraded) {
    limitations.push(
      `Native suite did not pass cleanly (status ${adapted.status}, exit code ${String(exitCode)}): errors outside test bodies or uncollected failures may exist`,
    );
  }
  if (!sessionClosed) {
    limitations.push(
      "Native session did not close: only assertions reported before the interruption are included",
    );
  }

  return {
    artifacts: [],
    category: effectiveConfig.category,
    contract_version: "1.0",
    engine: engineIdentity(),
    execution,
    limitations: [...limitations, ...engineLimitations()],
    native,
    profile_id: effectiveConfig.profileId,
    run_id: input.runId,
    selection: request.selection,
    summary,
    target: request.target,
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
  problem: string,
): RunnerResult {
  return {
    artifacts: [],
    category: effectiveConfig.category,
    contract_version: "1.0",
    engine: engineIdentity(),
    execution: {
      error: truncate(stderr, ERROR_TAIL_BYTES) || problem,
      exit_code: exitCode ?? undefined,
      finished_at: finishedAt,
      started_at: startedAt,
      status: "error",
    },
    limitations: [
      `Native execution produced no readable result: ${problem}`,
      ...engineLimitations(),
    ],
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

/**
 * The group was SIGKILLed when the child exited; give the kernel a moment to
 * reap it before clearing the marker. A group that survives keeps its marker
 * so the next runner startup refuses to run on top of it.
 */
async function clearMarkerOnceGone(runRoot: string, pid: number) {
  for (let i = 0; i < 40; i++) {
    if (clearNativeChildMarkerIfGone(runRoot, pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Always consumes a child stream so the child can never block on a full
 * pipe. The first NATIVE_LOG_CAP_BYTES go to a private run log; a short tail
 * is kept in memory for error diagnostics.
 */
function drainToFile(
  stream: null | Readable | undefined,
  filePath: string,
): DrainedStream {
  if (!stream) {
    return { done: Promise.resolve(), tail: () => "" };
  }
  const fd = openSync(filePath, "w", 0o600);
  let written = 0;
  let tail = Buffer.alloc(0);

  const done = new Promise<void>((resolve) => {
    const finish = () => {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      resolve();
    };
    stream.on("data", (chunk: Buffer) => {
      if (written < NATIVE_LOG_CAP_BYTES) {
        const slice = chunk.subarray(0, NATIVE_LOG_CAP_BYTES - written);
        writeSync(fd, slice);
        written += slice.length;
      }
      tail = Buffer.concat([tail, chunk]).subarray(-ERROR_TAIL_BYTES);
    });
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", finish);
  });

  return { done, tail: () => tail.toString("utf-8").trim() };
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

/**
 * Reads and adapts the raw native export. A launch/config/discovery failure
 * (no tests collected, nonzero exit) is not a readable conformance result.
 */
function readNativeExport(
  exportPath: string,
  runId: string,
  exitCode: null | number,
): { adapted: AdaptedExport | null; problem: string } {
  if (!existsSync(exportPath)) {
    return { adapted: null, problem: "native export missing" };
  }
  let adapted: AdaptedExport;
  try {
    const parsed: unknown = JSON.parse(readFileSync(exportPath, "utf-8"));
    adapted = validateAndAdaptNativeExport(parsed, { expectedRunId: runId });
  } catch (error) {
    return {
      adapted: null,
      problem: `native export unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (adapted.assertions.length === 0 && exitCode !== 0) {
    return { adapted: null, problem: "no native tests were collected" };
  }
  return { adapted, problem: "" };
}

/**
 * Tracks the spawned child until it and its process group are gone: drains
 * its output, records the group marker, waits for exit (honouring the abort
 * signal) and clears the marker once the group is confirmed gone.
 */
async function superviseChild(
  child: SpawnedProcess,
  runRoot: string,
  logsDir: string,
  signal: AbortSignal,
): Promise<{ exitCode: null | number; stderrTail: string }> {
  const stdoutLog = drainToFile(child.stdout, join(logsDir, "stdout.log"));
  const stderrLog = drainToFile(child.stderr, join(logsDir, "stderr.log"));

  // Record the detached group so a crashed or timed-out runner can detect
  // it on restart. If that fails, the child must not run untracked.
  if (child.pid) {
    try {
      writeNativeChildMarker(runRoot, child.pid);
    } catch (error) {
      killGroup(child.pid, "SIGKILL");
      await waitForChild(child, AbortSignal.abort());
      throw new Error(
        `Could not record the native child process group: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const exitCode = await waitForChild(child, signal);
  // A descendant outside the process group could keep the pipes open;
  // never wait for them indefinitely once the child itself has exited.
  if (
    !(await settlesWithin(
      Promise.all([stdoutLog.done, stderrLog.done]),
      DRAIN_GRACE_MS,
    ))
  ) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  if (child.pid) await clearMarkerOnceGone(runRoot, child.pid);
  return { exitCode, stderrTail: stderrLog.tail() || stdoutLog.tail() };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Waits for the native child to exit. On abort the whole process group gets
 * SIGTERM, escalating to SIGKILL. After exit any surviving descendant in the
 * group is killed, so nothing outlives the run.
 */
function waitForChild(
  child: SpawnedProcess,
  signal: AbortSignal,
): Promise<null | number> {
  return new Promise<null | number>((resolve, reject) => {
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;

    const onAbort = () => {
      if (!child.pid) return;
      killGroup(child.pid, "SIGTERM");
      escalation = setTimeout(() => {
        if (!settled && child.pid) killGroup(child.pid, "SIGKILL");
      }, KILL_ESCALATION_MS);
    };

    const finish = (err: Error | undefined, code: null | number) => {
      if (settled) return;
      settled = true;
      clearTimeout(escalation);
      signal.removeEventListener("abort", onAbort);
      if (child.pid) killGroup(child.pid, "SIGKILL");
      if (err) reject(err);
      else resolve(code);
    };

    child.on("exit", (code) => finish(undefined, code));
    child.on("error", (err) => finish(err, null));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
