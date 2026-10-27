import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const runStatusSchema = z.enum([
  "cancelled",
  "completed",
  "error",
  "queued",
  "running",
  "timed_out",
  "waiting_for_interaction",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const terminalRunStatuses: readonly RunStatus[] = [
  "cancelled",
  "completed",
  "error",
  "timed_out",
];

export function isTerminalStatus(status: RunStatus): boolean {
  return terminalRunStatuses.includes(status);
}

// ---------------------------------------------------------------------------
// RunRequest
// ---------------------------------------------------------------------------

const selectionSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(32),
});

const targetSchema = z
  .object({
    actor_name: z.string().min(1),
    actor_type: z.enum(["issuer", "relying_party", "verifier", "wallet"]),
    actor_version: z.string().optional(),
    issuer_identifier: z.string().url().optional(),
  })
  .strict();

const runParametersSchema = z
  .object({
    authorization_interaction: z
      .enum(["auto", "browser_redirect", "credential_presentation"])
      .optional(),
    credential_configuration_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(16)
      .optional(),
    credential_offer_uri: z.string().min(1).optional(),
    issuer_url: z.string().url().startsWith("https://").optional(),
  })
  .strict();

export const runRequestSchema = z
  .object({
    category: z.enum(["issuance", "presentation"]),
    contract_version: z.literal("1.0"),
    parameters: runParametersSchema.default({}),
    profile_id: z.string().min(1),
    selection: selectionSchema,
    target: targetSchema,
    timeout_ms: z.number().int().positive().max(3_600_000).default(600_000),
  })
  .strict();

export type RunRequest = z.infer<typeof runRequestSchema>;

// ---------------------------------------------------------------------------
// PendingInteraction
// ---------------------------------------------------------------------------

export const pendingInteractionSchema = z.object({
  correlation_id: z.string().optional(),
  created_at: z.string(),
  expires_at: z.string(),
  interaction_id: z.string(),
  kind: z.enum(["browser_authorization", "wallet_deeplink", "wallet_qr"]),
  scenario_id: z.string(),
  uri: z.string(),
});
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

// ---------------------------------------------------------------------------
// RunSnapshot
// ---------------------------------------------------------------------------

export const runSnapshotSchema = z.object({
  cancel_requested: z.boolean(),
  contract_version: z.literal("1.0"),
  created_at: z.string(),
  engine: z.string(),
  pending_interactions: z.array(pendingInteractionSchema),
  result_url: z.string(),
  run_id: z.string(),
  status: runStatusSchema,
  updated_at: z.string(),
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

// ---------------------------------------------------------------------------
// RunnerResult
// ---------------------------------------------------------------------------

const engineSchema = z.object({
  fork_repository: z.string(),
  id: z.string(),
  revision: z.string(),
  upstream_repository: z.string(),
  version: z.string(),
});

const executionSchema = z.object({
  error: z.string().optional(),
  exit_code: z.number().int().optional(),
  finished_at: z.string().optional(),
  started_at: z.string(),
  status: z.string(),
});

const nativeSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
});

/**
 * Shared runner v1.0 native assertion wire shape (both engines). `raw` is the
 * engine's original producer record as JSON text, kept for diagnostics.
 */
const nativeAssertionSchema = z
  .object({
    ancestor_titles: z.array(z.string()),
    assertion_id: z.string().min(1),
    credential_configuration_id: z.string().optional(),
    error_message: z.string().optional(),
    file: z.string(),
    full_title: z.string(),
    native_status: z.enum(["FAIL", "NOT_REACHED", "PASS"]),
    phase: z.string(),
    raw: z
      .string()
      .refine((text) => {
        try {
          JSON.parse(text);
          return true;
        } catch {
          return false;
        }
      }, "must be JSON text")
      .optional(),
    requirement_id: z.string().optional(),
    vitest_status: z.string().optional(),
  })
  .strict();

const scenarioOutcomeSchema = z.object({
  scenario_id: z.string(),
  verdict: z.enum(["FAIL", "INCONCLUSIVE", "PASS"]),
});

const nativeSchema = z.object({
  assertions: z.array(nativeAssertionSchema),
  coverage_mode: z.enum(["interoperability", "it_wallet_profile"]),
  native_suite_status: z.string(),
  scenario_outcomes: z.array(scenarioOutcomeSchema),
  sessions: z.array(nativeSessionSchema),
});

const summarySchema = z.object({
  assertion_count: z.number().int().min(0),
  native_failed_assertion_count: z.number().int().min(0),
  result: z.enum(["fail", "inconclusive", "not_tested", "partial", "pass"]),
});

const artifactManifestEntrySchema = z
  .object({
    artifact_id: z.string(),
    download_url: z.string(),
    filename: z.string(),
    mime_type: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z.number().int().min(0),
  })
  .strict();

export const runnerResultSchema = z
  .object({
    artifacts: z.array(artifactManifestEntrySchema),
    category: z.string(),
    contract_version: z.literal("1.0"),
    engine: engineSchema,
    execution: executionSchema,
    limitations: z.array(z.string()),
    native: nativeSchema,
    profile_id: z.string(),
    run_id: z.string(),
    selection: selectionSchema,
    summary: summarySchema,
    target: targetSchema,
  })
  .strict();

export type RunnerResult = z.infer<typeof runnerResultSchema>;

// ---------------------------------------------------------------------------
// RunnerError
// ---------------------------------------------------------------------------

export class RunnerError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function idempotencyConflict(): RunnerError {
  return new RunnerError(
    "IDEMPOTENCY_CONFLICT",
    409,
    "Same key with different request body",
  );
}

export function invalidRequest(detail: string): RunnerError {
  return new RunnerError("INVALID_REQUEST", 400, detail);
}

export function notFound(runId: string): RunnerError {
  return new RunnerError("NOT_FOUND", 404, `Run '${runId}' not found`);
}

export function resultNotReady(): RunnerError {
  return new RunnerError(
    "RESULT_NOT_READY",
    409,
    "Run has not reached a terminal state",
  );
}

export function runBusy(): RunnerError {
  return new RunnerError("RUNNER_BUSY", 409, "Runner is busy");
}
