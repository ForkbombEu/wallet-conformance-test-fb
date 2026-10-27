import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EffectiveConfig } from "@/runner-api/effective-config";

import { getRunnerRuntime } from "@/logic/runner-runtime";
import { packageRoot } from "@/logic/runtime-paths";
import {
  type RunnerResult,
  type RunRequest,
  runRequestSchema,
} from "@/runner-api/contract";
import { JobManager } from "@/runner-api/job-manager";
import { JobStore } from "@/runner-api/job-store";
import { resolveRun, startRunner } from "@/runner-api/main";
import { buildNativeEnv } from "@/runner-api/native-worker";
import { loadProfileCatalogue } from "@/runner-api/profiles";

const TOKEN = "review-token";

let dir: string;

function effectiveConfig(): EffectiveConfig {
  return {
    authorizationInteraction: "auto",
    category: "issuance",
    coverageMode: "interoperability",
    credentialConfigurationIds: ["t"],
    initializedAssets: [],
    overrides: {},
    profileConfigPath: join(dir, "op.ini"),
    profileId: "p",
    selectionId: "s",
    target: { issuerIdentifier: "https://issuer.example" },
    testFile: join(dir, "x.issuance.spec.ts"),
    writablePaths: {
      attestation: join(dir, "a"),
      backup: join(dir, "b"),
      credentials: join(dir, "c"),
      db: join(dir, "d.db"),
      logs: join(dir, "l"),
    },
  };
}

function genericIni(): string {
  return readFileSync(join(packageRoot, "config.example.ini"), "utf-8").replace(
    "ecosystem = it_wallet",
    "ecosystem = generic_oid4vci",
  );
}

function makeRequest(): RunRequest {
  return runRequestSchema.parse({
    category: "issuance",
    contract_version: "1.0",
    profile_id: "p",
    selection: { ids: ["s"] },
    target: { actor_name: "x", actor_type: "issuer" },
  });
}

function writeProfiles(ini: string): string {
  writeFileSync(join(dir, "op.ini"), ini);
  const path = join(dir, "profiles.json");
  writeFileSync(
    path,
    JSON.stringify({
      profiles: [
        {
          allowedAuthorizationInteraction: ["auto"],
          category: "issuance",
          configFile: "op.ini",
          coverageMode: "interoperability",
          id: "p",
          selections: [
            {
              id: "s",
              testFile: "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
            },
          ],
        },
      ],
    }),
  );
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-review-"));
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("review: quarantine survives a restart", () => {
  it("a key whose record was quarantined in a previous process cannot start new work", async () => {
    const first = new JobStore(dir);
    const keyHash = JobStore.keyHash("default", "k");
    first.saveRun({
      cancelRequested: false,
      createdAt: "t",
      idempotencyKeyHash: keyHash,
      namespace: "default",
      request: makeRequest(),
      requestHash: JobStore.canonicalRequestHash(makeRequest()),
      runId: "r1",
      status: "completed",
      updatedAt: "t",
    });
    writeFileSync(join(dir, "runs", "r1.json"), "{broken");
    expect(() => first.findByKeyHash(keyHash)).toThrow(/quarantined/);

    // New process: the record is already in quarantine/.
    const manager = new JobManager({
      execute: async () => {
        throw new Error("must not run");
      },
      store: new JobStore(dir),
    });
    await expect(manager.submit(makeRequest(), "k")).rejects.toMatchObject({
      code: "RUN_RECORD_CORRUPT",
    });
    expect(manager.corruptRecords().map((c) => c.runId)).toEqual(["r1"]);
  });
});

describe("review: native child environment", () => {
  it("never passes the runner bearer token and marks runner mode explicitly", () => {
    const env = buildNativeEnv(
      effectiveConfig(),
      {
        effectiveIni: join(dir, "e.ini"),
        resultsDir: join(dir, "r"),
        runId: "run-1",
      },
      { CREDIMI_RUNNER_TOKEN: "secret", PATH: "/bin" },
    );
    expect(env.CREDIMI_RUNNER_TOKEN).toBeUndefined();
    expect(env.WCT_RUNNER_MODE).toBe("1");
    expect(env.PATH).toBe("/bin");
  });

  it("WCT_RUN_ID alone (human native export) does not enable runner mode", () => {
    expect(
      getRunnerRuntime({ WCT_RESULTS_DIR: "/x", WCT_RUN_ID: "human-run" }),
    ).toBeUndefined();
  });
});

describe("review: cancel and shutdown are bounded", () => {
  it("a worker that never settles cannot hang cancel or shutdown", async () => {
    const manager = new JobManager({
      abortGraceMs: 200,
      execute: () => new Promise<never>(() => undefined),
      store: new JobStore(dir),
    });
    const { snapshot } = await manager.submit(makeRequest(), "k");
    const cancelled = await manager.cancel(snapshot.run_id);
    expect(cancelled.status).toBe("cancelled");
    const result = await manager.getResult(snapshot.run_id);
    expect(result.limitations.join(" ")).toMatch(/did not stop/);
    await manager.shutdown();
  });
});

describe("review: publication-boundary validation keeps the lifecycle status", () => {
  it("a cancelled run with an invalid worker result stays cancelled", async () => {
    const manager = new JobManager({
      execute: (ctx) =>
        new Promise((resolve) => {
          ctx.abortSignal.addEventListener("abort", () =>
            resolve({
              privateArtifactPaths: [],
              result: { run_id: ctx.runId } as unknown as RunnerResult,
            }),
          );
        }),
      store: new JobStore(dir),
    });
    const { snapshot } = await manager.submit(makeRequest(), "k");
    await manager.cancel(snapshot.run_id);
    const result = await manager.getResult(snapshot.run_id);
    expect(result.execution.status).toBe("cancelled");
    expect(result.limitations.join(" ")).toMatch(/wire validation/);
    await manager.shutdown();
  });
});

describe("review: operator INI errors", () => {
  it("an invalid operator INI fails startup, naming the profile", async () => {
    const profiles = writeProfiles("[issuance]\nurl = not-a-url\n");
    await expect(
      startRunner({ port: 0, profiles, runRoot: join(dir, "state") }),
    ).rejects.toThrow(/Profile 'p'.*config/);
    expect(existsSync(join(dir, "state", ".owner.lock"))).toBe(false);
  });

  it("an INI broken after startup is a descriptive PROFILE_CONFIG_INVALID, not a bare error", () => {
    const catalogue = loadProfileCatalogue(writeProfiles(genericIni()));
    writeFileSync(join(dir, "op.ini"), "[issuance]\nurl = not-a-url\n");
    expect(() => resolveRun(catalogue, makeRequest(), dir)).toThrow(
      expect.objectContaining({ code: "PROFILE_CONFIG_INVALID" }),
    );
  });
});

describe("review: close releases the lock only after the listener stops", () => {
  it("JobManager.shutdown leaves the lock to the server owner", async () => {
    const store = new JobStore(dir);
    expect(store.acquireRootLock()).toBe(true);
    await new JobManager({
      execute: async () => {
        throw new Error("unused");
      },
      store,
    }).shutdown();
    expect(store.hasRootLock()).toBe(true);
    store.releaseRootLock();
  });

  it("runner.close stops listening and then releases the lock", async () => {
    const root = join(dir, "state");
    const runner = await startRunner({
      port: 0,
      profiles: writeProfiles(genericIni()),
      runRoot: root,
    });
    await runner.close();
    expect(runner.server.listening).toBe(false);
    expect(existsSync(join(root, ".owner.lock"))).toBe(false);
  });
});
