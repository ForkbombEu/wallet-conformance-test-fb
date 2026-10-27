import { z } from "zod";

import { engagementFactoryConfigSchema } from "@/logic/engagement-factory";

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
// Browser driver config (opaque for now; prompt 18 fills this in)
// ---------------------------------------------------------------------------

const browserDriverConfigSchema = z
  .object({
    type: z.string().min(1),
  })
  .strict();
export type BrowserDriverConfig = z.infer<typeof browserDriverConfigSchema>;

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

const profileSchema = z
  .object({
    allowedAuthorizationInteraction: z
      .array(authorizationInteractionSchema)
      .min(1),
    authorizationDriver: authorizationDriverConfigSchema.optional(),
    browserDriver: browserDriverConfigSchema.optional(),
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
    credential_offer_uri: safeString.optional(),
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

export function getProfile(id: string): Profile | undefined {
  return profileCatalogue.find((p) => p.id === id);
}

export function getSelection(
  profile: Profile,
  selectionId: string,
): SelectionEntry | undefined {
  return profile.selections.find((s) => s.id === selectionId);
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
