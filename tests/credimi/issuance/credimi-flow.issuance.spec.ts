import { defineIssuanceTest } from "#/config/test-metadata";
import { assertIssuanceFlowSuccess } from "#/helpers/flow-assertion-helpers";
import { describe, expect, test } from "vitest";

import { WalletIssuanceOrchestratorFlow } from "@/orchestrator";

/**
 * A deliberately small interoperability smoke test.
 *
 * It runs WCT's complete issuance orchestrator but does not apply the Italian
 * Wallet profile assertions from the official conformance suites. Once this
 * passes, run those suites separately to classify profile differences.
 */
const configurations = await defineIssuanceTest("CredimiIssuanceSmoke");

configurations.forEach((configuration) => {
  describe(`[${configuration.name}] Credimi issuance smoke`, () => {
    test("completes the authorization-code issuance flow", async () => {
      const orchestrator = new WalletIssuanceOrchestratorFlow(configuration);
      const result = await orchestrator.issuance();

      assertIssuanceFlowSuccess(result);
      expect(result.fetchMetadataResponse.success).toBe(true);
      expect(result.pushedAuthorizationRequestResponse.success).toBe(true);
      expect(result.authorizeResponse.success).toBe(true);
      expect(result.tokenResponse.success).toBe(true);
      expect(result.credentialResponse.success).toBe(true);
    }, 120_000);
  });
});
