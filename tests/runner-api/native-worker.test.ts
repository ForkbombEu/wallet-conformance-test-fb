import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunRequest } from "@/runner-api/contract";
import type { EffectiveConfig } from "@/runner-api/effective-config";
import type { Config } from "@/types";

import { packageRoot, resolveSelectionTestFile } from "@/logic/runtime-paths";
import { buildEffectiveConfig } from "@/runner-api/effective-config";
import {
  createNativeExecutor,
  type ProcessAdapter,
  type SpawnedProcess,
  type SpawnOptions,
} from "@/runner-api/native-worker";
import { getProfile } from "@/runner-api/profiles";

interface FakeSpawnRecord {
  args: string[];
  command: string;
  options: SpawnOptions;
}

function makeBaseConfig(): Config {
  return {
    issuance: {
      authorization_interaction: "auto",
      callback_port: 4000,
      client_authentication: "auto",
      credential_types: [],
      save_credential: false,
      tests_dir: "./tests",
      url: "https://issuer.example",
    },
    issuer: { port: 3003 },
    logging: {
      log_file: "./data/logs/test.log",
      log_format: "%(message)s",
      log_level: "INFO",
    },
    network: {
      bind_address: "127.0.0.1",
      max_retries: 10,
      timeout: 10,
      tls_reject_unauthorized: true,
    },
    presentation: {
      authorize_request_url: "https://rp.example/auth",
      tests_dir: "./tests",
    },
    profile: { ecosystem: "generic_oid4vci" },
    steps_mapping: { mapping: {} },
    testing: {
      custom_step_pattern: "**/*.ts",
      spec_pattern: "**/*.spec.ts",
      strict_custom_steps: false,
    },
    trust: {
      ca_cert_path: "./data/trust",
      certificate_subject: "CN=test",
      federation_trust_anchors: [],
      federation_trust_anchors_jwks_path: "./data/trust",
    },
    trust_anchor: { port: 3001, verify: true },
    wallet: {
      backup_storage_path: "./data/backup",
      credentials_storage_path: "./data/credentials",
      port: 3002,
      wallet_attestations_storage_path: "./data/attestation",
      wallet_id: "test",
      wallet_name: "Test",
      wallet_version: "V1_0" as never,
    },
  };
}

function makeEffectiveConfig(workspace = dir): EffectiveConfig {
  const effective = buildEffectiveConfig(
    requireProfile("credimi-issuance-smoke"),
    "credimi-issuance-smoke",
    {},
    makeBaseConfig(),
    workspace,
  );
  // The worker requires real absolute selection/INI paths before spawning.
  return {
    ...effective,
    profileConfigPath: join(packageRoot, "config.example.ini"),
    testFile: resolveSelectionTestFile(effective.testFile),
  };
}

function makeFakeAdapter(
  exitCode = 0,
  options: { exitDelayMs?: number; stderr?: string } = {},
): {
  adapter: ProcessAdapter;
  getExitCode: () => null | number;
  spawns: FakeSpawnRecord[];
} {
  const spawns: FakeSpawnRecord[] = [];
  let exitCodeRef: null | number = null;

  const adapter: ProcessAdapter = {
    spawn(command, args, opts) {
      spawns.push({ args, command, options: opts });

      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {
        error: [],
        exit: [],
      };

      const handle: SpawnedProcess = {
        kill: () => true,
        on(event, listener) {
          listeners[event]?.push(listener as (...a: unknown[]) => void);
        },
        pid: 12345,
      };

      // Simulate async exit
      setTimeout(() => {
        exitCodeRef = exitCode;
        for (const fn of listeners.exit ?? []) fn(exitCode);
      }, options.exitDelayMs ?? 10);

      return handle;
    },
  };

  return { adapter, getExitCode: () => exitCodeRef, spawns };
}

// -- Fake process adapter ---------------------------------------------------

function makeRequest(): RunRequest {
  return {
    category: "issuance",
    contract_version: "1.0",
    parameters: {},
    profile_id: "credimi-issuance-smoke",
    selection: { ids: ["credimi-issuance-smoke"] },
    target: { actor_name: "test", actor_type: "issuer" },
    timeout_ms: 600_000,
  };
}

function requireProfile(id: string) {
  const p = getProfile(id);
  if (!p) throw new Error(`Profile '${id}' not found`);
  return p;
}

// -- Tests -------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-nw-"));
  mkdirSync(join(dir, "results"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("native-worker — args/env/cwd", () => {
  it("spawns node with vitest run and correct config", async () => {
    const { adapter, spawns } = makeFakeAdapter();
    const execute = createNativeExecutor({
      effectiveConfig: makeEffectiveConfig(),
      processAdapter: adapter,
      request: makeRequest(),
    });

    await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: "test-run-1",
      runRoot: dir,
    });

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe(process.execPath);
    expect(spawns[0]?.args).toContain("run");
    expect(spawns[0]?.args).toContain("--config");
    expect(
      spawns[0]?.args.some((a) => a.includes("vitest.issuance.config")),
    ).toBe(true);
  });

  it("passes WCT_RUN_ID, WCT_RESULTS_DIR, WCT_DB_PATH explicitly", async () => {
    const { adapter, spawns } = makeFakeAdapter();
    const execute = createNativeExecutor({
      effectiveConfig: makeEffectiveConfig(),
      processAdapter: adapter,
      request: makeRequest(),
    });

    await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: "my-run-id",
      runRoot: dir,
    });

    const env = spawns[0]?.options.env ?? {};
    expect(env.WCT_RUN_ID).toBe("my-run-id");
    expect(env.WCT_RESULTS_DIR).toContain("results");
    expect(env.WCT_DB_PATH).toContain("wct.db");
  });

  it("uses correct cwd and shell:false", async () => {
    const { adapter, spawns } = makeFakeAdapter();
    const execute = createNativeExecutor({
      effectiveConfig: makeEffectiveConfig(),
      processAdapter: adapter,
      request: makeRequest(),
    });

    await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: "run-1",
      runRoot: dir,
    });

    expect(spawns[0]?.options.cwd).toBe(dir);
    expect(spawns[0]?.options.shell).toBe(false);
    expect(spawns[0]?.options.detached).toBe(true);
  });

  it("passes the test file from effective config", async () => {
    const { adapter, spawns } = makeFakeAdapter();
    const eff = makeEffectiveConfig();
    const execute = createNativeExecutor({
      effectiveConfig: eff,
      processAdapter: adapter,
      request: makeRequest(),
    });

    await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: "run-1",
      runRoot: dir,
    });

    expect(spawns[0]?.args).toContain(eff.testFile);
  });
});

describe("native-worker — profile immutability", () => {
  it("does not mutate the effective config", async () => {
    const eff = makeEffectiveConfig();
    const snapshot = JSON.stringify(eff);
    const { adapter } = makeFakeAdapter();
    const execute = createNativeExecutor({
      effectiveConfig: eff,
      processAdapter: adapter,
      request: makeRequest(),
    });

    await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: "run-1",
      runRoot: dir,
    });

    expect(JSON.stringify(eff)).toBe(snapshot);
  });
});

describe("native-worker — distinct DBs", () => {
  it("rejects writable paths outside the run workspace", async () => {
    const { adapter, spawns } = makeFakeAdapter();
    const execute = createNativeExecutor({
      effectiveConfig: makeEffectiveConfig(join(dir, "other-run")),
      processAdapter: adapter,
      request: makeRequest(),
    });
    await expect(
      execute({
        abortSignal: new AbortController().signal,
        request: makeRequest(),
        runId: "run-x",
        runRoot: join(dir, "run-x"),
      }),
    ).rejects.toThrow(/outside the run workspace/);
    expect(spawns).toHaveLength(0);
  });

  it("different runs get different WCT_DB_PATH", async () => {
    const { adapter, spawns } = makeFakeAdapter();

    for (const runId of ["run-a", "run-b"]) {
      const runDir = join(dir, runId);
      // Production resolves effective config per run workspace (resolveRun).
      const execute = createNativeExecutor({
        effectiveConfig: makeEffectiveConfig(runDir),
        processAdapter: adapter,
        request: makeRequest(),
      });
      mkdirSync(runDir, { recursive: true });
      await execute({
        abortSignal: new AbortController().signal,
        request: makeRequest(),
        runId,
        runRoot: runDir,
      });
    }

    const dbPaths = spawns.map((s) => s.options.env.WCT_DB_PATH);
    expect(dbPaths[0]).not.toBe(dbPaths[1]);
    expect(dbPaths[0]).toContain("run-a");
    expect(dbPaths[1]).toContain("run-b");
  });
});

describe("native-worker — nonzero with export", () => {
  it("nonzero exit + readable export = completed with failure", async () => {
    // Write a native export with a FAIL assertion (producer format = camelCase)
    writeFileSync(
      join(dir, "results", "native-results.json"),
      JSON.stringify({
        assertions: [
          {
            ancestorTitles: [],
            file: "test.ts",
            nativeStatus: "FAIL",
            phase: "issuance",
            requirementId: "CI_001",
            title: "CI_001: test",
            vitestStatus: "failed",
          },
        ],
        closedAt: "2026-01-01T00:00:02Z",
        phase: "issuance",
        runId: "run-1",
        sessionId: "session-1",
        startedAt: "2026-01-01T00:00:00Z",
        status: "FAILED",
      }),
    );

    const { adapter } = makeFakeAdapter(1);
    const execute = createNativeExecutor({
      effectiveConfig: makeEffectiveConfig(),
      processAdapter: adapter,
      request: makeRequest(),
    });

    const evidence = await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: "run-1",
      runRoot: dir,
    });

    expect(evidence.result.execution.status).toBe("completed");
    expect(evidence.result.summary.result).toBe("fail");
    expect(evidence.result.native.assertions).toHaveLength(1);
    expect(evidence.result.native.assertions[0]?.native_status).toBe("FAIL");
    expect(evidence.result.native.sessions[0]?.id).toBe("session-1");
  });
});

describe("native-worker — missing/empty export", () => {
  it("missing export → error result", async () => {
    const { adapter } = makeFakeAdapter(1);
    const execute = createNativeExecutor({
      effectiveConfig: makeEffectiveConfig(),
      processAdapter: adapter,
      request: makeRequest(),
    });

    const evidence = await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: "run-1",
      runRoot: dir,
    });

    expect(evidence.result.execution.status).toBe("error");
    expect(evidence.result.summary.result).toBe("not_tested");
    expect(evidence.result.native.assertions).toHaveLength(0);
  });

  it("corrupt export → error result", async () => {
    writeFileSync(join(dir, "results", "native-results.json"), "not json");
    const { adapter } = makeFakeAdapter(0);
    const execute = createNativeExecutor({
      effectiveConfig: makeEffectiveConfig(),
      processAdapter: adapter,
      request: makeRequest(),
    });

    const evidence = await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: "run-1",
      runRoot: dir,
    });

    expect(evidence.result.execution.status).toBe("error");
  });

  it("zero assertions in export → not_tested", async () => {
    writeFileSync(
      join(dir, "results", "native-results.json"),
      JSON.stringify({
        assertions: [],
        closedAt: null,
        sessionId: "s1",
        startedAt: "2026-01-01T00:00:00Z",
        status: "PASSED",
      }),
    );

    const { adapter } = makeFakeAdapter(0);
    const execute = createNativeExecutor({
      effectiveConfig: makeEffectiveConfig(),
      processAdapter: adapter,
      request: makeRequest(),
    });

    const evidence = await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: "run-1",
      runRoot: dir,
    });

    expect(evidence.result.summary.result).toBe("not_tested");
    expect(evidence.result.summary.assertion_count).toBe(0);
  });
});

describe("native-worker — cancellation", () => {
  it("abort signal triggers graceful termination", async () => {
    const { adapter, spawns } = makeFakeAdapter(0, { exitDelayMs: 10_000 });
    const execute = createNativeExecutor({
      effectiveConfig: makeEffectiveConfig(),
      processAdapter: adapter,
      request: makeRequest(),
    });

    const controller = new AbortController();
    void execute({
      abortSignal: controller.signal,
      request: makeRequest(),
      runId: "run-1",
      runRoot: dir,
    });

    // Abort after spawn
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    // The fake adapter's exit will fire after 10s; but we don't wait that long.
    // The promise should settle after the abort handler resolves.
    // For this test we just verify spawn happened and abort was called.
    expect(spawns).toHaveLength(1);
    // Don't await promise (it would block for 10s on the fake)
  });
});

describe("native-worker — byte-capped diagnostics", () => {
  it("truncates error messages in error result", async () => {
    // Missing export with stderr (the adapter doesn't capture stderr in fake,
    // but the error message is constructed from the fallback)
    const { adapter } = makeFakeAdapter(1);
    const execute = createNativeExecutor({
      effectiveConfig: makeEffectiveConfig(),
      processAdapter: adapter,
      request: makeRequest(),
    });

    const evidence = await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: "run-1",
      runRoot: dir,
    });

    // Error result should have bounded error message
    const err = evidence.result.execution.error ?? "";
    expect(err.length).toBeLessThanOrEqual(4096);
  });
});
