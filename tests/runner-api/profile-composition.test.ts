import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfigWithHierarchy } from "@/logic/config-loader";
import { runRequestSchema } from "@/runner-api/contract";
import { buildEffectiveConfig } from "@/runner-api/effective-config";
import { loadProfiles, resolveRun, startRunner } from "@/runner-api/main";
import { loadProfileCatalogue } from "@/runner-api/profiles";

const TOKEN = "l08-test-token";

function makeIni(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    "global.data_dir": "./data",
    "global.log_level": "INFO",
    "issuance.url": "https://issuer.example",
    "issuer.port": "3003",
    "logging.log_file": "./data/logs/test.log",
    "logging.log_format": "%(message)s",
    "logging.log_level": "INFO",
    "presentation.authorize_request_url": "https://rp.example/auth",
    "trust.ca_cert_path": "./data/trust",
    "trust.certificate_subject": "CN=test",
    "trust.federation_trust_anchors[]": "https://ta.example",
    "trust.federation_trust_anchors_jwks_path": "./data/trust",
    "trust_anchor.port": "3001",
    "wallet.backup_storage_path": "./data/backup",
    "wallet.credentials_storage_path": "./data/credentials",
    "wallet.port": "3002",
    "wallet.wallet_attestations_storage_path": "./data/attestation",
    "wallet.wallet_id": "test",
    "wallet.wallet_name": "Test",
    "wallet.wallet_version": "V1_0",
    ...overrides,
  };

  const sections: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(base)) {
    const dotIndex = key.indexOf(".");
    const section = key.slice(0, dotIndex);
    const field = key.slice(dotIndex + 1);
    (sections[section] ??= []).push(`${field} = ${value}`);
  }

  return Object.entries(sections)
    .map(([section, lines]) => `[${section}]\n${lines.join("\n")}`)
    .join("\n\n");
}

function makeProfilesJson(configDir: string): string {
  const profilesPath = join(configDir, "profiles.json");
  writeFileSync(
    profilesPath,
    JSON.stringify({
      profiles: [
        {
          allowedAuthorizationInteraction: ["auto"],
          category: "issuance",
          configFile: "config-a.ini",
          coverageMode: "interoperability",
          id: "profile-a",
          selections: [
            {
              id: "credimi-issuance-smoke",
              testFile: "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
            },
          ],
        },
        {
          allowedAuthorizationInteraction: ["auto"],
          category: "issuance",
          configFile: "config-b.ini",
          coverageMode: "interoperability",
          id: "profile-b",
          selections: [
            {
              id: "credimi-issuance-smoke",
              testFile: "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
            },
          ],
        },
      ],
    }),
  );
  return profilesPath;
}

let dir: string;
let savedToken: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-l08-"));
  savedToken = process.env.CREDIMI_RUNNER_TOKEN;
});

afterEach(() => {
  if (savedToken === undefined) {
    Reflect.deleteProperty(process.env, "CREDIMI_RUNNER_TOKEN");
  } else {
    process.env.CREDIMI_RUNNER_TOKEN = savedToken;
  }
  rmSync(dir, { force: true, recursive: true });
});

describe("L08 — loadProfiles resolves and validates", () => {
  it("loads profiles with resolved configFile paths", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    writeFileSync(
      join(dir, "config-b.ini"),
      makeIni({ "issuance.url": "https://b.example" }),
    );
    const profilesPath = makeProfilesJson(dir);

    const profiles = loadProfiles(profilesPath);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]?.id).toBe("profile-a");
    expect(profiles[1]?.id).toBe("profile-b");
    // configFile is resolved to absolute path
    expect(profiles[0]?.configFile).toContain("config-a.ini");
    expect(profiles[1]?.configFile).toContain("config-b.ini");
  });

  it("rejects duplicate profile IDs", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    const profilesPath = join(dir, "profiles.json");
    writeFileSync(
      profilesPath,
      JSON.stringify({
        profiles: [
          {
            allowedAuthorizationInteraction: ["auto"],
            category: "issuance",
            configFile: "config-a.ini",
            coverageMode: "interoperability",
            id: "dup",
            selections: [
              {
                id: "s1",
                testFile:
                  "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
              },
            ],
          },
          {
            allowedAuthorizationInteraction: ["auto"],
            category: "issuance",
            configFile: "config-a.ini",
            coverageMode: "interoperability",
            id: "dup",
            selections: [
              {
                id: "s1",
                testFile:
                  "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
              },
            ],
          },
        ],
      }),
    );
    expect(() => loadProfiles(profilesPath)).toThrow(/Duplicate profile id/);
  });

  it("rejects missing configFile", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    const profilesPath = join(dir, "profiles.json");
    writeFileSync(
      profilesPath,
      JSON.stringify({
        profiles: [
          {
            allowedAuthorizationInteraction: ["auto"],
            category: "issuance",
            configFile: "nonexistent.ini",
            coverageMode: "interoperability",
            id: "p1",
            selections: [
              {
                id: "s1",
                testFile:
                  "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
              },
            ],
          },
        ],
      }),
    );
    expect(() => loadProfiles(profilesPath)).toThrow(/config not found/);
  });

  it("rejects empty profiles", () => {
    const profilesPath = join(dir, "profiles.json");
    writeFileSync(profilesPath, JSON.stringify({ profiles: [] }));
    expect(() => loadProfiles(profilesPath)).toThrow(/no profiles/);
  });

  it("rejects profile with no selections", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    const profilesPath = join(dir, "profiles.json");
    writeFileSync(
      profilesPath,
      JSON.stringify({
        profiles: [
          {
            allowedAuthorizationInteraction: ["auto"],
            category: "issuance",
            configFile: "config-a.ini",
            coverageMode: "interoperability",
            id: "p1",
            selections: [],
          },
        ],
      }),
    );
    expect(() => loadProfiles(profilesPath)).toThrow(/selections/);
  });
});

describe("L08 — buildEffectiveConfig with real config", () => {
  it("empty overrides use real base config without TypeError", () => {
    writeFileSync(
      join(dir, "config-a.ini"),
      makeIni({ "issuance.url": "https://real-issuer.example" }),
    );
    writeFileSync(join(dir, "config-b.ini"), makeIni());
    const profilesPath = makeProfilesJson(dir);
    const profile = loadProfiles(profilesPath)[0];
    if (!profile) throw new Error("profile not loaded");

    const config = loadConfigWithHierarchy({
      fileIni: profile.configFile,
    });
    const effectiveConfig = buildEffectiveConfig(
      profile,
      "credimi-issuance-smoke",
      {},
      config,
      join(dir, "run"),
    );

    // No TypeError — this is the core L08 gate
    expect(effectiveConfig.target.issuerIdentifier).toBe(
      "https://real-issuer.example",
    );
    expect(effectiveConfig.profileId).toBe("profile-a");
  });

  it("custom INI values survive through effective config", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    writeFileSync(
      join(dir, "config-b.ini"),
      makeIni({ "issuance.url": "https://b-issuer.example" }),
    );
    const profilesPath = makeProfilesJson(dir);
    const profile = loadProfiles(profilesPath)[1];
    if (!profile) throw new Error("profile not loaded");

    const config = loadConfigWithHierarchy({
      fileIni: profile.configFile,
    });
    const effectiveConfig = buildEffectiveConfig(
      profile,
      "credimi-issuance-smoke",
      {},
      config,
      join(dir, "run"),
    );

    expect(effectiveConfig.target.issuerIdentifier).toBe(
      "https://b-issuer.example",
    );
    expect(effectiveConfig.profileId).toBe("profile-b");
  });

  it("relative paths resolve from profiles JSON directory", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    writeFileSync(join(dir, "config-b.ini"), makeIni());
    const profilesPath = makeProfilesJson(dir);
    const profiles = loadProfiles(profilesPath);
    expect(profiles[0]?.configFile).toBe(join(dir, "config-a.ini"));
  });
});

// ---------------------------------------------------------------------------
// L08 audit addendum — the SAME catalogue/resolver used by startRunner
// ---------------------------------------------------------------------------

function makeRunRequest(overrides: Record<string, unknown> = {}) {
  return runRequestSchema.parse({
    category: "issuance",
    contract_version: "1.0",
    profile_id: "profile-b",
    selection: { ids: ["credimi-issuance-smoke"] },
    target: { actor_name: "issuer-b", actor_type: "issuer" },
    ...overrides,
  });
}

async function postRun(
  url: string,
  body: Record<string, unknown>,
  key: string,
): Promise<{ body: { error?: { code: string } }; status: number }> {
  const res = await fetch(`${url}/v1/runs`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });
  return {
    body: (await res.json()) as { error?: { code: string } },
    status: res.status,
  };
}

function writeTwoProfiles(): string {
  writeFileSync(
    join(dir, "config-a.ini"),
    makeIni({ "issuance.url": "https://a-issuer.example" }),
  );
  writeFileSync(
    join(dir, "config-b.ini"),
    makeIni({
      "issuance.credential_types[]": "b_custom_credential",
      "issuance.url": "https://b-issuer.example",
    }),
  );
  return makeProfilesJson(dir);
}

describe("L08 audit — loadProfileCatalogue validates full JSON", () => {
  it("rejects unknown profile fields instead of casting", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    const profilesPath = join(dir, "profiles.json");
    writeFileSync(
      profilesPath,
      JSON.stringify({
        profiles: [
          {
            allowedAuthorizationInteraction: ["auto"],
            category: "issuance",
            configFile: "config-a.ini",
            coverageMode: "interoperability",
            id: "p1",
            selections: [
              {
                id: "credimi-issuance-smoke",
                testFile:
                  "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
              },
            ],
            surprise: true,
          },
        ],
      }),
    );
    expect(() => loadProfileCatalogue(profilesPath)).toThrow(/surprise/);
  });

  it("rejects a selection whose test file does not exist", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    const profilesPath = join(dir, "profiles.json");
    writeFileSync(
      profilesPath,
      JSON.stringify({
        profiles: [
          {
            allowedAuthorizationInteraction: ["auto"],
            category: "issuance",
            configFile: "config-a.ini",
            coverageMode: "interoperability",
            id: "p1",
            selections: [
              { id: "s1", testFile: "tests/nope/missing.issuance.spec.ts" },
            ],
          },
        ],
      }),
    );
    expect(() => loadProfileCatalogue(profilesPath)).toThrow(
      /test file not found/,
    );
  });

  it("resolves test files to absolute paths and keeps them valid from another cwd", () => {
    const profilesPath = writeTwoProfiles();
    const originalCwd = process.cwd();
    process.chdir(tmpdir());
    try {
      const catalogue = loadProfileCatalogue(profilesPath);
      const selection = catalogue.get("profile-b")?.selections[0];
      expect(selection?.testFile).toMatch(/^\//);
      expect(selection?.testFile).toContain(
        "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
      );
      expect(catalogue.get("profile-b")?.configFile).toBe(
        join(dir, "config-b.ini"),
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("L08 audit — resolveRun selects the requested profile", () => {
  it("empty parameters reach profile-b's typed effective config", () => {
    const catalogue = loadProfileCatalogue(writeTwoProfiles());
    const resolved = resolveRun(catalogue, makeRunRequest(), join(dir, "ws"));
    expect(resolved.profileId).toBe("profile-b");
    expect(resolved.profileConfigPath).toBe(join(dir, "config-b.ini"));
    expect(resolved.target.issuerIdentifier).toBe("https://b-issuer.example");
    expect(resolved.credentialConfigurationIds).toEqual([
      "b_custom_credential",
    ]);
  });

  it("rejects category mismatch, extra selections and unknown profile", () => {
    const catalogue = loadProfileCatalogue(writeTwoProfiles());
    expect(() =>
      resolveRun(
        catalogue,
        makeRunRequest({ category: "presentation" }),
        join(dir, "ws"),
      ),
    ).toThrow(/category/);
    expect(() =>
      resolveRun(
        catalogue,
        makeRunRequest({
          selection: { ids: ["credimi-issuance-smoke", "other"] },
        }),
        join(dir, "ws"),
      ),
    ).toThrow(/exactly one selection/);
    expect(() =>
      resolveRun(
        catalogue,
        makeRunRequest({ profile_id: "credimi-issuance-smoke" }),
        join(dir, "ws"),
      ),
    ).toThrow(/Unknown profile/);
  });

  it("rejects an advertised target issuer that differs from the effective issuer", () => {
    const catalogue = loadProfileCatalogue(writeTwoProfiles());
    expect(() =>
      resolveRun(
        catalogue,
        makeRunRequest({
          target: {
            actor_name: "issuer-a",
            actor_type: "issuer",
            issuer_identifier: "https://a-issuer.example",
          },
        }),
        join(dir, "ws"),
      ),
    ).toThrow(/does not match/);
  });

  it("does not leak TLS relaxation from an operator INI into the server process", () => {
    writeFileSync(
      join(dir, "config-a.ini"),
      makeIni({ "network.tls_reject_unauthorized": "false" }),
    );
    writeFileSync(join(dir, "config-b.ini"), makeIni());
    const catalogue = loadProfileCatalogue(makeProfilesJson(dir));
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    resolveRun(
      catalogue,
      makeRunRequest({ profile_id: "profile-a" }),
      join(dir, "ws"),
    );
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
  });
});

describe("L08 audit — startRunner HTTP surface uses the loaded catalogue", () => {
  it("capabilities and validation use operator profiles, not the default catalogue", async () => {
    process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
    const runner = await startRunner({
      port: 0,
      profiles: writeTwoProfiles(),
      runRoot: join(dir, "state"),
    });
    try {
      const caps = (await (
        await fetch(`${runner.url}/v1/capabilities`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).json()) as { profiles: { id: string }[] };
      expect(caps.profiles.map((p) => p.id)).toEqual([
        "profile-a",
        "profile-b",
      ]);
      expect(JSON.stringify(caps)).not.toContain(dir);

      const base = {
        category: "issuance",
        contract_version: "1.0",
        selection: { ids: ["credimi-issuance-smoke"] },
        target: { actor_name: "x", actor_type: "issuer" },
      };
      const unknown = await postRun(
        runner.url,
        { ...base, profile_id: "credimi-issuance-smoke" },
        "k1",
      );
      expect(unknown.status).toBe(400);
      const wrongCategory = await postRun(
        runner.url,
        { ...base, category: "presentation", profile_id: "profile-b" },
        "k2",
      );
      expect(wrongCategory.status).toBe(400);
      const extra = await postRun(
        runner.url,
        {
          ...base,
          profile_id: "profile-b",
          selection: { ids: ["credimi-issuance-smoke", "x"] },
        },
        "k3",
      );
      expect(extra.status).toBe(400);
    } finally {
      await runner.close();
    }
  });

  it("fails visibly on an invalid profiles file before listening", async () => {
    process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
    const profilesPath = join(dir, "profiles.json");
    writeFileSync(profilesPath, JSON.stringify({ profiles: [{ id: "x" }] }));
    await expect(
      startRunner({ port: 0, profiles: profilesPath, runRoot: dir }),
    ).rejects.toThrow();
  });
});
