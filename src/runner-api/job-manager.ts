import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readPackageVersion } from "@/logic/runtime-paths";

import type {
  RunnerResult,
  RunRequest,
  RunSnapshot,
  RunStatus,
} from "./contract";

import {
  idempotencyConflict,
  isTerminalStatus,
  notFound,
  resultNotReady,
  runBusy,
  RunnerError,
  runnerResultSchema,
} from "./contract";
import {
  type CorruptRecord,
  generateRunId,
  JobStore,
  type StoredRun,
} from "./job-store";
import { validateAndAdaptNativeExport } from "./native-result-adapter";
import { summarizeResult } from "./summarize";

/** Why the manager aborted a live run. Set before aborting. */
export type AbortReason = "cancel" | "deadline" | "shutdown";

export interface AckMessage {
  driver_status: "completed" | "failed";
  message?: string;
}

export interface ExecuteContext {
  abortSignal: AbortSignal;
  /** ISO time at which the manager aborts the run (timeout_ms). */
  deadline?: string;
  request: RunRequest;
  runId: string;
  runRoot: string;
}

export type ExecuteFn = (ctx: ExecuteContext) => Promise<ExecutionEvidence>;

export interface ExecutionEvidence {
  privateArtifactPaths: string[];
  result: RunnerResult;
}

export interface JobManagerDeps {
  clock?: () => Date;
  execute: ExecuteFn;
  newId?: () => string;
  store: JobStore;
}

interface LiveRun {
  abortController: AbortController;
  abortReason?: AbortReason;
  /** Settles after the executor returned AND the terminal state is persisted. */
  done: Promise<void>;
  runId: string;
}

const ABORT_STATUS: Record<AbortReason, RunStatus> = {
  cancel: "cancelled",
  deadline: "timed_out",
  shutdown: "cancelled",
};

const ABORT_LIMITATION: Record<AbortReason, string> = {
  cancel: "Run cancelled by request; native results are incomplete",
  deadline: "Run deadline (timeout_ms) reached; native results are incomplete",
  shutdown: "Run interrupted by runner shutdown; native results are incomplete",
};

export class JobManager {
  private readonly clock: () => Date;
  private readonly execute: ExecuteFn;
  private live: LiveRun | undefined;
  private readonly newId: () => string;
  private shutdownPromise: Promise<void> | undefined;
  private readonly store: JobStore;

  constructor(deps: JobManagerDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.execute = deps.execute;
    this.newId = deps.newId ?? generateRunId;
    this.store = deps.store;
    this.store.rebuildIndex();
  }

  /**
   * The legacy engine never publishes pending interactions, so every ACK
   * refers to an unknown interaction.
   */
  async acknowledge(
    runId: string,
    interactionId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of the v1 API; legacy has no interactions to settle
    _ack: AckMessage,
  ): Promise<RunSnapshot> {
    if (!this.store.getRun(runId)) {
      throw notFound(runId);
    }
    throw new RunnerError(
      "NOT_FOUND",
      404,
      `Interaction '${interactionId}' not found in run '${runId}'`,
    );
  }

  /**
   * Requests cancellation and waits until the run's terminal state (with a
   * readable result) is persisted. Idempotent.
   */
  async cancel(runId: string): Promise<RunSnapshot> {
    const run = this.store.getRun(runId);
    if (!run) {
      throw notFound(runId);
    }
    if (isTerminalStatus(run.status)) {
      return this.toSnapshot(run);
    }

    this.updateRun(runId, (r) => ({ ...r, cancelRequested: true }));

    const live = this.live;
    if (live?.runId === runId) {
      this.abortLive(live, "cancel");
      await live.done;
    } else {
      // No executor owns this run: finalize it directly.
      this.finalize(run, {
        error: new Error("Run cancelled before execution"),
        reason: "cancel",
      });
    }

    const final = this.store.getRun(runId);
    if (!final) {
      throw notFound(runId);
    }
    return this.toSnapshot(final);
  }

  async cancelByKey(
    idempotencyKey: string,
    namespace = "default",
  ): Promise<RunSnapshot> {
    const keyHash = JobStore.keyHash(namespace, idempotencyKey);
    const run = this.store.findByKeyHash(keyHash);
    if (!run) {
      throw notFound(idempotencyKey);
    }
    return this.cancel(run.runId);
  }

  /** Run records quarantined as corrupt (identifiers and reasons only). */
  corruptRecords(): CorruptRecord[] {
    return this.store.corruptRecords();
  }

  async getResult(runId: string): Promise<RunnerResult> {
    const run = this.store.getRun(runId);
    if (!run) {
      throw notFound(runId);
    }
    if (!isTerminalStatus(run.status)) {
      throw resultNotReady();
    }
    if (!run.result) {
      throw new RunnerError(
        "RESULT_UNAVAILABLE",
        409,
        "Terminal run has no readable result",
      );
    }
    return run.result;
  }

  async getSnapshot(runId: string): Promise<RunSnapshot> {
    const run = this.store.getRun(runId);
    if (!run) {
      throw notFound(runId);
    }
    return this.toSnapshot(run);
  }

  /**
   * Turns every persisted non-terminal run that no live executor owns into a
   * readable `error` result marked as interrupted, keeping any partial
   * native assertions the interrupted child had exported. Call only after
   * the store owns the state-root lock, before accepting work.
   */
  recoverInterruptedRuns(): string[] {
    const recovered: string[] = [];
    for (const run of this.store.allRuns()) {
      if (isTerminalStatus(run.status) || this.live?.runId === run.runId) {
        continue;
      }
      this.finalize(run, {
        error: new Error(
          "Run interrupted: the runner stopped before this run finished",
        ),
        partialNative: readPartialNative(
          this.store.workDir(run.runId),
          run.runId,
        ),
      });
      recovered.push(run.runId);
    }
    return recovered;
  }

  /**
   * Stops accepting work, aborts the live run and waits until its cleanup
   * and terminal persistence complete. Idempotent.
   */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      const live = this.live;
      if (live) {
        this.abortLive(live, "shutdown");
        await live.done;
      }
      this.store.releaseRootLock();
    })();
    return this.shutdownPromise;
  }

  async submit(
    request: RunRequest,
    idempotencyKey: string,
    namespace = "default",
  ): Promise<{ replayed: boolean; snapshot: RunSnapshot }> {
    const keyHash = JobStore.keyHash(namespace, idempotencyKey);
    const requestHash = JobStore.canonicalRequestHash(request);

    // Replay check before shutdown/busy checks: replays create no work.
    const existing = this.store.findByKeyHash(keyHash);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw idempotencyConflict();
      }
      return {
        replayed: true,
        snapshot: this.toSnapshot(existing),
      };
    }

    if (this.shutdownPromise) {
      throw new RunnerError(
        "RUNNER_SHUTTING_DOWN",
        503,
        "Runner is shutting down",
      );
    }
    if (this.live) {
      throw runBusy();
    }

    const now = this.clock().toISOString();
    const runId = this.newId();
    const run: StoredRun = {
      cancelRequested: false,
      createdAt: now,
      idempotencyKeyHash: keyHash,
      namespace,
      request,
      requestHash,
      runId,
      status: "queued",
      updatedAt: now,
    };

    this.store.saveRun(run);

    const abortController = new AbortController();
    const live: LiveRun = {
      abortController,
      done: Promise.resolve(),
      runId,
    };
    this.live = live;
    // The single-run slot is released only after terminal persistence.
    live.done = this.runExecution(run, live)
      .catch((error: unknown) => {
        console.error(
          `[runner] failed to finalize run ${runId}:`,
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        if (this.live === live) {
          this.live = undefined;
        }
      });

    return {
      replayed: false,
      snapshot: this.toSnapshot(run),
    };
  }

  private abortLive(live: LiveRun, reason: AbortReason): void {
    if (live.abortReason) {
      return;
    }
    live.abortReason = reason;
    live.abortController.abort(new Error(ABORT_LIMITATION[reason]));
  }

  /**
   * Persists the terminal state and a readable result in one write.
   * A run that is already terminal is never overwritten.
   */
  private finalize(
    run: StoredRun,
    outcome:
      | {
          error: unknown;
          partialNative?: RunnerResult["native"];
          reason?: AbortReason;
        }
      | { reason?: AbortReason; result: RunnerResult },
  ): void {
    const current = this.store.getRun(run.runId);
    if (!current || isTerminalStatus(current.status)) {
      return;
    }
    const finishedAt = this.clock().toISOString();
    const reason = outcome.reason;

    let result: RunnerResult;
    let status: RunStatus;
    if ("result" in outcome) {
      status = reason
        ? ABORT_STATUS[reason]
        : workerTerminalStatus(outcome.result.execution.status);
      result = reason
        ? withLifecycle(outcome.result, status, finishedAt, [
            ABORT_LIMITATION[reason],
          ])
        : withLifecycle(outcome.result, status, finishedAt, []);
    } else {
      status = reason ? ABORT_STATUS[reason] : "error";
      result = buildErrorResult(
        run,
        outcome.error,
        status,
        finishedAt,
        reason,
        outcome.partialNative,
      );
    }

    // Publication boundary: only a wire-valid result is ever stored.
    const wire = runnerResultSchema.safeParse(result);
    if (!wire.success) {
      const issues = wire.error.issues
        .map((i) => `${i.path.join(".")}: ${i.code}`)
        .join("; ");
      status = "error";
      result = buildErrorResult(
        run,
        new Error(`Native result failed wire validation (${issues})`),
        status,
        finishedAt,
        undefined,
      );
    }

    this.store.saveRun({
      ...current,
      result,
      status,
      updatedAt: finishedAt,
    });
  }

  private async runExecution(run: StoredRun, live: LiveRun): Promise<void> {
    this.updateRun(run.runId, (r) => ({ ...r, status: "running" }));

    const timeoutMs = run.request.timeout_ms ?? 600_000;
    const deadline = new Date(this.clock().getTime() + timeoutMs);
    const deadlineTimer = setTimeout(
      () => this.abortLive(live, "deadline"),
      timeoutMs,
    );

    try {
      const evidence = await this.execute({
        abortSignal: live.abortController.signal,
        deadline: deadline.toISOString(),
        request: run.request,
        runId: run.runId,
        runRoot: this.store.workDir(run.runId),
      });
      clearTimeout(deadlineTimer);
      this.finalize(run, { reason: live.abortReason, result: evidence.result });
    } catch (error) {
      clearTimeout(deadlineTimer);
      this.finalize(run, { error, reason: live.abortReason });
    }
  }

  private toSnapshot(run: StoredRun): RunSnapshot {
    return {
      cancel_requested: run.cancelRequested,
      contract_version: "1.0",
      created_at: run.createdAt,
      engine: "pagopa-wct",
      pending_interactions: [],
      result_url: `/v1/runs/${run.runId}/result`,
      run_id: run.runId,
      status: run.status,
      updated_at: run.updatedAt,
    };
  }

  private updateRun(runId: string, updater: (r: StoredRun) => StoredRun): void {
    const run = this.store.getRun(runId);
    if (!run) {
      return;
    }
    const updated = updater({ ...run, updatedAt: this.clock().toISOString() });
    this.store.saveRun(updated);
  }
}

const ERROR_MESSAGE_MAX = 4_096;

function buildErrorResult(
  run: StoredRun,
  error: unknown,
  status: RunStatus,
  finishedAt: string,
  reason: AbortReason | undefined,
  partialNative?: RunnerResult["native"],
): RunnerResult {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, ERROR_MESSAGE_MAX);
  const execution: RunnerResult["execution"] = {
    error: message,
    finished_at: finishedAt,
    started_at: run.createdAt,
    status,
  };
  const native: RunnerResult["native"] = partialNative ?? {
    assertions: [],
    coverage_mode: "interoperability",
    native_suite_status: "ERROR",
    scenario_outcomes: [],
    sessions: [],
  };
  return {
    artifacts: [],
    category: run.request.category,
    contract_version: "1.0",
    engine: {
      fork_repository:
        "https://github.com/ForkbombEu/wallet-conformance-test-fb",
      id: "pagopa-wct",
      revision: "unknown",
      upstream_repository: "https://github.com/pagopa/wallet-conformance-test",
      version: readPackageVersion(),
    },
    execution,
    limitations: [
      reason ? ABORT_LIMITATION[reason] : `Execution error: ${message}`,
      partialNative
        ? "Only partial native assertions exported before the interruption are included"
        : "No native result was collected",
      "engine.revision is unknown: no trusted build revision is available",
    ],
    native,
    profile_id: run.request.profile_id,
    run_id: run.runId,
    selection: run.request.selection,
    summary: summarizeResult(execution, native),
    target: run.request.target,
  };
}

/** Reads a native export left in an interrupted run's workspace, if valid. */
function readPartialNative(
  workDir: string,
  runId: string,
): RunnerResult["native"] | undefined {
  const exportPath = join(workDir, "results", "native-results.json");
  if (!existsSync(exportPath)) return undefined;
  try {
    const adapted = validateAndAdaptNativeExport(
      JSON.parse(readFileSync(exportPath, "utf-8")) as unknown,
      { expectedRunId: runId },
    );
    if (adapted.assertions.length === 0) return undefined;
    return {
      assertions: adapted.assertions,
      coverage_mode: "interoperability",
      native_suite_status: adapted.status,
      scenario_outcomes: [],
      sessions: [{ id: adapted.sessionId, status: adapted.status }],
    };
  } catch {
    return undefined;
  }
}

/**
 * Forces the lifecycle status onto a worker result and recomputes the
 * summary from the preserved native data (PASS + incomplete ⇒ partial).
 */
function withLifecycle(
  result: RunnerResult,
  status: RunStatus,
  finishedAt: string,
  limitations: string[],
): RunnerResult {
  const execution: RunnerResult["execution"] = {
    ...result.execution,
    finished_at: result.execution.finished_at ?? finishedAt,
    status,
  };
  return {
    ...result,
    execution,
    limitations: [...result.limitations, ...limitations],
    summary: summarizeResult(execution, result.native),
  };
}

/** A worker may only report completed or error without a manager abort. */
function workerTerminalStatus(status: string): RunStatus {
  return status === "completed" ? "completed" : "error";
}
