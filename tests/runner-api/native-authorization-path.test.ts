import { IssuerTestConfiguration } from "#/config/issuance-test-configuration";
import { parse, stringify } from "ini";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FetchMetadataOptions,
  FetchMetadataStepResponse,
} from "@/step/issuance/fetch-metadata-step";
import type {
  PushedAuthorizationRequestResponse,
  PushedAuthorizationRequestStepOptions,
} from "@/step/issuance/pushed-authorization-request-step";

import {
  createRunnerAuthorizationDriver,
  getRunnerRuntime,
} from "@/logic/runner-runtime";
import { packageRoot } from "@/logic/runtime-paths";
import { WalletIssuanceOrchestratorFlow } from "@/orchestrator/wallet-issuance-orchestrator-flow";
import { buildNativeEnv } from "@/runner-api/native-worker";
import { loadProfileCatalogue } from "@/runner-api/profiles";
import {
  AuthorizeDefaultStep,
  CredentialRequestDefaultStep,
  FetchMetadataDefaultStep,
  NonceRequestDefaultStep,
  NotificationRequestDefaultStep,
  PushedAuthorizationRequestDefaultStep,
  TokenRequestDefaultStep,
} from "@/step/issuance";

// The system-browser opener must never run in runner mode.
const execSpy = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("system browser opener must not be called in runner mode");
  }),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  exec: execSpy,
}));

const CREDENTIAL_ID = "generic_pid_sd_jwt";
const ISSUER = "https://issuer.example";
const HUNG_DEADLINE_MS = 10_000;
const STEP_BOUND_MS = 30_000;

let dir: string;
let authServer: Server;
let authBase: string;
let authRequests: string[];
let callbackPort: number;
let savedEnv: NodeJS.ProcessEnv;
const parRequestUris: string[] = [];

/** Realistic generic OID4VCI discovery pointing at the local auth server. */
class StubFetchMetadataStep extends FetchMetadataDefaultStep {
  override async run(
    options: FetchMetadataOptions,
  ): Promise<FetchMetadataStepResponse> {
    return this.execute(async () => ({
      discoveredVia: "oid4vci" as const,
      issuerDiscovery: {
        authorizationServer: options.baseUrl,
        authorizationServerMetadata: {
          authorization_endpoint: `${authBase}/authorize`,
          issuer: options.baseUrl,
          pushed_authorization_request_endpoint: `${authBase}/par`,
          token_endpoint: `${authBase}/token`,
        },
        credentialIssuer: options.baseUrl,
        credentialIssuerMetadata: {
          credential_configurations_supported: {
            [CREDENTIAL_ID]: { format: "dc+sd-jwt", vct: "urn:example:pid" },
          },
          credential_endpoint: `${options.baseUrl}/credential`,
          credential_issuer: options.baseUrl,
        },
        discoveryMethod: "oid4vci_well_known" as const,
        profile: "generic_oid4vci" as const,
      },
      status: 200,
    }));
  }
}

/** A PAR response as an issuer returns it (fresh request_uri per call). */
class StubParStep extends PushedAuthorizationRequestDefaultStep {
  override async run(
    _options: PushedAuthorizationRequestStepOptions,
  ): Promise<PushedAuthorizationRequestResponse> {
    void _options;
    return this.execute(async () => {
      const requestUri = `urn:ietf:params:oauth:request_uri:${randomUUID()}`;
      parRequestUris.push(requestUri);
      return {
        codeVerifier: randomUUID(),
        expires_in: 60,
        request_uri: requestUri,
        state: randomUUID(),
      };
    });
  }
}

/**
 * TEST-ONLY launch boundary. This host's AppArmor policy forbids the
 * unprivileged user namespaces Chrome's sandbox needs, so the test browser
 * runs without it. Production keeps the default sandboxed launcher.
 */
const launchTestBrowser = async () => {
  const puppeteer = await import("puppeteer");
  return puppeteer.default.launch({ args: ["--no-sandbox"], headless: true });
};

/** Puts this process in the same runner mode a native child would be in. */
function enterRunnerMode(options: {
  deadlineMs?: number;
  driverModule?: string;
}): void {
  process.env.WCT_RUN_ID = `run-${randomUUID()}`;
  process.env.WCT_RUNNER_MODE = "1";
  if (options.driverModule) {
    process.env.WCT_AUTHORIZATION_DRIVER_MODULE = options.driverModule;
  } else {
    delete process.env.WCT_AUTHORIZATION_DRIVER_MODULE;
  }
  if (options.deadlineMs) {
    process.env.WCT_RUN_DEADLINE = new Date(
      Date.now() + options.deadlineMs,
    ).toISOString();
  } else {
    delete process.env.WCT_RUN_DEADLINE;
  }
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  await new Promise<void>((r) => server.close(() => r()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

function makeConfiguration(): IssuerTestConfiguration {
  return IssuerTestConfiguration.createCustom({
    authorizeStepClass: AuthorizeDefaultStep,
    credentialConfigurationId: CREDENTIAL_ID,
    credentialRequestStepClass: CredentialRequestDefaultStep,
    fetchMetadataStepClass: StubFetchMetadataStep,
    name: "NativeAuthorizationPath",
    nonceRequestStepClass: NonceRequestDefaultStep,
    notificationRequestStepClass: NotificationRequestDefaultStep,
    pushedAuthorizationRequestStepClass: StubParStep,
    tokenRequestStepClass: TokenRequestDefaultStep,
  });
}

async function portIsFree(port: number): Promise<boolean> {
  const server = createNetServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function readDriverRecord(kind: string): {
  authorizationUrl: string;
  pageUrl: string;
  redirectUri: string;
} {
  return JSON.parse(
    readFileSync(join(dir, `driver-${kind}.json`), "utf-8"),
  ) as { authorizationUrl: string; pageUrl: string; redirectUri: string };
}

/**
 * The orchestrator exactly as a runner child builds it, except for the
 * browser launch boundary: the driver comes from the same runner runtime
 * (WCT_* env) the orchestrator itself resolves.
 */
function runnerOrchestrator(): WalletIssuanceOrchestratorFlow {
  const runtime = getRunnerRuntime();
  if (!runtime) throw new Error("not in runner mode");
  return new WalletIssuanceOrchestratorFlow(
    makeConfiguration(),
    createRunnerAuthorizationDriver(runtime, launchTestBrowser),
  );
}

/** Operator driver modules, written as real ES modules on disk. */
function writeDriverModule(kind: "complete" | "hang" | "throw"): string {
  const record = join(dir, `driver-${kind}.json`);
  const body = {
    complete: `
      const target = new URL(redirectUri);
      target.searchParams.set("code", "code-from-operator-driver");
      target.searchParams.set("iss", "${ISSUER}");
      target.searchParams.set("state", "state-1");
      // Fails with ERR_CONNECTION_REFUSED unless the listener is ready.
      await page.goto(target.href);`,
    hang: `await new Promise(() => {});`,
    throw: `throw new Error("operator driver failed early");`,
  }[kind];
  const modulePath = join(dir, `driver-${kind}.mjs`);
  writeFileSync(
    modulePath,
    `import { writeFileSync } from "node:fs";
export async function driveAuthorization({ page, authorizationUrl, redirectUri, signal }) {
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({
    authorizationUrl, redirectUri, signalAborted: signal.aborted,
    pageUrl: page.url(),
  }));
  ${body}
}
`,
  );
  return modulePath;
}

beforeEach(async () => {
  savedEnv = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), "wct-l10-"));
  authRequests = [];
  execSpy.mockClear();

  authServer = createHttpServer((req, res) => {
    authRequests.push(req.url ?? "");
    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end("<html><body>login</body></html>");
  });
  await new Promise<void>((r) => authServer.listen(0, "127.0.0.1", () => r()));
  const address = authServer.address();
  if (!address || typeof address === "string") throw new Error("no address");
  authBase = `http://127.0.0.1:${address.port}`;
  callbackPort = await freePort();

  const ini = parse(
    readFileSync(join(packageRoot, "config.example.ini"), "utf-8"),
  ) as Record<string, Record<string, unknown>>;
  const section = (name: string) => (ini[name] ??= {});
  section("profile").ecosystem = "generic_oid4vci";
  section("issuance").url = ISSUER;
  section("issuance").authorization_interaction = "browser_redirect";
  section("issuance").callback_port = callbackPort;
  section("issuance").credential_types = [CREDENTIAL_ID];
  section("wallet").wallet_attestations_storage_path = join(dir, "attestation");
  section("wallet").credentials_storage_path = join(dir, "credentials");
  section("wallet").backup_storage_path = join(dir, "backup");
  section("trust_anchor").tls_cert_dir = join(dir, "backup");
  section("logging").log_file = join(dir, "logs", "native.log");
  const iniPath = join(dir, "operator.ini");
  writeFileSync(iniPath, stringify(ini));
  process.env.CONFIG_FILE_INI = iniPath;
});

afterEach(async () => {
  process.env = savedEnv;
  await new Promise<void>((r) => authServer.close(() => r()));
  rmSync(dir, { force: true, recursive: true });
});

describe("L10 — operator driver through the real issuance orchestrator", () => {
  it("drives the real authorization URL against a listening callback and completes the native step", async () => {
    enterRunnerMode({ driverModule: writeDriverModule("complete") });
    const ctx = await runnerOrchestrator().runThroughAuthorize();

    expect(ctx.authorizeResponse.success).toBe(true);
    expect(ctx.authorizeResponse.response?.authorizeResponse?.code).toBe(
      "code-from-operator-driver",
    );
    const record = readDriverRecord("complete");
    expect(record.authorizationUrl).toContain(`${authBase}/authorize?`);
    expect(record.authorizationUrl).toContain(
      encodeURIComponent(parRequestUris.at(-1) ?? "missing"),
    );
    expect(record.redirectUri).toBe(`http://localhost:${callbackPort}/cb`);
    expect(authRequests.some((u) => u.startsWith("/authorize?"))).toBe(true);
    expect(execSpy).not.toHaveBeenCalled();
    await expect(portIsFree(callbackPort)).resolves.toBe(true);
  }, 60_000);

  it("an early driver exception fails the step, releases the port, and the next run reuses it", async () => {
    enterRunnerMode({ driverModule: writeDriverModule("throw") });
    const failing = runnerOrchestrator();
    await expect(failing.runThroughAuthorize()).rejects.toThrow();
    expect(failing["_authorizeResponse"]?.error?.message).toContain(
      "operator driver failed early",
    );
    await expect(portIsFree(callbackPort)).resolves.toBe(true);

    enterRunnerMode({ driverModule: writeDriverModule("complete") });
    const next = runnerOrchestrator();
    const ctx = await next.runThroughAuthorize();
    expect(ctx.authorizeResponse.success).toBe(true);
  }, 60_000);

  it("a hung driver is bounded by the run deadline signal and cleaned up", async () => {
    // Long enough for Chrome to start and reach the operator module under
    // load; the module then hangs until the deadline aborts it.
    enterRunnerMode({
      deadlineMs: HUNG_DEADLINE_MS,
      driverModule: writeDriverModule("hang"),
    });
    const orchestrator = runnerOrchestrator();
    const started = Date.now();
    await expect(orchestrator.runThroughAuthorize()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(STEP_BOUND_MS);
    expect(orchestrator["_authorizeResponse"]?.error?.message).toMatch(
      /aborted.*run deadline reached/,
    );
    expect(readDriverRecord("hang").authorizationUrl).toContain("/authorize");
    await expect(portIsFree(callbackPort)).resolves.toBe(true);
  }, 60_000);

  it("runner browser mode without an operator driver never opens the system browser", async () => {
    enterRunnerMode({});
    const orchestrator = new WalletIssuanceOrchestratorFlow(
      makeConfiguration(),
    );
    await expect(orchestrator.runThroughAuthorize()).rejects.toThrow();
    expect(orchestrator["_authorizeResponse"]?.error?.message).toContain(
      "requires an operator authorizationDriver",
    );
    expect(execSpy).not.toHaveBeenCalled();
    await expect(portIsFree(callbackPort)).resolves.toBe(true);
  });
});

describe("L10 — runner configuration carries the canonical driver setting", () => {
  function writeProfiles(profile: Record<string, unknown>): string {
    const path = join(dir, "profiles.json");
    writeFileSync(
      path,
      JSON.stringify({
        profiles: [
          {
            allowedAuthorizationInteraction: ["auto", "browser_redirect"],
            category: "issuance",
            configFile: "operator.ini",
            coverageMode: "interoperability",
            id: "browser-profile",
            selections: [
              {
                id: "smoke",
                testFile:
                  "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
              },
            ],
            ...profile,
          },
        ],
      }),
    );
    return path;
  }

  it("resolves the driver module absolutely and hands it to the child env", () => {
    writeDriverModule("complete");
    const catalogue = loadProfileCatalogue(
      writeProfiles({
        authorizationDriver: {
          modulePath: "driver-complete.mjs",
          type: "puppeteer",
        },
      }),
    );
    const modulePath =
      catalogue.get("browser-profile")?.authorizationDriver?.modulePath;
    expect(modulePath).toBe(join(dir, "driver-complete.mjs"));

    const env = buildNativeEnv(
      {
        authorizationDriver: {
          modulePath: modulePath ?? "",
          type: "puppeteer",
        },
        authorizationInteraction: "browser_redirect",
        category: "issuance",
        coverageMode: "interoperability",
        credentialConfigurationIds: [CREDENTIAL_ID],
        initializedAssets: [],
        overrides: {},
        profileConfigPath: join(dir, "operator.ini"),
        profileId: "browser-profile",
        selectionId: "smoke",
        target: { issuerIdentifier: ISSUER },
        testFile: join(dir, "x.issuance.spec.ts"),
        writablePaths: {
          attestation: join(dir, "a"),
          backup: join(dir, "b"),
          credentials: join(dir, "c"),
          db: join(dir, "d.db"),
          logs: join(dir, "l"),
        },
      },
      {
        deadline: "2030-01-01T00:00:00.000Z",
        effectiveIni: join(dir, "effective.ini"),
        resultsDir: join(dir, "results"),
        runId: "run-1",
      },
      { WCT_AUTHORIZATION_DRIVER_MODULE: "/inherited/evil.mjs" },
    );
    expect(env.WCT_AUTHORIZATION_DRIVER_MODULE).toBe(modulePath);
    expect(env.WCT_RUN_DEADLINE).toBe("2030-01-01T00:00:00.000Z");
  });

  it("rejects the obsolete browserDriver field and a missing driver module", () => {
    expect(() =>
      loadProfileCatalogue(writeProfiles({ browserDriver: { type: "x" } })),
    ).toThrow(/browserDriver/);
    expect(() =>
      loadProfileCatalogue(
        writeProfiles({
          authorizationDriver: { modulePath: "nope.mjs", type: "puppeteer" },
        }),
      ),
    ).toThrow(/authorization driver module not found/);
  });

  it("rejects presentation / engagementFactory profiles instead of advertising them", () => {
    expect(() =>
      loadProfileCatalogue(writeProfiles({ category: "presentation" })),
    ).toThrow(/not supported by this runner/);
    expect(() =>
      loadProfileCatalogue(
        writeProfiles({
          engagementFactory: { modulePath: "factory.mjs" },
        }),
      ),
    ).toThrow();
  });
});
