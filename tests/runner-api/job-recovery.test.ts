import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecuteFn } from "@/runner-api/job-manager";

import { packageRoot } from "@/logic/runtime-paths";
import {
  type RunnerResult,
  runnerResultSchema,
  type RunRequest,
  runRequestSchema,
} from "@/runner-api/contract";
import { JobManager } from "@/runner-api/job-manager";
import { JobStore, type StoredRun } from "@/runner-api/job-store";
import { startRunner } from "@/runner-api/main";

const TOKEN = "l12-token";

/** The pre-L02 algorithm: replacer array of top-level keys (lossy). */
function legacyHash(request: RunRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(request, Object.keys(request).sort()))
    .digest("hex");
}

function makeRequest(target: Partial<RunRequest["target"]> = {}): RunRequest {
  return runRequestSchema.parse({
    category: "issuance",
    contract_version: "1.0",
    profile_id: "p",
    selection: { ids: ["s"] },
    target: {
      actor_name: "issuer-a",
      actor_type: "issuer",
      issuer_identifier: "https://a.example",
      ...target,
    },
  });
}

/** Writes a record and its index exactly as the old store did. */
function seedLegacyRecord(
  root: string,
  runId: string,
  key: string,
  request: RunRequest,
  extra: Partial<StoredRun> = {},
): void {
  mkdirSync(join(root, "runs"), { recursive: true });
  mkdirSync(join(root, "index"), { recursive: true });
  const keyHash = JobStore.keyHash("default", key);
  const record = {
    cancelRequested: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    idempotencyKeyHash: keyHash,
    namespace: "default",
    request,
    requestHash: legacyHash(request),
    result: storedResult(runId, request),
    runId,
    status: "completed",
    updatedAt: "2026-10-01T00:00:01.000Z",
    ...extra,
  };
  writeFileSync(join(root, "runs", `${runId}.json`), JSON.stringify(record));
  writeFileSync(
    join(root, "index", `${keyHash}.json`),
    JSON.stringify({ keyHash, runId }),
  );
}

function storedResult(runId: string, request: RunRequest): RunnerResult {
  return {
    artifacts: [],
    category: "issuance",
    contract_version: "1.0",
    engine: {
      fork_repository: "f",
      id: "pagopa-wct",
      revision: "unknown",
      upstream_repository: "u",
      version: "1.2.1",
    },
    execution: {
      exit_code: 1,
      finished_at: "2026-10-01T00:00:01.000Z",
      started_at: "2026-10-01T00:00:00.000Z",
      status: "completed",
    },
    limitations: [],
    native: {
      assertions: [
        {
          ancestor_titles: [],
          assertion_id: "assertion-0",
          file: "/x.issuance.spec.ts",
          full_title: "case",
          native_status: "FAIL",
          phase: "issuance",
        },
      ],
      coverage_mode: "interoperability",
      native_suite_status: "FAILED",
      scenario_outcomes: [],
      sessions: [],
    },
    profile_id: "p",
    run_id: runId,
    selection: request.selection,
    summary: {
      assertion_count: 1,
      native_failed_assertion_count: 1,
      result: "fail",
    },
    target: request.target,
  };
}

const neverExecute: ExecuteFn = async () => {
  throw new Error("no new work may be launched");
};

let dir: string;
let managers: JobManager[];

function manager(execute: ExecuteFn = neverExecute): JobManager {
  const store = new JobStore(dir);
  const m = new JobManager({ execute, store });
  managers.push(m);
  return m;
}

function writeProfiles(): string {
  writeFileSync(
    join(dir, "operator.ini"),
    readFileSync(join(packageRoot, "config.example.ini"), "utf-8").replace(
      "ecosystem = it_wallet",
      "ecosystem = generic_oid4vci",
    ),
  );
  const path = join(dir, "profiles.json");
  writeFileSync(
    path,
    JSON.stringify({
      profiles: [
        {
          allowedAuthorizationInteraction: ["auto"],
          category: "issuance",
          configFile: "operator.ini",
          coverageMode: "interoperability",
          id: "p",
          selections: [
            {
              id: "s",
              testFile: "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
            },
          ],
        },
      ],
    }),
  );
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-l12-"));
  managers = [];
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
});

afterEach(async () => {
  for (const m of managers) await m.shutdown();
  rmSync(dir, { force: true, recursive: true });
});

describe("L12 — root lock ownership", () => {
  it("a store that never acquired the lock cannot release another owner's lock", () => {
    const owner = new JobStore(dir);
    const other = new JobStore(dir);
    expect(owner.acquireRootLock()).toBe(true);
    other.releaseRootLock();
    expect(owner.hasRootLock()).toBe(true);
    expect(other.acquireRootLock()).toBe(false);
    owner.releaseRootLock();
    expect(owner.hasRootLock()).toBe(false);
    // Exactly once: a second release by the former owner is a no-op.
    expect(other.acquireRootLock()).toBe(true);
    owner.releaseRootLock();
    expect(other.hasRootLock()).toBe(true);
    other.releaseRootLock();
  });

  it("two actual servers on the same root: second fails, first lock survives", async () => {
    const profiles = writeProfiles();
    const root = join(dir, "state");
    const first = await startRunner({ port: 0, profiles, runRoot: root });
    try {
      await expect(
        startRunner({ port: 0, profiles, runRoot: root }),
      ).rejects.toThrow(/locked by another runner/);
      expect(existsSync(join(root, ".owner.lock"))).toBe(true);
      const health = await fetch(`${first.url}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await first.close();
    }
    expect(existsSync(join(root, ".owner.lock"))).toBe(false);
    const again = await startRunner({ port: 0, profiles, runRoot: root });
    await again.close();
  });

  it("a startup failure after acquiring releases only its own lock", async () => {
    const profiles = writeProfiles();
    const root = join(dir, "state");
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const address = blocker.address();
    const port = address && typeof address === "object" ? address.port : 0;
    try {
      await expect(
        startRunner({ port, profiles, runRoot: root }),
      ).rejects.toThrow();
      expect(existsSync(join(root, ".owner.lock"))).toBe(false);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

describe("L12 — legacy request-hash migration", () => {
  it("an identical nested request replays after migration", async () => {
    const request = makeRequest();
    seedLegacyRecord(dir, "old-run", "key-1", request);
    const m = manager();
    const replay = await m.submit(request, "key-1");
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot.run_id).toBe("old-run");
    const migrated = JSON.parse(
      readFileSync(join(dir, "runs", "old-run.json"), "utf-8"),
    ) as StoredRun;
    expect(migrated.requestHash).toBe(JobStore.canonicalRequestHash(request));
    // Migrated evidence remains readable.
    const result = runnerResultSchema.parse(await m.getResult("old-run"));
    expect(result.summary.result).toBe("fail");
  });

  it("a changed nested target with the same key conflicts (old hash was blind to it)", async () => {
    const request = makeRequest();
    const changed = makeRequest({ issuer_identifier: "https://b.example" });
    expect(legacyHash(changed)).toBe(legacyHash(request));
    seedLegacyRecord(dir, "old-run", "key-1", request);
    await expect(manager().submit(changed, "key-1")).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("array order remains significant", async () => {
    const request = runRequestSchema.parse({
      ...makeRequest(),
      selection: { ids: ["a", "b"] },
    });
    seedLegacyRecord(dir, "old-run", "key-1", request);
    const reordered = runRequestSchema.parse({
      ...request,
      selection: { ids: ["b", "a"] },
    });
    await expect(manager().submit(reordered, "key-1")).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("a record whose hash matches neither algorithm is quarantined, not trusted", async () => {
    seedLegacyRecord(dir, "tampered", "key-1", makeRequest(), {
      requestHash: "0".repeat(64),
    });
    const m = manager();
    await expect(m.submit(makeRequest(), "key-1")).rejects.toMatchObject({
      code: "RUN_RECORD_CORRUPT",
    });
    expect(readdirSync(join(dir, "quarantine"))).toContain("tampered.json");
  });
});

describe("L12 — restart recovery", () => {
  it("a persisted running record becomes a readable interrupted terminal run", async () => {
    const request = makeRequest();
    seedLegacyRecord(dir, "was-running", "key-1", request, {
      requestHash: JobStore.canonicalRequestHash(request),
      requestHashVersion: 2,
      result: undefined,
      status: "running",
    });
    // Partial native evidence the interrupted child had written.
    const results = join(dir, "work", "was-running", "results");
    mkdirSync(results, { recursive: true });
    writeFileSync(
      join(results, "native-results.json"),
      JSON.stringify({
        assertions: [
          {
            ancestorTitles: ["Suite"],
            description: "ok",
            errorMessage: null,
            file: "/x.issuance.spec.ts",
            nativeStatus: "PASS",
            phase: "issuance",
            requirementId: null,
            timestamp: "2026-10-01T00:00:00.500Z",
            title: "case one",
            vitestStatus: "passed",
          },
        ],
        closedAt: null,
        phase: "issuance",
        runId: "was-running",
        sessionId: "session-1",
        startedAt: "2026-10-01T00:00:00.000Z",
        status: "OPEN",
      }),
    );

    const m = manager();
    m.recoverInterruptedRuns();
    const snap = await m.getSnapshot("was-running");
    expect(snap.status).toBe("error");
    const result = runnerResultSchema.parse(await m.getResult("was-running"));
    expect(result.execution.status).toBe(snap.status);
    expect(result.limitations.join(" ")).toMatch(/interrupted/);
    expect(result.native.assertions).toHaveLength(1);
    expect(result.summary.result).toBe("partial");
    // The key still replays the recovered run instead of launching work.
    const replay = await m.submit(request, "key-1");
    expect(replay.replayed).toBe(true);
  });

  it("startRunner recovers before accepting work", async () => {
    const profiles = writeProfiles();
    const root = join(dir, "state");
    seedLegacyRecord(root, "was-queued", "key-q", makeRequest(), {
      result: undefined,
      status: "queued",
    });
    const runner = await startRunner({ port: 0, profiles, runRoot: root });
    try {
      const res = await fetch(`${runner.url}/v1/runs/was-queued`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(((await res.json()) as { status: string }).status).toBe("error");
    } finally {
      await runner.close();
    }
  });
});

describe("L12 — corrupt records", () => {
  it("a corrupt record cannot let its key launch new work", async () => {
    seedLegacyRecord(dir, "broken", "key-1", makeRequest());
    writeFileSync(
      join(dir, "runs", "broken.json"),
      '{"runId":"broken","secret":"s3cr3t-token", truncated',
    );
    const m = manager();
    const error = await m.submit(makeRequest(), "key-1").catch((e) => e);
    expect(error).toMatchObject({ code: "RUN_RECORD_CORRUPT" });
    expect(String((error as Error).message)).not.toContain("s3cr3t");
    expect(readdirSync(join(dir, "quarantine"))).toContain("broken.json");
    expect(m.corruptRecords().map((c) => c.runId)).toEqual(["broken"]);
    expect(JSON.stringify(m.corruptRecords())).not.toContain("s3cr3t");
  });
});
