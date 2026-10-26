import type { Config } from "@/types";

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
  category: Profile["category"];
  coverageMode: Profile["coverageMode"];
  overrides: RunOverrides;
  profileId: string;
  selectionId: string;
  target: {
    issuerIdentifier: string;
  };
  testFile: string;
  writablePaths: {
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

  return {
    category: profile.category,
    coverageMode: profile.coverageMode,
    overrides,
    profileId: profile.id,
    selectionId,
    target: {
      issuerIdentifier,
    },
    testFile: selection.testFile,
    writablePaths: {
      backup: `${ws}/data/backup`,
      credentials: `${ws}/data/credentials`,
      db: `${ws}/data/wct.db`,
      logs: `${ws}/data/logs`,
    },
  };
}
