/* eslint-disable max-lines-per-function */
/**
 * L15 production composition gate (coverage: interoperability).
 *
 * Part A launches the COMPILED server command (`node dist/runner-api/main.js`)
 * with temporary operator profiles/INIs. Nothing is injected: real profile
 * loader, selection validation, effective config, native worker, real Vitest
 * child with the real ConformanceReporter, adapter, summarizer, lifecycle,
 * artifact manifests, HTTP routes and process signals. The only "SUT" is
 * harmless local fixtures and a closed local port.
 *
 * Part B uses the exact production constructor (startRunner) and replaces
 * only the low-level subprocess boundary to emit stale / malformed / missing
 * native evidence, asserting the argv/env production resolution produced.
 */
import { parse, stringify } from "ini";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { packageRoot } from "@/logic/runtime-paths";
import { type RunnerResult, runnerResultSchema } from "@/runner-api/contract";
import { startRunner } from "@/runner-api/main";
import {
  defaultProcessAdapter,
  type ProcessAdapter,
  type SpawnOptions,
} from "@/runner-api/native-worker";

const TOKEN = "l15-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const FIXTURES = resolve(import.meta.dirname, "fixtures/production");
const SMOKE = "tests/credimi/issuance/credimi-flow.issuance.spec.ts";
const SLOW = 300_000;

let work: string;
let operatorDir: string;
let profilesPath: string;
let stateDir: string;
let closedIssuerPort: number;
let localPorts: number[];

interface Server {
  child: ChildProcessWithoutNullStreams;
  exit: Promise<null | number>;
  url: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertNothingLeft(runId: string): Promise<void> {
  const pids = pidsOf(runId);
  expect(alive(pids.main)).toBe(false);
  expect(alive(pids.worker)).toBe(false);
  for (const port of localPorts)
    await expect(portIsFree(port)).resolves.toBe(true);
}

async function download(url: string, result: RunnerResult): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const entry of result.artifacts) {
    const res = await fetch(`${url}${entry.download_url}`, { headers: auth });
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(sha256(bytes)).toBe(entry.sha256);
    expect(bytes.length).toBe(entry.size_bytes);
    out.push(bytes);
  }
  return out;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  await new Promise<void>((r) => server.close(() => r()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function launchCompiled(): Promise<Server> {
  const child = spawn(
    process.execPath,
    [
      join(packageRoot, "dist/runner-api/main.js"),
      "--profiles",
      profilesPath,
      "--state-dir",
      stateDir,
      "--port",
      "0",
    ],
    {
      cwd: work,
      env: { ...process.env, CREDIMI_RUNNER_TOKEN: TOKEN },
    },
  );
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (output += d.toString()));
  const exit = new Promise<null | number>((r) => child.once("exit", r));
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 30_000);
    child.stdout.on("data", () => {
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    void exit.then(() => {
      clearTimeout(timer);
      reject(new Error(`server exited: ${output}`));
    });
  });
  return { child, exit, url };
}

function pidsOf(runId: string): { main: number; worker: number } {
  return JSON.parse(
    readFileSync(join(stateDir, "work", runId, "pids.json"), "utf-8"),
  ) as { main: number; worker: number };
}

async function portIsFree(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((r) => {
    server.once("error", () => r(false));
    server.listen(port, "127.0.0.1", () => server.close(() => r(true)));
  });
}

async function post(
  url: string,
  key: string,
  body: Record<string, unknown>,
): Promise<{ json: Record<string, unknown>; status: number }> {
  const res = await fetch(`${url}/v1/runs`, {
    body: JSON.stringify({
      category: "issuance",
      contract_version: "1.0",
      profile_id: "local-fixtures",
      target: { actor_name: "local-fixture", actor_type: "issuer" },
      ...body,
    }),
    headers: {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });
  return {
    json: (await res.json()) as Record<string, unknown>,
    status: res.status,
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function startRun(
  url: string,
  key: string,
  body: Record<string, unknown>,
): Promise<string> {
  const { json, status } = await post(url, key, body);
  expect({ json, status }).toMatchObject({ status: 202 });
  return json.run_id as string;
}

async function terminal(url: string, runId: string): Promise<RunnerResult> {
  for (let i = 0; i < 2_400; i++) {
    const snap = (await (
      await fetch(`${url}/v1/runs/${runId}`, { headers: auth })
    ).json()) as { status: string };
    if (
      ["cancelled", "completed", "error", "timed_out"].includes(snap.status)
    ) {
      const result = runnerResultSchema.parse(
        await (
          await fetch(`${url}/v1/runs/${runId}/result`, { headers: auth })
        ).json(),
      );
      expect(result.execution.status).toBe(snap.status);
      return result;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${runId} did not finish`);
}

async function waitFor(path: string): Promise<void> {
  for (let i = 0; i < 600 && !existsSync(path); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(path)) throw new Error(`never appeared: ${path}`);
}

/** Waits until the reporter's OPEN export contains the first assertion. */
async function waitForFirstAssertion(runId: string): Promise<void> {
  const exportPath = join(
    stateDir,
    "work",
    runId,
    "results",
    "native-results.json",
  );
  for (let i = 0; i < 600; i++) {
    if (existsSync(exportPath)) {
      const data = JSON.parse(readFileSync(exportPath, "utf-8")) as {
        assertions: unknown[];
      };
      if (data.assertions.length > 0) return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const logs = join(stateDir, "work", runId, "logs");
  const tail = (f: string) =>
    existsSync(join(logs, f))
      ? readFileSync(join(logs, f), "utf-8").slice(-2000)
      : "";
  throw new Error(
    `first assertion never exported\nstdout: ${tail("stdout.log")}\nstderr: ${tail("stderr.log")}`,
  );
}

async function writeOperatorIni(
  name: string,
  issuance: Record<string, unknown>,
): Promise<number[]> {
  const ini = parse(
    readFileSync(join(packageRoot, "config.example.ini"), "utf-8"),
  ) as Record<string, Record<string, unknown>>;
  const section = (s: string) => (ini[s] ??= {});
  const ports = [await freePort(), await freePort(), await freePort()];
  section("profile").ecosystem = "generic_oid4vci";
  Object.assign(section("issuance"), issuance);
  section("network").bind_address = "127.0.0.1";
  section("network").timeout = 2;
  section("network").max_retries = 1;
  section("trust_anchor").port = ports[0];
  delete section("trust_anchor").tls_cert_dir;
  section("wallet").port = ports[1];
  section("issuer").port = ports[2];
  writeFileSync(join(operatorDir, name), stringify(ini));
  return ports;
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "wct-l15-"));
  operatorDir = join(work, "operator");
  stateDir = join(work, "state");
  mkdirSync(operatorDir);
  // dist/runner-api/main.js comes from the suite's build-once global setup.

  closedIssuerPort = await freePort();
  localPorts = await writeOperatorIni("fixtures.ini", {
    credential_types: ["generic_pid_sd_jwt"],
    url: `https://127.0.0.1:${closedIssuerPort}`,
  });
  const callbackPort = await freePort();
  await writeOperatorIni("browser.ini", {
    authorization_interaction: "browser_redirect",
    callback_port: callbackPort,
    credential_types: ["generic_pid_sd_jwt"],
    url: "https://issuer.invalid",
  });
  writeFileSync(
    join(operatorDir, "driver.mjs"),
    `import { writeFileSync } from "node:fs";
export async function driveAuthorization({ page, authorizationUrl, redirectUri }) {
  writeFileSync(new URL("./driver-record.json", import.meta.url), JSON.stringify({ authorizationUrl, redirectUri }));
  const target = new URL(redirectUri);
  target.searchParams.set("code", "code-from-production-driver");
  target.searchParams.set("iss", "https://issuer.invalid");
  target.searchParams.set("state", "s");
  await page.goto(target.href);
}
`,
  );

  profilesPath = join(operatorDir, "profiles.json");
  writeFileSync(
    profilesPath,
    JSON.stringify({
      profiles: [
        {
          allowedAuthorizationInteraction: ["auto"],
          category: "issuance",
          configFile: "fixtures.ini",
          coverageMode: "interoperability",
          id: "local-fixtures",
          selections: [
            {
              id: "matrix",
              testFile: join(FIXTURES, "matrix.issuance.spec.ts"),
            },
            {
              id: "waiting",
              testFile: join(FIXTURES, "waiting.issuance.spec.ts"),
            },
            {
              id: "teardown",
              testFile: join(FIXTURES, "teardown.issuance.spec.ts"),
            },
            { id: "credimi-issuance-smoke", testFile: SMOKE },
          ],
        },
        {
          allowedAuthorizationInteraction: ["browser_redirect"],
          authorizationDriver: { modulePath: "driver.mjs", type: "puppeteer" },
          category: "issuance",
          configFile: "browser.ini",
          coverageMode: "interoperability",
          id: "browser",
          selections: [
            {
              id: "browser",
              testFile: join(FIXTURES, "browser.issuance.spec.ts"),
            },
          ],
        },
      ],
    }),
  );
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
}, SLOW);

afterAll(() => {
  rmSync(work, { force: true, recursive: true });
});

describe("L15 — compiled legacy server, real native children", () => {
  let server: Server;
  let matrix: RunnerResult;
  let matrixBytes: Buffer[];

  beforeAll(async () => {
    server = await launchCompiled();
  }, SLOW);

  afterAll(async () => {
    if (server.child.exitCode === null) {
      server.child.kill("SIGTERM");
      await server.exit;
    }
  });

  it(
    "a deliberately failing native suite is completed + fail with exact evidence",
    async () => {
      const runId = await startRun(server.url, "matrix-1", {
        selection: { ids: ["matrix"] },
      });
      matrix = await terminal(server.url, runId);

      expect(matrix.execution.status).toBe("completed");
      expect(matrix.execution.exit_code).not.toBe(0);
      expect(matrix.summary.result).toBe("fail");
      expect(matrix.summary.assertion_count).toBe(4);
      expect(matrix.summary.native_failed_assertion_count).toBe(1);
      expect(matrix.native.coverage_mode).toBe("interoperability");
      expect(matrix.engine.revision).toMatch(/^[0-9a-f]{40}$/);

      const byTitle = (s: string) =>
        matrix.native.assertions.find((a) => a.full_title.includes(s));
      expect(byTitle("[CI_900]")?.requirement_id).toBe("CI_900");
      expect(
        matrix.native.assertions.filter((a) => a.requirement_id === "CI_901"),
      ).toHaveLength(2);
      expect(byTitle("generic assertion")?.requirement_id).toBeUndefined();
      expect(byTitle("second occurrence")?.native_status).toBe("FAIL");
      expect(byTitle("[CI_900]")?.full_title).toBe(
        "Production matrix > Requirement identifiers > [CI_900]: bracketed requirement passes",
      );
      expect(
        new Set(matrix.native.assertions.map((a) => a.assertion_id)).size,
      ).toBe(4);

      // Raw native export written by the real reporter, served byte-exact.
      matrixBytes = await download(server.url, matrix);
      const raw = JSON.parse(matrixBytes[0]?.toString() ?? "{}") as {
        assertions: { nativeStatus: string }[];
        runId: string;
        status: string;
      };
      expect(raw.runId).toBe(runId);
      expect(raw.status).toBe("FAILED");
      expect(
        raw.assertions.filter((a) => a.nativeStatus === "FAIL"),
      ).toHaveLength(1);

      // The child consumed this profile's INI/SUT identity.
      const diag = JSON.parse(
        readFileSync(join(stateDir, "work", runId, "diagnostic.json"), "utf-8"),
      ) as {
        config_file_ini: string;
        credential_types: string[];
        issuer_url: string;
      };
      expect(diag.issuer_url).toBe(`https://127.0.0.1:${closedIssuerPort}`);
      expect(diag.credential_types).toEqual(["generic_pid_sd_jwt"]);
      expect(diag.config_file_ini).toBe(
        join(stateDir, "work", runId, "effective.ini"),
      );
    },
    SLOW,
  );

  it(
    "sequential runs, idempotency and request rejection",
    async () => {
      const second = await startRun(server.url, "matrix-2", {
        parameters: { credential_configuration_ids: ["other_type"] },
        selection: { ids: ["matrix"] },
      });
      expect(second).not.toBe(matrix.run_id);
      const secondResult = await terminal(server.url, second);
      expect(secondResult.summary.result).toBe("fail");
      const diag = JSON.parse(
        readFileSync(
          join(stateDir, "work", second, "diagnostic.json"),
          "utf-8",
        ),
      ) as { credential_types: string[] };
      expect(diag.credential_types).toEqual(["other_type"]);

      const replay = await post(server.url, "matrix-1", {
        selection: { ids: ["matrix"] },
      });
      expect(replay.status).toBe(200);
      expect(replay.json.run_id).toBe(matrix.run_id);
      const conflict = await post(server.url, "matrix-1", {
        selection: { ids: ["matrix"] },
        target: { actor_name: "changed", actor_type: "issuer" },
      });
      expect(conflict.status).toBe(409);
      expect((conflict.json.error as { code: string }).code).toBe(
        "IDEMPOTENCY_CONFLICT",
      );

      for (const [key, body] of [
        ["r1", { profile_id: "nope", selection: { ids: ["matrix"] } }],
        ["r2", { category: "presentation", selection: { ids: ["matrix"] } }],
        ["r3", { selection: { ids: ["unknown-selection"] } }],
        ["r4", { selection: { ids: ["matrix", "waiting"] } }],
      ] as const) {
        expect((await post(server.url, key, body)).status).toBe(400);
      }

      const entry = matrix.artifacts[0];
      if (!entry) throw new Error("no artifact");
      expect(
        (
          await fetch(`${server.url}/v1/runs/${second}/artifacts/nope.json`, {
            headers: auth,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(
            `${server.url}/v1/runs/not-a-run/artifacts/${entry.artifact_id}`,
            {
              headers: auth,
            },
          )
        ).status,
      ).toBe(404);
    },
    SLOW,
  );

  it(
    "cancelling a waiting native child keeps partial evidence and leaves nothing running",
    async () => {
      const runId = await startRun(server.url, "wait-cancel", {
        selection: { ids: ["waiting"] },
      });
      await waitForFirstAssertion(runId);
      const res = await fetch(`${server.url}/v1/runs/${runId}/cancel`, {
        headers: auth,
        method: "POST",
      });
      expect(((await res.json()) as { status: string }).status).toBe(
        "cancelled",
      );
      const result = await terminal(server.url, runId);
      expect(result.summary.result).toBe("partial");
      expect(result.native.assertions.map((a) => a.native_status)).toEqual([
        "PASS",
      ]);
      await download(server.url, result);
      await assertNothingLeft(runId);
    },
    SLOW,
  );

  it(
    "a real deadline times out the native child with partial evidence",
    async () => {
      const runId = await startRun(server.url, "wait-deadline", {
        selection: { ids: ["waiting"] },
        timeout_ms: 15_000,
      });
      const result = await terminal(server.url, runId);
      expect(result.execution.status).toBe("timed_out");
      expect(result.summary.result).toBe("partial");
      expect(result.native.assertions).toHaveLength(1);
      await assertNothingLeft(runId);
    },
    SLOW,
  );

  it(
    "the source generic smoke selection runs against the profile's (closed) issuer",
    async () => {
      const runId = await startRun(server.url, "smoke-1", {
        selection: { ids: ["credimi-issuance-smoke"] },
      });
      const result = await terminal(server.url, runId);
      expect(result.execution.status).toBe("completed");
      expect(result.summary.result).toBe("fail");
      expect(result.native.assertions[0]?.file).toBe(join(packageRoot, SMOKE));
      expect(result.native.assertions[0]?.full_title).toContain(
        "Credimi issuance smoke",
      );
    },
    SLOW,
  );

  it(
    "configured browser: the native orchestrator drives the operator module through AuthorizeDefaultStep",
    async () => {
      const runId = await startRun(server.url, "browser-1", {
        profile_id: "browser",
        selection: { ids: ["browser"] },
      });
      const result = await terminal(server.url, runId);
      expect(result.execution.status).toBe("completed");
      expect(result.summary.result).toBe("pass");
      expect(result.native.assertions[0]?.requirement_id).toBe("CI_950");
      const record = JSON.parse(
        readFileSync(join(operatorDir, "driver-record.json"), "utf-8"),
      ) as { authorizationUrl: string; redirectUri: string };
      expect(record.authorizationUrl).toContain("/authorize?client_id=");
      expect(record.redirectUri).toMatch(/^http:\/\/localhost:\d+\/cb$/);
    },
    SLOW,
  );

  it(
    "SIGTERM during a live run finalizes it; restart keeps results, replay and downloads",
    async () => {
      const runId = await startRun(server.url, "wait-shutdown", {
        selection: { ids: ["waiting"] },
      });
      await waitForFirstAssertion(runId);
      server.child.kill("SIGTERM");
      await expect(server.exit).resolves.toBe(0);
      expect(existsSync(join(stateDir, ".owner.lock"))).toBe(false);
      await assertNothingLeft(runId);

      server = await launchCompiled();
      const shut = await terminal(server.url, runId);
      expect(shut.execution.status).toBe("cancelled");
      expect(shut.limitations.join(" ")).toMatch(/shutdown/);
      expect(shut.summary.result).toBe("partial");

      const again = await terminal(server.url, matrix.run_id);
      expect(again).toEqual(matrix);
      await expect(download(server.url, again)).resolves.toEqual(matrixBytes);
      const replay = await post(server.url, "matrix-1", {
        selection: { ids: ["matrix"] },
      });
      expect(replay.status).toBe(200);
      expect(replay.json.run_id).toBe(matrix.run_id);
    },
    SLOW,
  );

  it(
    "L16: a passing check followed by a failing teardown is never pass; the next run still starts",
    async () => {
      const runId = await startRun(server.url, "teardown-1", {
        selection: { ids: ["teardown"] },
      });
      const result = await terminal(server.url, runId);

      expect(result.execution.status).toBe("completed");
      expect(result.execution.exit_code).not.toBe(0);
      expect(result.native.assertions.map((a) => a.native_status)).toEqual([
        "PASS",
      ]);
      expect(result.native.native_suite_status).toBe("INCOMPLETE");
      expect(result.summary.result).toBe("partial");
      expect(result.limitations.join(" ")).toMatch(
        /teardown failed on purpose/,
      );

      // The served raw export is the reporter's exact file, errors included.
      const [bytes] = await download(server.url, result);
      expect(
        bytes?.equals(
          readFileSync(
            join(stateDir, "work", runId, "results", "native-results.json"),
          ),
        ),
      ).toBe(true);
      const raw = JSON.parse(bytes?.toString() ?? "{}") as {
        errors?: { location?: string; message: string; origin: string }[];
        status: string;
      };
      expect(raw.status).toBe("INCOMPLETE");
      expect(raw.errors).toEqual([
        expect.objectContaining({
          location: "Production teardown",
          message: expect.stringContaining("teardown failed on purpose"),
          origin: "suite",
        }),
      ]);

      const next = await startRun(server.url, "teardown-2", {
        selection: { ids: ["matrix"] },
      });
      expect((await terminal(server.url, next)).summary.result).toBe("fail");
    },
    SLOW,
  );

  it(
    "a crashed server leaves its lock; after manual removal the interrupted run recovers truthfully",
    async () => {
      const runId = await startRun(server.url, "wait-crash", {
        selection: { ids: ["waiting"] },
      });
      await waitForFirstAssertion(runId);
      await waitFor(join(stateDir, "work", runId, "pids.json"));
      server.child.kill("SIGKILL");
      await server.exit;

      // Stale lock: startup refuses instead of deleting it automatically.
      await expect(launchCompiled()).rejects.toThrow(
        /locked by another runner/,
      );

      // Operator procedure: stop the orphaned native group, then remove the lock.
      const pids = pidsOf(runId);
      try {
        process.kill(-pids.main, "SIGKILL");
      } catch {
        // already gone
      }
      for (let i = 0; i < 100 && alive(pids.main); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      rmSync(join(stateDir, ".owner.lock"));

      server = await launchCompiled();
      const recovered = await terminal(server.url, runId);
      expect(recovered.execution.status).toBe("error");
      expect(recovered.limitations.join(" ")).toMatch(/interrupted/);
      expect(recovered.native.assertions.map((a) => a.native_status)).toEqual([
        "PASS",
      ]);
      expect(recovered.summary.result).toBe("partial");
    },
    SLOW,
  );
});

describe("L15 — production constructor, low-level subprocess boundary only", () => {
  /** Emits a native export as a broken engine would, then exits 1. */
  function evidenceAdapter(
    kind: "malformed" | "none" | "stale",
    seen: { args: string[]; options: SpawnOptions }[],
  ): ProcessAdapter {
    return {
      spawn(command, args, options) {
        seen.push({ args, options });
        const out = join(
          options.env.WCT_RESULTS_DIR ?? "",
          "native-results.json",
        );
        const body = {
          malformed: `require("fs").writeFileSync(${JSON.stringify(out)}, "{not json");`,
          none: "",
          stale: `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({assertions:[{ancestorTitles:[],description:"",errorMessage:null,file:"x",nativeStatus:"PASS",phase:"issuance",requirementId:null,timestamp:"t",title:"old",vitestStatus:"passed"}],closedAt:"t",phase:"issuance",runId:"OLD-RUN",sessionId:"s",startedAt:"t",status:"PASSED"}));`,
        }[kind];
        return defaultProcessAdapter.spawn(
          command,
          ["-e", `${body} process.exit(1);`],
          options,
        );
      },
    };
  }

  it.each(["stale", "malformed", "none"] as const)(
    "%s native evidence is an error, never a pass",
    async (kind) => {
      const seen: { args: string[]; options: SpawnOptions }[] = [];
      const runner = await startRunner({
        port: 0,
        processAdapter: evidenceAdapter(kind, seen),
        profiles: profilesPath,
        runRoot: join(work, `state-${kind}`),
      });
      try {
        const runId = await startRun(runner.url, "k", {
          selection: { ids: ["matrix"] },
        });
        const result = await terminal(runner.url, runId);
        expect(result.execution.status).toBe("error");
        expect(result.summary.result).toBe("not_tested");
        expect(result.native.assertions).toEqual([]);

        // Production resolution reached the boundary unchanged.
        const call = seen[0];
        expect(call?.args.slice(1, 4)).toEqual([
          "run",
          "--config",
          join(packageRoot, "vitest.issuance.config.js"),
        ]);
        expect(call?.args[4]).toBe(join(FIXTURES, "matrix.issuance.spec.ts"));
        expect(call?.options.env.CONFIG_FILE_INI).toBe(
          join(work, `state-${kind}`, "work", runId, "effective.ini"),
        );
        expect(call?.options.env.WCT_RUN_ID).toBe(runId);
        expect(call?.options.env.CONFIG_CREDENTIAL_ISSUER_URI).toBe(
          `https://127.0.0.1:${closedIssuerPort}`,
        );
      } finally {
        await runner.close();
      }
    },
    SLOW,
  );
});
