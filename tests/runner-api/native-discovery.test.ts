import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunRequest } from "../../src/runner-api/contract";
import type {
  ProcessAdapter,
  SpawnedProcess,
  SpawnOptions,
} from "../../src/runner-api/native-worker";
import type { Profile } from "../../src/runner-api/profiles";

import { createNativeExecutor } from "../../src/runner-api/native-worker";

function makeFakeAdapter(exitCode = 0) {
  const spawns: { args: string[]; command: string; options: SpawnOptions }[] =
    [];
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
      setTimeout(() => {
        for (const fn of listeners.exit ?? []) fn(exitCode);
      }, 10);
      return handle;
    },
  };
  return { adapter, spawns };
}

function makeProfile(): Profile {
  return {
    allowedAuthorizationInteraction: ["auto"],
    category: "issuance",
    configFile: "/abs/config.ini",
    coverageMode: "interoperability",
    id: "test-profile",
    selections: [
      {
        id: "credimi-issuance-smoke",
        testFile: "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
      },
    ],
  };
}

function makeRequest(): RunRequest {
  return {
    category: "issuance",
    contract_version: "1.0",
    parameters: {
      credential_configuration_ids: ["pid-1", "pid-2"],
      issuer_url: "https://override-issuer.example",
    },
    profile_id: "test-profile",
    selection: { ids: ["credimi-issuance-smoke"] },
    target: {
      actor_name: "test",
      actor_type: "issuer",
      issuer_identifier: "https://issuer.example",
    },
    timeout_ms: 600_000,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-l09-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("L09 — native child config discovery", () => {
  it("sets CONFIG_ISSUANCE_TESTS_DIR to test file's parent directory", async () => {
    const { adapter, spawns } = makeFakeAdapter();
    const execute = createNativeExecutor({
      effectiveConfig: {
        ...makeEffectiveConfig(),
        testFile: "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
      },
      processAdapter: adapter,
      request: makeRequest(),
    });

    await execute({
      abortSignal: new AbortController().signal,
      request: makeRequest(),
      runId: "run-1",
      runRoot: dir,
    });

    const env = spawns[0]?.options.env ?? {};
    expect(env.CONFIG_ISSUANCE_TESTS_DIR).toBe("tests/credimi/issuance");
    expect(env.CONFIG_ISSUANCE_TESTS_DIR).not.toBe(join(dir, "tests"));
  });

  it("applies issuer_url override to CONFIG_CREDENTIAL_ISSUER_URI", async () => {
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

    const env = spawns[0]?.options.env ?? {};
    expect(env.CONFIG_CREDENTIAL_ISSUER_URI).toBe(
      "https://override-issuer.example",
    );
  });

  it("maps credential_configuration_ids to CONFIG_CREDENTIAL_TYPES", async () => {
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

    const env = spawns[0]?.options.env ?? {};
    expect(env.CONFIG_CREDENTIAL_TYPES).toBe("pid-1,pid-2");
  });

  it("passes absolute CONFIG_FILE_INI", async () => {
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

    const env = spawns[0]?.options.env ?? {};
    expect(env.CONFIG_FILE_INI).toBeTruthy();
    expect(env.CONFIG_FILE_INI).toContain("config.ini");
  });
});

function makeEffectiveConfig() {
  return {
    authorizationInteraction: "auto" as const,
    category: "issuance" as const,
    coverageMode: "interoperability" as const,
    credentialConfigurationIds: ["dc_sd_jwt_PersonIdentificationData"],
    overrides: {},
    profileConfigPath: "/abs/config.ini",
    profileId: "test-profile",
    selectionId: "credimi-issuance-smoke",
    target: { issuerIdentifier: "https://issuer.example" },
    testFile: "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
    writablePaths: {
      backup: join(dir, "data", "backup"),
      credentials: join(dir, "data", "credentials"),
      db: join(dir, "data", "wct.db"),
      logs: join(dir, "data", "logs"),
    },
  };
}
