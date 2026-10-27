import type { DatabaseSync } from "node:sqlite";
import type { TestResult } from "vitest/node";
import type { Reporter } from "vitest/reporters";

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import type { ConformanceCheck, Phase } from "@/report/types";

import { openDb, resolveDbPath } from "@/report/db";
import {
  buildNativeExport,
  type NativeAssertion,
  type NativeExport,
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

type SessionStatus = "FAILED" | "INCOMPLETE" | "PASSED";
type TestType = Phase;

const DEFAULT_ENTITY_NAME = "-";

export class ConformanceReporter implements Reporter {
  private checkResults: CheckResult[] = [];
  private collectedAssertions: NativeAssertion[] = [];
  private db: DatabaseSync | undefined;
  private sessionId: string | undefined;
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
    testModules: Parameters<NonNullable<Reporter["onTestRunEnd"]>>[0] = [],
    unhandledErrors: Parameters<NonNullable<Reporter["onTestRunEnd"]>>[1] = [],
    reason?: Parameters<NonNullable<Reporter["onTestRunEnd"]>>[2],
  ): void {
    if (!this.db || !this.sessionId) {
      return;
    }

    // Errors outside test bodies (suite hooks, unhandled rejections) mean the
    // suite did not pass, even when every collected assertion passed.
    const suiteErrors =
      unhandledErrors.length > 0 ||
      testModules.some((m) => m.errors().length > 0) ||
      reason === "failed";
    const status = this.resolveFinalStatus(this.checkResults, suiteErrors);
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

    createSession(this.db, {
      entityName: DEFAULT_ENTITY_NAME,
      id: this.sessionId,
      phase: this.testType,
      startedAt: new Date().toISOString(),
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
    suiteErrors = false,
  ): SessionStatus {
    if (results.includes("FAIL")) {
      return "FAILED";
    }

    if (suiteErrors || results.includes("NOT_REACHED")) {
      return "INCOMPLETE";
    }

    return "PASSED";
  }

  private writeNativeResults(dbStatus: "OPEN" | SessionStatus): void {
    const outputDir = process.env.WCT_RESULTS_DIR;
    const runId = process.env.WCT_RUN_ID;

    if (!outputDir || !runId || !this.sessionId) {
      return;
    }

    const startedAt =
      this.collectedAssertions[0]?.timestamp ?? new Date().toISOString();

    const open = dbStatus === "OPEN";
    const exportStatus: NativeExport["status"] =
      !open && this.collectedAssertions.length === 0 ? "INCOMPLETE" : dbStatus;

    const data = buildNativeExport({
      assertions: this.collectedAssertions,
      closedAt: open ? null : new Date().toISOString(),
      phase: this.testType,
      runId,
      sessionId: this.sessionId,
      startedAt,
      status: exportStatus,
    });

    mkdirSync(outputDir, { recursive: true });
    writeNativeExport(outputDir, data);
    if (!open) console.log(`Native results written to ${outputDir}`);
  }
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
