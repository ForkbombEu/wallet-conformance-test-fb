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

import type { RunRequest, RunnerResult } from "../../src/runner-api/contract";
import { JobManager, type ExecuteFn } from "../../src/runner-api/job-manager";
import { JobStore } from "../../src/runner-api/job-store";
import { ArtifactStore } from "../../src/runner-api/artifacts";
import { createRunnerApp } from "../../src/runner-api/server";
import { validateAndAdaptNativeExport } from "../../src/runner-api/native-result-adapter";
import { summarizeResult } from "../../src/runner-api/summarize";

const TOKEN = "composition-token";

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

  it("artifact download with run_id binding works through API", async () => {
    // Setup real composition
    const store = new JobStore(dir);
    const artifacts = new ArtifactStore();
    const jobManager = new JobManager({
      execute: async (ctx) => {
        const resultsDir = join(ctx.runRoot, "results");
        mkdirSync(resultsDir, { recursive: true });
        writeFileSync(
          join(resultsDir, "native-results.json"),
          JSON.stringify(makeProducerExport({ runId: ctx.runId })),
        );

        // Register artifact
        const artifactId = `${ctx.runId}:native-export`;
        artifacts.registerFile(
          artifactId,
          "native-results.json",
          "application/json",
          join(resultsDir, "native-results.json"),
        );

        return {
          privateArtifactPaths: [join(resultsDir, "native-results.json")],
          result: {
            artifacts: [
              {
                artifact_id: artifactId,
                download_url: `/v1/runs/${ctx.runId}/artifacts/${encodeURIComponent(artifactId)}`,
                filename: "native-results.json",
                mime_type: "application/json",
                sha256: "",
                size_bytes: 0,
              },
            ],
            category: "issuance",
            contract_version: "1.0",
            engine: {
              fork_repository: "x",
              id: "pagopa-wct",
              revision: "unknown",
              upstream_repository: "x",
              version: "x",
            },
            execution: {
              started_at: "2026-01-01T00:00:00Z",
              status: "completed",
            },
            limitations: [],
            native: {
              assertions: validateAndAdaptNativeExport(
                makeProducerExport({ runId: ctx.runId }),
                { expectedRunId: ctx.runId },
              ).assertions.map((a) => ({ ...a, assertion_id: "a1" })),
              coverage_mode: "interoperability",
              native_suite_status: "FAILED",
              scenario_outcomes: [],
              sessions: [{ id: "session-1", status: "FAILED" }],
            },
            profile_id: "credimi-issuance-smoke",
            run_id: ctx.runId,
            selection: { ids: ["credimi-issuance-smoke"] },
            summary: {
              assertion_count: 1,
              native_failed_assertion_count: 1,
              result: "fail",
            },
            target: makeRequest().target,
          },
        };
      },
      store,
    });

    const app = createRunnerApp({ artifacts, jobManager });

    // Start real HTTP server
    const { createServer } = await import("node:http");
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No address");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Submit run
    const createRes = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "comp-1",
      },
      method: "POST",
    });
    expect(createRes.status).toBe(202);
    const { run_id } = await createRes.json();

    // Wait for completion
    await new Promise((r) => setTimeout(r, 100));

    // Get result
    const resultRes = await fetch(`${baseUrl}/v1/runs/${run_id}/result`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(resultRes.status).toBe(200);
    const result = await resultRes.json();
    expect(result.summary.result).toBe("fail");

    // Download artifact with run_id binding
    const artifactId = `${run_id}:native-export`;
    const artRes = await fetch(
      `${baseUrl}/v1/runs/${run_id}/artifacts/${encodeURIComponent(artifactId)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(artRes.status).toBe(200);
    expect(artRes.headers.get("x-content-sha256")).toBeTruthy();

    // Cross-run lookup denied
    const crossRes = await fetch(
      `${baseUrl}/v1/runs/OTHER-RUN/artifacts/${encodeURIComponent(artifactId)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(crossRes.status).toBe(404);

    await new Promise<void>((r) => server.close(() => r()));
  });
});
