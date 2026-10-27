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
} from "./contract";
import { generateRunId, JobStore, type StoredRun } from "./job-store";

export interface AckMessage {
  driver_status: "completed" | "failed";
  message?: string;
}

export interface ExecuteContext {
  abortSignal: AbortSignal;
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
  cleanupPromise: Promise<void>;
  runId: string;
}

export class JobManager {
  private readonly clock: () => Date;
  private readonly execute: ExecuteFn;
  private live: LiveRun | undefined;
  private readonly newId: () => string;
  private readonly store: JobStore;

  constructor(deps: JobManagerDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.execute = deps.execute;
    this.newId = deps.newId ?? generateRunId;
    this.store = deps.store;
    this.store.rebuildIndex();
  }

  // -- submit ----------------------------------------------------------------

  async acknowledge(
    runId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _interactionId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ack: AckMessage,
  ): Promise<RunSnapshot> {
    const run = this.store.getRun(runId);
    if (!run) {
      throw notFound(runId);
    }
    return this.toSnapshot(run);
  }

  async cancel(runId: string): Promise<RunSnapshot> {
    const run = this.store.getRun(runId);
    if (!run) {
      throw notFound(runId);
    }
    if (isTerminalStatus(run.status)) {
      return this.toSnapshot(run);
    }

    this.updateRun(run.runId, (r) => ({ ...r, cancelRequested: true }));

    // Abort the executor
    if (this.live?.runId === runId) {
      this.live.abortController.abort();
      // Wait for cleanup before settling terminal cancellation
      await this.live.cleanupPromise.catch(() => undefined);
    }

    const updated = this.store.getRun(runId);
    if (updated && !isTerminalStatus(updated.status)) {
      this.updateRun(runId, (r) => ({ ...r, status: "cancelled" }));
    }

    const final = this.store.getRun(runId);
    if (!final) {
      throw notFound(runId);
    }
    return this.toSnapshot(final);
  }

  // -- queries ----------------------------------------------------------------

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

  // -- cancel ------------------------------------------------------------------

  async getSnapshot(runId: string): Promise<RunSnapshot> {
    const run = this.store.getRun(runId);
    if (!run) {
      throw notFound(runId);
    }
    return this.toSnapshot(run);
  }

  async shutdown(): Promise<void> {
    if (this.live) {
      this.live.abortController.abort();
      await this.live.cleanupPromise.catch(() => undefined);
      this.live = undefined;
    }
    this.store.releaseRootLock();
  }

  // -- acknowledge (stub for prompt 18) ---------------------------------------

  async submit(
    request: RunRequest,
    idempotencyKey: string,
    namespace = "default",
  ): Promise<{ replayed: boolean; snapshot: RunSnapshot }> {
    const keyHash = JobStore.keyHash(namespace, idempotencyKey);
    const requestHash = JobStore.canonicalRequestHash(request);

    // Replay check before busy check
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

    // Busy check
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

    // Start execution (fire-and-forget with proper lifecycle)
    const abortController = new AbortController();
    let cleanupResolve: () => void;
    const cleanupPromise = new Promise<void>((resolve) => {
      cleanupResolve = resolve;
    });

    this.live = {
      abortController,
      cleanupPromise,
      runId,
    };

    this.runExecution(run, abortController).finally(() => {
      if (this.live?.runId === runId) {
        this.live = undefined;
      }
      cleanupResolve();
    });

    return {
      replayed: false,
      snapshot: this.toSnapshot(run),
    };
  }

  // -- shutdown ----------------------------------------------------------------

  private async runExecution(
    run: StoredRun,
    abortController: AbortController,
  ): Promise<void> {
    this.updateRun(run.runId, (r) => ({ ...r, status: "running" }));

    // Install deadline timer from timeout_ms
    const timeoutMs = run.request.timeout_ms ?? 600_000;
    const deadlineTimer = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    try {
      const runRoot = this.store.workDir(run.runId);
      const evidence = await this.execute({
        abortSignal: abortController.signal,
        request: run.request,
        runId: run.runId,
        runRoot,
      });

      clearTimeout(deadlineTimer);

      // Late completion must not overwrite terminal state or pending cancel
      const current = this.store.getRun(run.runId);
      if (current && isTerminalStatus(current.status)) {
        return;
      }
      if (current?.cancelRequested) {
        return;
      }

      // Persist result BEFORE setting terminal state
      this.updateRun(run.runId, (r) => ({
        ...r,
        result: evidence.result,
        status: "completed",
      }));
    } catch (error) {
      clearTimeout(deadlineTimer);

      const current = this.store.getRun(run.runId);
      if (current && isTerminalStatus(current.status)) {
        return;
      }
      if (current?.cancelRequested) {
        return;
      }

      // Determine if this was a timeout or error
      const isTimeout = abortController.signal.aborted;
      const terminalStatus: RunStatus = isTimeout ? "timed_out" : "error";

      // Persist minimal honest envelope on error/timeout
      const errorResult = buildErrorResult(run, error);
      this.updateRun(run.runId, (r) => ({
        ...r,
        result: errorResult,
        status: terminalStatus,
      }));
    }
  }

  // -- helpers ------------------------------------------------------------------

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

function buildErrorResult(run: StoredRun, error: unknown): RunnerResult {
  const message = error instanceof Error ? error.message : String(error);
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
      version: "unknown",
    },
    execution: {
      error: message,
      started_at: run.createdAt,
      status: "error",
    },
    limitations: ["Infrastructure error: " + message],
    native: {
      assertions: [],
      coverage_mode: "interoperability",
      native_suite_status: "ERROR",
      scenario_outcomes: [],
      sessions: [],
    },
    profile_id: run.request.profile_id,
    run_id: run.runId,
    selection: run.request.selection,
    summary: {
      assertion_count: 0,
      native_failed_assertion_count: 0,
      result: "not_tested",
    },
    target: run.request.target,
  };
}
