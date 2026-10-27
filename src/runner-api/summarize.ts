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

  // Explicit scenario FAIL → fail (dominates)
  if (scenarioFail) {
    return {
      assertion_count: assertionCount,
      native_failed_assertion_count: nativeFailedCount,
      result: "fail",
    };
  }

  // INCONCLUSIVE scenario: remains inconclusive even with failed assertions,
  // unless there is an explicit independent conformance failure (scenario FAIL).
  // Per canonical contract: "INCONCLUSIVE plus failed strict-PASS matcher
  // remains inconclusive unless a separate explicit conformance failure is
  // established."
  if (scenarioInconclusive) {
    return {
      assertion_count: assertionCount,
      native_failed_assertion_count: nativeFailedCount,
      result: "inconclusive",
    };
  }

  // Failed assertion without INCONCLUSIVE scenario → fail
  if (nativeFailedCount > 0) {
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

  // Rule 5: complete, nonempty, all passed → pass
  return {
    assertion_count: assertionCount,
    native_failed_assertion_count: nativeFailedCount,
    result: "pass",
  };
}
