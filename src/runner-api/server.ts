import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import type { RunRequest } from "./contract";
import type { JobManager } from "./job-manager";

import { ArtifactStore, isSafeArtifactId } from "./artifacts";
import { invalidRequest, RunnerError, runRequestSchema } from "./contract";
import { engineIdentity } from "./engine";
import { type ProfileCatalogue, ProfileError } from "./profiles";

export interface RunnerDependencies {
  artifacts: ArtifactStore;
  /** The startup-loaded catalogue used for capabilities and validation. */
  catalogue: ProfileCatalogue;
  jobManager: JobManager;
  /**
   * Rejects a request that the selected profile cannot run (unknown profile,
   * category/selection mismatch, invalid overrides, issuer identity). Throws
   * ProfileError; runs before the job is accepted.
   */
  validateRun: (request: RunRequest) => void;
}

const JSON_LIMIT = "64kb";
const CONTRACT_VERSION = "1.0";

// eslint-disable-next-line max-lines-per-function -- HTTP server with all v1 routes
export function createRunnerApp(deps: RunnerDependencies): Express {
  const app = express();
  app.use(express.json({ limit: JSON_LIMIT }));

  // -- Auth middleware (all /v1 routes except healthz) ------------------------
  app.use("/v1", (req: Request, res: Response, next: NextFunction) => {
    const token = process.env.CREDIMI_RUNNER_TOKEN;
    if (!token) {
      res.status(500).json({
        error: {
          code: "SERVER_MISCONFIGURED",
          message: "CREDIMI_RUNNER_TOKEN is not set",
        },
      });
      return;
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
        },
      });
      return;
    }
    next();
  });

  // -- GET /healthz -----------------------------------------------------------
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // -- GET /v1/capabilities ---------------------------------------------------
  app.get("/v1/capabilities", (_req: Request, res: Response) => {
    res.status(200).json({
      categories: [...new Set(deps.catalogue.profiles.map((p) => p.category))],
      contract_version: CONTRACT_VERSION,
      engine: engineIdentity(),
      max_timeout_ms: 3_600_000,
      profiles: deps.catalogue.profiles.map((p) => ({
        allowed_authorization_interaction: p.allowedAuthorizationInteraction,
        category: p.category,
        coverage_mode: p.coverageMode,
        id: p.id,
        selections: p.selections.map((s) => ({ id: s.id })),
      })),
      selection_catalogue: deps.catalogue.profiles.flatMap((p) =>
        p.selections.map((s) => ({ profile_id: p.id, selection_id: s.id })),
      ),
    });
  });

  // -- POST /v1/runs ----------------------------------------------------------
  app.post(
    "/v1/runs",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const idempotencyKey = req.headers["idempotency-key"];
        if (!idempotencyKey || typeof idempotencyKey !== "string") {
          throw invalidRequest("Idempotency-Key header is required");
        }

        const body = req.body as Record<string, unknown>;
        const parsed = runRequestSchema.safeParse(body);
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          throw invalidRequest(detail);
        }

        const request: RunRequest = parsed.data;

        // Validation runs only for new work, after the replay check.
        const validate = () => {
          try {
            deps.validateRun(request);
          } catch (error) {
            if (error instanceof ProfileError) {
              // A broken operator INI is a runner-side problem, not a bad request.
              if (error.code === "PROFILE_CONFIG_INVALID") {
                console.error(`[runner] ${error.message}:`, error.cause);
                throw new RunnerError(error.code, 500, error.message);
              }
              throw new RunnerError(error.code, 400, error.message);
            }
            throw error;
          }
        };

        const { replayed, snapshot } = await deps.jobManager.submit(
          request,
          idempotencyKey,
          "default",
          validate,
        );
        res.status(replayed ? 200 : 202).json(snapshot);
      } catch (error) {
        next(error);
      }
    },
  );

  // -- GET /v1/runs/:runId -----------------------------------------------------
  app.get(
    "/v1/runs/:runId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const snapshot = await deps.jobManager.getSnapshot(
          req.params.runId as string,
        );
        res.status(200).json(snapshot);
      } catch (error) {
        next(error);
      }
    },
  );

  // -- POST /v1/runs/:runId/cancel ----------------------------------------------
  app.post(
    "/v1/runs/:runId/cancel",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const snapshot = await deps.jobManager.cancel(
          req.params.runId as string,
        );
        res.status(200).json(snapshot);
      } catch (error) {
        next(error);
      }
    },
  );

  // -- POST /v1/runs/cancel-by-key ------------------------------------------------
  app.post(
    "/v1/runs/cancel-by-key",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const idempotencyKey = req.headers["idempotency-key"];
        if (!idempotencyKey || typeof idempotencyKey !== "string") {
          throw invalidRequest("Idempotency-Key header is required");
        }
        const snapshot = await deps.jobManager.cancelByKey(idempotencyKey);
        res.status(200).json(snapshot);
      } catch (error) {
        next(error);
      }
    },
  );

  // -- POST /v1/runs/:runId/interactions/:interactionId/ack ------------------------
  app.post(
    "/v1/runs/:runId/interactions/:interactionId/ack",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as { driver_status?: string; message?: string };
        if (
          !body ||
          (body.driver_status !== "completed" &&
            body.driver_status !== "failed")
        ) {
          throw invalidRequest("driver_status must be 'completed' or 'failed'");
        }
        const snapshot = await deps.jobManager.acknowledge(
          req.params.runId as string,
          req.params.interactionId as string,
          { driver_status: body.driver_status, message: body.message },
        );
        res.status(200).json(snapshot);
      } catch (error) {
        next(error);
      }
    },
  );

  // -- GET /v1/runs/:runId/result ---------------------------------------------------
  app.get(
    "/v1/runs/:runId/result",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await deps.jobManager.getResult(
          req.params.runId as string,
        );
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  // -- GET /v1/runs/:runId/artifacts/:artifactId ---------------------------------------
  app.get(
    "/v1/runs/:runId/artifacts/:artifactId",
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const { artifactId, runId } = req.params as {
          artifactId: string;
          runId: string;
        };
        if (!isSafeArtifactId(artifactId)) {
          throw invalidRequest("Invalid artifact ID");
        }
        // Bound to BOTH the run and the artifact via the run's manifest.
        const artifact = deps.artifacts.read(runId, artifactId);
        if (!artifact) {
          throw new RunnerError(
            "NOT_FOUND",
            404,
            `Artifact '${artifactId}' not found in run '${runId}'`,
          );
        }
        res
          .status(200)
          .setHeader("Content-Type", artifact.entry.mime_type)
          .setHeader("X-Content-SHA256", artifact.entry.sha256)
          .send(artifact.content);
      } catch (error) {
        next(error);
      }
    },
  );

  // -- Error handler --------------------------------------------------------------
  app.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      void next; // Express requires 4-arg error middleware signature
      if (error instanceof RunnerError) {
        res.status(error.httpStatus).json({
          error: { code: error.code, message: error.message },
        });
        return;
      }
      // JSON parse error from express.json()
      if (error instanceof SyntaxError && "body" in error) {
        res.status(400).json({
          error: { code: "INVALID_REQUEST", message: "Malformed JSON body" },
        });
        return;
      }
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      });
    },
  );

  return app;
}
