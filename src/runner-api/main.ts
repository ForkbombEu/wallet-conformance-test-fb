import type { Express } from "express";

import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { Config } from "@/types";

import type { RunnerResult, RunRequest } from "./contract";

import { ArtifactStore } from "./artifacts";
import {
  buildEffectiveConfig,
  type EffectiveConfig,
  loadOperatorConfig,
} from "./effective-config";
import {
  type ExecuteFn,
  type ExecutionEvidence,
  JobManager,
} from "./job-manager";
import { JobStore } from "./job-store";
import { createNativeExecutor, type ProcessAdapter } from "./native-worker";
import {
  loadProfileCatalogue,
  type Profile,
  type ProfileCatalogue,
  ProfileError,
  selectProfileForRequest,
} from "./profiles";
import { createRunnerApp } from "./server";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8789;

export interface RunnerMain {
  app: Express;
  close(): Promise<void>;
  server: Server;
  url: string;
}

export interface RunnerMainOptions {
  host?: string;
  port?: number;
  /**
   * Low-level subprocess boundary for the native child (internal; tests
   * only). Production uses the real `child_process.spawn` adapter.
   */
  processAdapter?: ProcessAdapter;
  profiles: string;
  runRoot: string;
}

/**
 * Loads a profile's operator INI through the native loader. Failures become
 * PROFILE_CONFIG_INVALID; the detail (which may contain operator paths) is
 * kept in `cause` and logged, not sent to API clients.
 */
export function loadProfileConfig(profile: Profile): Config {
  try {
    return loadOperatorConfig(profile.configFile);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProfileError(
      "PROFILE_CONFIG_INVALID",
      `Profile '${profile.id}' configuration is invalid`,
      { cause: detail },
    );
  }
}

/**
 * Loads the operator profiles JSON. Kept for callers that only need the
 * validated list; startup uses {@link loadProfileCatalogue} directly.
 */
export function loadProfiles(profilesPath: string): Profile[] {
  return [...loadProfileCatalogue(profilesPath).profiles];
}

/**
 * Publishes a run's declared private files through the artifact layer and
 * returns the evidence with the manifest entries computed from the exact
 * bytes. A declared artifact that cannot be published becomes a limitation
 * and the summary can no longer be `pass`.
 */
export function publishRunEvidence(
  artifacts: ArtifactStore,
  runId: string,
  evidence: ExecutionEvidence,
): ExecutionEvidence {
  const published = artifacts.publish(runId, evidence.privateArtifactPaths);
  const result: RunnerResult = {
    ...evidence.result,
    artifacts: published.entries,
    limitations: [...evidence.result.limitations, ...published.limitations],
  };
  if (published.limitations.length > 0 && result.summary.result === "pass") {
    result.summary = { ...result.summary, result: "inconclusive" };
  }
  return { privateArtifactPaths: evidence.privateArtifactPaths, result };
}

/**
 * Resolves a run request against the startup-loaded catalogue and the
 * selected profile's real INI. Used both to validate a request before it is
 * accepted and to build the executor's effective configuration.
 */
export function resolveRun(
  catalogue: ProfileCatalogue,
  request: RunRequest,
  workspaceDir: string,
): EffectiveConfig {
  const { overrides, profile, selectionId } = selectProfileForRequest(
    catalogue,
    request,
  );
  const config = loadProfileConfig(profile);
  const effective = buildEffectiveConfig(
    profile,
    selectionId,
    overrides,
    config,
    workspaceDir,
  );

  const advertised = request.target.issuer_identifier;
  if (advertised && advertised !== effective.target.issuerIdentifier) {
    throw new ProfileError(
      "ISSUER_IDENTITY_MISMATCH",
      `Target issuer '${advertised}' does not match the effective issuer '${effective.target.issuerIdentifier}'`,
    );
  }

  return effective;
}

export async function startRunner(
  options: RunnerMainOptions,
): Promise<RunnerMain> {
  const token = process.env.CREDIMI_RUNNER_TOKEN;
  if (!token) {
    throw new Error("CREDIMI_RUNNER_TOKEN environment variable is required");
  }

  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  // Load and validate profiles and their INIs before listening
  const catalogue = loadProfileCatalogue(options.profiles);
  for (const profile of catalogue.profiles) {
    try {
      loadProfileConfig(profile);
    } catch (error) {
      const cause = error instanceof Error ? String(error.cause ?? "") : "";
      throw new Error(
        `Profile '${profile.id}' config ${profile.configFile} is invalid: ${cause}`,
      );
    }
  }

  const store = new JobStore(options.runRoot);
  if (!store.acquireRootLock()) {
    throw new Error(store.describeRootLock());
  }
  try {
    return await startOwnedRunner(
      store,
      catalogue,
      host,
      port,
      options.processAdapter,
    );
  } catch (error) {
    // Only this instance's own lock is released.
    store.releaseRootLock();
    throw error;
  }
}

async function startOwnedRunner(
  store: JobStore,
  catalogue: ProfileCatalogue,
  host: string,
  port: number,
  processAdapter: ProcessAdapter | undefined,
): Promise<RunnerMain> {
  const artifacts = new ArtifactStore(store.rootDir);

  // Real executor: resolve the requested profile and dispatch to the native worker
  const execute: ExecuteFn = async (ctx) => {
    const effectiveConfig = resolveRun(catalogue, ctx.request, ctx.runRoot);

    const nativeExecutor = createNativeExecutor({
      effectiveConfig,
      processAdapter,
      request: ctx.request,
    });

    return publishRunEvidence(artifacts, ctx.runId, await nativeExecutor(ctx));
  };

  const jobManager = new JobManager({ execute, store });
  // Exclusive ownership is established: settle runs a previous process left.
  jobManager.recoverInterruptedRuns();
  const app = createRunnerApp({
    artifacts,
    catalogue,
    jobManager,
    validateRun: (request) => {
      resolveRun(catalogue, request, store.rootDir);
    },
  });

  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const boundPort =
    address && typeof address === "object" ? address.port : port;
  const url = `http://${host}:${boundPort}`;

  // Stop accepting connections, finalize the live run, drain the listener,
  // and only then give up the state root.
  const close = async (): Promise<void> => {
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await jobManager.shutdown();
    server.closeAllConnections();
    await closed;
    store.releaseRootLock();
  };

  return { app, close, server, url };
}

export const RUNNER_USAGE = `Usage: wct-runner --profiles <file> --state-dir <dir> [--host <host>] [--port <port>]

  --profiles   Operator profiles JSON (required)
  --state-dir  Runner state root: runs, artifacts, work dirs, lock (required)
  --host       Listen address (default ${DEFAULT_HOST})
  --port       Listen port, 0 for an ephemeral port (default ${DEFAULT_PORT})

Environment: CREDIMI_RUNNER_TOKEN (required bearer token)`;

export class RunnerUsageError extends Error {}

/** Parses runner CLI arguments (`--flag value` or `--flag=value`). */
export function parseRunnerArgs(
  argv: readonly string[],
): "help" | RunnerMainOptions {
  let values: Record<string, boolean | string | undefined>;
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      args: [...argv],
      options: {
        help: { short: "h", type: "boolean" },
        host: { type: "string" },
        port: { type: "string" },
        profiles: { type: "string" },
        "state-dir": { type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    throw new RunnerUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (values.help) return "help";

  const profiles = values.profiles;
  const stateDir = values["state-dir"];
  if (typeof profiles !== "string" || profiles === "") {
    throw new RunnerUsageError("--profiles is required");
  }
  if (typeof stateDir !== "string" || stateDir === "") {
    throw new RunnerUsageError("--state-dir is required");
  }
  let port: number | undefined;
  if (typeof values.port === "string") {
    port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port > 65_535) {
      throw new RunnerUsageError(
        `--port must be 0-65535, got '${values.port}'`,
      );
    }
  }
  const host = typeof values.host === "string" ? values.host : undefined;
  if (host === "") {
    throw new RunnerUsageError("--host must not be empty");
  }
  return {
    host,
    port,
    profiles: resolve(profiles),
    runRoot: resolve(stateDir),
  };
}

/**
 * CLI entrypoint: starts the runner and stops it cleanly on SIGINT/SIGTERM
 * (live run finalized, owned lock released). Exit codes: 0 clean shutdown,
 * 1 startup failure, 2 usage error.
 */
export async function runRunnerCli(argv: readonly string[]): Promise<void> {
  let options: "help" | RunnerMainOptions;
  try {
    options = parseRunnerArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(RUNNER_USAGE);
    process.exit(2);
  }
  if (options === "help") {
    console.log(RUNNER_USAGE);
    return;
  }

  let runner: RunnerMain;
  try {
    runner = await startRunner(options);
  } catch (error) {
    console.error(
      "Failed to start:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
  console.log(`WCT runner listening on ${runner.url}`);

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}, shutting down...`);
    runner.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(
          "Shutdown failed:",
          error instanceof Error ? error.message : String(error),
        );
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** True only when this very module is the process entry script. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  void runRunnerCli(process.argv.slice(2));
}
