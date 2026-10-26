import type { Express } from "express";

import { createServer, type Server } from "node:http";

import { ArtifactStore } from "./artifacts";
import { JobManager } from "./job-manager";
import { JobStore } from "./job-store";
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
  runRoot: string;
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

  const store = new JobStore(options.runRoot);
  const artifacts = new ArtifactStore();
  const jobManager = new JobManager({
    execute: async () => {
      throw new Error("Executor not configured");
    },
    store,
  });

  const app = createRunnerApp({ artifacts, jobManager });

  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.once("error", reject);
  });

  const url = `http://${host}:${port}`;

  const close = async (): Promise<void> => {
    // Stop accepting new work
    await jobManager.shutdown();
    // Close HTTP server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { app, close, server, url };
}

// Only run when executed directly (not when imported)
if (
  process.argv[1]?.endsWith("main.ts") ||
  process.argv[1]?.endsWith("main.js")
) {
  startRunner({ runRoot: process.cwd() })
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
