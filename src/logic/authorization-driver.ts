import { exec } from "node:child_process";
import { platform } from "node:os";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Driver interface
// ---------------------------------------------------------------------------

export interface AuthorizationDriver {
  driveAuthorization(ctx: AuthorizationDriverContext): Promise<void>;
}

export type AuthorizationDriverConfig = PuppeteerDriverConfig;

// ---------------------------------------------------------------------------
// CLI driver (default — preserves existing system-browser path)
// ---------------------------------------------------------------------------

export interface AuthorizationDriverContext {
  authorizationUrl: string;
  redirectUri: string;
  runId: string;
  signal: AbortSignal;
}

/** Minimal browser surface used by the puppeteer driver. */
export interface DriverBrowser {
  close(): Promise<void>;
  newPage(): Promise<DriverPage>;
}

// ---------------------------------------------------------------------------
// Puppeteer driver (operator-configured)
// ---------------------------------------------------------------------------

export interface DriverPage {
  close(): Promise<void>;
  goto(url: string, opts?: object): Promise<unknown>;
}

export type LaunchDriverBrowser = () => Promise<DriverBrowser>;

export interface OperatorModule {
  driveAuthorization(params: {
    authorizationUrl: string;
    page: unknown;
    redirectUri: string;
    signal: AbortSignal;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory from profile config
// ---------------------------------------------------------------------------

export interface PuppeteerDriverConfig {
  modulePath: string;
  type: "puppeteer";
}

export function createAuthorizationDriver(
  config?: AuthorizationDriverConfig,
): AuthorizationDriver {
  if (!config) {
    return createCliDriver();
  }
  if (config.type === "puppeteer") {
    return createPuppeteerDriver(config);
  }
  throw new Error(`Unknown authorization driver type: ${String(config.type)}`);
}

export function createCliDriver(): AuthorizationDriver {
  return {
    async driveAuthorization(ctx) {
      openBrowser(ctx.authorizationUrl);
    },
  };
}

const launchHeadlessPuppeteer: LaunchDriverBrowser = async () => {
  const puppeteer = await import("puppeteer");
  return puppeteer.default.launch({ headless: true });
};

/**
 * Operator-configured puppeteer driver. The browser is closed when the
 * operator module finishes or fails, and immediately when the run signal
 * aborts, so a hung operator module cannot keep the browser alive.
 *
 * @param launchBrowser low-level browser launch boundary (defaults to
 *   headless puppeteer).
 */
export function createPuppeteerDriver(
  config: PuppeteerDriverConfig,
  launchBrowser: LaunchDriverBrowser = launchHeadlessPuppeteer,
): AuthorizationDriver {
  return {
    async driveAuthorization(ctx) {
      ctx.signal.throwIfAborted();
      const operatorModule = (await import(
        pathToFileURL(config.modulePath).href
      )) as OperatorModule;

      const browser = await launchBrowser();
      let closing: Promise<void> | undefined;
      const closeBrowser = () => {
        closing ??= browser.close().catch(() => undefined);
        return closing;
      };
      const onAbort = () => void closeBrowser();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      try {
        ctx.signal.throwIfAborted();
        const page = await browser.newPage();
        await page.goto(ctx.authorizationUrl, { waitUntil: "networkidle2" });

        // Let the operator module perform target-specific navigation/login
        await operatorModule.driveAuthorization({
          authorizationUrl: ctx.authorizationUrl,
          page,
          redirectUri: ctx.redirectUri,
          signal: ctx.signal,
        });
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        await closeBrowser();
      }
    },
  };
}

function openBrowser(url: string): void {
  const os = platform();
  const quotedUrl = JSON.stringify(url);
  let command: string;
  if (os === "darwin") {
    command = `open ${quotedUrl}`;
  } else if (os === "win32") {
    command = `start "" ${quotedUrl}`;
  } else {
    command = `xdg-open ${quotedUrl}`;
  }
  exec(command, (err) => {
    if (err) {
      console.warn(`Could not open browser automatically: ${err.message}`);
      console.warn(`Please open the following URL manually:\n  ${url}`);
    }
  });
}
