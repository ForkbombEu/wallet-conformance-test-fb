import { describe, expect, it } from "vitest";

import {
  assertAuthorizationInteractionSupported,
  assertBrowserDriverAvailable,
  assertSelectionMatchesCategory,
  getProfile,
  getSelection,
  type Profile,
  profileCatalogue,
  ProfileError,
  validateRunOverrides,
} from "@/runner-api/profiles";

function requireProfile(id: string): Profile {
  const p = getProfile(id);
  if (!p) {
    throw new Error(`Profile '${id}' not found`);
  }
  return p;
}

describe("profileCatalogue", () => {
  it("contains credimi-issuance-smoke with interoperability coverage", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    expect(profile).toBeDefined();
    expect(profile?.coverageMode).toBe("interoperability");
    expect(profile?.category).toBe("issuance");
    expect(profile?.selections).toHaveLength(1);
    expect(profile?.selections[0]?.id).toBe("credimi-issuance-smoke");
    expect(profile?.selections[0]?.testFile).toBe(
      "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
    );
  });

  it("uses safe lowercase IDs", () => {
    for (const p of profileCatalogue) {
      expect(p.id).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
      for (const s of p.selections) {
        expect(s.id).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
      }
    }
  });

  it("never relabels generic smoke as Italian conformance", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    expect(profile?.coverageMode).toBe("interoperability");
    expect(profile?.coverageMode).not.toBe("it_wallet_profile");
  });

  it("does not return a profile for unknown IDs", () => {
    expect(getProfile("nonexistent")).toBeUndefined();
  });
});

describe("getSelection", () => {
  it("finds a known selection", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    const sel = getSelection(profile, "credimi-issuance-smoke");
    expect(sel).toBeDefined();
  });

  it("returns undefined for unknown selection", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    expect(getSelection(profile, "unknown-sel")).toBeUndefined();
  });
});

describe("validateRunOverrides", () => {
  it("accepts empty overrides", () => {
    expect(validateRunOverrides({})).toEqual({});
  });

  it("accepts valid issuer_url with HTTPS", () => {
    const r = validateRunOverrides({
      issuer_url: "https://issuer.example.com",
    });
    expect(r.issuer_url).toBe("https://issuer.example.com");
  });

  it("rejects HTTP issuer_url", () => {
    expect(() =>
      validateRunOverrides({ issuer_url: "http://issuer.example.com" }),
    ).toThrow(ProfileError);
  });

  it("rejects unknown properties", () => {
    expect(() => validateRunOverrides({ evil_path: "/etc/passwd" })).toThrow(
      ProfileError,
    );
  });

  it("rejects issuer_url with newlines", () => {
    expect(() =>
      validateRunOverrides({
        issuer_url: "https://issuer.example.com\n[extra_section]",
      }),
    ).toThrow(ProfileError);
  });

  it("rejects credential_offer_uri with newlines", () => {
    expect(() =>
      validateRunOverrides({
        credential_offer_uri: "openid-credential-offer://x\n[injected]",
      }),
    ).toThrow(ProfileError);
  });

  it("rejects credential_configuration_ids with newlines", () => {
    expect(() =>
      validateRunOverrides({
        credential_configuration_ids: ["valid\ninjected=1"],
      }),
    ).toThrow(ProfileError);
  });

  it("accepts credential_configuration_ids with 1 to 16 entries", () => {
    const one = validateRunOverrides({
      credential_configuration_ids: ["cfg-1"],
    });
    expect(one.credential_configuration_ids).toHaveLength(1);

    const sixteen = validateRunOverrides({
      credential_configuration_ids: Array.from(
        { length: 16 },
        (_, i) => `cfg-${i}`,
      ),
    });
    expect(sixteen.credential_configuration_ids).toHaveLength(16);
  });

  it("rejects credential_configuration_ids with 0 entries", () => {
    expect(() =>
      validateRunOverrides({ credential_configuration_ids: [] }),
    ).toThrow(ProfileError);
  });

  it("rejects credential_configuration_ids with more than 16 entries", () => {
    expect(() =>
      validateRunOverrides({
        credential_configuration_ids: Array.from(
          { length: 17 },
          (_, i) => `cfg-${i}`,
        ),
      }),
    ).toThrow(ProfileError);
  });

  it("rejects duplicate credential_configuration_ids", () => {
    expect(() =>
      validateRunOverrides({
        credential_configuration_ids: ["dup", "dup"],
      }),
    ).toThrow(ProfileError);
  });

  it("rejects empty string in credential_configuration_ids", () => {
    expect(() =>
      validateRunOverrides({ credential_configuration_ids: [""] }),
    ).toThrow(ProfileError);
  });

  it("accepts valid authorization_interaction", () => {
    const r = validateRunOverrides({
      authorization_interaction: "browser_redirect",
    });
    expect(r.authorization_interaction).toBe("browser_redirect");
  });

  it("rejects invalid authorization_interaction", () => {
    expect(() =>
      validateRunOverrides({ authorization_interaction: "evil_mode" }),
    ).toThrow(ProfileError);
  });
});

describe("assertSelectionMatchesCategory", () => {
  it("returns the selection for a valid ID", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    const sel = assertSelectionMatchesCategory(
      profile,
      "credimi-issuance-smoke",
    );
    expect(sel.id).toBe("credimi-issuance-smoke");
  });

  it("throws for unknown selection ID", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    expect(() => assertSelectionMatchesCategory(profile, "bogus")).toThrow(
      ProfileError,
    );
  });
});

describe("assertAuthorizationInteractionSupported", () => {
  it("allows auto for credimi-issuance-smoke", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    expect(() =>
      assertAuthorizationInteractionSupported(profile, "auto"),
    ).not.toThrow();
  });

  it("allows browser_redirect for credimi-issuance-smoke", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    expect(() =>
      assertAuthorizationInteractionSupported(profile, "browser_redirect"),
    ).not.toThrow();
  });

  it("rejects credential_presentation for credimi-issuance-smoke", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    expect(() =>
      assertAuthorizationInteractionSupported(
        profile,
        "credential_presentation",
      ),
    ).toThrow(ProfileError);
  });
});

describe("assertBrowserDriverAvailable", () => {
  it("does not require driver for auto interaction", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    expect(() => assertBrowserDriverAvailable(profile, "auto")).not.toThrow();
  });

  it("rejects browser_redirect when no driver is configured", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    expect(profile?.browserDriver).toBeUndefined();
    expect(() =>
      assertBrowserDriverAvailable(profile, "browser_redirect"),
    ).toThrow(ProfileError);
  });

  it("allows browser_redirect when driver is configured", () => {
    const profile = requireProfile("credimi-issuance-smoke");
    const withDriver = { ...profile, browserDriver: { type: "test" } };
    expect(() =>
      assertBrowserDriverAvailable(withDriver, "browser_redirect"),
    ).not.toThrow();
  });
});

describe("coverage modes remain distinct", () => {
  it("interoperability and it_wallet_profile are different values", () => {
    const p = requireProfile("credimi-issuance-smoke");
    expect(p.coverageMode).toBe("interoperability");
    // A hypothetical Italian profile would use it_wallet_profile
    const italianProfile = {
      ...p,
      coverageMode: "it_wallet_profile" as const,
    };
    expect(italianProfile.coverageMode).not.toBe(p.coverageMode);
  });
});
