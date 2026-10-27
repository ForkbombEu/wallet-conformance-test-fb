import { parse, stringify } from "ini";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunRequest } from "@/runner-api/contract";
import type { ExecutionEvidence } from "@/runner-api/job-manager";

import { packageRoot, resolveSelectionTestFile } from "@/logic/runtime-paths";
import {
  resolveVitestBin,
  resolveVitestConfigPath,
} from "@/logic/test-command";
import { runnerResultSchema, runRequestSchema } from "@/runner-api/contract";
import { resolveRun } from "@/runner-api/main";
import {
  buildNativeEnv,
  createNativeExecutor,
  defaultProcessAdapter,
  NATIVE_LOG_CAP_BYTES,
  type ProcessAdapter,
} from "@/runner-api/native-worker";
import {
  loadProfileCatalogue,
  type ProfileCatalogue,
} from "@/runner-api/profiles";

const FIXTURE_SPEC = resolve(
  import.meta.dirname,
  "fixtures/native-discovery/diagnostic.issuance.spec.ts",
);
const SMOKE_SPEC = "tests/credimi/issuance/credimi-flow.issuance.spec.ts";
const CHILD_TIMEOUT = 90_000;

interface Diagnostic {
  authorization_interaction: string;
  backup_storage_path: string;
  ca_cert_path: string;
  config_file_ini: string;
  configuration_count: number;
  credential_offer_uri: null | string;
  credential_types: string[];
  credentials_storage_path: string;
  db_path: string;
  issuer_url: string;
  log_file: string;
  wallet_attestations_storage_path: string;
}

let dir: string;
let catalogue: ProfileCatalogue;
let operatorIni: string;

function countingAdapter(): { adapter: ProcessAdapter; spawned: number[] } {
  const spawned: number[] = [];
  return {
    adapter: {
      spawn(command, args, options) {
        const child = defaultProcessAdapter.spawn(command, args, options);
        spawned.push(child.pid ?? -1);
        return child;
      },
    },
    spawned,
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  await new Promise<void>((r) => server.close(() => r()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeRequest(parameters: RunRequest["parameters"] = {}): RunRequest {
  return runRequestSchema.parse({
    category: "issuance",
    contract_version: "1.0",
    parameters,
    profile_id: "discovery-fixture",
    selection: { ids: ["diagnostic"] },
    target: { actor_name: "fixture", actor_type: "issuer" },
  });
}

function readDiagnostic(runRoot: string): Diagnostic {
  return JSON.parse(
    readFileSync(join(runRoot, "diagnostic.json"), "utf-8"),
  ) as Diagnostic;
}

async function runNative(
  runId: string,
  request: RunRequest,
  options: { adapter?: ProcessAdapter; signal?: AbortSignal } = {},
): Promise<{ evidence: ExecutionEvidence; runRoot: string }> {
  const runRoot = join(dir, "work", runId);
  const effectiveConfig = resolveRun(catalogue, request, runRoot);
  const execute = createNativeExecutor({
    effectiveConfig,
    processAdapter: options.adapter,
    request,
  });
  const evidence = await execute({
    abortSignal: options.signal ?? new AbortController().signal,
    request,
    runId,
    runRoot,
  });
  return { evidence, runRoot };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A complete operator INI derived from the shipped example config. */
async function writeOperatorIni(target: string): Promise<void> {
  const ini = parse(
    readFileSync(join(packageRoot, "config.example.ini"), "utf-8"),
  ) as Record<string, Record<string, unknown>>;
  const section = (name: string) => (ini[name] ??= {});
  section("issuance").url = "https://operator-issuer.example";
  section("issuance").credential_types = ["operator_default_type"];
  section("trust_anchor").port = await freePort();
  delete section("trust_anchor").tls_cert_dir;
  section("wallet").port = await freePort();
  section("issuer").port = await freePort();
  section("network").bind_address = "127.0.0.1";
  // Generic interoperability: `auto` resolves to credential_presentation.
  section("profile").ecosystem = "generic_oid4vci";
  writeFileSync(target, stringify(ini));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wct-l09-"));
  operatorIni = join(dir, "operator.ini");
  await writeOperatorIni(operatorIni);
  const profilesPath = join(dir, "profiles.json");
  writeFileSync(
    profilesPath,
    JSON.stringify({
      profiles: [
        {
          allowedAuthorizationInteraction: ["auto"],
          category: "issuance",
          configFile: "operator.ini",
          coverageMode: "interoperability",
          id: "discovery-fixture",
          selections: [{ id: "diagnostic", testFile: FIXTURE_SPEC }],
        },
      ],
    }),
  );
  catalogue = loadProfileCatalogue(profilesPath);
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("L09 — real native child discovers and consumes the selection", () => {
  it(
    "collects the selected fixture and applies every typed override",
    async () => {
      const iniHash = sha256(operatorIni);
      const { evidence, runRoot } = await runNative(
        "run-a",
        makeRequest({
          credential_configuration_ids: ["cfg_one", "cfg_two"],
          credential_offer_uri: "openid-credential-offer://?credential_offer=x",
          issuer_url: "https://override-issuer.example",
        }),
      );

      const result = runnerResultSchema.parse(evidence.result);
      expect(result.execution.status).toBe("completed");
      expect(result.execution.exit_code).toBe(0);
      expect(result.summary.assertion_count).toBe(2);
      expect(result.summary.result).toBe("pass");

      const diag = readDiagnostic(runRoot);
      expect(diag.config_file_ini).toBe(join(runRoot, "effective.ini"));
      expect(diag.issuer_url).toBe("https://override-issuer.example");
      expect(diag.credential_types).toEqual(["cfg_one", "cfg_two"]);
      expect(diag.configuration_count).toBe(2);
      expect(diag.credential_offer_uri).toBe(
        "openid-credential-offer://?credential_offer=x",
      );
      expect(diag.authorization_interaction).toBe("auto");
      for (const writable of [
        diag.db_path,
        diag.log_file,
        diag.backup_storage_path,
        diag.credentials_storage_path,
        diag.wallet_attestations_storage_path,
      ]) {
        expect(writable.startsWith(`${runRoot}/`)).toBe(true);
      }
      // Read-only trust references still point at the operator's files.
      expect(diag.ca_cert_path).toBe(join(dir, "data/trust_anchor/localhost"));
      expect(existsSync(diag.db_path)).toBe(true);
      expect(sha256(operatorIni)).toBe(iniHash);
    },
    CHILD_TIMEOUT,
  );

  it(
    "two sequential runs use separate writable state and leave the operator INI unchanged",
    async () => {
      const iniBefore = readFileSync(operatorIni, "utf-8");
      const a = await runNative("run-1", makeRequest());
      const b = await runNative("run-2", makeRequest());
      const da = readDiagnostic(a.runRoot);
      const db = readDiagnostic(b.runRoot);

      expect(da.credential_types).toEqual(["operator_default_type"]);
      expect(da.issuer_url).toBe("https://operator-issuer.example");
      for (const key of [
        "db_path",
        "log_file",
        "backup_storage_path",
        "credentials_storage_path",
        "wallet_attestations_storage_path",
      ] as const) {
        expect(da[key]).not.toBe(db[key]);
      }
      expect(readFileSync(operatorIni, "utf-8")).toBe(iniBefore);
    },
    CHILD_TIMEOUT * 2,
  );

  it(
    "a real failing native assertion is a readable completed result",
    async () => {
      const { evidence } = await runNative(
        "run-fail",
        makeRequest({
          credential_configuration_ids: ["fixture_force_failure"],
        }),
      );
      expect(evidence.result.execution.status).toBe("completed");
      expect(evidence.result.execution.exit_code).not.toBe(0);
      expect(evidence.result.summary.result).toBe("fail");
      expect(evidence.result.summary.native_failed_assertion_count).toBe(1);
    },
    CHILD_TIMEOUT,
  );

  it(
    "verbose child output is drained without hanging and capped on disk",
    async () => {
      const { evidence, runRoot } = await runNative(
        "run-verbose",
        makeRequest({ credential_configuration_ids: ["fixture_verbose"] }),
      );
      expect(evidence.result.execution.status).toBe("completed");
      const stdoutLog = join(runRoot, "logs", "stdout.log");
      // More than a pipe buffer flowed through without blocking the child
      // (the exact amount depends on how much the worker flushed at exit).
      expect(statSync(stdoutLog).size).toBeGreaterThan(64 * 1024);
      expect(statSync(stdoutLog).size).toBeLessThanOrEqual(
        NATIVE_LOG_CAP_BYTES,
      );
    },
    CHILD_TIMEOUT,
  );

  it(
    "abort terminates the whole native process group",
    async () => {
      const { adapter, spawned } = countingAdapter();
      const controller = new AbortController();
      const pending = runNative("run-abort", makeRequest(), {
        adapter,
        signal: controller.signal,
      });
      for (let i = 0; spawned.length === 0 && i < 500; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(spawned).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 500));
      controller.abort();
      const { evidence } = await pending;
      expect(evidence.result.execution.status).toBe("error");
      const pid = spawned[0] ?? -1;
      expect(groupAlive(pid)).toBe(false);
    },
    CHILD_TIMEOUT,
  );
});

describe("L09 — rejected before spawn", () => {
  it("a pre-aborted signal never spawns", async () => {
    const { adapter, spawned } = countingAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runNative("run-pre", makeRequest(), {
        adapter,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(spawned).toHaveLength(0);
  });

  it("a missing selection file or INI never spawns", async () => {
    const { adapter, spawned } = countingAdapter();
    const runRoot = join(dir, "work", "run-missing");
    const request = makeRequest();
    const effectiveConfig = resolveRun(catalogue, request, runRoot);
    const ctx = {
      abortSignal: new AbortController().signal,
      request,
      runId: "run-missing",
      runRoot,
    };
    await expect(
      createNativeExecutor({
        effectiveConfig: { ...effectiveConfig, testFile: join(dir, "x.ts") },
        processAdapter: adapter,
        request,
      })(ctx),
    ).rejects.toThrow(/test file not found/);
    await expect(
      createNativeExecutor({
        effectiveConfig: {
          ...effectiveConfig,
          profileConfigPath: join(dir, "missing.ini"),
        },
        processAdapter: adapter,
        request,
      })(ctx),
    ).rejects.toThrow(/INI not found/);
    expect(spawned).toHaveLength(0);
  });

  it("an offer URI the native loader cannot parse is rejected before acceptance", () => {
    expect(() =>
      resolveRun(
        catalogue,
        makeRequest({ credential_offer_uri: "ftp://offer" }),
        dir,
      ),
    ).toThrow(/credential_offer_uri/);
  });
});

describe("L09 — production smoke spec discovery (source mode)", () => {
  it(
    "native Vitest lists the smoke spec under the worker's include root",
    () => {
      const smoke = resolveSelectionTestFile(SMOKE_SPEC);
      const runRoot = join(dir, "work", "list");
      const request = makeRequest();
      const effectiveConfig = {
        ...resolveRun(catalogue, request, runRoot),
        testFile: smoke,
      };
      const env = buildNativeEnv(effectiveConfig, {
        effectiveIni: operatorIni,
        resultsDir: join(runRoot, "results"),
        runId: "list",
      });
      expect(env.CONFIG_ISSUANCE_TESTS_DIR).toBe(dirname(smoke));

      const output = execFileSync(
        process.execPath,
        [
          resolveVitestBin(),
          "list",
          "--filesOnly",
          "--config",
          resolveVitestConfigPath("issuance"),
          smoke,
        ],
        { cwd: dir, encoding: "utf-8", env, timeout: CHILD_TIMEOUT },
      );
      expect(output).toContain("credimi-flow.issuance.spec.ts");
    },
    CHILD_TIMEOUT,
  );
});
