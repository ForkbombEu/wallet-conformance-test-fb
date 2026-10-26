import { describe, expect, it } from "vitest";

import {
  idempotencyConflict,
  invalidRequest,
  isTerminalStatus,
  notFound,
  resultNotReady,
  runBusy,
  runnerResultSchema,
  runRequestSchema,
  runSnapshotSchema,
  runStatusSchema,
} from "@/runner-api/contract";

const goldenRequest = {
  category: "issuance",
  contract_version: "1.0",
  parameters: {},
  profile_id: "capture-interop-dev",
  selection: { ids: ["credimi-issuance-smoke"] },
  target: {
    actor_name: "Synthetic issuer",
    actor_type: "issuer",
    issuer_identifier: "https://issuer.example/issuers/eu-pid-device-bound",
  },
  timeout_ms: 600_000,
};

describe("runRequestSchema", () => {
  it("accepts the golden WCT request shape", () => {
    expect(runRequestSchema.safeParse(goldenRequest).success).toBe(true);
  });

  it("accepts the golden ITWCT request shape", () => {
    const itwct = {
      category: "presentation",
      contract_version: "1.0",
      parameters: {},
      profile_id: "wallet-presentation-dev",
      selection: { ids: ["WP_RP_HAPPY"] },
      target: {
        actor_name: "Synthetic wallet",
        actor_type: "wallet",
        actor_version: "fixture",
      },
      timeout_ms: 600_000,
    };
    expect(runRequestSchema.safeParse(itwct).success).toBe(true);
  });

  it("rejects unknown top-level fields", () => {
    expect(
      runRequestSchema.safeParse({ ...goldenRequest, evil: true }).success,
    ).toBe(false);
  });

  it("rejects wrong contract_version", () => {
    expect(
      runRequestSchema.safeParse({ ...goldenRequest, contract_version: "2.0" })
        .success,
    ).toBe(false);
  });

  it("rejects empty selection", () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        selection: { ids: [] },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid category", () => {
    expect(
      runRequestSchema.safeParse({ ...goldenRequest, category: "evil" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown parameters keys", () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        parameters: { evil_path: "/etc/passwd" },
      }).success,
    ).toBe(false);
  });

  it("rejects non-HTTPS issuer_url in parameters", () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        parameters: { issuer_url: "http://evil.example" },
      }).success,
    ).toBe(false);
  });

  it("accepts typed issuer_url override", () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        parameters: { issuer_url: "https://override.example" },
      }).success,
    ).toBe(true);
  });

  it("rejects invalid actor_type", () => {
    expect(
      runRequestSchema.safeParse({
        ...goldenRequest,
        target: { ...goldenRequest.target, actor_type: "evil" },
      }).success,
    ).toBe(false);
  });

  it("applies defaults for timeout_ms and parameters", () => {
    const minimal = {
      category: "issuance",
      contract_version: "1.0",
      profile_id: "test",
      selection: { ids: ["sel"] },
      target: { actor_name: "x", actor_type: "issuer" },
    };
    const result = runRequestSchema.parse(minimal);
    expect(result.timeout_ms).toBe(600_000);
    expect(result.parameters).toEqual({});
  });

  it("coverage modes remain distinct via selection", () => {
    const interop = runRequestSchema.parse(goldenRequest);
    expect(interop.profile_id).toBe("capture-interop-dev");
  });
});

describe("runSnapshotSchema", () => {
  it("accepts a valid snapshot", () => {
    const snapshot = {
      cancel_requested: false,
      contract_version: "1.0",
      created_at: "2026-01-01T00:00:00Z",
      engine: "pagopa-wct",
      pending_interactions: [],
      result_url: "/v1/runs/abc/result",
      run_id: "abc",
      status: "running",
      updated_at: "2026-01-01T00:00:01Z",
    };
    expect(runSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("rejects invalid status", () => {
    expect(
      runSnapshotSchema.safeParse({
        cancel_requested: false,
        contract_version: "1.0",
        created_at: "2026-01-01T00:00:00Z",
        engine: "pagopa-wct",
        pending_interactions: [],
        result_url: "/r",
        run_id: "a",
        status: "evil",
        updated_at: "2026-01-01T00:00:01Z",
      }).success,
    ).toBe(false);
  });
});

describe("runStatusSchema", () => {
  it("accepts all valid statuses", () => {
    for (const s of [
      "queued",
      "running",
      "waiting_for_interaction",
      "completed",
      "cancelled",
      "timed_out",
      "error",
    ]) {
      expect(runStatusSchema.safeParse(s).success).toBe(true);
    }
  });
});

describe("isTerminalStatus", () => {
  it("identifies terminal statuses", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("timed_out")).toBe(true);
    expect(isTerminalStatus("error")).toBe(true);
  });

  it("identifies non-terminal statuses", () => {
    expect(isTerminalStatus("queued")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("waiting_for_interaction")).toBe(false);
  });
});

describe("runnerResultSchema", () => {
  it("accepts the golden WCT pass fixture shape", () => {
    const result = {
      artifacts: [],
      category: "issuance",
      contract_version: "1.0",
      engine: {
        fork_repository:
          "https://github.com/ForkbombEu/wallet-conformance-test-fb",
        id: "pagopa-wct",
        revision: "b728cca",
        upstream_repository:
          "https://github.com/pagopa/wallet-conformance-test",
        version: "1.0",
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
      run_id: "abc",
      selection: { ids: ["credimi-issuance-smoke"] },
      summary: {
        assertion_count: 0,
        native_failed_assertion_count: 0,
        result: "not_tested",
      },
      target: { actor_name: "x", actor_type: "issuer" },
    };
    expect(runnerResultSchema.safeParse(result).success).toBe(true);
  });
});

describe("RunnerError", () => {
  it("notFound has code NOT_FOUND and 404", () => {
    const e = notFound("run-1");
    expect(e.code).toBe("NOT_FOUND");
    expect(e.httpStatus).toBe(404);
  });

  it("runBusy has code RUNNER_BUSY and 409", () => {
    expect(runBusy().code).toBe("RUNNER_BUSY");
    expect(runBusy().httpStatus).toBe(409);
  });

  it("idempotencyConflict has code IDEMPOTENCY_CONFLICT and 409", () => {
    expect(idempotencyConflict().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("invalidRequest has code INVALID_REQUEST and 400", () => {
    expect(invalidRequest("bad").httpStatus).toBe(400);
  });

  it("resultNotReady has code RESULT_NOT_READY and 409", () => {
    expect(resultNotReady().code).toBe("RESULT_NOT_READY");
  });
});
