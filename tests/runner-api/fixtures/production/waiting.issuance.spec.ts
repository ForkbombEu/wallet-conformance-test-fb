/**
 * Fixture that passes one assertion and then waits, so the runner can cancel
 * it, hit its deadline, or be killed mid-run. Records the native process ids
 * in `pids.json` so the test can verify nothing survives the run.
 *
 * Vitest 3.2's task-update throttle (strict `Date.now() - last > 100`) can
 * drop the pending flush when its timer fires at exactly 100 ms, so a test
 * that just finished may not reach reporters until the next task update. The
 * annotation below, sent > 100 ms later, forces that update deterministically.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

writeFileSync(
  join(process.cwd(), "pids.json"),
  JSON.stringify({ main: process.ppid, worker: process.pid }),
);

describe("Waiting suite", () => {
  test("[CI_910]: completes before the wait", () => {
    expect(true).toBe(true);
  });

  test("CI_911: waits until cancelled or timed out", async ({ annotate }) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await annotate("waiting for cancellation or deadline");
    await new Promise((resolve) => setTimeout(resolve, 150_000));
    expect.unreachable("the runner must cancel or time out this test");
  }, 200_000);
});
