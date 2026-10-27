import { describe, expect, it } from "vitest";

import type { RunnerResult } from "@/runner-api/contract";

import { summarizeResult } from "@/runner-api/summarize";

type NativeAssertion = RunnerResult["native"]["assertions"][number];

function makeAssertion(
  overrides: Partial<NativeAssertion> = {},
): NativeAssertion {
  return {
    ancestor_titles: [],
    assertion_id: "a1",
    file: "test.ts",
    full_title: "test",
    native_status: "PASS",
    phase: "issuance",
    ...overrides,
  };
}

const completed = {
  exit_code: 0,
  finished_at: "2026-01-01T00:00:02Z",
  started_at: "2026-01-01T00:00:00Z",
  status: "completed",
};

const cancelled = { ...completed, status: "cancelled" };
const errored = { ...completed, status: "error" };
const timedOut = { ...completed, status: "timed_out" };

describe("summarizeResult — aggregation table", () => {
  it("clean pass: all assertions pass, no scenario failures", () => {
    const s = summarizeResult(completed, {
      assertions: [makeAssertion(), makeAssertion({ assertion_id: "a2" })],
      coverage_mode: "interoperability",
      native_suite_status: "PASSED",
      scenario_outcomes: [{ scenario_id: "s1", verdict: "PASS" }],
      sessions: [],
    });
    expect(s.result).toBe("pass");
    expect(s.assertion_count).toBe(2);
    expect(s.native_failed_assertion_count).toBe(0);
  });

  it("failed assertion with PASS scenario → fail", () => {
    const s = summarizeResult(completed, {
      assertions: [
        makeAssertion({ native_status: "FAIL" }),
        makeAssertion({ assertion_id: "a2" }),
      ],
      coverage_mode: "interoperability",
      native_suite_status: "FAILED",
      scenario_outcomes: [{ scenario_id: "s1", verdict: "PASS" }],
      sessions: [],
    });
    expect(s.result).toBe("fail");
    expect(s.native_failed_assertion_count).toBe(1);
  });

  it("scenario FAIL → fail even with passing assertions", () => {
    const s = summarizeResult(completed, {
      assertions: [makeAssertion()],
      coverage_mode: "interoperability",
      native_suite_status: "FAILED",
      scenario_outcomes: [{ scenario_id: "s1", verdict: "FAIL" }],
      sessions: [],
    });
    expect(s.result).toBe("fail");
  });

  it("INCONCLUSIVE scenario without failure → inconclusive", () => {
    const s = summarizeResult(completed, {
      assertions: [makeAssertion()],
      coverage_mode: "interoperability",
      native_suite_status: "INCONCLUSIVE",
      scenario_outcomes: [{ scenario_id: "s1", verdict: "INCONCLUSIVE" }],
      sessions: [],
    });
    expect(s.result).toBe("inconclusive");
  });

  it("mixed explicit FAIL + INCONCLUSIVE → fail (failure dominates)", () => {
    const s = summarizeResult(completed, {
      assertions: [makeAssertion({ native_status: "FAIL" })],
      coverage_mode: "interoperability",
      native_suite_status: "FAILED",
      scenario_outcomes: [
        { scenario_id: "s1", verdict: "FAIL" },
        { scenario_id: "s2", verdict: "INCONCLUSIVE" },
      ],
      sessions: [],
    });
    expect(s.result).toBe("fail");
  });

  it("NOT_REACHED with some executed → partial", () => {
    const s = summarizeResult(completed, {
      assertions: [
        makeAssertion(),
        makeAssertion({ assertion_id: "a2", native_status: "NOT_REACHED" }),
      ],
      coverage_mode: "interoperability",
      native_suite_status: "INCOMPLETE",
      scenario_outcomes: [],
      sessions: [],
    });
    expect(s.result).toBe("partial");
    expect(s.assertion_count).toBe(2);
  });

  it("zero assertions → not_tested", () => {
    const s = summarizeResult(completed, {
      assertions: [],
      coverage_mode: "interoperability",
      native_suite_status: "PASSED",
      scenario_outcomes: [],
      sessions: [],
    });
    expect(s.result).toBe("not_tested");
    expect(s.assertion_count).toBe(0);
  });

  it("failed setup (zero assertions, errored) → not_tested", () => {
    const s = summarizeResult(errored, {
      assertions: [],
      coverage_mode: "interoperability",
      native_suite_status: "FAILED",
      scenario_outcomes: [],
      sessions: [],
    });
    expect(s.result).toBe("not_tested");
  });

  it("cancel after one passing assertion → partial", () => {
    const s = summarizeResult(cancelled, {
      assertions: [makeAssertion()],
      coverage_mode: "interoperability",
      native_suite_status: "PASSED",
      scenario_outcomes: [],
      sessions: [],
    });
    expect(s.result).toBe("partial");
    expect(s.assertion_count).toBe(1);
    expect(s.native_failed_assertion_count).toBe(0);
  });

  it("timeout with assertions → partial", () => {
    const s = summarizeResult(timedOut, {
      assertions: [makeAssertion()],
      coverage_mode: "interoperability",
      native_suite_status: "PASSED",
      scenario_outcomes: [],
      sessions: [],
    });
    expect(s.result).toBe("partial");
  });

  it("error with assertions → partial", () => {
    const s = summarizeResult(errored, {
      assertions: [makeAssertion()],
      coverage_mode: "interoperability",
      native_suite_status: "PASSED",
      scenario_outcomes: [],
      sessions: [],
    });
    expect(s.result).toBe("partial");
  });

  it("cancelled run with real FAIL → fail (failure dominates)", () => {
    const s = summarizeResult(cancelled, {
      assertions: [makeAssertion({ native_status: "FAIL" })],
      coverage_mode: "interoperability",
      native_suite_status: "FAILED",
      scenario_outcomes: [],
      sessions: [],
    });
    expect(s.result).toBe("fail");
  });

  it("NOT_REACHED with FAIL → fail (failure dominates)", () => {
    const s = summarizeResult(completed, {
      assertions: [
        makeAssertion({ native_status: "FAIL" }),
        makeAssertion({ assertion_id: "a2", native_status: "NOT_REACHED" }),
      ],
      coverage_mode: "interoperability",
      native_suite_status: "FAILED",
      scenario_outcomes: [],
      sessions: [],
    });
    expect(s.result).toBe("fail");
  });
});

describe("summarizeResult — native suite status (L16)", () => {
  const allPass = (native_suite_status: string) => ({
    assertions: [makeAssertion(), makeAssertion({ assertion_id: "a2" })],
    coverage_mode: "interoperability" as const,
    native_suite_status,
    scenario_outcomes: [],
    sessions: [],
  });

  it("completed + all PASS + INCOMPLETE suite → partial, never pass", () => {
    expect(summarizeResult(completed, allPass("INCOMPLETE")).result).toBe(
      "partial",
    );
  });

  it("completed + all PASS + unknown native status → partial", () => {
    expect(summarizeResult(completed, allPass("SOMETHING_NEW")).result).toBe(
      "partial",
    );
    expect(summarizeResult(completed, allPass("OPEN")).result).toBe("partial");
  });

  it("completed + all PASS + PASSED but nonzero exit → partial", () => {
    expect(
      summarizeResult({ ...completed, exit_code: 1 }, allPass("PASSED")).result,
    ).toBe("partial");
  });

  it("unknown execution status with all PASS → partial", () => {
    expect(
      summarizeResult({ ...completed, status: "running" }, allPass("PASSED"))
        .result,
    ).toBe("partial");
  });

  it("ordinary native FAIL in a completed run stays fail", () => {
    const s = summarizeResult(
      { ...completed, exit_code: 1 },
      {
        ...allPass("FAILED"),
        assertions: [makeAssertion({ native_status: "FAIL" })],
      },
    );
    expect(s).toEqual({
      assertion_count: 1,
      native_failed_assertion_count: 1,
      result: "fail",
    });
  });

  it("completed + all PASS + PASSED + exit 0 still passes", () => {
    expect(summarizeResult(completed, allPass("PASSED")).result).toBe("pass");
  });
});
