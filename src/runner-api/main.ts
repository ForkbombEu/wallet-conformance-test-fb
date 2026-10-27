import type { Express } from "express";

import { createServer, type Server } from "node:http";

import type { RunRequest } from "./contract";

import { ArtifactStore } from "./artifacts";
import {
  buildEffectiveConfig,
  type EffectiveConfig,
  loadOperatorConfig,
} from "./effective-config";
import { type ExecuteFn, JobManager } from "./job-manager";
import { JobStore } from "./job-store";
import { createNativeExecutor } from "./native-worker";
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
  profiles: string;
  runRoot: string;
}

/**
 * Loads the operator profiles JSON. Kept for callers that only need the
 * validated list; startup uses {@link loadProfileCatalogue} directly.
 */
export function loadProfiles(profilesPath: string): Profile[] {
  return [...loadProfileCatalogue(profilesPath).profiles];
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
  const config = loadOperatorConfig(profile.configFile);
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

  // Load and validate profiles before listening
  const catalogue = loadProfileCatalogue(options.profiles);

  const store = new JobStore(options.runRoot);
  if (!store.acquireRootLock()) {
    throw new Error(store.describeRootLock());
  }
  try {
    return await startOwnedRunner(store, catalogue, host, port);
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
): Promise<RunnerMain> {
  const artifacts = new ArtifactStore();

  // Real executor: resolve the requested profile and dispatch to the native worker
  const execute: ExecuteFn = async (ctx) => {
    const effectiveConfig = resolveRun(catalogue, ctx.request, ctx.runRoot);

    const nativeExecutor = createNativeExecutor({
      effectiveConfig,
      request: ctx.request,
    });

    const evidence = await nativeExecutor(ctx);

    // Register real artifacts from private paths
    for (const artifactPath of evidence.privateArtifactPaths) {
      const basename = artifactPath.split("/").pop() ?? "artifact";
      const artifactId = `${ctx.runId}:${basename}`;
      artifacts.registerFile(
        artifactId,
        basename,
        "application/json",
        artifactPath,
      );
    }

    return evidence;
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

  const close = async (): Promise<void> => {
    await jobManager.shutdown();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { app, close, server, url };
}

// Only run when executed directly
const isDirectRun =
  process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");

if (isDirectRun) {
  const args = process.argv.slice(2);
  const profilesPath =
    args.find((a) => a.startsWith("--profiles="))?.split("=")[1] ?? "";
  const stateDir =
    args.find((a) => a.startsWith("--state-dir="))?.split("=")[1] ??
    process.cwd();
  const port = args.find((a) => a.startsWith("--port="))?.split("=")[1];

  startRunner({
    host: "127.0.0.1",
    port: port ? Number(port) : undefined,
    profiles: profilesPath,
    runRoot: stateDir,
  })
    .then((runner) => {
      console.log(`WCT runner listening on ${runner.url}`);

      const shutdown = async () => {
        console.log("Shutting down...");
        await runner.close();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error) => {
      console.error("Failed to start:", error);
      process.exit(1);
    });
}
