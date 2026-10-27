import { parse, stringify } from "ini";
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { packageRoot } from "@/logic/runtime-paths";
import {
  type RunnerResult,
  type RunRequest,
  runRequestSchema,
} from "@/runner-api/contract";
import { JobManager } from "@/runner-api/job-manager";
import { JobStore } from "@/runner-api/job-store";
import { resolveRun, startRunner } from "@/runner-api/main";
import { createNativeExecutor } from "@/runner-api/native-worker";
import { loadProfileCatalogue } from "@/runner-api/profiles";

const TOKEN = "review-2-token";
const FIXTURES = resolve(import.meta.dirname, "fixtures/review");
const CHILD_TIMEOUT = 120_000;
const auth = { authorization: `Bearer ${TOKEN}` };

let dir: string;
let operatorIni: string;
let profilesPath: string;
let orphans: ChildProcess[];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  await new Promise<void>((r) => server.close(() => r()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

function makeRequest(selection: string, profile = "review"): RunRequest {
  return runRequestSchema.parse({
    category: "issuance",
    contract_version: "1.0",
    profile_id: profile,
    selection: { ids: [selection] },
    target: { actor_name: "fixture", actor_type: "issuer" },
  });
}

async function runNative(selection: string): Promise<{
  result: RunnerResult;
  runRoot: string;
}> {
  const catalogue = loadProfileCatalogue(profilesPath);
  const request = makeRequest(selection);
  const runRoot = join(dir, "work", selection);
  const execute = createNativeExecutor({
    effectiveConfig: resolveRun(catalogue, request, runRoot),
    request,
  });
  const evidence = await execute({
    abortSignal: new AbortController().signal,
    request,
    runId: `run-${selection}`,
    runRoot,
  });
  return { result: evidence.result, runRoot };
}

/** A detached process group standing in for an orphaned native child. */
function spawnOrphan(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    detached: true,
    stdio: "ignore",
  });
  orphans.push(child);
  if (!child.pid) throw new Error("no pid");
  return child.pid;
}

function writeMarker(stateRoot: string, runId: string, body: string): string {
  const workDir = join(stateRoot, "work", runId);
  mkdirSync(workDir, { recursive: true });
  const path = join(workDir, "native-child.json");
  writeFileSync(path, body);
  return path;
}

beforeEach(async () => {
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
  orphans = [];
  dir = mkdtempSync(join(tmpdir(), "wct-review2-"));
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
  operatorIni = join(dir, "operator.ini");
  writeFileSync(operatorIni, stringify(ini));
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
          id: "review",
          selections: [
            {
              id: "afterall",
              testFile: join(FIXTURES, "afterall-error.issuance.spec.ts"),
            },
            {
              id: "unhandled",
              testFile: join(FIXTURES, "unhandled.issuance.spec.ts"),
            },
          ],
        },
      ],
    }),
  );
});

afterEach(() => {
  for (const child of orphans) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(dir, { force: true, recursive: true });
});

describe("review 2: a broken native suite is never pass", () => {
  it.each(["afterall", "unhandled"])(
    "%s: all tests pass but the suite failed",
    async (selection) => {
      const { result, runRoot } = await runNative(selection);
      expect(result.execution.exit_code).not.toBe(0);
      expect(
        result.native.assertions.every((a) => a.native_status === "PASS"),
      ).toBe(true);
      expect(result.summary.result).toBe("partial");
      expect(result.limitations.join(" ")).toMatch(/suite/i);
      // The native child marker is removed once the group is confirmed gone.
      expect(existsSync(join(runRoot, "native-child.json"))).toBe(false);
    },
    CHILD_TIMEOUT,
  );
});

describe("review 2: orphaned native process groups block startup", () => {
  it("a live group from any run (even a terminal one) refuses startup", async () => {
    const root = join(dir, "state");
    const pid = spawnOrphan();
    writeMarker(
      root,
      "finished-run",
      JSON.stringify({ bootId: "", pid, startTime: "" }),
    );
    await expect(
      startRunner({ port: 0, profiles: profilesPath, runRoot: root }),
    ).rejects.toThrow(
      new RegExp(`native process group ${pid} .*still running`),
    );
    expect(existsSync(join(root, ".owner.lock"))).toBe(false);
  });

  it("a corrupt marker whose pid is still alive also refuses startup", async () => {
    const root = join(dir, "state");
    const pid = spawnOrphan();
    writeMarker(root, "r", `{"pid":${pid},"bootId":"tru`);
    await expect(
      startRunner({ port: 0, profiles: profilesPath, runRoot: root }),
    ).rejects.toThrow(/still running/);
  });

  it("a dead group's marker is cleared and startup proceeds", async () => {
    const root = join(dir, "state");
    const pid = spawnOrphan();
    process.kill(-pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    const marker = writeMarker(root, "r", JSON.stringify({ pid }));
    const runner = await startRunner({
      port: 0,
      profiles: profilesPath,
      runRoot: root,
    });
    await runner.close();
    expect(existsSync(marker)).toBe(false);
  });
});

describe("review 2: idempotent replay does not depend on the current INI", () => {
  it(
    "a retry with the same key replays even after the operator INI broke",
    async () => {
      const runner = await startRunner({
        port: 0,
        profiles: profilesPath,
        runRoot: join(dir, "state"),
      });
      try {
        const body = JSON.stringify(makeRequest("afterall"));
        const post = () =>
          fetch(`${runner.url}/v1/runs`, {
            body,
            headers: {
              ...auth,
              "content-type": "application/json",
              "idempotency-key": "same-key",
            },
            method: "POST",
          });
        const first = await post();
        expect(first.status).toBe(202);
        const { run_id: runId } = (await first.json()) as { run_id: string };
        writeFileSync(operatorIni, "[issuance]\nurl = not-a-url\n");
        const retry = await post();
        expect(retry.status).toBe(200);
        expect(((await retry.json()) as { run_id: string }).run_id).toBe(runId);
      } finally {
        await runner.close();
      }
    },
    CHILD_TIMEOUT,
  );
});

describe("review 2: quarantine without an index entry", () => {
  it("a quarantined record still blocks its key when the index entry is missing", () => {
    const store = new JobStore(dir);
    const keyHash = JobStore.keyHash("default", "k");
    store.saveRun({
      cancelRequested: false,
      createdAt: "t",
      idempotencyKeyHash: keyHash,
      namespace: "default",
      request: makeRequest("afterall"),
      requestHash: JobStore.canonicalRequestHash(makeRequest("afterall")),
      runId: "r1",
      status: "completed",
      updatedAt: "t",
    });
    // Truncated record (key hash still readable), index entry lost.
    const record = readFileSync(join(dir, "runs", "r1.json"), "utf-8");
    writeFileSync(join(dir, "runs", "r1.json"), record.slice(0, 200));
    rmSync(join(dir, "index", `${keyHash}.json`));
    expect(() => store.findByKeyHash(keyHash)).toThrow(/quarantined/);
    expect(() => new JobStore(dir).findByKeyHash(keyHash)).toThrow(
      /quarantined/,
    );
  });
});

describe("review 2: abort grace keeps partial native evidence", () => {
  it("a hung worker's exported assertions survive into the cancelled result", async () => {
    const manager = new JobManager({
      abortGraceMs: 200,
      execute: (ctx) => {
        const results = join(ctx.runRoot, "results");
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
                timestamp: "t",
                title: "case",
                vitestStatus: "passed",
              },
            ],
            closedAt: null,
            phase: "issuance",
            runId: ctx.runId,
            sessionId: "s",
            startedAt: "t",
            status: "OPEN",
          }),
        );
        return new Promise<never>(() => undefined);
      },
      store: new JobStore(join(dir, "store")),
    });
    const { snapshot } = await manager.submit(makeRequest("afterall"), "k");
    await new Promise((r) => setTimeout(r, 50));
    await manager.cancel(snapshot.run_id);
    const result = await manager.getResult(snapshot.run_id);
    expect(result.execution.status).toBe("cancelled");
    expect(result.native.assertions).toHaveLength(1);
    expect(result.summary.result).toBe("partial");
    await manager.shutdown();
  });
});
