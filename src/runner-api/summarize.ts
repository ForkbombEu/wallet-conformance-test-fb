import type { RunnerResult } from "./contract";

type Execution = RunnerResult["execution"];
type Native = RunnerResult["native"];
type Summary = RunnerResult["summary"];

export function summarizeResult(execution: Execution, native: Native): Summary {
  const assertionCount = native.assertions.length;
  const nativeFailedCount = native.assertions.filter(
    (a) => a.native_status === "FAIL",
  ).length;
  const hasNotReached = native.assertions.some(
    (a) => a.native_status === "NOT_REACHED",
  );
  const scenarioFail = native.scenario_outcomes.some(
    (s) => s.verdict === "FAIL",
  );
  const scenarioInconclusive = native.scenario_outcomes.some(
    (s) => s.verdict === "INCONCLUSIVE",
  );

  // Rule 5: zero assertions → not_tested
  if (assertionCount === 0) {
    return {
      assertion_count: 0,
      native_failed_assertion_count: 0,
      result: "not_tested",
    };
  }

  // Rule 2: failed assertion or scenario FAIL → fail
  if (nativeFailedCount > 0 || scenarioFail) {
    return {
      assertion_count: assertionCount,
      native_failed_assertion_count: nativeFailedCount,
      result: "fail",
    };
  }

  // Incomplete execution (cancel/timeout/error) with some assertions → partial
  const incompleteStatuses = ["cancelled", "error", "timed_out"];
  if (incompleteStatuses.includes(execution.status)) {
    return {
      assertion_count: assertionCount,
      native_failed_assertion_count: nativeFailedCount,
      result: "partial",
    };
  }

  // NOT_REACHED with some executed assertions → partial (rule 5)
  if (hasNotReached) {
    return {
      assertion_count: assertionCount,
      native_failed_assertion_count: nativeFailedCount,
      result: "partial",
    };
  }

  // Rule 3: INCONCLUSIVE scenario without associated failure → inconclusive
  if (scenarioInconclusive) {
    return {
      assertion_count: assertionCount,
      native_failed_assertion_count: nativeFailedCount,
      result: "inconclusive",
    };
  }

  // Rule 5: complete, nonempty, all passed → pass
  return {
    assertion_count: assertionCount,
    native_failed_assertion_count: nativeFailedCount,
    result: "pass",
  };
}
