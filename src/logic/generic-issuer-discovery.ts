import { z } from "zod";

import type { Config } from "@/types";

import { MetadataDiscoveryError } from "@/orchestrator/errors";

const issuerMetadataSchema = z
  .object({
    authorization_servers: z.array(z.string().url()).optional(),
    credential_configurations_supported: z.record(z.string(), z.unknown()),
    credential_endpoint: z.string().url(),
    credential_issuer: z.string().url(),
    nonce_endpoint: z.string().url().optional(),
  })
  .passthrough();

const authorizationServerMetadataSchema = z
  .object({
    authorization_endpoint: z.string().url().optional(),
    issuer: z.string().url(),
    pushed_authorization_request_endpoint: z.string().url().optional(),
    token_endpoint: z.string().url().optional(),
  })
  .passthrough();

export type GenericAuthorizationServerMetadata = z.infer<
  typeof authorizationServerMetadataSchema
>;
export type GenericIssuerMetadata = z.infer<typeof issuerMetadataSchema>;

export interface IssuerDiscoveryResult {
  authorizationServer: string;
  authorizationServerMetadata: GenericAuthorizationServerMetadata;
  credentialIssuer: string;
  credentialIssuerMetadata: GenericIssuerMetadata;
  discoveryMethod: "oid4vci_well_known";
  profile: "generic_oid4vci";
}

/** RFC 8414 / OpenID4VCI well-known construction retains an issuer path. */
export function buildWellKnownUrl(
  issuer: string,
  wellKnownName:
    | "oauth-authorization-server"
    | "openid-configuration"
    | "openid-credential-issuer",
): string {
  const url = new URL(issuer);
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  url.pathname = path
    ? `/.well-known/${wellKnownName}/${path}`
    : `/.well-known/${wellKnownName}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function discoverGenericIssuer(
  credentialIssuer: string,
  network: Config["network"],
): Promise<IssuerDiscoveryResult> {
  const metadataUrl = buildWellKnownUrl(
    credentialIssuer,
    "openid-credential-issuer",
  );
  const credentialIssuerMetadata = issuerMetadataSchema.parse(
    await fetchJson(metadataUrl, network),
  );
  if (credentialIssuerMetadata.credential_issuer !== credentialIssuer) {
    throw new MetadataDiscoveryError(
      metadataUrl,
      `credential_issuer '${credentialIssuerMetadata.credential_issuer}' does not match requested issuer '${credentialIssuer}'`,
    );
  }
  const authorizationServer =
    credentialIssuerMetadata.authorization_servers?.[0] ?? credentialIssuer;
  const oauthUrl = buildWellKnownUrl(
    authorizationServer,
    "oauth-authorization-server",
  );
  let rawAuthorizationMetadata: unknown;
  try {
    rawAuthorizationMetadata = await fetchJson(oauthUrl, network);
  } catch (error) {
    if (
      !(error instanceof MetadataDiscoveryError) ||
      !error.message.endsWith("HTTP 404")
    ) {
      throw error;
    }
    rawAuthorizationMetadata = await fetchJson(
      buildWellKnownUrl(authorizationServer, "openid-configuration"),
      network,
    );
  }
  const authorizationServerMetadata = authorizationServerMetadataSchema.parse(
    rawAuthorizationMetadata,
  );
  if (authorizationServerMetadata.issuer !== authorizationServer) {
    throw new MetadataDiscoveryError(
      authorizationServer,
      `authorization-server issuer '${authorizationServerMetadata.issuer}' does not match '${authorizationServer}'`,
    );
  }
  return {
    authorizationServer,
    authorizationServerMetadata,
    credentialIssuer,
    credentialIssuerMetadata,
    discoveryMethod: "oid4vci_well_known",
    profile: "generic_oid4vci",
  };
}

async function fetchJson(
  url: string,
  network: Config["network"],
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: network.user_agent
        ? { "User-Agent": network.user_agent }
        : undefined,
      signal: AbortSignal.timeout(network.timeout * 1000),
    });
  } catch (error) {
    throw new MetadataDiscoveryError(
      url,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) {
    throw new MetadataDiscoveryError(url, `HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new MetadataDiscoveryError(url, "response is not valid JSON");
  }
}
