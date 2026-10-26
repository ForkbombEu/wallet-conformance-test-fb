import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

interface ExportedAssertion {
  ancestorTitles: string[];
  description: string;
  errorMessage: null | string;
  file: string;
  nativeStatus: string;
  phase: string;
  requirementId: null | string;
  title: string;
  vitestStatus: string;
}

interface ExportedResult {
  assertions: ExportedAssertion[];
  phase: string;
  runId: string;
  sessionId: string;
  status: string;
}

let tempDir: string;
let savedDb: string | undefined;
let savedResultsDir: string | undefined;
let savedRunId: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "wct-fixture-"));
  savedDb = process.env.WCT_DB_PATH;
  savedResultsDir = process.env.WCT_RESULTS_DIR;
  savedRunId = process.env.WCT_RUN_ID;
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
  restoreEnv("WCT_DB_PATH", savedDb);
  restoreEnv("WCT_RESULTS_DIR", savedResultsDir);
  restoreEnv("WCT_RUN_ID", savedRunId);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

function runFixture(): ExportedResult {
  const resultsDir = path.join(tempDir, "results");
  const dbPath = path.join(tempDir, "test.db");
  const runId = "fixture-run-001";

  execFileSync(
    "pnpm",
    ["exec", "vitest", "run", "--config", "vitest.reporter-fixture.config.ts"],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        WCT_DB_PATH: dbPath,
        WCT_RESULTS_DIR: resultsDir,
        WCT_RUN_ID: runId,
      },
      stdio: "pipe",
      timeout: 30_000,
    },
  );

  const raw = readFileSync(
    path.join(resultsDir, "native-results.json"),
    "utf-8",
  );
  return JSON.parse(raw) as ExportedResult;
}

describe("reporter fixture runtime", () => {
  it(
    "captures file and ancestor fields from real Vitest",
    { timeout: 30_000 },
    () => {
      const result = runFixture();

      expect(result.assertions).toHaveLength(3);
      expect(result.runId).toBe("fixture-run-001");
      expect(result.sessionId).toBeTruthy();
      expect(result.phase).toBe("issuance");
      expect(result.status).toBe("PASSED");

      const nested = result.assertions.find(
        (a) => a.title === "CI_001: nested test",
      );
      expect(nested, "nested test exists").toBeDefined();
      expect(nested?.ancestorTitles).toEqual(["Outer Suite", "Inner Suite"]);
      expect(nested?.requirementId).toBe("CI_001");
      expect(nested?.file).toContain("reporter-fixture.spec.ts");
      expect(nested?.nativeStatus).toBe("PASS");
      expect(nested?.vitestStatus).toBe("passed");

      const top = result.assertions.find(
        (a) => a.title === "CI_002: top-level test",
      );
      expect(top, "top-level test exists").toBeDefined();
      expect(top?.ancestorTitles).toEqual(["Outer Suite"]);
      expect(top?.requirementId).toBe("CI_002");

      const generic = result.assertions.find(
        (a) => a.title === "generic smoke test",
      );
      expect(generic, "generic test exists").toBeDefined();
      expect(generic?.ancestorTitles).toEqual([]);
      expect(generic?.requirementId).toBeNull();
      expect(generic?.file).toContain("reporter-fixture.spec.ts");
    },
  );

  it("binds export to reporter-created session ID", { timeout: 30_000 }, () => {
    const result = runFixture();
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
