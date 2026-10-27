import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecuteContext, ExecuteFn } from "@/runner-api/job-manager";

import {
  type RunnerResult,
  runnerResultSchema,
  type RunRequest,
} from "@/runner-api/contract";
import { JobManager } from "@/runner-api/job-manager";
import { JobStore } from "@/runner-api/job-store";
import { summarizeResult } from "@/runner-api/summarize";

// JobManager unit tests: injected typed executors are the intended seam here.

type Assertion = RunnerResult["native"]["assertions"][number];

function assertion(
  index: number,
  status: Assertion["native_status"],
): Assertion {
  return {
    ancestor_titles: ["Suite"],
    assertion_id: `assertion-${index}`,
    file: "/abs/spec.issuance.spec.ts",
    full_title: `Suite > case ${index}`,
    native_status: status,
    phase: "issuance",
  };
}

const ARTIFACT = {
  artifact_id: "native-results.json",
  download_url: "/v1/runs/x/artifacts/native-results.json",
  filename: "native-results.json",
  mime_type: "application/json",
  sha256: "a".repeat(64),
  size_bytes: 10,
};

function makeRequest(timeoutMs = 600_000): RunRequest {
  return {
    category: "issuance",
    contract_version: "1.0",
    parameters: {},
    profile_id: "p",
    selection: { ids: ["s"] },
    target: { actor_name: "x", actor_type: "issuer" },
    timeout_ms: timeoutMs,
  };
}

function nativeResult(
  ctx: ExecuteContext,
  assertions: Assertion[],
  execution: Partial<RunnerResult["execution"]> = {},
): RunnerResult {
  const exec: RunnerResult["execution"] = {
    exit_code: 0,
    finished_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    status: "completed",
    ...execution,
  };
  const native: RunnerResult["native"] = {
    assertions,
    coverage_mode: "interoperability",
    native_suite_status: "FAILED",
    scenario_outcomes: [],
    sessions: [{ id: "session-1", status: "FAILED" }],
  };
  return {
    artifacts: [{ ...ARTIFACT, download_url: `/v1/runs/${ctx.runId}/x` }],
    category: "issuance",
    contract_version: "1.0",
    engine: {
      fork_repository: "f",
      id: "pagopa-wct",
      revision: "unknown",
      upstream_repository: "u",
      version: "1.2.1",
    },
    execution: exec,
    limitations: [],
    native,
    profile_id: "p",
    run_id: ctx.runId,
    selection: ctx.request.selection,
    summary: summarizeResult(exec, native),
    target: ctx.request.target,
  };
}

/** Resolves once aborted, either rejecting or returning prior evidence. */
function untilAborted(
  ctx: ExecuteContext,
  onAbort: () => Promise<never> | RunnerResult,
): Promise<{ privateArtifactPaths: string[]; result: RunnerResult }> {
  return new Promise((resolve, reject) => {
    ctx.abortSignal.addEventListener("abort", () => {
      try {
        const value = onAbort();
        if (value instanceof Promise) {
          value.catch(reject);
          return;
        }
        resolve({ privateArtifactPaths: [], result: value });
      } catch (error) {
        reject(error);
      }
    });
  });
}

let dir: string;
let manager: JobManager;

async function settle(runId: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const snap = await manager.getSnapshot(runId);
    if (["cancelled", "completed", "error", "timed_out"].includes(snap.status))
      return snap.status;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run did not settle");
}

function start(execute: ExecuteFn): JobManager {
  manager = new JobManager({ execute, store: new JobStore(dir) });
  return manager;
}

/** Snapshot and result must agree and the result must be wire-valid. */
async function terminal(runId: string): Promise<RunnerResult> {
  const status = await settle(runId);
  const result = runnerResultSchema.parse(await manager.getResult(runId));
  expect(result.execution.status).toBe(status);
  expect(result.execution.finished_at).toBeTruthy();
  return result;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-l11-"));
});

afterEach(async () => {
  await manager.shutdown();
  rmSync(dir, { force: true, recursive: true });
});

describe("L11 — terminal state and result agree", () => {
  it("a readable failed suite with nonzero exit is completed + fail", async () => {
    start(async (ctx) => ({
      privateArtifactPaths: [],
      result: nativeResult(ctx, [assertion(0, "PASS"), assertion(1, "FAIL")], {
        exit_code: 1,
      }),
    }));
    const { snapshot } = await manager.submit(makeRequest(), "k");
    const result = await terminal(snapshot.run_id);
    expect(result.execution.status).toBe("completed");
    expect(result.summary.result).toBe("fail");
  });

  it("worker returning execution.status=error is error in both", async () => {
    start(async (ctx) => ({
      privateArtifactPaths: [],
      result: nativeResult(ctx, [], { exit_code: 1, status: "error" }),
    }));
    const { snapshot } = await manager.submit(makeRequest(), "k");
    const result = await terminal(snapshot.run_id);
    expect(result.execution.status).toBe("error");
  });

  it("deadline then worker rejects is timed_out in both", async () => {
    start((ctx) =>
      untilAborted(ctx, () => Promise.reject(new Error("child killed"))),
    );
    const { snapshot } = await manager.submit(makeRequest(50), "k");
    const result = await terminal(snapshot.run_id);
    expect(result.execution.status).toBe("timed_out");
    expect(result.summary.result).toBe("not_tested");
  });

  it("deadline then worker resolves with prior PASS assertions is timed_out + partial", async () => {
    start((ctx) =>
      untilAborted(ctx, () => nativeResult(ctx, [assertion(0, "PASS")])),
    );
    const { snapshot } = await manager.submit(makeRequest(50), "k");
    const result = await terminal(snapshot.run_id);
    expect(result.execution.status).toBe("timed_out");
    expect(result.summary.result).toBe("partial");
    expect(result.native.assertions).toHaveLength(1);
    expect(result.artifacts).toHaveLength(1);
  });

  it("cancel with zero assertions returns a readable cancelled envelope", async () => {
    start((ctx) =>
      untilAborted(ctx, () => Promise.reject(new Error("aborted"))),
    );
    const { snapshot } = await manager.submit(makeRequest(), "k");
    const cancelled = await manager.cancel(snapshot.run_id);
    expect(cancelled.status).toBe("cancelled");
    const result = await terminal(snapshot.run_id);
    expect(result.summary.result).toBe("not_tested");
  });

  it("cancel retains partial assertions and artifacts and is partial, not pass", async () => {
    start((ctx) =>
      untilAborted(ctx, () =>
        nativeResult(ctx, [assertion(0, "PASS"), assertion(1, "PASS")]),
      ),
    );
    const { snapshot } = await manager.submit(makeRequest(), "k");
    await manager.cancel(snapshot.run_id);
    const result = await terminal(snapshot.run_id);
    expect(result.execution.status).toBe("cancelled");
    expect(result.summary.result).toBe("partial");
    expect(result.native.assertions).toHaveLength(2);
    expect(result.artifacts).toHaveLength(1);
  });

  it("a late worker result after cancellation cannot turn the run into a pass", async () => {
    // Worker ignores the abort and later reports a full pass.
    start(
      (ctx) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                privateArtifactPaths: [],
                result: nativeResult(ctx, [assertion(0, "PASS")]),
              }),
            100,
          ),
        ),
    );
    const { snapshot } = await manager.submit(makeRequest(), "k");
    await manager.cancel(snapshot.run_id);
    const result = await terminal(snapshot.run_id);
    expect(result.execution.status).toBe("cancelled");
    expect(result.summary.result).toBe("partial");
  });

  it("cancel and shutdown are idempotent", async () => {
    start((ctx) =>
      untilAborted(ctx, () => Promise.reject(new Error("aborted"))),
    );
    const { snapshot } = await manager.submit(makeRequest(), "k");
    const [a, b] = await Promise.all([
      manager.cancel(snapshot.run_id),
      manager.cancel(snapshot.run_id),
    ]);
    expect(a.status).toBe("cancelled");
    expect(b.status).toBe("cancelled");
    await Promise.all([manager.shutdown(), manager.shutdown()]);
  });
});

describe("L11 — shutdown", () => {
  it("blocks new submissions once shutdown starts and finalizes the live run", async () => {
    let release: () => void = () => undefined;
    const cleanupDone = new Promise<void>((r) => (release = r));
    start((ctx) =>
      untilAborted(ctx, () =>
        // Worker cleanup takes a while after the abort.
        cleanupDone.then(() => {
          throw new Error("terminated by shutdown");
        }),
      ),
    );
    const { snapshot } = await manager.submit(makeRequest(), "k1");
    const stopping = manager.shutdown();

    await expect(manager.submit(makeRequest(), "k2")).rejects.toMatchObject({
      code: "RUNNER_SHUTTING_DOWN",
    });
    // Identical replay is still answered.
    const replay = await manager.submit(makeRequest(), "k1");
    expect(replay.replayed).toBe(true);
    // The slot stays owned until worker cleanup completes.
    expect((await manager.getSnapshot(snapshot.run_id)).status).toBe("running");

    release();
    await stopping;
    const result = await terminal(snapshot.run_id);
    expect(result.execution.status).toBe("cancelled");
    expect(result.limitations.join(" ")).toMatch(/shutdown/);
  });
});

describe("L11 — interaction ACK (legacy has no pending interactions)", () => {
  it("an ACK for an unknown interaction is NOT_FOUND and leaves the run alone", async () => {
    start((ctx) =>
      untilAborted(ctx, () => Promise.reject(new Error("aborted"))),
    );
    const { snapshot } = await manager.submit(makeRequest(), "k");
    await expect(
      manager.acknowledge(snapshot.run_id, "nope", {
        driver_status: "failed",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const snap = await manager.getSnapshot(snapshot.run_id);
    expect(snap.status).toBe("running");
    expect(snap.cancel_requested).toBe(false);
  });
});
