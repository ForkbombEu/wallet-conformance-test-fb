import { parse, stringify } from "ini";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { packageRoot } from "@/logic/runtime-paths";
import { ArtifactStore } from "@/runner-api/artifacts";
import { type RunnerResult, runnerResultSchema } from "@/runner-api/contract";
import { publishRunEvidence, startRunner } from "@/runner-api/main";

const TOKEN = "l13-token";
const FIXTURE_SPEC = resolve(
  import.meta.dirname,
  "fixtures/native-discovery/diagnostic.issuance.spec.ts",
);
const CHILD_TIMEOUT = 120_000;
const auth = { authorization: `Bearer ${TOKEN}` };

let dir: string;
let profilesPath: string;
let stateRoot: string;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  await new Promise<void>((r) => server.close(() => r()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function runToTerminal(
  url: string,
  key: string,
  credentialIds: string[],
): Promise<RunnerResult> {
  const post = await fetch(`${url}/v1/runs`, {
    body: JSON.stringify({
      category: "issuance",
      contract_version: "1.0",
      parameters: { credential_configuration_ids: credentialIds },
      profile_id: "fixture",
      selection: { ids: ["diagnostic"] },
      target: { actor_name: "fixture", actor_type: "issuer" },
    }),
    headers: {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });
  expect(post.status).toBe(202);
  const { run_id: runId } = (await post.json()) as { run_id: string };
  for (let i = 0; i < 1_000; i++) {
    const snap = (await (
      await fetch(`${url}/v1/runs/${runId}`, { headers: auth })
    ).json()) as { status: string };
    if (["cancelled", "completed", "error", "timed_out"].includes(snap.status))
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const res = await fetch(`${url}/v1/runs/${runId}/result`, { headers: auth });
  expect(res.status).toBe(200);
  return (await res.json()) as RunnerResult;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

beforeEach(async () => {
  process.env.CREDIMI_RUNNER_TOKEN = TOKEN;
  dir = mkdtempSync(join(tmpdir(), "wct-l13-"));
  stateRoot = join(dir, "state");
  const ini = parse(
    readFileSync(join(packageRoot, "config.example.ini"), "utf-8"),
  ) as Record<string, Record<string, unknown>>;
  const section = (name: string) => (ini[name] ??= {});
  section("profile").ecosystem = "generic_oid4vci";
  section("issuance").url = "https://issuer.example";
  section("trust_anchor").port = await freePort();
  delete section("trust_anchor").tls_cert_dir;
  section("wallet").port = await freePort();
  section("issuer").port = await freePort();
  section("network").bind_address = "127.0.0.1";
  writeFileSync(join(dir, "operator.ini"), stringify(ini));
  profilesPath = join(dir, "profiles.json");
  writeFileSync(
    profilesPath,
    JSON.stringify({
      profiles: [
        {
          allowedAuthorizationInteraction: ["auto"],
          category: "issuance",
          configFile: "operator.ini",
          coverageMode: "interoperability",
          id: "fixture",
          selections: [{ id: "diagnostic", testFile: FIXTURE_SPEC }],
        },
      ],
    }),
  );
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("L13 — production manifest from real worker output", () => {
  it(
    "every download_url resolves to the exact bytes, survives restart, and is run-bound",
    async () => {
      let runner = await startRunner({
        port: 0,
        profiles: profilesPath,
        runRoot: stateRoot,
      });
      let result: RunnerResult;
      let downloads: Buffer[];
      try {
        result = await runToTerminal(runner.url, "k1", [
          "fixture_force_failure",
        ]);
        // Full wire validation, including adapter raw / assertion_id.
        runnerResultSchema.parse(result);
        expect(result.execution.status).toBe("completed");
        expect(result.summary.result).toBe("fail");
        expect(result.native.assertions[0]?.raw).toBeTruthy();
        expect(result.artifacts.length).toBeGreaterThan(0);
        expect(JSON.stringify(result)).not.toContain(stateRoot);

        downloads = [];
        for (const entry of result.artifacts) {
          const res = await fetch(`${runner.url}${entry.download_url}`, {
            headers: auth,
          });
          expect(res.status).toBe(200);
          const bytes = Buffer.from(await res.arrayBuffer());
          expect(sha256(bytes)).toBe(entry.sha256);
          expect(bytes.length).toBe(entry.size_bytes);
          downloads.push(bytes);
        }
        // The raw native export bytes are preserved unmodified.
        const raw = readFileSync(
          join(
            stateRoot,
            "work",
            result.run_id,
            "results",
            "native-results.json",
          ),
        );
        expect(downloads[0]?.equals(raw)).toBe(true);

        // Wrong run / wrong ID
        const entry = result.artifacts[0];
        if (!entry) throw new Error("no artifact");
        expect(
          (
            await fetch(
              `${runner.url}/v1/runs/other-run/artifacts/${entry.artifact_id}`,
              { headers: auth },
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await fetch(
              `${runner.url}/v1/runs/${result.run_id}/artifacts/nope.json`,
              { headers: auth },
            )
          ).status,
        ).toBe(404);
      } finally {
        await runner.close();
      }

      // Restart the real server on the same root.
      runner = await startRunner({
        port: 0,
        profiles: profilesPath,
        runRoot: stateRoot,
      });
      try {
        const again = (await (
          await fetch(`${runner.url}/v1/runs/${result.run_id}/result`, {
            headers: auth,
          })
        ).json()) as RunnerResult;
        expect(again.artifacts).toEqual(result.artifacts);
        for (const [i, entry] of again.artifacts.entries()) {
          const res = await fetch(`${runner.url}${entry.download_url}`, {
            headers: auth,
          });
          expect(Buffer.from(await res.arrayBuffer())).toEqual(downloads[i]);
        }

        // A corrupted stored artifact is never served as valid evidence.
        const filesDir = join(stateRoot, "artifacts", result.run_id, "files");
        for (const f of readdirSync(filesDir)) {
          writeFileSync(join(filesDir, f), "tampered");
        }
        const first = again.artifacts[0];
        if (!first) throw new Error("no artifact");
        const corrupt = await fetch(`${runner.url}${first.download_url}`, {
          headers: auth,
        });
        expect(corrupt.status).toBe(500);
        expect(
          ((await corrupt.json()) as { error: { code: string } }).error.code,
        ).toBe("ARTIFACT_CORRUPT");
      } finally {
        await runner.close();
      }
    },
    CHILD_TIMEOUT,
  );
});

describe("L13 — publishRunEvidence", () => {
  it("a missing declared artifact becomes a limitation, never an empty-hash entry", () => {
    const artifacts = new ArtifactStore(join(dir, "state"));
    const base = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "fixtures/contract/wct-interop-fail.json"),
        "utf-8",
      ),
    ) as RunnerResult;
    const passing: RunnerResult = {
      ...base,
      execution: { ...base.execution, exit_code: 0 },
      native: {
        ...base.native,
        assertions: base.native.assertions.map((a) => ({
          ...a,
          native_status: "PASS" as const,
        })),
      },
      summary: {
        ...base.summary,
        native_failed_assertion_count: 0,
        result: "pass",
      },
    };
    const published = publishRunEvidence(artifacts, "run-x", {
      privateArtifactPaths: [join(dir, "does-not-exist.json")],
      result: passing,
    });
    expect(published.result.artifacts).toEqual([]);
    expect(published.result.summary.result).not.toBe("pass");
    expect(published.result.limitations.join(" ")).toMatch(/does-not-exist/);
    expect(JSON.stringify(published.result)).not.toContain(dir);
    runnerResultSchema.parse(published.result);
  });
});

describe("L13 — shared contract fixtures", () => {
  it.each([
    "wct-interop-fail.json",
    "itwct-inconclusive.json",
    "itwct-assertion-fail.json",
  ])("%s parses with the legacy wire schema", (name) => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "fixtures/contract", name),
        "utf-8",
      ),
    ) as unknown;
    expect(runnerResultSchema.safeParse(fixture).success).toBe(true);
  });
});
