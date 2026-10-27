/**
 * Configured-browser production fixture: runs the REAL
 * WalletIssuanceOrchestratorFlow authorize stage (real AuthorizeDefaultStep,
 * callback server and operator driver module from the runner runtime) inside
 * the runner's native child. Only FetchMetadata/PAR are stubbed (no issuer),
 * against a local authorization endpoint started here.
 *
 * TEST-ONLY: the browser launch boundary adds --no-sandbox because this
 * host's AppArmor policy forbids Chrome's user-namespace sandbox. The driver
 * itself is resolved by the production runner runtime (WCT_* env).
 */
import { IssuerTestConfiguration } from "#/config/issuance-test-configuration";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  FetchMetadataOptions,
  FetchMetadataStepResponse,
} from "@/step/issuance/fetch-metadata-step";
import type { PushedAuthorizationRequestResponse } from "@/step/issuance/pushed-authorization-request-step";

import { loadConfigWithHierarchy } from "@/logic/config-loader";
import {
  createRunnerAuthorizationDriver,
  getRunnerRuntime,
} from "@/logic/runner-runtime";
import { WalletIssuanceOrchestratorFlow } from "@/orchestrator/wallet-issuance-orchestrator-flow";
import {
  AuthorizeDefaultStep,
  CredentialRequestDefaultStep,
  FetchMetadataDefaultStep,
  NonceRequestDefaultStep,
  NotificationRequestDefaultStep,
  PushedAuthorizationRequestDefaultStep,
  TokenRequestDefaultStep,
} from "@/step/issuance";

const config = loadConfigWithHierarchy();
const credentialId = config.issuance.credential_types[0] ?? "missing";
let authServer: Server;
let authBase = "";

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
        },
        credentialIssuer: options.baseUrl,
        credentialIssuerMetadata: {
          credential_configurations_supported: {
            [credentialId]: { format: "dc+sd-jwt" },
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

class StubParStep extends PushedAuthorizationRequestDefaultStep {
  override async run(): Promise<PushedAuthorizationRequestResponse> {
    return this.execute(async () => ({
      codeVerifier: randomUUID(),
      expires_in: 60,
      request_uri: `urn:ietf:params:oauth:request_uri:${randomUUID()}`,
      state: randomUUID(),
    }));
  }
}

beforeAll(async () => {
  authServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" }).end("<p>login</p>");
  });
  await new Promise<void>((r) => authServer.listen(0, "127.0.0.1", () => r()));
  const address = authServer.address();
  if (!address || typeof address === "string") throw new Error("no address");
  authBase = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => authServer.close(() => r()));
});

describe("Configured browser authorization", () => {
  test("[CI_950]: native authorize step completes through the operator driver", async () => {
    const runtime = getRunnerRuntime();
    expect(runtime?.authorizationDriver?.modulePath).toBeTruthy();
    if (!runtime) return;
    const orchestrator = new WalletIssuanceOrchestratorFlow(
      IssuerTestConfiguration.createCustom({
        authorizeStepClass: AuthorizeDefaultStep,
        credentialConfigurationId: credentialId,
        credentialRequestStepClass: CredentialRequestDefaultStep,
        fetchMetadataStepClass: StubFetchMetadataStep,
        name: "ProductionBrowserFixture",
        nonceRequestStepClass: NonceRequestDefaultStep,
        notificationRequestStepClass: NotificationRequestDefaultStep,
        pushedAuthorizationRequestStepClass: StubParStep,
        tokenRequestStepClass: TokenRequestDefaultStep,
      }),
      createRunnerAuthorizationDriver(runtime, async () => {
        const puppeteer = await import("puppeteer");
        return puppeteer.default.launch({
          args: ["--no-sandbox"],
          headless: true,
        });
      }),
    );
    const ctx = await orchestrator.runThroughAuthorize();
    expect(ctx.authorizeResponse.success).toBe(true);
    expect(ctx.authorizeResponse.response?.authorizeResponse?.code).toBe(
      "code-from-production-driver",
    );
  }, 60_000);
});
