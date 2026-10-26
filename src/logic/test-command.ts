import { createRequire } from "node:module";
import { join } from "node:path";

import type { CliOptions } from "@/logic";

import { packageRoot } from "@/logic/runtime-paths";

const nodeRequire = createRequire(import.meta.url);
const experimentalWarningFlag = "--disable-warning=ExperimentalWarning";

export function applyEnvOption(
  env: NodeJS.ProcessEnv,
  key: string,
  value: boolean | number | string | undefined,
): void {
  if (value !== undefined) {
    env[key] = String(value);
  }
}

export function getNodeOptionsWithExperimentalWarningDisabled(
  nodeOptions: string | undefined,
): string {
  return [nodeOptions, experimentalWarningFlag].filter(Boolean).join(" ");
}

export function resolveVitestBin(): string {
  return nodeRequire.resolve("vitest/vitest.mjs");
}

export function resolveVitestConfigPath(
  category: "issuance" | "presentation",
): string {
  const configFile =
    category === "issuance"
      ? "vitest.issuance.config.js"
      : "vitest.presentation.config.js";
  return join(packageRoot, configFile);
}

/**
 * Builds the environment for a test subprocess from CLI options.
 */
export function setEnvFromOptions(options: CliOptions): NodeJS.ProcessEnv {
  const env = { ...process.env };

  env.NODE_OPTIONS = getNodeOptionsWithExperimentalWarningDisabled(
    env.NODE_OPTIONS,
  );

  if (options.fileIni) {
    env.CONFIG_FILE_INI = options.fileIni;
  }

  applyEnvOption(
    env,
    "CONFIG_CREDENTIAL_ISSUER_URI",
    options.credentialIssuerUri,
  );
  applyEnvOption(
    env,
    "CONFIG_CREDENTIAL_OFFER_URI",
    options.credentialOfferUri,
  );
  applyEnvOption(
    env,
    "CONFIG_PRESENTATION_AUTHORIZE_URI",
    options.presentationAuthorizeUri,
  );
  applyEnvOption(
    env,
    "CONFIG_PRESENTATION_AUTHORIZE_SCRIPT",
    options.presentationAuthorizeScript,
  );
  applyEnvOption(env, "CONFIG_CREDENTIAL_TYPES", options.credentialTypes);
  applyEnvOption(env, "CONFIG_ECOSYSTEM", options.ecosystem);
  applyEnvOption(
    env,
    "CONFIG_AUTHORIZATION_INTERACTION",
    options.authorizationInteraction,
  );
  applyEnvOption(
    env,
    "CONFIG_CLIENT_AUTHENTICATION",
    options.clientAuthentication,
  );
  applyEnvOption(env, "CONFIG_TIMEOUT", options.timeout);
  applyEnvOption(env, "CONFIG_MAX_RETRIES", options.maxRetries);
  applyEnvOption(env, "CONFIG_LOG_LEVEL", options.logLevel);
  applyEnvOption(env, "CONFIG_LOG_FILE", options.logFile);
  applyEnvOption(env, "CONFIG_PORT", options.port);
  applyEnvOption(env, "CONFIG_SAVE_CREDENTIAL", options.saveCredential);
  applyEnvOption(env, "CONFIG_ISSUANCE_TESTS_DIR", options.issuanceTestsDir);
  applyEnvOption(
    env,
    "CONFIG_ISSUANCE_CERTIFICATE_SUBJECT",
    options.issuanceCertificateSubject,
  );
  applyEnvOption(
    env,
    "CONFIG_PRESENTATION_TESTS_DIR",
    options.presentationTestsDir,
  );
  applyEnvOption(env, "CONFIG_STEPS_MAPPING", options.stepsMapping);
  applyEnvOption(env, "CONFIG_UNSAFE_TLS", options.unsafeTls);
  applyEnvOption(env, "TESTS", options.tests);
  applyEnvOption(env, "CONFIG_WALLET_VERSION", options.walletVersion);
  applyEnvOption(
    env,
    "CONFIG_REFRESH_TOKEN_REISSUANCE",
    options.refreshTokenReissuance,
  );
  applyEnvOption(
    env,
    "CONFIG_CREDENTIAL_CONFIGURATION_ID_REISSUANCE",
    options.credentialConfigurationIdReissuance,
  );
  applyEnvOption(
    env,
    "CONFIG_REFRESH_TOKEN_DEFERRED",
    options.refreshTokenDeferred,
  );
  applyEnvOption(env, "CONFIG_TRANSACTION_ID", options.transactionId);
  applyEnvOption(env, "CONFIG_TRUST_ANCHOR_VERIFY", options.trustAnchorVerify);

  return env;
}
