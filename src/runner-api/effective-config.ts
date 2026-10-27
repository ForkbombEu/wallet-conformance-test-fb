import type { Config } from "@/types";

import { loadConfigWithHierarchy } from "@/logic/config-loader";
import { resolveWorkspacePath } from "@/logic/runtime-paths";

import {
  assertAuthorizationInteractionSupported,
  assertBrowserDriverAvailable,
  assertSelectionMatchesCategory,
  type AuthorizationInteraction,
  type Profile,
  ProfileError,
  type RunOverrides,
} from "./profiles";

// ---------------------------------------------------------------------------
// Effective config
// ---------------------------------------------------------------------------

export interface EffectiveConfig {
  authorizationInteraction: AuthorizationInteraction;
  category: Profile["category"];
  coverageMode: Profile["coverageMode"];
  /** issuance.credential_types after applying credential_configuration_ids. */
  credentialConfigurationIds: string[];
  /** Absolute operator asset paths seeded into per-run backup storage. */
  initializedAssets: string[];
  overrides: RunOverrides;
  profileConfigPath: string;
  profileId: string;
  selectionId: string;
  target: {
    issuerIdentifier: string;
  };
  testFile: string;
  writablePaths: {
    attestation: string;
    backup: string;
    credentials: string;
    db: string;
    logs: string;
  };
}

export function buildEffectiveConfig(
  profile: Profile,
  selectionId: string,
  overrides: RunOverrides,
  baseConfig: Config,
  workspaceDir: string,
): EffectiveConfig {
  // Validate selection exists and category matches
  const selection = assertSelectionMatchesCategory(profile, selectionId);
  if (profile.category !== "issuance" && profile.category !== "presentation") {
    throw new ProfileError(
      "CATEGORY_MISMATCH",
      `Profile '${profile.id}' has unsupported category '${profile.category}'`,
    );
  }

  // Validate authorization interaction
  const effectiveInteraction: AuthorizationInteraction =
    overrides.authorization_interaction ??
    baseConfig.issuance.authorization_interaction;

  assertAuthorizationInteractionSupported(profile, effectiveInteraction);
  assertBrowserDriverAvailable(profile, effectiveInteraction);

  // Resolve effective issuer identifier
  const issuerIdentifier = overrides.issuer_url ?? baseConfig.issuance.url;

  if (!issuerIdentifier) {
    throw new ProfileError(
      "MISSING_ISSUER_IDENTIFIER",
      "No issuer identifier is configured (issuer_url override or config issuance.url)",
    );
  }

  // Verify effective issuer matches override if one was provided
  if (overrides.issuer_url && issuerIdentifier !== overrides.issuer_url) {
    throw new ProfileError(
      "ISSUER_IDENTITY_MISMATCH",
      `Effective issuer '${issuerIdentifier}' does not match override '${overrides.issuer_url}'`,
    );
  }

  // Fresh per-run writable paths under the workspace
  const ws = resolveWorkspacePath(workspaceDir);

  const credentialConfigurationIds =
    overrides.credential_configuration_ids ??
    baseConfig.issuance.credential_types;

  return {
    authorizationInteraction: effectiveInteraction,
    category: profile.category,
    coverageMode: profile.coverageMode,
    credentialConfigurationIds,
    initializedAssets: profile.initializedAssets ?? [],
    overrides,
    profileConfigPath: profile.configFile,
    profileId: profile.id,
    selectionId,
    target: {
      issuerIdentifier,
    },
    testFile: selection.testFile,
    writablePaths: {
      attestation: `${ws}/data/attestation`,
      backup: `${ws}/data/backup`,
      credentials: `${ws}/data/credentials`,
      db: `${ws}/data/wct.db`,
      logs: `${ws}/data/logs`,
    },
  };
}

/**
 * Loads an operator INI through the native hierarchical loader without
 * leaking its process-wide side effects into the long-lived runner process.
 *
 * The native loader sets NODE_TLS_REJECT_UNAUTHORIZED=0 when the INI disables
 * TLS verification; that relaxation belongs to the native child only.
 */
export function loadOperatorConfig(configFile: string): Config {
  const tlsBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    return loadConfigWithHierarchy({ fileIni: configFile });
  } finally {
    if (tlsBefore === undefined) {
      Reflect.deleteProperty(process.env, "NODE_TLS_REJECT_UNAUTHORIZED");
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsBefore;
    }
  }
}
