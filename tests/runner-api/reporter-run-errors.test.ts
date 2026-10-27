/**
 * L16: errors outside test bodies (suite hooks, unhandled errors, collection
 * failures) can never become a final PASS.
 *
 * Each case runs an ACTUAL Vitest child with the REAL ConformanceReporter
 * through the real native executor and JobManager lifecycle, then checks the
 * exact bytes the reporter wrote, the persisted native session and the final
 * aggregate.
 */
import { parse, stringify } from "ini";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { packageRoot } from "@/logic/runtime-paths";
import {
  type RunnerResult,
  runnerResultSchema,
  type RunRequest,
  runRequestSchema,
} from "@/runner-api/contract";
import { JobManager } from "@/runner-api/job-manager";
import { JobStore } from "@/runner-api/job-store";
import { resolveRun } from "@/runner-api/main";
import { nativeExportSchema } from "@/runner-api/native-result-adapter";
import { createNativeExecutor } from "@/runner-api/native-worker";
import { loadProfileCatalogue } from "@/runner-api/profiles";

const FIXTURES = resolve(import.meta.dirname, "fixtures/review");
const CHILD_TIMEOUT = 120_000;
const SELECTIONS = {
  afterall: "afterall-error.issuance.spec.ts",
  collection: "collection-error.issuance.spec.ts",
  "pass-fail": "pass-fail.issuance.spec.ts",
  passing: "passing.issuance.spec.ts",
  unhandled: "unhandled.issuance.spec.ts",
} as const;

type Selection = keyof typeof SELECTIONS;

let dir: string;
let profilesPath: string;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  await new Promise<void>((r) => server.close(() => r()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

function makeRequest(selection: Selection): RunRequest {
  return runRequestSchema.parse({
    category: "issuance",
    contract_version: "1.0",
    profile_id: "modes",
    selection: { ids: [selection] },
    target: { actor_name: "fixture", actor_type: "issuer" },
  });
}

/** Runs one fixture through the real executor and manager lifecycle. */
async function runMode(selection: Selection): Promise<{
  dbStatus: string;
  raw: ReturnType<typeof nativeExportSchema.parse>;
  result: RunnerResult;
}> {
  const catalogue = loadProfileCatalogue(profilesPath);
  const store = new JobStore(join(dir, "state"));
  const manager = new JobManager({
    execute: (ctx) =>
      createNativeExecutor({
        effectiveConfig: resolveRun(catalogue, ctx.request, ctx.runRoot),
        request: ctx.request,
      })(ctx),
    store,
  });
  const { snapshot } = await manager.submit(makeRequest(selection), selection);
  let result: RunnerResult | undefined;
  for (let i = 0; i < 1_200 && !result; i++) {
    const snap = await manager.getSnapshot(snapshot.run_id);
    if (["cancelled", "completed", "error", "timed_out"].includes(snap.status))
      result = await manager.getResult(snapshot.run_id);
    else await new Promise((r) => setTimeout(r, 100));
  }
  await manager.shutdown();
  if (!result) throw new Error(`${selection} never finished`);

  const workDir = store.workDir(snapshot.run_id);
  const raw = nativeExportSchema.parse(
    JSON.parse(
      readFileSync(join(workDir, "results", "native-results.json"), "utf-8"),
    ),
  );
  const db = new DatabaseSync(join(workDir, "data", "wct.db"), {
    readOnly: true,
  });
  const row = db
    .prepare("SELECT status FROM sessions WHERE id = ?")
    .get(raw.sessionId) as undefined | { status: string };
  db.close();
  return {
    dbStatus: row?.status ?? "missing",
    raw,
    result: runnerResultSchema.parse(result),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wct-l16-"));
  const ini = parse(
    readFileSync(join(packageRoot, "config.example.ini"), "utf-8"),
  ) as Record<string, Record<string, unknown>>;
  const section = (name: string) => (ini[name] ??= {});
  section("profile").ecosystem = "generic_oid4vci";
  section("issuance").url = "https://issuer.example";
  section("trust_anchor").port = await freePort();
  delete section("trust_anchor").tls_cert_dir;
  section("wallet").port = await freePort();
  section("issuer").port = await freePort();
  section("network").bind_address = "127.0.0.1";
  writeFileSync(join(dir, "operator.ini"), stringify(ini));
  profilesPath = join(dir, "profiles.json");
  writeFileSync(
    profilesPath,
    JSON.stringify({
      profiles: [
        {
          allowedAuthorizationInteraction: ["auto"],
          category: "issuance",
          configFile: "operator.ini",
          coverageMode: "interoperability",
          id: "modes",
          selections: Object.entries(SELECTIONS).map(([id, file]) => ({
            id,
            testFile: join(FIXTURES, file),
          })),
        },
      ],
    }),
  );
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("L16 — real Vitest child, real reporter, real worker + manager", () => {
  it(
    "(a) PASS test then a failing afterAll: suite error exported, never pass",
    async () => {
      const { dbStatus, raw, result } = await runMode("afterall");
      expect(result.execution.exit_code).toBe(1);
      expect(raw.status).toBe("INCOMPLETE");
      expect(dbStatus).toBe("INCOMPLETE");
      expect(raw.assertions.map((a) => a.nativeStatus)).toEqual(["PASS"]);
      expect(raw.errors).toEqual([
        expect.objectContaining({
          location: "Broken suite (afterAll)",
          message: expect.stringContaining("afterAll failed on purpose"),
          origin: "suite",
        }),
      ]);
      expect(result.execution.status).toBe("completed");
      expect(result.native.native_suite_status).toBe("INCOMPLETE");
      expect(result.native.assertions.map((a) => a.native_status)).toEqual([
        "PASS",
      ]);
      expect(result.summary.result).toBe("partial");
      expect(result.limitations.join(" ")).toMatch(
        /afterAll failed on purpose/,
      );
    },
    CHILD_TIMEOUT,
  );

  it(
    "(b) PASS test with an unhandled rejection: unhandled error exported, never pass",
    async () => {
      const { dbStatus, raw, result } = await runMode("unhandled");
      expect(result.execution.exit_code).toBe(1);
      expect(raw.status).toBe("INCOMPLETE");
      expect(dbStatus).toBe("INCOMPLETE");
      expect(raw.assertions.map((a) => a.nativeStatus)).toEqual(["PASS"]);
      expect(raw.errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("unhandled rejection on purpose"),
          origin: "unhandled",
        }),
      ]);
      expect(result.summary.result).toBe("partial");
    },
    CHILD_TIMEOUT,
  );

  it(
    "(c) ordinary PASS + FAIL assertions stay completed + fail",
    async () => {
      const { dbStatus, raw, result } = await runMode("pass-fail");
      expect(raw.status).toBe("FAILED");
      expect(dbStatus).toBe("FAILED");
      expect(raw.errors).toBeUndefined();
      expect(result.execution.status).toBe("completed");
      expect(result.summary).toEqual({
        assertion_count: 2,
        native_failed_assertion_count: 1,
        result: "fail",
      });
    },
    CHILD_TIMEOUT,
  );

  it(
    "(d) a collection failure has zero assertions and is never PASSED",
    async () => {
      const { dbStatus, raw, result } = await runMode("collection");
      expect(raw.assertions).toEqual([]);
      expect(raw.status).toBe("INCOMPLETE");
      expect(dbStatus).toBe("INCOMPLETE");
      expect(raw.errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("collection failed on purpose"),
          origin: "module",
        }),
      ]);
      expect(result.summary.result).toBe("not_tested");
    },
    CHILD_TIMEOUT,
  );

  it(
    "a clean suite records its real session start and still passes",
    async () => {
      const before = new Date().toISOString();
      const { dbStatus, raw, result } = await runMode("passing");
      expect(raw.status).toBe("PASSED");
      expect(dbStatus).toBe("PASSED");
      expect(raw.errors).toBeUndefined();
      expect(raw.startedAt < (raw.assertions[0]?.timestamp ?? "")).toBe(true);
      expect(raw.startedAt >= before).toBe(true);
      expect(result.execution.exit_code).toBe(0);
      expect(result.summary.result).toBe("pass");
    },
    CHILD_TIMEOUT,
  );
});
