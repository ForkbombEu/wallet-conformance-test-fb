/**
 * R17: a worker-declared raw evidence artifact that fails its INITIAL
 * publication keeps the aggregate nonpass through terminal aggregation,
 * restart and replay. Native assertions and the native session verdict stay
 * as they ran.
 *
 * - UNIT (publisher): the real ArtifactStore on real files (missing,
 *   unreadable, oversize, write failure).
 * - UNIT (aggregation): typed executors through the real publishRunEvidence
 *   and JobManager lifecycle.
 * - Real server composition: startRunner with a real Vitest child and the
 *   real reporter; only the artifact source read is replaced.
 */
import { parse, stringify } from "ini";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecuteContext } from "@/runner-api/job-manager";

import { packageRoot } from "@/logic/runtime-paths";
import { ArtifactStore, MAX_ARTIFACT_BYTES } from "@/runner-api/artifacts";
import {
  type RunnerResult,
  runnerResultSchema,
  type RunRequest,
  runRequestSchema,
} from "@/runner-api/contract";
import { JobManager } from "@/runner-api/job-manager";
import { JobStore } from "@/runner-api/job-store";
import { publishRunEvidence, startRunner } from "@/runner-api/main";
import { summarizeResult } from "@/runner-api/summarize";

const TOKEN = "r17-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const PASSING = resolve(
  import.meta.dirname,
  "fixtures/review/passing.issuance.spec.ts",
);
const CHILD_TIMEOUT = 120_000;
const BENIGN =
  "engine.revision is unknown: running from source without trusted build metadata";

type Assertion = RunnerResult["native"]["assertions"][number];

let dir: string;

function assertion(index: number, status: Assertion["native_status"]) {
  return {
    ancestor_titles: ["Suite"],
    assertion_id: `assertion-${index}`,
    file: "/abs/spec.issuance.spec.ts",
    full_title: `Suite > case ${index}`,
    native_status: status,
    phase: "issuance",
  };
}

function makeRequest(profile = "p", selection = "s"): RunRequest {
  return runRequestSchema.parse({
    category: "issuance",
    contract_version: "1.0",
    profile_id: profile,
    selection: { ids: [selection] },
    target: { actor_name: "x", actor_type: "issuer" },
  });
}

async function settle(
  manager: JobManager,
  runId: string,
): Promise<RunnerResult> {
  for (let i = 0; i < 1_200; i++) {
    const snap = await manager.getSnapshot(runId);
    if (["cancelled", "completed", "error", "timed_out"].includes(snap.status))
      return runnerResultSchema.parse(await manager.getResult(runId));
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${runId} did not finish`);
}

function source(name: string, content: string): string {
  const path = join(dir, "private", name);
  mkdirSync(join(dir, "private"), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** A worker result whose native suite ran cleanly (PASSED, exit 0). */
function workerResult(
  ctx: ExecuteContext,
  assertions: Assertion[],
): RunnerResult {
  const failed = assertions.some((a) => a.native_status === "FAIL");
  const execution: RunnerResult["execution"] = {
    exit_code: failed ? 1 : 0,
    finished_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    status: "completed",
  };
  const native: RunnerResult["native"] = {
    assertions,
    coverage_mode: "interoperability",
    native_suite_status: failed ? "FAILED" : "PASSED",
    scenario_outcomes: [],
    sessions: [{ id: "session-1", status: failed ? "FAILED" : "PASSED" }],
  };
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
    execution,
    limitations: [BENIGN],
    native,
    profile_id: "p",
    run_id: ctx.runId,
    selection: ctx.request.selection,
    summary: summarizeResult(execution, native),
    target: ctx.request.target,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-r17-"));
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
});

afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { force: true, recursive: true });
});

describe("R17 UNIT — real publisher boundary reports typed failures", () => {
  it("missing, unreadable and oversize sources are typed failures; readable ones publish exactly", () => {
    const store = new ArtifactStore(join(dir, "state"));
    const good = source("good.json", '{"ok":true}');
    const unreadable = source("unreadable.json", "secret");
    chmodSync(unreadable, 0o000);
    const oversize = source("oversize.log", "");
    truncateSync(oversize, MAX_ARTIFACT_BYTES + 1);

    const published = store.publish("run-1", [
      good,
      join(dir, "private", "missing.json"),
      unreadable,
      oversize,
    ]);

    expect(published.entries.map((e) => e.artifact_id)).toEqual(["good.json"]);
    expect(published.entries[0]?.sha256).toBe(
      createHash("sha256").update('{"ok":true}').digest("hex"),
    );
    expect(published.failed).toEqual([
      { filename: "missing.json", reason: "missing" },
      { filename: "unreadable.json", reason: "unreadable" },
      { filename: "oversize.log", reason: "oversize" },
    ]);
    expect(published.limitations).toHaveLength(3);
    expect(JSON.stringify(published)).not.toContain(dir);
    expect(store.read("run-1", "missing.json")).toBeUndefined();
  });

  it("a failed copy into storage is a typed write failure", () => {
    const store = new ArtifactStore(join(dir, "state"));
    const files = join(dir, "state", "artifacts", "run-1", "files");
    mkdirSync(files, { recursive: true });
    chmodSync(files, 0o500);
    try {
      const published = store.publish("run-1", [source("a.json", "a")]);
      expect(published.entries).toEqual([]);
      expect(published.failed).toEqual([
        { filename: "a.json", reason: "write_failed" },
      ]);
    } finally {
      chmodSync(files, 0o700);
    }
  });
});

describe("R17 UNIT — publication failure survives manager aggregation", () => {
  function manager(
    execute: ConstructorParameters<typeof JobManager>[0]["execute"],
  ) {
    return new JobManager({ execute, store: new JobStore(join(dir, "jobs")) });
  }

  it("native PASS + missing declared artifact stays inconclusive after finalization", async () => {
    const artifacts = new ArtifactStore(join(dir, "state"));
    const jobs = manager(async (ctx) =>
      publishRunEvidence(artifacts, ctx.runId, {
        privateArtifactPaths: [join(dir, "private", "native-results.json")],
        result: workerResult(ctx, [assertion(0, "PASS")]),
      }),
    );
    const { snapshot } = await jobs.submit(makeRequest(), "k");
    const result = await settle(jobs, snapshot.run_id);
    await jobs.shutdown();

    expect(result.execution.status).toBe("completed");
    expect(result.native.native_suite_status).toBe("PASSED");
    expect(result.native.assertions.map((a) => a.native_status)).toEqual([
      "PASS",
    ]);
    expect(result.artifacts).toEqual([]);
    expect(result.summary.result).toBe("inconclusive");
    expect(result.limitations.join(" ")).toMatch(
      /native-results\.json.*missing/,
    );
  });

  it("successful publication with only a benign limitation keeps a real pass", async () => {
    const artifacts = new ArtifactStore(join(dir, "state"));
    const jobs = manager(async (ctx) =>
      publishRunEvidence(artifacts, ctx.runId, {
        privateArtifactPaths: [source("native-results.json", "{}")],
        result: workerResult(ctx, [assertion(0, "PASS")]),
      }),
    );
    const { snapshot } = await jobs.submit(makeRequest(), "k");
    const result = await settle(jobs, snapshot.run_id);
    await jobs.shutdown();

    expect(result.limitations).toContain(BENIGN);
    expect(result.artifacts).toHaveLength(1);
    expect(result.summary.result).toBe("pass");
  });

  it("an independent native FAIL stays fail when publication also failed", async () => {
    const artifacts = new ArtifactStore(join(dir, "state"));
    const jobs = manager(async (ctx) =>
      publishRunEvidence(artifacts, ctx.runId, {
        privateArtifactPaths: [join(dir, "private", "gone.json")],
        result: workerResult(ctx, [assertion(0, "PASS"), assertion(1, "FAIL")]),
      }),
    );
    const { snapshot } = await jobs.submit(makeRequest(), "k");
    const result = await settle(jobs, snapshot.run_id);
    await jobs.shutdown();
    expect(result.summary.result).toBe("fail");
  });

  it("cancellation keeps the evidence that published and stays nonpass", async () => {
    const artifacts = new ArtifactStore(join(dir, "state"));
    const jobs = manager(
      (ctx) =>
        new Promise((done) => {
          ctx.abortSignal.addEventListener("abort", () =>
            done(
              publishRunEvidence(artifacts, ctx.runId, {
                privateArtifactPaths: [
                  source("native-results.json", '{"partial":true}'),
                  join(dir, "private", "stdout.log"),
                ],
                result: workerResult(ctx, [assertion(0, "PASS")]),
              }),
            ),
          );
        }),
    );
    const { snapshot } = await jobs.submit(makeRequest(), "k");
    await new Promise((r) => setTimeout(r, 20));
    await jobs.cancel(snapshot.run_id);
    const result = await settle(jobs, snapshot.run_id);
    await jobs.shutdown();

    expect(result.execution.status).toBe("cancelled");
    expect(result.summary.result).toBe("partial");
    expect(result.artifacts.map((a) => a.artifact_id)).toEqual([
      "native-results.json",
    ]);
    expect(result.limitations.join(" ")).toMatch(/stdout\.log.*missing/);
  });

  it("an exception in the publication path yields a readable nonpass result keeping native data", async () => {
    class BrokenStore extends ArtifactStore {
      override publish(): never {
        throw Object.assign(new Error(`EIO: ${dir}/secret path`), {
          code: "EIO",
        });
      }
    }
    const artifacts = new BrokenStore(join(dir, "state"));
    const jobs = manager(async (ctx) =>
      publishRunEvidence(artifacts, ctx.runId, {
        privateArtifactPaths: [source("native-results.json", "{}")],
        result: workerResult(ctx, [assertion(0, "PASS")]),
      }),
    );
    const { snapshot } = await jobs.submit(makeRequest(), "k");
    const result = await settle(jobs, snapshot.run_id);
    await jobs.shutdown();

    expect(result.execution.status).toBe("completed");
    expect(result.native.assertions).toHaveLength(1);
    expect(result.artifacts).toEqual([]);
    expect(result.summary.result).toBe("inconclusive");
    expect(result.limitations.join(" ")).toMatch(/EIO/);
    expect(JSON.stringify(result)).not.toContain(dir);
  });
});

describe("R17 — real server composition, real native reporter child", () => {
  let profilesPath: string;

  async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const address = server.address();
    await new Promise<void>((r) => server.close(() => r()));
    if (!address || typeof address === "string") throw new Error("no port");
    return address.port;
  }

  async function post(url: string, key: string) {
    return fetch(`${url}/v1/runs`, {
      body: JSON.stringify(makeRequest("r17", "passing")),
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      method: "POST",
    });
  }

  async function terminal(url: string, runId: string): Promise<RunnerResult> {
    for (let i = 0; i < 1_200; i++) {
      const snap = (await (
        await fetch(`${url}/v1/runs/${runId}`, { headers: auth })
      ).json()) as { status: string };
      if (
        ["cancelled", "completed", "error", "timed_out"].includes(snap.status)
      ) {
        return runnerResultSchema.parse(
          await (
            await fetch(`${url}/v1/runs/${runId}/result`, { headers: auth })
          ).json(),
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`run ${runId} did not finish`);
  }

  beforeEach(async () => {
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
            id: "r17",
            selections: [{ id: "passing", testFile: PASSING }],
          },
        ],
      }),
    );
  });

  it(
    "an unreadable native export keeps a nonpass aggregate through restart and replay",
    async () => {
      const root = join(dir, "state");
      const runner = await startRunner({
        // Only the artifact layer's source read fails; the native child,
        // reporter, adapter, worker, manager and routes are real.
        artifactSourceReader: (path) => {
          if (path.endsWith("native-results.json")) {
            throw Object.assign(new Error("EACCES: permission denied"), {
              code: "EACCES",
            });
          }
          return readFileSync(path);
        },
        port: 0,
        profiles: profilesPath,
        runRoot: root,
      });
      let runId: string;
      let first: RunnerResult;
      try {
        const accepted = await post(runner.url, "same-key");
        expect(accepted.status).toBe(202);
        runId = ((await accepted.json()) as { run_id: string }).run_id;
        first = await terminal(runner.url, runId);
      } finally {
        await runner.close();
      }

      expect(first.execution.status).toBe("completed");
      expect(first.execution.exit_code).toBe(0);
      expect(first.native.native_suite_status).toBe("PASSED");
      expect(first.native.assertions.map((a) => a.native_status)).toEqual([
        "PASS",
      ]);
      expect(first.artifacts).toEqual([]);
      expect(first.summary.result).toBe("inconclusive");
      expect(first.limitations.join(" ")).toMatch(
        /native-results\.json.*could not be read/,
      );

      // Restart on the same state root (normal reader) and replay the key.
      const restarted = await startRunner({
        port: 0,
        profiles: profilesPath,
        runRoot: root,
      });
      try {
        await expect(terminal(restarted.url, runId)).resolves.toEqual(first);
        const replay = await post(restarted.url, "same-key");
        expect(replay.status).toBe(200);
        expect(((await replay.json()) as { run_id: string }).run_id).toBe(
          runId,
        );
        const missing = await fetch(
          `${restarted.url}/v1/runs/${runId}/artifacts/native-results.json`,
          { headers: auth },
        );
        expect(missing.status).toBe(404);

        // A normal publication of the same harmless suite is a real pass.
        const ok = await post(restarted.url, "other-key");
        const okId = ((await ok.json()) as { run_id: string }).run_id;
        const passed = await terminal(restarted.url, okId);
        expect(passed.summary.result).toBe("pass");
        const [entry] = passed.artifacts;
        if (!entry) throw new Error("no artifact published");
        const bytes = Buffer.from(
          await (
            await fetch(`${restarted.url}${entry.download_url}`, {
              headers: auth,
            })
          ).arrayBuffer(),
        );
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          entry.sha256,
        );
        expect(bytes.length).toBe(entry.size_bytes);
      } finally {
        await restarted.close();
      }
    },
    CHILD_TIMEOUT,
  );
});
