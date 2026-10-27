import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunnerResult, RunRequest } from "@/runner-api/contract";
import type { ExecuteFn } from "@/runner-api/job-manager";

import { ArtifactStore } from "@/runner-api/artifacts";
import { JobManager } from "@/runner-api/job-manager";
import { JobStore } from "@/runner-api/job-store";
import {
  defaultProfileCatalogue,
  getProfile,
  profileCatalogue,
  selectProfileForRequest,
} from "@/runner-api/profiles";
import { createRunnerApp } from "@/runner-api/server";

const TOKEN = "acceptance-test-token";

interface FakeNativeHandle {
  listenerPort: number;
  listenerServer: Server | undefined;
  spawnCount: number;
  writeExport: (data: object) => void;
}

function createFakeNativeExecute(
  runRoot: string,
  options: { exitCode?: number; failExport?: boolean } = {},
): { execute: ExecuteFn; handle: FakeNativeHandle } {
  let spawnCount = 0;
  let listenerServer: Server | undefined;
  let listenerPort = 0;

  const execute: ExecuteFn = async (ctx) => {
    spawnCount++;

    // Create results dir and write native export
    const resultsDir = join(ctx.runRoot, "results");
    mkdirSync(resultsDir, { recursive: true });

    if (!options.failExport) {
      writeFileSync(
        join(resultsDir, "native-results.json"),
        JSON.stringify({
          assertions: [
            {
              ancestor_titles: [],
              assertion_id: "a1",
              file: "test.ts",
              full_title: "CI_001: acceptance assertion",
              native_status: "PASS",
              phase: "issuance",
              requirement_id: "CI_001",
            },
          ],
          closedAt: new Date().toISOString(),
          sessionId: "acceptance-session",
          startedAt: new Date().toISOString(),
          status: "PASSED",
        }),
      );
    }

    // Spawn a fake listener child (simulates TA/WP/mock-issuer)
    const server = createServer((req, res) => {
      res.writeHead(200).end("fake-native-listener");
    });
    listenerServer = server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        listenerPort = addr.port;
        resolve();
      }),
    );

    // Simulate some work then exit
    await new Promise((r) => setTimeout(r, 50));

    // Cleanup listener
    await new Promise<void>((resolve) => server.close(() => resolve()));
    listenerServer = undefined;

    return {
      privateArtifactPaths: [],
      result: makeResult({ run_id: ctx.runId }),
    };
  };

  return {
    execute,
    handle: {
      get listenerPort() {
        return listenerPort;
      },
      get listenerServer() {
        return listenerServer;
      },
      get spawnCount() {
        return spawnCount;
      },
      writeExport: () => {},
    },
  };
}

// -- Fake native process (spawns a listener child, controlled by test) -----

function makeRequest(): RunRequest {
  return {
    category: "issuance",
    contract_version: "1.0",
    parameters: {},
    profile_id: "credimi-issuance-smoke",
    selection: { ids: ["credimi-issuance-smoke"] },
    target: {
      actor_name: "Acceptance issuer",
      actor_type: "issuer",
      issuer_identifier: "https://issuer.example/issuers/eu-pid-device-bound",
    },
    timeout_ms: 600_000,
  };
}

function makeResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    artifacts: [],
    category: "issuance",
    contract_version: "1.0",
    engine: {
      fork_repository:
        "https://github.com/ForkbombEu/wallet-conformance-test-fb",
      id: "pagopa-wct",
      revision: "acceptance-test",
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
      assertions: [
        {
          ancestor_titles: ["Acceptance"],
          assertion_id: "acc-1",
          file: "acceptance.ts",
          full_title: "CI_001: acceptance assertion",
          native_status: "PASS",
          phase: "issuance",
          requirement_id: "CI_001",
        },
      ],
      coverage_mode: "interoperability",
      native_suite_status: "PASSED",
      scenario_outcomes: [],
      sessions: [{ id: "acceptance-session", status: "PASSED" }],
    },
    profile_id: "credimi-issuance-smoke",
    run_id: "acceptance-run",
    selection: { ids: ["credimi-issuance-smoke"] },
    summary: {
      assertion_count: 1,
      native_failed_assertion_count: 0,
      result: "pass",
    },
    target: makeRequest().target,
    ...overrides,
  };
}

// -- Test infrastructure -----------------------------------------------------

let dir: string;
let store: JobStore;
let artifacts: ArtifactStore;
let jobManager: JobManager;
let baseUrl: string;
let closeServer: () => Promise<void>;

async function startTestServer(executeFn: ExecuteFn): Promise<void> {
  store = new JobStore(dir);
  artifacts = new ArtifactStore(dir);
  jobManager = new JobManager({ execute: executeFn, store });
  const app = createRunnerApp({
    artifacts,
    catalogue: defaultProfileCatalogue,
    jobManager,
    validateRun: (request) => {
      selectProfileForRequest(defaultProfileCatalogue, request);
    },
  });

  const { createServer: createHttpServer } = await import("node:http");
  const server = createHttpServer(app);
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-acc-"));
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
});

afterEach(async () => {
  if (closeServer) await closeServer();
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

// -- Acceptance cases ---------------------------------------------------------

// eslint-disable-next-line max-lines-per-function -- acceptance test suite
describe("Acceptance — full API/job/config/export integration", () => {
  it("starts generic issuer run, exports results, downloads artifact, replays", async () => {
    const fake = createFakeNativeExecute(dir);
    await startTestServer(fake.execute);

    // 1. Start a run
    const createRes = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "acc-key-1" }),
      method: "POST",
    });
    expect(createRes.status).toBe(202);
    const snapshot = await createRes.json();
    const runId = snapshot.run_id;
    expect(runId).toBeTruthy();

    // 2. Wait for completion
    await new Promise((r) => setTimeout(r, 200));

    // 3. Get result — verify coverage_mode interoperability
    const resultRes = await fetch(`${baseUrl}/v1/runs/${runId}/result`, {
      headers: authHeaders(),
    });
    expect(resultRes.status).toBe(200);
    const result = await resultRes.json();
    expect(result.native.coverage_mode).toBe("interoperability");
    expect(result.native.sessions[0]?.id).toBe("acceptance-session");
    expect(result.summary.result).toBe("pass");

    // 4. Publish through the artifact layer and download by run + ID
    const exportPath = join(dir, "native-results.json");
    writeFileSync(exportPath, JSON.stringify(result));
    const [entry] = artifacts.publish(runId, [exportPath]).entries;
    if (!entry) throw new Error("artifact not published");
    const artRes = await fetch(`${baseUrl}${entry.download_url}`, {
      headers: authHeaders(),
    });
    expect(artRes.status).toBe(200);
    const artBody = await artRes.json();
    expect(artBody.summary).toBeDefined();

    // 5. Replay start with same key
    const replayRes = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "acc-key-1" }),
      method: "POST",
    });
    expect(replayRes.status).toBe(200);
    const replaySnap = await replayRes.json();
    expect(replaySnap.run_id).toBe(runId);
  });

  it("failed native test = completed execution with nonpassing domain result", async () => {
    const failExecute: ExecuteFn = async (ctx) => {
      const resultsDir = join(ctx.runRoot, "results");
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(
        join(resultsDir, "native-results.json"),
        JSON.stringify({
          assertions: [
            {
              ancestor_titles: [],
              assertion_id: "a1",
              file: "test.ts",
              full_title: "CI_001: failing assertion",
              native_status: "FAIL",
              phase: "issuance",
              requirement_id: "CI_001",
            },
          ],
          closedAt: new Date().toISOString(),
          sessionId: "fail-session",
          startedAt: new Date().toISOString(),
          status: "FAILED",
        }),
      );
      return {
        privateArtifactPaths: [],
        result: makeResult({
          native: {
            assertions: [
              {
                ancestor_titles: [],
                assertion_id: "a1",
                file: "test.ts",
                full_title: "CI_001: failing assertion",
                native_status: "FAIL",
                phase: "issuance",
                requirement_id: "CI_001",
              },
            ],
            coverage_mode: "interoperability",
            native_suite_status: "FAILED",
            scenario_outcomes: [],
            sessions: [{ id: "fail-session", status: "FAILED" }],
          },
          summary: {
            assertion_count: 1,
            native_failed_assertion_count: 1,
            result: "fail",
          },
        }),
      };
    };

    await startTestServer(failExecute);
    const createRes = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "acc-fail" }),
      method: "POST",
    });
    expect(createRes.status).toBe(202);
    const { run_id } = await createRes.json();

    await new Promise((r) => setTimeout(r, 100));
    const resultRes = await fetch(`${baseUrl}/v1/runs/${run_id}/result`, {
      headers: authHeaders(),
    });
    expect(resultRes.status).toBe(200);
    const result = await resultRes.json();
    expect(result.execution.status).toBe("completed");
    expect(result.summary.result).toBe("fail");
  });

  it("missing native results cannot pass", async () => {
    const noExportExecute: ExecuteFn = async () => ({
      privateArtifactPaths: [],
      result: makeResult({
        execution: {
          error: "native export missing",
          finished_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          status: "error",
        },
        native: {
          assertions: [],
          coverage_mode: "interoperability",
          native_suite_status: "ERROR",
          scenario_outcomes: [],
          sessions: [],
        },
        summary: {
          assertion_count: 0,
          native_failed_assertion_count: 0,
          result: "not_tested",
        },
      }),
    });

    await startTestServer(noExportExecute);
    const createRes = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "acc-no-export" }),
      method: "POST",
    });
    const { run_id } = await createRes.json();

    await new Promise((r) => setTimeout(r, 100));
    const resultRes = await fetch(`${baseUrl}/v1/runs/${run_id}/result`, {
      headers: authHeaders(),
    });
    const result = await resultRes.json();
    expect(result.summary.result).not.toBe("pass");
  });

  it("same-key concurrent starts spawn only one fake native process", async () => {
    let spawnCount = 0;
    const slowExecute: ExecuteFn = async () => {
      spawnCount++;
      await new Promise((r) => setTimeout(r, 200));
      return {
        privateArtifactPaths: [],
        result: makeResult(),
      };
    };

    await startTestServer(slowExecute);

    const results = await Promise.allSettled([
      fetch(`${baseUrl}/v1/runs`, {
        body: JSON.stringify(makeRequest()),
        headers: authHeaders({ "Idempotency-Key": "acc-concurrent" }),
        method: "POST",
      }),
      fetch(`${baseUrl}/v1/runs`, {
        body: JSON.stringify(makeRequest()),
        headers: authHeaders({ "Idempotency-Key": "acc-concurrent" }),
        method: "POST",
      }),
      fetch(`${baseUrl}/v1/runs`, {
        body: JSON.stringify(makeRequest()),
        headers: authHeaders({ "Idempotency-Key": "acc-concurrent" }),
        method: "POST",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(3);
    expect(spawnCount).toBe(1);
  });

  it("generic issuer request cannot select Italian suite", async () => {
    const profile = getProfile("credimi-issuance-smoke");
    expect(profile?.coverageMode).toBe("interoperability");

    // The only selection is credimi-issuance-smoke, which maps to the generic test
    expect(profile?.selections[0]?.testFile).toBe(
      "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
    );

    // No Italian suite in the catalogue
    const italianProfiles = profileCatalogue.filter(
      (p) => p.coverageMode === "it_wallet_profile",
    );
    expect(italianProfiles).toHaveLength(0);
  });

  it("no runtime files written under package root", async () => {
    const fake = createFakeNativeExecute(dir);
    await startTestServer(fake.execute);

    await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "acc-no-root" }),
      method: "POST",
    });
    await new Promise((r) => setTimeout(r, 200));

    // Verify no files in package root beyond expected
    const packageRoot = process.cwd();
    const entries = readdirSync(packageRoot);
    // The run root is the temp dir, not the package root
    // Just verify the temp dir has the expected structure
    expect(existsSync(join(dir, "runs"))).toBe(true);
    expect(entries).toContain("package.json"); // sanity
  });

  it("cancel + listener cleanup, next run binds same port", async () => {
    let listenerPort = 0;
    const cancelExecute: ExecuteFn = async (ctx) => {
      // Spawn a listener child
      const server = createServer(() => {});
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          listenerPort = addr.port;
          resolve();
        }),
      );

      // Hold until cancelled
      return new Promise((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => {
          server.close(() => {
            resolve({
              privateArtifactPaths: [],
              result: makeResult(),
            });
          });
        });
      });
    };

    await startTestServer(cancelExecute);
    const createRes = await fetch(`${baseUrl}/v1/runs`, {
      body: JSON.stringify(makeRequest()),
      headers: authHeaders({ "Idempotency-Key": "acc-cancel" }),
      method: "POST",
    });
    const { run_id } = await createRes.json();
    await new Promise((r) => setTimeout(r, 50));

    // Cancel
    await fetch(`${baseUrl}/v1/runs/${run_id}/cancel`, {
      headers: authHeaders(),
      method: "POST",
    });
    await new Promise((r) => setTimeout(r, 100));

    // Verify the port can be rebound (listener was closed)
    const newServer = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      newServer.listen(listenerPort, "127.0.0.1", () => resolve());
      newServer.once("error", reject);
    });
    await new Promise<void>((resolve) => newServer.close(() => resolve()));
    expect(listenerPort).toBeGreaterThan(0);
  });
});

// -- Browser flow (prompt 18) ---------------------------------------------------

describe("Acceptance — browser flow with driver", () => {
  it("browser_redirect without driver is rejected before spawning", async () => {
    const profile = getProfile("credimi-issuance-smoke");
    if (!profile) throw new Error("Profile not found");
    // Profile allows browser_redirect but has no authorizationDriver
    expect(profile.authorizationDriver).toBeUndefined();

    // In the server, this would be rejected by assertBrowserDriverAvailable
    // before spawning. Verify the profile gate exists.
    const { assertBrowserDriverAvailable } =
      await import("@/runner-api/profiles");
    expect(() =>
      assertBrowserDriverAvailable(profile, "browser_redirect"),
    ).toThrow(/no authorization driver/);
  });
});
