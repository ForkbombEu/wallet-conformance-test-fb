import { z } from "zod";

// ---------------------------------------------------------------------------
// Runtime schema for the actual legacy NativeExport (camelCase producer)
// ---------------------------------------------------------------------------

const nativeAssertionSchema = z
  .object({
    ancestorTitles: z.array(z.string()),
    description: z.string().optional(),
    errorMessage: z.string().nullish(),
    file: z.string(),
    nativeStatus: z.enum(["FAIL", "NOT_REACHED", "PASS"]),
    phase: z.string(),
    requirementId: z.string().nullish(),
    timestamp: z.string().optional(),
    title: z.string(),
    vitestStatus: z.enum(["failed", "passed", "pending", "skipped"]).optional(),
  })
  .strict();

export const nativeExportSchema = z
  .object({
    assertions: z.array(nativeAssertionSchema),
    closedAt: z.string().nullish(),
    phase: z.string(),
    runId: z.string(),
    sessionId: z.string(),
    startedAt: z.string(),
    status: z.enum(["FAILED", "INCOMPLETE", "OPEN", "PASSED"]),
  })
  .strict();

export interface AdaptedAssertion {
  ancestor_titles: string[];
  assertion_id: string;
  credential_configuration_id?: string;
  error_message?: string;
  file: string;
  full_title: string;
  native_status: "FAIL" | "NOT_REACHED" | "PASS";
  phase: string;
  raw?: string;
  requirement_id?: string;
  vitest_status?: string;
}

// ---------------------------------------------------------------------------
// Adapted wire assertion (snake_case)
// ---------------------------------------------------------------------------

export interface AdapterOptions {
  expectedCategory?: string;
  expectedRunId: string;
  expectedSelection?: string[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type NativeExportRaw = z.infer<typeof nativeExportSchema>;

export class NativeExportValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeExportValidationError";
    this.code = code;
  }
}

export function validateAndAdaptNativeExport(
  raw: unknown,
  options: AdapterOptions,
): { assertions: AdaptedAssertion[]; sessionId: string; status: string } {
  // Step 1: Validate raw native data against producer format
  const parsed = nativeExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NativeExportValidationError(
      "INVALID_NATIVE_EXPORT",
      `Native export does not match producer format: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const data = parsed.data;

  // Step 2: Validate run ID matches
  if (data.runId !== options.expectedRunId) {
    throw new NativeExportValidationError(
      "RUN_ID_MISMATCH",
      `Native export runId '${data.runId}' does not match expected '${options.expectedRunId}'`,
    );
  }

  // Step 3: Map camelCase to snake_case explicitly, derive assertion_id from occurrence
  const assertions: AdaptedAssertion[] = data.assertions.map((a, index) => ({
    ancestor_titles: a.ancestorTitles,
    assertion_id: `assertion-${index}`,
    error_message: a.errorMessage ?? undefined,
    file: a.file,
    full_title: [...a.ancestorTitles, a.title].join(" > "),
    native_status: a.nativeStatus,
    phase: a.phase,
    raw: JSON.stringify(a),
    requirement_id: a.requirementId ?? undefined,
    vitest_status: a.vitestStatus,
  }));

  return {
    assertions,
    sessionId: data.sessionId,
    status: data.status,
  };
}
