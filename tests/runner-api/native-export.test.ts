import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildNativeExport,
  type NativeAssertion,
  writeNativeExport,
} from "@/report/native-export";

function makeAssertion(
  overrides: Partial<NativeAssertion> = {},
): NativeAssertion {
  return {
    ancestorTitles: ["Suite"],
    description: "test description",
    errorMessage: null,
    file: "/tmp/test.spec.ts",
    nativeStatus: "PASS",
    phase: "issuance",
    requirementId: "CI_002",
    timestamp: "2026-01-01T00:00:00.000Z",
    title: "CI_002: test description",
    vitestStatus: "passed",
    ...overrides,
  };
}

describe("buildNativeExport", () => {
  it("builds export with all fields", () => {
    const result = buildNativeExport({
      assertions: [makeAssertion()],
      closedAt: "2026-01-01T00:01:00.000Z",
      phase: "issuance",
      runId: "run-1",
      sessionId: "session-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "PASSED",
    });

    expect(result.runId).toBe("run-1");
    expect(result.sessionId).toBe("session-1");
    expect(result.phase).toBe("issuance");
    expect(result.status).toBe("PASSED");
    expect(result.assertions).toHaveLength(1);
  });

  it("preserves duplicate requirement IDs as separate assertions", () => {
    const result = buildNativeExport({
      assertions: [
        makeAssertion({ title: "CI_002: first suite" }),
        makeAssertion({ title: "CI_002: second suite" }),
      ],
      closedAt: null,
      phase: "issuance",
      runId: "run-1",
      sessionId: "session-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "FAILED",
    });

    expect(result.assertions).toHaveLength(2);
    expect(result.assertions[0]?.requirementId).toBe("CI_002");
    expect(result.assertions[1]?.requirementId).toBe("CI_002");
  });

  it("preserves null requirementId for generic assertions", () => {
    const result = buildNativeExport({
      assertions: [
        makeAssertion({
          requirementId: null,
          title: "completes the authorization-code issuance flow",
        }),
      ],
      closedAt: null,
      phase: "issuance",
      runId: "run-1",
      sessionId: "session-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "PASSED",
    });

    expect(result.assertions[0]?.requirementId).toBeNull();
    expect(result.assertions[0]?.title).toBe(
      "completes the authorization-code issuance flow",
    );
  });

  it("preserves NOT_REACHED status", () => {
    const result = buildNativeExport({
      assertions: [
        makeAssertion({
          nativeStatus: "NOT_REACHED",
          vitestStatus: "skipped",
        }),
      ],
      closedAt: null,
      phase: "issuance",
      runId: "run-1",
      sessionId: "session-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "INCOMPLETE",
    });

    expect(result.assertions[0]?.nativeStatus).toBe("NOT_REACHED");
    expect(result.assertions[0]?.vitestStatus).toBe("skipped");
  });

  it("preserves raw FAIL with error message", () => {
    const result = buildNativeExport({
      assertions: [
        makeAssertion({
          errorMessage: "expected true to be false",
          nativeStatus: "FAIL",
          vitestStatus: "failed",
        }),
      ],
      closedAt: null,
      phase: "issuance",
      runId: "run-1",
      sessionId: "session-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "FAILED",
    });

    expect(result.assertions[0]?.nativeStatus).toBe("FAIL");
    expect(result.assertions[0]?.errorMessage).toBe(
      "expected true to be false",
    );
    expect(result.assertions[0]?.vitestStatus).toBe("failed");
  });

  it("handles zero assertions", () => {
    const result = buildNativeExport({
      assertions: [],
      closedAt: null,
      phase: "issuance",
      runId: "run-1",
      sessionId: "session-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "INCOMPLETE",
    });

    expect(result.assertions).toHaveLength(0);
    expect(result.status).toBe("INCOMPLETE");
  });
});

describe("writeNativeExport", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "wct-export-"));
  });

  afterEach(() => {
    rmSync(tempDir, { force: true, recursive: true });
  });

  it("writes native-results.json to the output directory", () => {
    const data = buildNativeExport({
      assertions: [makeAssertion()],
      closedAt: "2026-01-01T00:01:00.000Z",
      phase: "issuance",
      runId: "run-1",
      sessionId: "session-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "PASSED",
    });

    const filePath = writeNativeExport(tempDir, data);
    expect(existsSync(filePath)).toBe(true);

    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(parsed.runId).toBe("run-1");
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.assertions).toHaveLength(1);
  });

  it("round-trips all assertion fields", () => {
    const assertion = makeAssertion({
      ancestorTitles: ["Describe A", "Describe B"],
      errorMessage: "some failure",
      file: "/abs/path/to/test.spec.ts",
      nativeStatus: "FAIL",
      requirementId: "RPR-010",
      title: "RPR-010: deep test",
      vitestStatus: "failed",
    });

    const data = buildNativeExport({
      assertions: [assertion],
      closedAt: "2026-01-01T00:01:00.000Z",
      phase: "presentation",
      runId: "run-2",
      sessionId: "session-2",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "FAILED",
    });

    writeNativeExport(tempDir, data);
    const parsed = JSON.parse(
      readFileSync(path.join(tempDir, "native-results.json"), "utf-8"),
    );

    const a = parsed.assertions[0];
    expect(a.requirementId).toBe("RPR-010");
    expect(a.title).toBe("RPR-010: deep test");
    expect(a.ancestorTitles).toEqual(["Describe A", "Describe B"]);
    expect(a.file).toBe("/abs/path/to/test.spec.ts");
    expect(a.nativeStatus).toBe("FAIL");
    expect(a.vitestStatus).toBe("failed");
    expect(a.errorMessage).toBe("some failure");
    expect(parsed.sessionId).toBe("session-2");
    expect(parsed.phase).toBe("presentation");
  });

  it("overwrites existing file atomically via temp+rename", () => {
    const data1 = buildNativeExport({
      assertions: [],
      closedAt: null,
      phase: "issuance",
      runId: "run-1",
      sessionId: "session-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "INCOMPLETE",
    });

    const data2 = buildNativeExport({
      assertions: [makeAssertion()],
      closedAt: "2026-01-01T00:01:00.000Z",
      phase: "issuance",
      runId: "run-1",
      sessionId: "session-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "PASSED",
    });

    writeNativeExport(tempDir, data1);
    writeNativeExport(tempDir, data2);

    const parsed = JSON.parse(
      readFileSync(path.join(tempDir, "native-results.json"), "utf-8"),
    );
    expect(parsed.assertions).toHaveLength(1);
    expect(parsed.status).toBe("PASSED");
  });
});
