import { describe, expect, it } from "vitest";

import {
  nativeExportSchema,
  NativeExportValidationError,
  validateAndAdaptNativeExport,
} from "../../src/runner-api/native-result-adapter";

function makeRawExport(overrides: Record<string, unknown> = {}) {
  return {
    assertions: [
      {
        ancestorTitles: ["Suite"],
        description: "test description",
        errorMessage: null,
        file: "test.ts",
        nativeStatus: "FAIL",
        phase: "issuance",
        requirementId: "CI_002",
        timestamp: "2026-01-01T00:00:00Z",
        title: "CI_002: test description",
        vitestStatus: "failed",
      },
    ],
    closedAt: "2026-01-01T00:00:02Z",
    phase: "issuance",
    runId: "run-1",
    sessionId: "session-1",
    startedAt: "2026-01-01T00:00:00Z",
    status: "FAILED",
    ...overrides,
  };
}

describe("nativeExportSchema", () => {
  it("accepts valid producer format", () => {
    expect(nativeExportSchema.safeParse(makeRawExport()).success).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(
      nativeExportSchema.safeParse(makeRawExport({ evil: true })).success,
    ).toBe(false);
  });

  it("rejects invalid nativeStatus", () => {
    expect(
      nativeExportSchema.safeParse(
        makeRawExport({
          assertions: [
            { ...makeRawExport().assertions[0], nativeStatus: "EVIL" },
          ],
        }),
      ).success,
    ).toBe(false);
  });
});

describe("validateAndAdaptNativeExport", () => {
  it("adapts camelCase to snake_case", () => {
    const result = validateAndAdaptNativeExport(makeRawExport(), {
      expectedRunId: "run-1",
    });
    expect(result.assertions).toHaveLength(1);
    const a = result.assertions[0];
    expect(a?.native_status).toBe("FAIL");
    expect(a?.full_title).toBe("Suite > CI_002: test description");
    expect(a?.ancestor_titles).toEqual(["Suite"]);
    expect(a?.requirement_id).toBe("CI_002");
    expect(a?.file).toBe("test.ts");
  });

  it("preserves FAIL status (the key defect fix)", () => {
    const result = validateAndAdaptNativeExport(makeRawExport(), {
      expectedRunId: "run-1",
    });
    expect(result.assertions[0]?.native_status).toBe("FAIL");
  });

  it("omits null requirementId", () => {
    const raw = makeRawExport({
      assertions: [{ ...makeRawExport().assertions[0], requirementId: null }],
    });
    const result = validateAndAdaptNativeExport(raw, {
      expectedRunId: "run-1",
    });
    expect(result.assertions[0]?.requirement_id).toBeUndefined();
  });

  it("rejects runId mismatch", () => {
    expect(() =>
      validateAndAdaptNativeExport(makeRawExport(), {
        expectedRunId: "other-run",
      }),
    ).toThrow(NativeExportValidationError);
  });

  it("rejects invalid producer format", () => {
    expect(() =>
      validateAndAdaptNativeExport(
        { invalid: true },
        { expectedRunId: "run-1" },
      ),
    ).toThrow(NativeExportValidationError);
  });

  it("preserves duplicate requirement IDs as separate assertions", () => {
    const raw = makeRawExport({
      assertions: [
        { ...makeRawExport().assertions[0], title: "CI_002: first" },
        { ...makeRawExport().assertions[0], title: "CI_002: second" },
      ],
    });
    const result = validateAndAdaptNativeExport(raw, {
      expectedRunId: "run-1",
    });
    expect(result.assertions).toHaveLength(2);
    expect(result.assertions[0]?.requirement_id).toBe("CI_002");
    expect(result.assertions[1]?.requirement_id).toBe("CI_002");
  });

  it("handles zero assertions", () => {
    const raw = makeRawExport({ assertions: [] });
    const result = validateAndAdaptNativeExport(raw, {
      expectedRunId: "run-1",
    });
    expect(result.assertions).toHaveLength(0);
    expect(result.status).toBe("FAILED");
  });

  it("preserves sessionId separately", () => {
    const result = validateAndAdaptNativeExport(makeRawExport(), {
      expectedRunId: "run-1",
    });
    expect(result.sessionId).toBe("session-1");
  });
});
