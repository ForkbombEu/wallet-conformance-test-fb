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

export interface OperatorModule {
  driveAuthorization(params: {
    authorizationUrl: string;
    page: unknown;
    redirectUri: string;
    signal: AbortSignal;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Puppeteer driver (operator-configured)
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

// ---------------------------------------------------------------------------
// Factory from profile config
// ---------------------------------------------------------------------------

export function createPuppeteerDriver(
  config: PuppeteerDriverConfig,
): AuthorizationDriver {
  return {
    async driveAuthorization(ctx) {
      const puppeteer = await import("puppeteer");
      const operatorModule = (await import(
        pathToFileURL(config.modulePath).href
      )) as OperatorModule;

      let browser: unknown;
      let page: unknown;
      try {
        browser = await puppeteer.default.launch({
          headless: true,
        });
        page = await (
          browser as {
            newPage(): Promise<unknown>;
          }
        ).newPage();

        // Navigate to authorization URL
        await (
          page as {
            goto(url: string, opts?: object): Promise<unknown>;
          }
        ).goto(ctx.authorizationUrl, { waitUntil: "networkidle2" });

        // Let the operator module perform target-specific navigation/login
        await operatorModule.driveAuthorization({
          authorizationUrl: ctx.authorizationUrl,
          page,
          redirectUri: ctx.redirectUri,
          signal: ctx.signal,
        });
      } finally {
        // Always close page and browser
        try {
          if (
            page &&
            typeof (page as { close?: () => Promise<void> }).close ===
              "function"
          ) {
            await (page as { close: () => Promise<void> }).close();
          }
        } catch {
          // ignore close errors
        }
        try {
          if (
            browser &&
            typeof (browser as { close?: () => Promise<void> }).close ===
              "function"
          ) {
            await (browser as { close: () => Promise<void> }).close();
          }
        } catch {
          // ignore close errors
        }
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
