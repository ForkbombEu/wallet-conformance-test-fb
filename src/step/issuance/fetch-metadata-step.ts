import { fetchMetadata } from "@pagopa/io-wallet-oid4vci";

import { discoverGenericIssuer } from "@/logic/generic-issuer-discovery";
import { fetchWithConfig } from "@/logic/utils";
import { recordSessionEntityNameFromEntityConfiguration } from "@/report/session-runtime";

import { StepFlow, StepResponse } from "../step-flow";

export interface FetchMetadataExecuteResponse {
  discoveredVia?: "federation" | "oid4vci";
  // Entity statement metadata is version-dependent and consumed structurally by orchestrators/tests.
  entityStatementClaims?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  issuerDiscovery?: import("@/logic/generic-issuer-discovery").IssuerDiscoveryResult;
  status: number;
}

export interface FetchMetadataOptions {
  baseUrl: string;
}

export type FetchMetadataStepResponse = StepResponse & {
  response?: FetchMetadataExecuteResponse;
};

/**
 * Flow step to fetch issuer or verifier metadata from the well-known endpoint.
 * It retrieves the entity statement JWT and its claims.
 * Base URI is taken from the configuration.
 *
 * If HTTP response is executed successfully, the response field contains:
 * - status: HTTP status code of the response.
 * - discoveredVia: The discovery method used (e.g. "federation" or "oid4vci").
 *
 * If the entity statement claims are successfully parsed, the response field also contains:
 * - entityStatementClaims: The parsed claims from the entity statement JWT.
 */
export class FetchMetadataDefaultStep extends StepFlow {
  static readonly tag = "FETCH_METADATA";

  async run(options: FetchMetadataOptions): Promise<FetchMetadataStepResponse> {
    const log = this.log;

    log.info("Discovering metadata...");

    return this.execute<FetchMetadataExecuteResponse>(async () => {
      if (this.config.profile.ecosystem === "generic_oid4vci") {
        const issuerDiscovery = await discoverGenericIssuer(
          options.baseUrl,
          this.config.network,
        );
        log.info(
          `Generic OID4VCI discovery completed via ${issuerDiscovery.discoveryMethod}`,
        );
        return { issuerDiscovery, status: 200 };
      }
      const result = await fetchMetadata({
        callbacks: {
          fetch: fetchWithConfig(this.config.network),
        },
        config: this.ioWalletSdkConfig,
        credentialIssuerUrl: options.baseUrl,
      });

      log.debug(
        "Metadata fetched successfully:",
        JSON.stringify(result, null, 2),
      );

      recordSessionEntityNameFromEntityConfiguration(
        "issuance",
        result.openid_federation_claims,
      );

      return {
        discoveredVia: result.discoveredVia,
        entityStatementClaims: result.openid_federation_claims,
        status: 200,
      };
    });
  }

  tag(): string {
    return FetchMetadataDefaultStep.tag;
  }
}
