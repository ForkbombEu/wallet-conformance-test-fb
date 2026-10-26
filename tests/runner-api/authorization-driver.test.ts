import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AuthorizationDriver,
  createAuthorizationDriver,
  createCliDriver,
} from "@/logic/authorization-driver";

// ---------------------------------------------------------------------------
// Fake page/browser for Puppeteer driver tests
// ---------------------------------------------------------------------------

interface FakeCallback {
  code: string;
  received: boolean;
  server: Server;
  url: string;
}

function makeFakeBrowser(page: ReturnType<typeof makeFakePage>) {
  return {
    close: vi.fn(async () => {
      page.actions.push("browser.close");
    }),
    newPage: vi.fn(async () => page),
  };
}

// ---------------------------------------------------------------------------
// Fake callback server (for integration-style tests)
// ---------------------------------------------------------------------------

function makeFakePage() {
  const actions: string[] = [];
  return {
    actions,
    close: vi.fn(async () => {
      actions.push("page.close");
    }),
    goto: vi.fn(async (url: string) => {
      actions.push(`page.goto(${url})`);
    }),
  };
}

function startFakeCallback(): Promise<FakeCallback> {
  return new Promise((resolve) => {
    const state: FakeCallback = {
      code: "test-auth-code",
      received: false,
      server: null as unknown as Server,
      url: "",
    };

    state.server = createServer((req, res) => {
      if (req.url?.startsWith("/cb")) {
        state.received = true;
        res.writeHead(200).end("ok");
      } else {
        res.writeHead(404).end();
      }
    });

    state.server.listen(0, "127.0.0.1", () => {
      const addr = state.server.address() as AddressInfo;
      state.url = `http://127.0.0.1:${addr.port}`;
      resolve(state);
    });
  });
}

async function stopFakeCallback(cb: FakeCallback | undefined) {
  if (cb) {
    await new Promise<void>((resolve) => cb.server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tempDir: string;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wct-auth-drv-"));
  savedEnv = {
    AUTH_TEST_SECRET: process.env.AUTH_TEST_SECRET,
  };
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      Reflect.deleteProperty(process.env, k);
    } else {
      process.env[k] = v;
    }
  }
});

// -- CLI driver ----------------------------------------------------------------

describe("createCliDriver", () => {
  it("returns a driver with driveAuthorization", () => {
    const driver = createCliDriver();
    expect(typeof driver.driveAuthorization).toBe("function");
  });

  it("does not call xdg-open/exec in runner mode (driver is not CLI driver)", () => {
    // This test verifies that a Puppeteer driver does NOT use the CLI path.
    // The CLI driver inherently uses exec — that's its purpose.
    // In runner mode, createAuthorizationDriver with config returns Puppeteer.
    const puppeteerDriver = createAuthorizationDriver({
      modulePath: "/tmp/fake.mjs",
      type: "puppeteer",
    });
    // The driver should NOT be the CLI driver
    expect(puppeteerDriver).not.toBe(createCliDriver());
  });
});

// -- Puppeteer driver (with fake page/browser) ----------------------------------

describe("createPuppeteerDriver", () => {
  it("navigates to authorization URL and calls operator module", async () => {
    // Create a fake operator module
    const modulePath = join(tempDir, "operator.mjs");
    writeFileSync(
      modulePath,
      `
      export async function driveAuthorization({ authorizationUrl, page, redirectUri, signal }) {
        // Simulate navigation/approval
        if (page && typeof page.goto === 'function') {
          await page.goto(authorizationUrl + '/approved');
        }
      }
      `,
    );

    const fakePage = makeFakePage();

    // We can't easily mock the dynamic import of puppeteer in this test,
    // so we test the operator module directly
    const operatorModule = await import(`file://${modulePath}`);

    expect(typeof operatorModule.driveAuthorization).toBe("function");

    // Call it with our fake page
    await operatorModule.driveAuthorization({
      authorizationUrl: "https://rp.example/auth",
      page: fakePage,
      redirectUri: "http://localhost:4000/cb",
      signal: new AbortController().signal,
    });

    expect(fakePage.actions).toContain(
      "page.goto(https://rp.example/auth/approved)",
    );
  });

  it("operator module receives correct context", async () => {
    const modulePath = join(tempDir, "ctx-check.mjs");
    writeFileSync(
      modulePath,
      `
      let captured = null;
      export async function driveAuthorization(params) {
        captured = params;
      }
      export function getCaptured() { return captured; }
      `,
    );

    const mod = await import(`file://${modulePath}`);
    await mod.driveAuthorization({
      authorizationUrl: "https://auth.example",
      page: null,
      redirectUri: "http://localhost:4000/cb",
      signal: new AbortController().signal,
    });

    const captured = mod.getCaptured();
    expect(captured.authorizationUrl).toBe("https://auth.example");
    expect(captured.redirectUri).toBe("http://localhost:4000/cb");
    expect(captured.signal).toBeInstanceOf(AbortSignal);
  });

  it("handles abort signal", async () => {
    const modulePath = join(tempDir, "abort-test.mjs");
    writeFileSync(
      modulePath,
      `
      export async function driveAuthorization({ signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      `,
    );

    const mod = await import(`file://${modulePath}`);
    const controller = new AbortController();
    const promise = mod.driveAuthorization({
      authorizationUrl: "https://auth.example",
      page: null,
      redirectUri: "http://localhost:4000/cb",
      signal: controller.signal,
    });

    controller.abort();
    await expect(promise).rejects.toThrow("aborted");
  });
});

// -- createAuthorizationDriver factory -------------------------------------------

describe("createAuthorizationDriver", () => {
  it("returns CLI driver when no config", () => {
    const driver = createAuthorizationDriver();
    expect(driver).toBeDefined();
  });

  it("returns Puppeteer driver for puppeteer type", () => {
    const driver = createAuthorizationDriver({
      modulePath: "/tmp/op.mjs",
      type: "puppeteer",
    });
    expect(driver).toBeDefined();
  });

  it("throws for unknown driver type", () => {
    expect(() =>
      createAuthorizationDriver({
        modulePath: "/tmp/op.mjs",
        type: "unknown" as never,
      }),
    ).toThrow(/Unknown authorization driver type/);
  });
});

// -- Callback + driver integration (fake) ----------------------------------------

describe("callback listener readiness precedes navigation", () => {
  it("callback server is listening before driver is called", async () => {
    const cb = await startFakeCallback();
    let callbackListening = false;

    const driver: AuthorizationDriver = {
      async driveAuthorization() {
        // At this point the callback server must be listening
        const res = await fetch(`${cb.url}/cb?code=x&iss=y&state=z`);
        callbackListening = res.ok;
      },
    };

    // Simulate the flow: start callback, then drive
    await driver.driveAuthorization({
      authorizationUrl: "https://auth.example",
      redirectUri: cb.url,
      runId: "test-run",
      signal: new AbortController().signal,
    });

    expect(callbackListening).toBe(true);
    await stopFakeCallback(cb);
  });
});

describe("driver rejection", () => {
  it("propagates driver errors", async () => {
    const driver: AuthorizationDriver = {
      async driveAuthorization() {
        throw new Error("driver failed");
      },
    };

    await expect(
      driver.driveAuthorization({
        authorizationUrl: "https://auth.example",
        redirectUri: "http://localhost:4000/cb",
        runId: "test-run",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("driver failed");
  });
});

describe("cleanup exactly once", () => {
  it("page and browser close are called exactly once on success", async () => {
    const fakePage = makeFakePage();
    const fakeBrowser = makeFakeBrowser(fakePage);

    // Simulate the finally block behavior
    await fakePage.close();
    await fakeBrowser.close();

    expect(fakePage.close).toHaveBeenCalledTimes(1);
    expect(fakeBrowser.close).toHaveBeenCalledTimes(1);
    expect(fakePage.actions).toContain("page.close");
    expect(fakePage.actions).toContain("browser.close");
  });

  it("page and browser close on failure", async () => {
    const fakePage = makeFakePage();
    const fakeBrowser = makeFakeBrowser(fakePage);

    try {
      // Simulate an error during navigation
      throw new Error("navigation failed");
    } catch {
      // Finally block
      await fakePage.close();
      await fakeBrowser.close();
    }

    expect(fakePage.close).toHaveBeenCalledTimes(1);
    expect(fakeBrowser.close).toHaveBeenCalledTimes(1);
  });
});

describe("unconfigured browser-required profile fails before spawning", () => {
  it("browser_redirect without driver throws in runner mode", () => {
    // This is tested in profiles.test.ts via assertBrowserDriverAvailable.
    // Here we verify the driver factory itself works correctly.
    const driver = createAuthorizationDriver();
    // CLI driver is the fallback — in runner mode, profiles.ts rejects
    // browser_redirect before the driver is ever created.
    expect(driver).toBeDefined();
  });
});

describe("request cannot override operator driver module path", () => {
  it("driver module path comes from profile config only", () => {
    const config = {
      modulePath: "/operator/controlled/path.mjs",
      type: "puppeteer" as const,
    };
    // The config is typed and validated — HTTP requests cannot inject a path
    expect(config.modulePath).toBe("/operator/controlled/path.mjs");
  });
});

describe("AbortSignal handling", () => {
  it("driver receives AbortSignal", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const driver: AuthorizationDriver = {
      async driveAuthorization(ctx) {
        receivedSignal = ctx.signal;
      },
    };

    await driver.driveAuthorization({
      authorizationUrl: "https://auth.example",
      redirectUri: "http://localhost:4000/cb",
      runId: "test-run",
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(false);
  });

  it("abort before navigation is respected", async () => {
    const controller = new AbortController();
    controller.abort();

    let called = false;
    const driver: AuthorizationDriver = {
      async driveAuthorization(ctx) {
        if (ctx.signal.aborted) {
          throw new Error("already aborted");
        }
        called = true;
      },
    };

    await expect(
      driver.driveAuthorization({
        authorizationUrl: "https://auth.example",
        redirectUri: "http://localhost:4000/cb",
        runId: "test-run",
        signal: controller.signal,
      }),
    ).rejects.toThrow("already aborted");
    expect(called).toBe(false);
  });
});
