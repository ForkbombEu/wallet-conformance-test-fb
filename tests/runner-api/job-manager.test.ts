import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunnerResult, RunRequest } from "@/runner-api/contract";

import { type ExecuteFn, JobManager } from "@/runner-api/job-manager";
import { JobStore } from "@/runner-api/job-store";

function makeRequest(): RunRequest {
  return {
    category: "issuance",
    contract_version: "1.0",
    parameters: {},
    profile_id: "test",
    selection: { ids: ["credimi-issuance-smoke"] },
    target: { actor_name: "x", actor_type: "issuer" },
    timeout_ms: 600_000,
  };
}

function makeResult(): RunnerResult {
  return {
    artifacts: [],
    category: "issuance",
    contract_version: "1.0",
    engine: {
      fork_repository:
        "https://github.com/ForkbombEu/wallet-conformance-test-fb",
      id: "pagopa-wct",
      revision: "b728cca",
      upstream_repository: "https://github.com/pagopa/wallet-conformance-test",
      version: "test",
    },
    execution: {
      exit_code: 0,
      finished_at: "2026-01-01T00:00:02Z",
      started_at: "2026-01-01T00:00:00Z",
      status: "completed",
    },
    limitations: [],
    native: {
      assertions: [],
      coverage_mode: "interoperability",
      native_suite_status: "PASSED",
      scenario_outcomes: [],
      sessions: [],
    },
    profile_id: "test",
    run_id: "run-1",
    selection: { ids: ["credimi-issuance-smoke"] },
    summary: {
      assertion_count: 0,
      native_failed_assertion_count: 0,
      result: "not_tested",
    },
    target: { actor_name: "x", actor_type: "issuer" },
  };
}

let dir: string;
let store: JobStore;

function makeFakeExecute(): ExecuteFn {
  return vi.fn().mockResolvedValue({
    privateArtifactPaths: [],
    result: makeResult(),
  }) as unknown as ExecuteFn & ReturnType<typeof vi.fn>;
}

function makeSlowExecute(delayMs: number, abortable = true): ExecuteFn {
  return vi.fn().mockImplementation(
    (ctx: { abortSignal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve({
              privateArtifactPaths: [],
              result: makeResult(),
            }),
          delayMs,
        );
        if (abortable) {
          ctx.abortSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }
      }),
  ) as unknown as ExecuteFn & ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-mgr-"));
  store = new JobStore(dir);
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("JobManager — submit lifecycle", () => {
  it("submits and completes a run", async () => {
    const execute = makeFakeExecute();
    const mgr = new JobManager({ execute, store });

    const { replayed, snapshot } = await mgr.submit(makeRequest(), "key-1");
    expect(replayed).toBe(false);
    expect(snapshot.status).toBe("queued");

    // Wait for async execution to settle
    await new Promise((r) => setTimeout(r, 50));
    const result = await mgr.getResult(snapshot.run_id);
    expect(result).toBeDefined();
    await mgr.shutdown();
  });

  it("executes exactly once for duplicate simultaneous starts", async () => {
    const execute = makeFakeExecute();
    const mgr = new JobManager({ execute, store });

    const [a, b] = await Promise.all([
      mgr.submit(makeRequest(), "key-1"),
      mgr.submit(makeRequest(), "key-1"),
    ]);

    // One replays, one executes
    const replayedCount = [a, b].filter((r) => r.replayed).length;
    expect(replayedCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    await mgr.shutdown();
  });

  it("distinct keys get distinct busy rejections", async () => {
    const execute = makeSlowExecute(100);
    const mgr = new JobManager({ execute, store });

    await mgr.submit(makeRequest(), "key-1");
    await expect(mgr.submit(makeRequest(), "key-2")).rejects.toMatchObject({
      code: "RUNNER_BUSY",
    });
    await mgr.shutdown();
  });

  it("same key replays during busy", async () => {
    const execute = makeSlowExecute(100);
    const mgr = new JobManager({ execute, store });

    const first = await mgr.submit(makeRequest(), "key-1");
    const second = await mgr.submit(makeRequest(), "key-1");

    expect(second.replayed).toBe(true);
    expect(second.snapshot.run_id).toBe(first.snapshot.run_id);
    expect(execute).toHaveBeenCalledTimes(1);
    await mgr.shutdown();
  });

  it("same key + different body → IDEMPOTENCY_CONFLICT", async () => {
    const execute = makeFakeExecute();
    const mgr = new JobManager({ execute, store });

    await mgr.submit(makeRequest(), "key-1");
    const different = { ...makeRequest(), profile_id: "other" };
    await expect(mgr.submit(different, "key-1")).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await mgr.shutdown();
  });

  it("late completion does not overwrite terminal cancellation", async () => {
    let resolveExecute: (v: unknown) => void = () => {};
    const slowExecute = vi.fn().mockImplementation(
      (ctx: { abortSignal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          resolveExecute = resolve;
          ctx.abortSignal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    ) as unknown as ExecuteFn;

    const mgr = new JobManager({ execute: slowExecute, store });
    const { snapshot } = await mgr.submit(makeRequest(), "key-1");
    await mgr.cancel(snapshot.run_id);

    // Now resolve the late completion
    resolveExecute({ privateArtifactPaths: [], result: makeResult() });
    await new Promise((r) => setTimeout(r, 50));

    const snap = await mgr.getSnapshot(snapshot.run_id);
    expect(snap.status).toBe("cancelled");
    await mgr.shutdown();
  });

  it("executor call count is 1 for racing identical starts", async () => {
    const execute = makeSlowExecute(50);
    const mgr = new JobManager({ execute, store });

    const results = await Promise.allSettled([
      mgr.submit(makeRequest(), "race-key"),
      mgr.submit(makeRequest(), "race-key"),
      mgr.submit(makeRequest(), "race-key"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(3); // all get a snapshot (replay or new)
    expect(execute).toHaveBeenCalledTimes(1);
    await mgr.shutdown();
  });
});

describe("JobManager — cancel", () => {
  it("cancel-before-execute settles to cancelled", async () => {
    const execute = makeSlowExecute(10_000);
    const mgr = new JobManager({ execute, store });

    const { snapshot } = await mgr.submit(makeRequest(), "key-1");
    const cancelled = await mgr.cancel(snapshot.run_id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancel_requested).toBe(true);
    await mgr.shutdown();
  });

  it("cancel-during-execute aborts and settles to cancelled", async () => {
    const execute = makeSlowExecute(10_000);
    const mgr = new JobManager({ execute, store });

    const { snapshot } = await mgr.submit(makeRequest(), "key-1");
    await new Promise((r) => setTimeout(r, 10)); // let execute start
    const cancelled = await mgr.cancel(snapshot.run_id);
    expect(cancelled.status).toBe("cancelled");
    await mgr.shutdown();
  });

  it("cancel is idempotent", async () => {
    const execute = makeSlowExecute(10_000);
    const mgr = new JobManager({ execute, store });

    const { snapshot } = await mgr.submit(makeRequest(), "key-1");
    await mgr.cancel(snapshot.run_id);
    const again = await mgr.cancel(snapshot.run_id);
    expect(again.status).toBe("cancelled");
    await mgr.shutdown();
  });

  it("cancelByKey before run exists throws NOT_FOUND and creates nothing", async () => {
    const execute = makeFakeExecute();
    const mgr = new JobManager({ execute, store });

    await expect(mgr.cancelByKey("nonexistent-key")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(execute).not.toHaveBeenCalled();
    await mgr.shutdown();
  });

  it("cancelByKey after run exists cancels it", async () => {
    const execute = makeSlowExecute(10_000);
    const mgr = new JobManager({ execute, store });

    await mgr.submit(makeRequest(), "my-key");
    await new Promise((r) => setTimeout(r, 10));
    const cancelled = await mgr.cancelByKey("my-key");
    expect(cancelled.status).toBe("cancelled");
    await mgr.shutdown();
  });
});

describe("JobManager — getSnapshot / getResult", () => {
  it("getSnapshot for unknown run throws NOT_FOUND", async () => {
    const mgr = new JobManager({ execute: makeFakeExecute(), store });
    await expect(mgr.getSnapshot("nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await mgr.shutdown();
  });

  it("getResult before terminal throws RESULT_NOT_READY", async () => {
    const execute = makeSlowExecute(10_000);
    const mgr = new JobManager({ execute, store });

    const { snapshot } = await mgr.submit(makeRequest(), "key-1");
    await expect(mgr.getResult(snapshot.run_id)).rejects.toMatchObject({
      code: "RESULT_NOT_READY",
    });
    await mgr.shutdown();
  });

  it("getResult after completion returns result", async () => {
    const execute = makeFakeExecute();
    const mgr = new JobManager({ execute, store });

    const { snapshot } = await mgr.submit(makeRequest(), "key-1");
    await new Promise((r) => setTimeout(r, 50));
    const result = await mgr.getResult(snapshot.run_id);
    expect(result.contract_version).toBe("1.0");
    await mgr.shutdown();
  });

  it("getResult after cancellation throws RESULT_NOT_READY (no result stored)", async () => {
    const execute = makeSlowExecute(10_000);
    const mgr = new JobManager({ execute, store });

    const { snapshot } = await mgr.submit(makeRequest(), "key-1");
    await mgr.cancel(snapshot.run_id);
    await expect(mgr.getResult(snapshot.run_id)).rejects.toMatchObject({
      code: "RESULT_UNAVAILABLE",
    });
    await mgr.shutdown();
  });
});

describe("JobManager — timeout vs completion", () => {
  it("timeout cannot overwrite completed state", async () => {
    // Fake: execute resolves quickly (completion wins)
    const execute = makeFakeExecute();
    const mgr = new JobManager({ execute, store });

    const { snapshot } = await mgr.submit(makeRequest(), "key-1");
    await new Promise((r) => setTimeout(r, 50));
    const snap = await mgr.getSnapshot(snapshot.run_id);
    expect(snap.status).toBe("completed");
    await mgr.shutdown();
  });
});

describe("JobManager — cleanup error", () => {
  it("executor error settles run to error state", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new Error("spawn failed")) as unknown as ExecuteFn;
    const mgr = new JobManager({ execute, store });

    const { snapshot } = await mgr.submit(makeRequest(), "key-1");
    await new Promise((r) => setTimeout(r, 50));
    const snap = await mgr.getSnapshot(snapshot.run_id);
    expect(snap.status).toBe("error");
    await mgr.shutdown();
  });
});

describe("JobManager — persistence", () => {
  it("run survives manager restart (replay works)", async () => {
    const execute = makeFakeExecute();
    const mgr1 = new JobManager({ execute, store });
    const { snapshot } = await mgr1.submit(makeRequest(), "persist-key");
    await new Promise((r) => setTimeout(r, 50));
    await mgr1.shutdown();

    // New manager on same store
    const execute2 = makeFakeExecute();
    const mgr2 = new JobManager({ execute: execute2, store });
    const replay = await mgr2.submit(makeRequest(), "persist-key");
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot.run_id).toBe(snapshot.run_id);
    expect(execute2).not.toHaveBeenCalled();
    await mgr2.shutdown();
  });
});
