import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunnerResult, RunRequest } from "@/runner-api/contract";
import type { ExecuteFn } from "@/runner-api/job-manager";

import { ArtifactStore } from "@/runner-api/artifacts";
import { JobManager } from "@/runner-api/job-manager";
import { JobStore } from "@/runner-api/job-store";
import { createRunnerApp } from "@/runner-api/server";

const TOKEN = "test-token-12345";

function makeFakeExecute(delayMs = 10): ExecuteFn {
  return async () =>
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ privateArtifactPaths: [], result: makeResult() }),
        delayMs,
      ),
    );
}

function makeRequest(): RunRequest {
  return {
    category: "issuance",
    contract_version: "1.0",
    parameters: {},
    profile_id: "credimi-issuance-smoke",
    selection: { ids: ["credimi-issuance-smoke"] },
    target: { actor_name: "test", actor_type: "issuer" },
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
      revision: "test",
      upstream_repository: "https://github.com/pagopa/wallet-conformance-test",
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
    profile_id: "credimi-issuance-smoke",
    run_id: "run-1",
    selection: { ids: ["credimi-issuance-smoke"] },
    summary: {
      assertion_count: 0,
      native_failed_assertion_count: 0,
      result: "not_tested",
    },
    target: { actor_name: "test", actor_type: "issuer" },
  };
}

let dir: string;
let store: JobStore;
let artifacts: ArtifactStore;
let jobManager: JobManager;
let baseUrl: string;
let closeServer: () => Promise<void>;

async function startTestServer(
  executeFn: ExecuteFn = makeFakeExecute(),
): Promise<void> {
  store = new JobStore(dir);
  artifacts = new ArtifactStore();
  jobManager = new JobManager({ execute: executeFn, store });
  const app = createRunnerApp({ artifacts, jobManager });

  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  closeServer = async () => {
    await jobManager.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wct-srv-"));
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
  await startTestServer();
});

afterEach(async () => {
  await closeServer();
  rmSync(dir, { force: true, recursive: true });
  Reflect.deleteProperty(process.env, "CREDIMI_RUNNER_TOKEN");
});

function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// -- Health -------------------------------------------------------------------

describe("GET /healthz", () => {
  it("returns 200 without auth", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

// -- Capabilities ---------------------------------------------------------------

describe("GET /v1/capabilities", () => {
  it("requires auth", async () => {
    const res = await fetch(`${baseUrl}/v1/capabilities`);
    expect(res.status).toBe(401);
  });

  it("returns contract version and engine info", async () => {
    const res = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contract_version).toBe("1.0");
    expect(body.engine.id).toBe("pagopa-wct");
    expect(body.categories).toContain("issuance");
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].coverage_mode).toBe("interoperability");
    expect(body.selection_catalogue).toHaveLength(1);
    expect(body.max_timeout_ms).toBe(3_600_000);
  });

  it("does not leak token", async () => {
    const res = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: authHeaders(),
    });
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
  });
});

// -- Submit run -----------------------------------------------------------------

describe("POST /v1/runs", () => {
  it("requires auth", async () => {
    const res = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("requires Idempotency-Key", async () => {
    const res = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders(),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("creates a new run with 202", async () => {
    const res = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    expect(res.status).toBe(202);
    const snapshot = await res.json();
    expect(snapshot.contract_version).toBe("1.0");
    expect(snapshot.engine).toBe("pagopa-wct");
    expect(snapshot.run_id).toBeTruthy();
  });

  it("replays with 200 for same key + same body", async () => {
    const first = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    const second = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    const s1 = await first.json();
    const s2 = await second.json();
    expect(s1.run_id).toBe(s2.run_id);
  });

  it("returns 409 for same key + different body", async () => {
    await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    const res = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify({ ...makeRequest(), timeout_ms: 300_000 }),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("returns 400 for unknown profile", async () => {
    const res = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify({ ...makeRequest(), profile_id: "nonexistent" }),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown selection", async () => {
    const res = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify({
        ...makeRequest(),
        selection: { ids: ["bogus-selection"] },
      }),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed body", async () => {
    const res = await fetch(`${baseUrl}/v1/runs`, {
      body: "not json",
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 for busy runner", async () => {
    // First run with slow executor
    await closeServer();
    await startTestServer(makeFakeExecute(500));

    await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });

    const res = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "key-2" }),
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("RUNNER_BUSY");
  });
});

// -- Get snapshot -----------------------------------------------------------------

describe("GET /v1/runs/:runId", () => {
  it("returns snapshot for known run", async () => {
    const create = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    const { run_id } = await create.json();

    const res = await fetch(`${baseUrl}/v1/runs/${run_id}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const snapshot = await res.json();
    expect(snapshot.run_id).toBe(run_id);
  });

  it("returns 404 for unknown run", async () => {
    const res = await fetch(`${baseUrl}/v1/runs/nonexistent`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

// -- Cancel -------------------------------------------------------------------------

describe("POST /v1/runs/:runId/cancel", () => {
  it("cancels a run", { timeout: 15_000 }, async () => {
    await closeServer();
    await startTestServer(makeFakeExecute(500));

    const create = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    const { run_id } = await create.json();

    const res = await fetch(`${baseUrl}/v1/runs/${run_id}/cancel`, {
      headers: authHeaders(),
      method: "POST",
    });
    expect(res.status).toBe(200);
    const snapshot = await res.json();
    expect(snapshot.cancel_requested).toBe(true);
  });
});

// -- Cancel by key --------------------------------------------------------------------

describe("POST /v1/runs/cancel-by-key", () => {
  it("requires Idempotency-Key", async () => {
    const res = await fetch(`${baseUrl}/v1/runs/cancel-by-key`, {
      headers: authHeaders(),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown key", async () => {
    const res = await fetch(`${baseUrl}/v1/runs/cancel-by-key`, {
      headers: authHeaders({ "Idempotency-Key": "nonexistent-key" }),
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("cancels existing run by key without creating work", async () => {
    // Start a run
    await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "my-key" }),
      method: "POST",
    });

    // Cancel by key
    const res = await fetch(`${baseUrl}/v1/runs/cancel-by-key`, {
      headers: authHeaders({ "Idempotency-Key": "my-key" }),
      method: "POST",
    });
    expect(res.status).toBe(200);
    const snapshot = await res.json();
    expect(snapshot.cancel_requested).toBe(true);
  });
});

// -- Get result ------------------------------------------------------------------------

describe("GET /v1/runs/:runId/result", () => {
  it("returns 409 while running", async () => {
    await closeServer();
    await startTestServer(makeFakeExecute(500));

    const create = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    const { run_id } = await create.json();

    const res = await fetch(`${baseUrl}/v1/runs/${run_id}/result`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(409);
  });

  it("returns result after completion", async () => {
    const create = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "key-1" }),
      method: "POST",
    });
    const { run_id } = await create.json();

    // Wait for completion
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`${baseUrl}/v1/runs/${run_id}/result`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.contract_version).toBe("1.0");
    expect(result.summary).toBeDefined();
  });
});

// -- Artifacts ----------------------------------------------------------------------------

describe("GET /v1/runs/:runId/artifacts/:artifactId", () => {
  it("returns 404 for unknown artifact", async () => {
    const res = await fetch(`${baseUrl}/v1/runs/run-1/artifacts/nonexistent`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for path traversal", async () => {
    const res = await fetch(
      `${baseUrl}/v1/runs/run-1/artifacts/${encodeURIComponent("../../etc/passwd")}`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(400);
  });

  it("serves exact bytes and hash", async () => {
    const content = Buffer.from("artifact content");
    artifacts.register("run-1:art1", "test.json", "application/json", content);

    const res = await fetch(`${baseUrl}/v1/runs/run-1/artifacts/run-1%3Aart1`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(content);
    expect(res.headers.get("X-Content-SHA256")).toHaveLength(64);
  });
});

// -- Import safety --------------------------------------------------------------------------

describe("import safety", () => {
  it("createRunnerApp does not listen on import", () => {
    // The module was already imported at the top of this file.
    // If it had started a server, the test would have hung or errored.
    expect(typeof createRunnerApp).toBe("function");
  });
});
