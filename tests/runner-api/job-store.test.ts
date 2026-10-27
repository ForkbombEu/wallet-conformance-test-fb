import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunRequest } from "@/runner-api/contract";

import { JobStore, type StoredRun } from "@/runner-api/job-store";

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

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  const request = makeRequest();
  return {
    cancelRequested: false,
    createdAt: "2026-01-01T00:00:00Z",
    idempotencyKeyHash: JobStore.keyHash("default", "key-hash-1"),
    namespace: "default",
    request,
    requestHash: JobStore.canonicalRequestHash(request),
    runId: "run-1",
    status: "queued",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

let dir: string;
let store: JobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-store-"));
  store = new JobStore(dir);
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("JobStore — persist and retrieve", () => {
  it("saves and reads a run", () => {
    const run = makeRun();
    store.saveRun(run);
    expect(store.getRun("run-1")).toEqual({ ...run, requestHashVersion: 2 });
  });

  it("returns undefined for unknown run", () => {
    expect(store.getRun("nope")).toBeUndefined();
  });

  it("persists across store instances (reopen)", () => {
    store.saveRun(makeRun());
    const reopened = new JobStore(dir);
    expect(reopened.getRun("run-1")).toBeDefined();
    expect(reopened.getRun("run-1")?.runId).toBe("run-1");
  });

  it("saves and updates a run", () => {
    store.saveRun(makeRun());
    const updated = makeRun({ status: "running" });
    store.saveRun(updated);
    expect(store.getRun("run-1")?.status).toBe("running");
  });
});

describe("JobStore — idempotency index", () => {
  it("finds by key hash after save", () => {
    const run = makeRun();
    store.saveRun(run);
    expect(
      store.findByKeyHash(JobStore.keyHash("default", "key-hash-1"))?.runId,
    ).toBe("run-1");
  });

  it("returns undefined for unknown key hash", () => {
    expect(store.findByKeyHash("unknown")).toBeUndefined();
  });

  it("rebuilds index from authoritative records after crash", () => {
    store.saveRun(makeRun());

    // Simulate crash: delete index but keep record
    const indexFile = join(
      dir,
      "index",
      `${JobStore.keyHash("default", "key-hash-1")}.json`,
    );
    rmSync(indexFile, { force: true });
    expect(existsSync(indexFile)).toBe(false);

    // findByKeyHash falls back to rebuilding from records
    expect(
      store.findByKeyHash(JobStore.keyHash("default", "key-hash-1"))?.runId,
    ).toBe("run-1");
    expect(existsSync(indexFile)).toBe(true);
  });

  it("rebuildIndex restores all indexes", () => {
    store.saveRun(makeRun());
    store.saveRun(
      makeRun({
        idempotencyKeyHash: JobStore.keyHash("default", "key-hash-2"),
        runId: "run-2",
      }),
    );

    rmSync(join(dir, "index"), { force: true, recursive: true });
    mkdirSync(join(dir, "index"), { recursive: true });

    store.rebuildIndex();
    expect(
      store.findByKeyHash(JobStore.keyHash("default", "key-hash-1"))?.runId,
    ).toBe("run-1");
    expect(
      store.findByKeyHash(JobStore.keyHash("default", "key-hash-2"))?.runId,
    ).toBe("run-2");
  });

  it("same key hash finds same run (replay)", () => {
    store.saveRun(makeRun());
    expect(
      store.findByKeyHash(JobStore.keyHash("default", "key-hash-1"))?.runId,
    ).toBe("run-1");
  });
});

describe("JobStore — canonical hashing", () => {
  it("produces stable hash for same request", () => {
    const req = makeRequest();
    expect(JobStore.canonicalRequestHash(req)).toBe(
      JobStore.canonicalRequestHash(req),
    );
  });

  it("different requests produce different hashes", () => {
    const a = makeRequest();
    const b = { ...makeRequest(), profile_id: "other" };
    expect(JobStore.canonicalRequestHash(a)).not.toBe(
      JobStore.canonicalRequestHash(b),
    );
  });

  it("key hash incorporates namespace and key", () => {
    expect(JobStore.keyHash("ns1", "k1")).not.toBe(
      JobStore.keyHash("ns2", "k1"),
    );
    expect(JobStore.keyHash("ns1", "k1")).not.toBe(
      JobStore.keyHash("ns1", "k2"),
    );
    expect(JobStore.keyHash("ns1", "k1")).toBe(JobStore.keyHash("ns1", "k1"));
  });
});

describe("JobStore — root lock", () => {
  it("acquires and releases lock", () => {
    expect(store.acquireRootLock()).toBe(true);
    expect(store.hasRootLock()).toBe(true);
    store.releaseRootLock();
    expect(store.hasRootLock()).toBe(false);
  });

  it("denies second acquisition while lock is held", () => {
    expect(store.acquireRootLock()).toBe(true);
    expect(store.acquireRootLock()).toBe(false);
    store.releaseRootLock();
    expect(store.acquireRootLock()).toBe(true);
  });
});

describe("JobStore — atomic writes", () => {
  it("writes run without leaving tmp files", () => {
    store.saveRun(makeRun());
    const files = readdirSync(join(dir, "runs"));
    expect(files.some((f: string) => f.endsWith(".tmp"))).toBe(false);
    expect(files).toContain("run-1.json");
  });
});
