import type { Express } from "express";

import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { ArtifactStore } from "./artifacts";
import { JobManager, type ExecuteFn } from "./job-manager";
import { JobStore } from "./job-store";
import { createRunnerApp } from "./server";
import { getProfile, type Profile } from "./profiles";
import { buildEffectiveConfig } from "./effective-config";
import { createNativeExecutor } from "./native-worker";

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

function loadProfiles(profilesPath: string): Profile[] {
  const absPath = resolve(profilesPath);
  if (!existsSync(absPath)) {
    throw new Error(`Profiles file not found: ${absPath}`);
  }
  const raw = JSON.parse(readFileSync(absPath, "utf-8")) as {
    profiles?: unknown[];
  };
  return (raw.profiles ?? []).map((p) => {
    const profile = getProfile((p as { id?: string }).id ?? "");
    if (!profile) {
      throw new Error(
        `Unknown profile in file: ${String((p as { id?: string }).id)}`,
      );
    }
    return profile;
  });
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
  const profiles = loadProfiles(options.profiles);

  const store = new JobStore(options.runRoot);
  const artifacts = new ArtifactStore();

  // Build real executor that dispatches to native worker
  const execute: ExecuteFn = async (ctx) => {
    const profile = profiles[0];
    if (!profile) {
      throw new Error("No profile loaded");
    }

    const effectiveConfig = buildEffectiveConfig(
      profile,
      ctx.request.selection.ids[0] ?? "",
      ctx.request.parameters ?? {},
      // Config is loaded by the native worker; here we just need the profile
      {} as never,
      ctx.runRoot,
    );

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
  const app = createRunnerApp({ artifacts, jobManager });

  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.once("error", reject);
  });

  const url = `http://${host}:${port}`;

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
