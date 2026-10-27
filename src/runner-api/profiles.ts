import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { engagementFactoryConfigSchema } from "@/logic/engagement-factory";
import { resolveSelectionTestFile } from "@/logic/runtime-paths";

import type { RunRequest } from "./contract";

// ---------------------------------------------------------------------------
// Selection entries
// ---------------------------------------------------------------------------

const selectionEntrySchema = z.object({
  description: z.string().optional(),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "must be a safe lowercase identifier"),
  testFile: z.string().min(1),
});
export type SelectionEntry = z.infer<typeof selectionEntrySchema>;

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const authorizationInteractionSchema = z.enum([
  "auto",
  "browser_redirect",
  "credential_presentation",
]);
export type AuthorizationInteraction = z.infer<
  typeof authorizationInteractionSchema
>;

const authorizationDriverConfigSchema = z
  .object({
    modulePath: z.string().min(1),
    type: z.literal("puppeteer"),
  })
  .strict();
export type AuthorizationDriverConfig = z.infer<
  typeof authorizationDriverConfigSchema
>;

export const profileSchema = z
  .object({
    allowedAuthorizationInteraction: z
      .array(authorizationInteractionSchema)
      .min(1),
    authorizationDriver: authorizationDriverConfigSchema.optional(),
    category: z.enum(["issuance", "presentation"]),
    configFile: z.string().min(1),
    coverageMode: z.enum(["interoperability", "it_wallet_profile"]),
    engagementFactory: engagementFactoryConfigSchema.optional(),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "must be a safe lowercase identifier"),
    initializedAssets: z.array(z.string().min(1)).optional(),
    selections: z.array(selectionEntrySchema).min(1),
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;

// ---------------------------------------------------------------------------
// Typed run overrides — unknown properties fail
// ---------------------------------------------------------------------------

const NO_NEWLINE = /^[^\r\n]*$/;

const safeString = z
  .string()
  .min(1)
  .refine((v) => NO_NEWLINE.test(v), "must not contain newlines");

const runOverridesSchema = z
  .object({
    authorization_interaction: authorizationInteractionSchema.optional(),
    credential_configuration_ids: z
      .array(safeString)
      .min(1)
      .max(16)
      .refine(
        (arr) => new Set(arr).size === arr.length,
        "must contain unique values",
      )
      .optional(),
    // Same schemes the native loader accepts (src/types/config.ts).
    credential_offer_uri: safeString
      .refine(
        (v) =>
          /^(https:\/\/|haip-vci:\/\/|openid-credential-offer:\/\/)/.test(v),
        "must use https://, haip-vci:// or openid-credential-offer://",
      )
      .optional(),
    issuer_url: z
      .string()
      .url()
      .startsWith("https://", "issuer_url must be absolute HTTPS")
      .optional(),
  })
  .strict();
export type RunOverrides = z.infer<typeof runOverridesSchema>;

// ---------------------------------------------------------------------------
// Profile catalogue
// ---------------------------------------------------------------------------

export const profileCatalogue: readonly Profile[] = [
  profileSchema.parse({
    allowedAuthorizationInteraction: ["auto", "browser_redirect"],
    category: "issuance",
    configFile: "config.credimi.ini",
    coverageMode: "interoperability",
    id: "credimi-issuance-smoke",
    selections: [
      {
        description:
          "Credimi interoperability smoke — generic OID4VCI, not Italian conformance",
        id: "credimi-issuance-smoke",
        testFile: "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
      },
    ],
  }),
] as const;

// ---------------------------------------------------------------------------
// Lookups and validation
// ---------------------------------------------------------------------------

export interface ProfileCatalogue {
  get(id: string): Profile | undefined;
  readonly profiles: readonly Profile[];
}

export class ProfileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
  }
}

export function assertAuthorizationInteractionSupported(
  profile: Profile,
  interaction: AuthorizationInteraction,
): void {
  if (!profile.allowedAuthorizationInteraction.includes(interaction)) {
    throw new ProfileError(
      "UNSUPPORTED_AUTHORIZATION_INTERACTION",
      `Interaction '${interaction}' is not allowed by profile '${profile.id}'`,
    );
  }
}

export function assertBrowserDriverAvailable(
  profile: Profile,
  interaction: AuthorizationInteraction,
): void {
  if (interaction === "browser_redirect" && !profile.authorizationDriver) {
    throw new ProfileError(
      "UNSUPPORTED_AUTHORIZATION_INTERACTION",
      `Profile '${profile.id}' requires browser_redirect but no authorization driver is configured`,
    );
  }
}

export function assertSelectionMatchesCategory(
  profile: Profile,
  selectionId: string,
): SelectionEntry {
  const selection = getSelection(profile, selectionId);
  if (!selection) {
    throw new ProfileError(
      "UNKNOWN_SELECTION",
      `Selection '${selectionId}' is not defined in profile '${profile.id}'`,
    );
  }
  return selection;
}

// ---------------------------------------------------------------------------
// Operator-supplied catalogue (startup path)
// ---------------------------------------------------------------------------

export function getProfile(id: string): Profile | undefined {
  return profileCatalogue.find((p) => p.id === id);
}

const profilesFileSchema = z
  .object({
    profiles: z.array(profileSchema).min(1, "contains no profiles"),
  })
  .strict();

/**
 * Builds a catalogue from already validated profiles, rejecting duplicate IDs.
 */
export function createProfileCatalogue(
  profiles: readonly Profile[],
): ProfileCatalogue {
  const byId = new Map<string, Profile>();
  for (const profile of profiles) {
    if (byId.has(profile.id)) {
      throw new ProfileError(
        "INVALID_PROFILES",
        `Duplicate profile id: ${profile.id}`,
      );
    }
    byId.set(profile.id, profile);
  }
  return {
    get: (id) => byId.get(id),
    profiles: [...profiles],
  };
}

/**
 * Checks a request against the catalogue without loading any INI: known
 * profile, matching category, exactly one defined selection and valid typed
 * overrides.
 */
export function selectProfileForRequest(
  catalogue: ProfileCatalogue,
  request: Pick<
    RunRequest,
    "category" | "parameters" | "profile_id" | "selection"
  >,
): { overrides: RunOverrides; profile: Profile; selectionId: string } {
  const profile = catalogue.get(request.profile_id);
  if (!profile) {
    throw new ProfileError(
      "UNKNOWN_PROFILE",
      `Unknown profile '${request.profile_id}'`,
    );
  }
  if (profile.category !== request.category) {
    throw new ProfileError(
      "CATEGORY_MISMATCH",
      `Profile '${profile.id}' has category '${profile.category}', request asked for '${request.category}'`,
    );
  }
  const [selectionId, ...extra] = request.selection.ids;
  if (!selectionId || extra.length > 0) {
    throw new ProfileError(
      "UNSUPPORTED_SELECTION",
      "This runner executes exactly one selection per run",
    );
  }
  assertSelectionMatchesCategory(profile, selectionId);
  const overrides = validateRunOverrides(request.parameters ?? {});
  return { overrides, profile, selectionId };
}

/** The built-in catalogue, used only by explicit fallback callers. */
export const defaultProfileCatalogue: ProfileCatalogue =
  createProfileCatalogue(profileCatalogue);

export function getSelection(
  profile: Profile,
  selectionId: string,
): SelectionEntry | undefined {
  return profile.selections.find((s) => s.id === selectionId);
}

/**
 * Loads and validates the operator profiles JSON.
 *
 * Every profile is validated against the full schema (unknown fields fail).
 * Operator paths (configFile, authorizationDriver.modulePath,
 * initializedAssets) resolve against the profiles JSON directory; selection
 * test files resolve against the package's test distribution root. All
 * returned paths are absolute and must exist.
 */
export function loadProfileCatalogue(profilesPath: string): ProfileCatalogue {
  const absPath = resolve(profilesPath);
  if (!existsSync(absPath)) {
    throw new ProfileError(
      "INVALID_PROFILES",
      `Profiles file not found: ${absPath}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absPath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProfileError(
      "INVALID_PROFILES",
      `Profiles file is not valid JSON: ${message}`,
    );
  }

  const parsed = profilesFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ProfileError(
      "INVALID_PROFILES",
      `Invalid profiles file: ${issues}`,
    );
  }

  const baseDir = dirname(absPath);
  const resolved = parsed.data.profiles.map((profile) => {
    assertRunnerSupportsProfile(profile);
    return resolveProfilePaths(profile, baseDir);
  });
  return createProfileCatalogue(resolved);
}

export function validateRunOverrides(raw: unknown): RunOverrides {
  const result = runOverridesSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ProfileError("INVALID_OVERRIDE", `Invalid override: ${issues}`);
  }
  return result.data;
}

/**
 * The runner MVP executes issuance only. Presentation runs (and therefore an
 * engagementFactory) have no native runner path yet, so such profiles are
 * rejected at startup instead of being advertised.
 */
function assertRunnerSupportsProfile(profile: Profile): void {
  if (profile.category !== "issuance") {
    throw new ProfileError(
      "INVALID_PROFILES",
      `Profile '${profile.id}': category '${profile.category}' is not supported by this runner`,
    );
  }
  if (profile.engagementFactory) {
    throw new ProfileError(
      "INVALID_PROFILES",
      `Profile '${profile.id}': engagementFactory requires presentation runs, which this runner does not support`,
    );
  }
}

function requireExisting(path: string, what: string, profileId: string) {
  if (!existsSync(path)) {
    throw new ProfileError(
      "INVALID_PROFILES",
      `Profile '${profileId}' ${what} not found: ${path}`,
    );
  }
  return path;
}

function resolveProfilePaths(profile: Profile, baseDir: string): Profile {
  const fromBase = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  const categorySuffix = `.${profile.category}.spec.`;

  return {
    ...profile,
    authorizationDriver: profile.authorizationDriver && {
      ...profile.authorizationDriver,
      modulePath: requireExisting(
        fromBase(profile.authorizationDriver.modulePath),
        "authorization driver module",
        profile.id,
      ),
    },
    configFile: requireExisting(
      fromBase(profile.configFile),
      "config",
      profile.id,
    ),
    initializedAssets: profile.initializedAssets?.map((asset) =>
      requireExisting(fromBase(asset), "initialized asset", profile.id),
    ),
    selections: profile.selections.map((selection) => {
      if (!selection.testFile.includes(categorySuffix)) {
        throw new ProfileError(
          "INVALID_PROFILES",
          `Profile '${profile.id}' selection '${selection.id}' is not a ${profile.category} spec: ${selection.testFile}`,
        );
      }
      return {
        ...selection,
        testFile: requireExisting(
          resolveSelectionTestFile(selection.testFile),
          `selection '${selection.id}' test file`,
          profile.id,
        ),
      };
    }),
  };
}
