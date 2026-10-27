import type { RunnerResult } from "./contract";

type Execution = RunnerResult["execution"];
type Native = RunnerResult["native"];
type Summary = RunnerResult["summary"];

/**
 * Whether the native suite itself ended cleanly: status PASSED and, when the
 * engine reported one, exit code 0.
 */
export function nativeSuiteClean(
  execution: Execution,
  native: Native,
): boolean {
  return (
    native.native_suite_status === "PASSED" &&
    (execution.exit_code === undefined || execution.exit_code === 0)
  );
}

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

  // Anything but a completed execution (cancel/timeout/error, or a status
  // this summarizer does not know) with some assertions → partial
  if (execution.status !== "completed") {
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

  // Every collected assertion passed, but the native suite itself did not
  // (hook/unhandled/collection errors, unknown status, nonzero exit) → partial
  if (!nativeSuiteClean(execution, native)) {
    return {
      assertion_count: assertionCount,
      native_failed_assertion_count: nativeFailedCount,
      result: "partial",
    };
  }

  // Rule 5: complete, nonempty, all passed, clean native suite → pass
  return {
    assertion_count: assertionCount,
    native_failed_assertion_count: nativeFailedCount,
    result: "pass",
  };
}
