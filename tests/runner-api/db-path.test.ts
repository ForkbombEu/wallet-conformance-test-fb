import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConformanceSession } from "@/report/types";

import { openDb, resolveDbPath } from "@/report/db";
import { createSession, listSessions } from "@/report/session-store";

function makeSession(id: string): Omit<ConformanceSession, "checks"> {
  return {
    entityName: "test-entity",
    id,
    phase: "issuance",
    startedAt: new Date().toISOString(),
    status: "OPEN",
  };
}

const ORIGINAL_ENV = process.env.WCT_DB_PATH;

function restoreEnv(): void {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.WCT_DB_PATH;
  } else {
    process.env.WCT_DB_PATH = ORIGINAL_ENV;
  }
}

describe("resolveDbPath", () => {
  afterEach(restoreEnv);

  it("returns package-relative default when no env var is set", () => {
    delete process.env.WCT_DB_PATH;
    const result = resolveDbPath();
    expect(result).toMatch(/data[/\\]wct\.db$/);
  });

  it("returns default when WCT_DB_PATH is empty string", () => {
    process.env.WCT_DB_PATH = "";
    const result = resolveDbPath();
    expect(result).toMatch(/data[/\\]wct\.db$/);
  });

  it("returns absolute override as-is", () => {
    const abs = path.join(tmpdir(), "test-wct.db");
    process.env.WCT_DB_PATH = abs;
    expect(resolveDbPath()).toBe(abs);
  });

  it("resolves relative override against cwd", () => {
    process.env.WCT_DB_PATH = "relative/test.db";
    const result = resolveDbPath();
    expect(result).toBe(path.resolve(process.cwd(), "relative/test.db"));
  });
});

describe("DB isolation", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = mkdtempSync(path.join(tmpdir(), "wct-db-a-"));
    dirB = mkdtempSync(path.join(tmpdir(), "wct-db-b-"));
  });

  afterEach(() => {
    rmSync(dirA, { force: true, recursive: true });
    rmSync(dirB, { force: true, recursive: true });
    restoreEnv();
  });

  it("opening A never sees B's sessions", () => {
    const dbA = openDb(path.join(dirA, "test.db"));
    createSession(dbA, makeSession("session-a"));
    dbA.close();

    const dbB = openDb(path.join(dirB, "test.db"));
    createSession(dbB, makeSession("session-b"));
    dbB.close();

    const reopenA = openDb(path.join(dirA, "test.db"));
    const sessionsA = listSessions(reopenA);
    expect(sessionsA).toHaveLength(1);
    expect(sessionsA[0]?.runId).toBe("session-a");
    reopenA.close();

    const reopenB = openDb(path.join(dirB, "test.db"));
    const sessionsB = listSessions(reopenB);
    expect(sessionsB).toHaveLength(1);
    expect(sessionsB[0]?.runId).toBe("session-b");
    reopenB.close();
  });

  it("openDb creates parent directories and schema", () => {
    const nested = path.join(dirA, "deep", "nested", "test.db");
    const db = openDb(nested);
    createSession(db, makeSession("nested-session"));
    const sessions = listSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.runId).toBe("nested-session");
    db.close();
  });

  it(":memory: works without filesystem", () => {
    const db = openDb(":memory:");
    createSession(db, makeSession("mem-session"));
    const sessions = listSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.runId).toBe("mem-session");
    db.close();
  });
});
