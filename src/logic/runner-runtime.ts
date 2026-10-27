import {
  type AuthorizationDriver,
  type AuthorizationDriverConfig,
  createPuppeteerDriver,
  type LaunchDriverBrowser,
} from "./authorization-driver";

/**
 * Runtime facts the runner passes to its native child through the
 * environment. Only present when the child was launched by the runner
 * (`WCT_RUN_ID` set); the ordinary human CLI never sees them.
 */
export interface RunnerRuntime {
  /** Operator driver from the validated profile, if any. */
  authorizationDriver?: AuthorizationDriverConfig;
  runId: string;
  /** Aborts on SIGTERM/SIGINT delivered to this process or at the run deadline. */
  signal: AbortSignal;
}

let cached: RunnerRuntime | undefined;

/**
 * Returns a driver for runner mode: the operator-configured driver, or one
 * that fails immediately. A runner child must never fall back to opening the
 * system browser.
 *
 * @param launchBrowser low-level browser launch boundary (production default:
 *   headless puppeteer).
 */
export function createRunnerAuthorizationDriver(
  runtime: RunnerRuntime,
  launchBrowser?: LaunchDriverBrowser,
): AuthorizationDriver {
  if (runtime.authorizationDriver) {
    return createPuppeteerDriver(runtime.authorizationDriver, launchBrowser);
  }
  return {
    async driveAuthorization() {
      throw new Error(
        "browser_redirect authorization requires an operator authorizationDriver in runner mode; the system browser is never used",
      );
    },
  };
}

export function getRunnerRuntime(
  env: NodeJS.ProcessEnv = process.env,
): RunnerRuntime | undefined {
  const runId = env.WCT_RUN_ID;
  if (!runId) {
    return undefined;
  }
  if (cached?.runId === runId) {
    return cached;
  }

  const controller = new AbortController();
  const abort = (reason: string) => {
    if (!controller.signal.aborted) controller.abort(new Error(reason));
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      abort(`received ${sig}`);
      // Give in-flight cleanup (callback listener, browser) a moment, then
      // terminate as the default handler would have.
      setTimeout(
        () => process.exit(128 + (sig === "SIGTERM" ? 15 : 2)),
        1_000,
      ).unref();
    });
  }
  const deadline = Date.parse(env.WCT_RUN_DEADLINE ?? "");
  if (Number.isFinite(deadline)) {
    setTimeout(
      () => abort("run deadline reached"),
      Math.max(0, deadline - Date.now()),
    ).unref();
  }

  const modulePath = env.WCT_AUTHORIZATION_DRIVER_MODULE;
  cached = {
    authorizationDriver: modulePath
      ? { modulePath, type: "puppeteer" }
      : undefined,
    runId,
    signal: controller.signal,
  };
  return cached;
}
