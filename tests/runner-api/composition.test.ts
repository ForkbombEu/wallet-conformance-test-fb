import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultProfileCatalogue,
  selectProfileForRequest,
} from "@/runner-api/profiles";

import type { RunnerResult, RunRequest } from "../../src/runner-api/contract";

import { ArtifactStore } from "../../src/runner-api/artifacts";
import { type ExecuteFn, JobManager } from "../../src/runner-api/job-manager";
import { JobStore } from "../../src/runner-api/job-store";
import { validateAndAdaptNativeExport } from "../../src/runner-api/native-result-adapter";
import { createRunnerApp } from "../../src/runner-api/server";
import { summarizeResult } from "../../src/runner-api/summarize";

const TOKEN = "composition-token";

// Real producer export format (camelCase from native-export.ts)
function makeProducerExport(overrides: Record<string, unknown> = {}) {
  return {
    assertions: [
      {
        ancestorTitles: ["Suite"],
        description: "test",
        errorMessage: null,
        file: "test.ts",
        nativeStatus: "FAIL",
        phase: "issuance",
        requirementId: "CI_001",
        timestamp: "2026-01-01T00:00:00Z",
        title: "CI_001: failing assertion",
        vitestStatus: "failed",
      },
    ],
    closedAt: "2026-01-01T00:00:02Z",
    phase: "issuance",
    runId: "run-1",
    sessionId: "session-1",
    startedAt: "2026-01-01T00:00:00Z",
    status: "FAILED",
    ...overrides,
  };
}

function makeRequest(): RunRequest {
  return {
    category: "issuance",
    contract_version: "1.0",
    parameters: {},
    profile_id: "credimi-issuance-smoke",
    selection: { ids: ["credimi-issuance-smoke"] },
    target: {
      actor_name: "test",
      actor_type: "issuer",
      issuer_identifier: "https://issuer.example",
    },
    timeout_ms: 600_000,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-compose-"));
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
  Reflect.deleteProperty(process.env, "CREDIMI_RUNNER_TOKEN");
});

describe("Real composition — producer → adapter → summarizer → API", () => {
  it("failed assertion stays fail through the full chain", async () => {
    // 1. Real producer writes export (camelCase)
    const resultsDir = join(dir, "results");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      join(resultsDir, "native-results.json"),
      JSON.stringify(makeProducerExport()),
    );

    // 2. Real adapter converts and validates
    const raw = JSON.parse(
      readFileSync(join(resultsDir, "native-results.json"), "utf-8"),
    );
    const adapted = validateAndAdaptNativeExport(raw, {
      expectedRunId: "run-1",
    });
    expect(adapted.assertions[0]?.native_status).toBe("FAIL");

    // 3. Real summarizer produces fail
    const summary = summarizeResult(
      { started_at: "2026-01-01T00:00:00Z", status: "completed" },
      {
        assertions: adapted.assertions,
        coverage_mode: "interoperability",
        native_suite_status: adapted.status,
        scenario_outcomes: [],
        sessions: [],
      },
    );
    expect(summary.result).toBe("fail");
    expect(summary.native_failed_assertion_count).toBe(1);
  });

  it("INCONCLUSIVE scenario with failed assertion stays inconclusive", () => {
    const adapted = validateAndAdaptNativeExport(makeProducerExport(), {
      expectedRunId: "run-1",
    });
    const summary = summarizeResult(
      { started_at: "2026-01-01T00:00:00Z", status: "completed" },
      {
        assertions: adapted.assertions,
        coverage_mode: "interoperability",
        native_suite_status: "INCONCLUSIVE",
        scenario_outcomes: [
          { scenario_id: "WP_RP_HAPPY", verdict: "INCONCLUSIVE" },
        ],
        sessions: [],
      },
    );
    expect(summary.result).toBe("inconclusive");
    expect(summary.native_failed_assertion_count).toBe(1);
  });

  it("runId mismatch is rejected", () => {
    try {
      validateAndAdaptNativeExport(makeProducerExport(), {
        expectedRunId: "other-run",
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("RUN_ID_MISMATCH");
    }
  });

  it("zero assertions = not_tested", () => {
    const adapted = validateAndAdaptNativeExport(
      makeProducerExport({ assertions: [] }),
      { expectedRunId: "run-1" },
    );
    const summary = summarizeResult(
      { started_at: "2026-01-01T00:00:00Z", status: "completed" },
      {
        assertions: adapted.assertions,
        coverage_mode: "interoperability",
        native_suite_status: adapted.status,
        scenario_outcomes: [],
        sessions: [],
      },
    );
    expect(summary.result).toBe("not_tested");
  });

  it("stale export from different run is rejected", () => {
    const staleExport = makeProducerExport({ runId: "OLD-RUN" });
    try {
      validateAndAdaptNativeExport(staleExport, { expectedRunId: "NEW-RUN" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("RUN_ID_MISMATCH");
    }
  });
});
