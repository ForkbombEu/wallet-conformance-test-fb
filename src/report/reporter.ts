import type { DatabaseSync } from "node:sqlite";
import type { TestResult } from "vitest/node";
import type { Reporter } from "vitest/reporters";

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import type { ConformanceCheck, Phase } from "@/report/types";

import { openDb, resolveDbPath } from "@/report/db";
import {
  buildNativeExport,
  MAX_NATIVE_ERROR_MESSAGE,
  MAX_NATIVE_ERRORS,
  type NativeAssertion,
  type NativeExport,
  type NativeRunError,
  writeNativeExport,
} from "@/report/native-export";
import {
  extractDescription,
  extractRequirementId,
} from "@/report/requirement-id";
import {
  appendCheck,
  closeSession,
  createSession,
} from "@/report/session-store";

type CheckResult = ConformanceCheck["result"];

type ReporterTestCase = Parameters<
  NonNullable<Reporter["onTestCaseResult"]>
>[0];

type RunEndArgs = Parameters<NonNullable<Reporter["onTestRunEnd"]>>;
type SerializedRunError = RunEndArgs[1][number];

type SessionStatus = "FAILED" | "INCOMPLETE" | "PASSED";
type TestType = Phase;

const DEFAULT_ENTITY_NAME = "-";

export class ConformanceReporter implements Reporter {
  private checkResults: CheckResult[] = [];
  private collectedAssertions: NativeAssertion[] = [];
  private db: DatabaseSync | undefined;
  private runErrors: NativeRunError[] = [];
  private sessionId: string | undefined;
  private startedAt = "";
  private readonly testType: TestType;

  private get exportEnabled(): boolean {
    return Boolean(process.env.WCT_RESULTS_DIR && process.env.WCT_RUN_ID);
  }

  constructor(testType: TestType) {
    this.testType = testType;
  }

  onTestCaseResult(testCase: ReporterTestCase): void {
    if (!this.db || !this.sessionId) {
      return;
    }

    const title = testCase.name;
    const vitestStatus = testCase.result().state;
    const result = this.mapResult(vitestStatus);
    const requirementId = extractRequirementId(title);
    const description = extractDescription(title);
    const check: ConformanceCheck = {
      description,
      phase: this.testType,
      requirementId: requirementId ?? title,
      result,
      timestamp: new Date().toISOString(),
    };

    if (result === "FAIL") {
      check.errorMessage = this.extractFailureMessage(testCase);
    }

    appendCheck(this.db, this.sessionId, check);
    this.checkResults.push(result);

    if (this.exportEnabled) {
      this.collectedAssertions.push({
        ancestorTitles: extractAncestorTitles(testCase),
        description,
        errorMessage: check.errorMessage ?? null,
        file: testCase.module.moduleId,
        nativeStatus: result,
        phase: this.testType,
        requirementId,
        timestamp: check.timestamp,
        title,
        vitestStatus,
      });
      // Keep a readable OPEN export so an interrupted run keeps the
      // assertions collected so far.
      this.writeNativeResults("OPEN");
    }
  }

  onTestRunEnd(
    testModules: RunEndArgs[0],
    unhandledErrors: RunEndArgs[1],
    reason: RunEndArgs[2],
  ): void {
    if (!this.db || !this.sessionId) {
      return;
    }

    // Errors outside test bodies (collection, suite hooks, unhandled errors,
    // an interrupted run) mean the suite did not pass, even when every
    // collected assertion passed.
    this.runErrors = collectRunErrors(testModules, unhandledErrors, reason);
    const status = this.resolveFinalStatus(
      this.checkResults,
      this.runErrors.length > 0 || reason !== "passed",
    );
    closeSession(this.db, this.sessionId, status, new Date().toISOString());
    this.db.close();

    console.log(`Conformance session ID: ${this.sessionId}`);

    if (this.exportEnabled) {
      this.writeNativeResults(status);
    }
  }

  onTestRunStart(): void {
    this.db = openDb(resolveDbPath());
    this.sessionId = randomUUID();
    this.checkResults = [];
    this.collectedAssertions = [];
    this.runErrors = [];
    this.startedAt = new Date().toISOString();

    createSession(this.db, {
      entityName: DEFAULT_ENTITY_NAME,
      id: this.sessionId,
      phase: this.testType,
      startedAt: this.startedAt,
      status: "OPEN",
    });
  }

  private extractFailureMessage(testCase: ReporterTestCase): string {
    const firstError = testCase.result().errors?.[0];

    if (!firstError) {
      return "Test failed without error details";
    }

    if (typeof firstError === "string") {
      return firstError;
    }

    if (typeof firstError === "object" && "message" in firstError) {
      const message = (firstError as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }

    return String(firstError);
  }

  private mapResult(state: TestResult["state"]): CheckResult {
    if (state === "passed") {
      return "PASS";
    }

    if (state === "failed") {
      return "FAIL";
    }

    return "NOT_REACHED";
  }

  private resolveFinalStatus(
    results: readonly CheckResult[],
    suiteErrors: boolean,
  ): SessionStatus {
    if (results.includes("FAIL")) {
      return "FAILED";
    }

    // Nothing ran, or something failed outside the collected assertions.
    if (
      suiteErrors ||
      results.length === 0 ||
      results.includes("NOT_REACHED")
    ) {
      return "INCOMPLETE";
    }

    return "PASSED";
  }

  private writeNativeResults(dbStatus: NativeExport["status"]): void {
    const outputDir = process.env.WCT_RESULTS_DIR;
    const runId = process.env.WCT_RUN_ID;

    if (!outputDir || !runId || !this.sessionId) {
      return;
    }

    const open = dbStatus === "OPEN";

    const data = buildNativeExport({
      assertions: this.collectedAssertions,
      closedAt: open ? null : new Date().toISOString(),
      errors: this.runErrors,
      phase: this.testType,
      runId,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      status: dbStatus,
    });

    mkdirSync(outputDir, { recursive: true });
    writeNativeExport(outputDir, data);
    if (!open) console.log(`Native results written to ${outputDir}`);
  }
}

/**
 * Collects the errors Vitest reports outside test bodies: module collection
 * errors, suite hook errors, unhandled errors and an interrupted run. Bounded
 * in count and message length; the assertions themselves are untouched.
 */
function collectRunErrors(
  testModules: RunEndArgs[0],
  unhandledErrors: RunEndArgs[1],
  reason: RunEndArgs[2],
): NativeRunError[] {
  const errors: NativeRunError[] = [];
  const add = (
    origin: NativeRunError["origin"],
    error: SerializedRunError,
    location?: string,
  ) => {
    if (errors.length >= MAX_NATIVE_ERRORS) return;
    errors.push({
      ...(location ? { location } : {}),
      message: runErrorMessage(error),
      origin,
    });
  };

  for (const testModule of testModules) {
    for (const error of testModule.errors()) {
      add("module", error, testModule.moduleId);
    }
    for (const suite of testModule.children.allSuites()) {
      for (const error of suite.errors()) add("suite", error, suite.fullName);
    }
  }
  for (const error of unhandledErrors) add("unhandled", error);
  if (reason === "interrupted") {
    add("run", { message: "The test run was interrupted before it finished" });
  }
  return errors;
}

function extractAncestorTitles(testCase: ReporterTestCase): string[] {
  const ancestors: string[] = [];
  let current = testCase.parent;
  while (current.type === "suite") {
    ancestors.unshift(current.name);
    current = current.parent;
  }
  return ancestors;
}

function runErrorMessage(error: SerializedRunError): string {
  const message =
    typeof error.message === "string" && error.message.length > 0
      ? error.message
      : String(error.name ?? "Unknown error");
  return message.slice(0, MAX_NATIVE_ERROR_MESSAGE);
}
