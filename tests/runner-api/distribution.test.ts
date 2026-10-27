import { parse, stringify } from "ini";
import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { packageRoot } from "@/logic/runtime-paths";

/**
 * Builds and packs the repository, installs the tarball into a clean
 * node_modules layout WITHOUT any source tests/ directory, and drives the
 * emitted runner exactly as an operator would.
 */

const TOKEN = "l14-token";
const PACKAGE_NAME = "@pagopa/it-wallet-conformance-tool";
const SLOW = 240_000;
const auth = { authorization: `Bearer ${TOKEN}` };

let work: string;
let pkg: string;
let operatorDir: string;
let profilesPath: string;

interface Launched {
  child: ChildProcessWithoutNullStreams;
  exit: Promise<null | number>;
  output: () => string;
  url: string;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  await new Promise<void>((r) => server.close(() => r()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function launch(args: string[], stateDir: string): Promise<Launched> {
  const child = spawn(
    process.execPath,
    [
      join(pkg, "dist/runner-api/main.js"),
      "--profiles",
      profilesPath,
      "--state-dir",
      stateDir,
      ...args,
    ],
    {
      // Launch from an unrelated directory: nothing may depend on cwd.
      cwd: mkdtempSync(join(work, "cwd-")),
      env: { ...process.env, CREDIMI_RUNNER_TOKEN: TOKEN },
    },
  );
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (output += d.toString()));
  const exit = new Promise<null | number>((r) => child.once("exit", r));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 30_000);
    const check = () => {
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", check);
    void exit.then(() => {
      clearTimeout(timer);
      reject(new Error(`runner exited early: ${output}`));
    });
  });
  return { child, exit, output: () => output, url };
}

async function waitTerminal(url: string, runId: string): Promise<void> {
  for (let i = 0; i < 1_200; i++) {
    const snap = (await (
      await fetch(`${url}/v1/runs/${runId}`, { headers: auth })
    ).json()) as { status: string };
    if (["cancelled", "completed", "error", "timed_out"].includes(snap.status))
      return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("run did not finish");
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "wct-l14-"));
  execFileSync("pnpm", ["build"], { cwd: packageRoot, stdio: "pipe" });
  execFileSync("pnpm", ["pack", "--pack-destination", work], {
    cwd: packageRoot,
    stdio: "pipe",
  });
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack produced no tarball");

  // Clean install layout: <work>/install/node_modules/<package>
  const modules = join(work, "install", "node_modules");
  mkdirSync(join(modules, "@pagopa"), { recursive: true });
  execFileSync("tar", ["-xzf", join(work, tarball), "-C", work]);
  pkg = join(modules, PACKAGE_NAME);
  renameSync(join(work, "package"), pkg);
  const manifest = JSON.parse(
    readFileSync(join(pkg, "package.json"), "utf-8"),
  ) as { dependencies: Record<string, string> };
  for (const dep of Object.keys(manifest.dependencies)) {
    const target = join(modules, dep);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(join(packageRoot, "node_modules", dep)), target);
  }

  // Operator configuration outside the package.
  operatorDir = join(work, "operator");
  mkdirSync(operatorDir);
  const ini = parse(
    readFileSync(join(pkg, "config.example.ini"), "utf-8"),
  ) as Record<string, Record<string, unknown>>;
  const section = (name: string) => (ini[name] ??= {});
  section("profile").ecosystem = "generic_oid4vci";
  // A local closed port: the smoke fails fast without contacting anyone.
  section("issuance").url = `https://127.0.0.1:${await freePort()}`;
  section("issuance").credential_types = ["generic_pid"];
  section("network").bind_address = "127.0.0.1";
  section("network").timeout = 2;
  section("network").max_retries = 1;
  section("trust_anchor").port = await freePort();
  delete section("trust_anchor").tls_cert_dir;
  section("wallet").port = await freePort();
  section("issuer").port = await freePort();
  writeFileSync(join(operatorDir, "operator.ini"), stringify(ini));
  profilesPath = join(operatorDir, "profiles.json");
  writeFileSync(
    profilesPath,
    JSON.stringify({
      profiles: [
        {
          allowedAuthorizationInteraction: ["auto"],
          category: "issuance",
          configFile: "operator.ini",
          coverageMode: "interoperability",
          id: "generic-smoke",
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
}, SLOW);

afterAll(() => {
  rmSync(work, { force: true, recursive: true });
});

describe("L14 — shipped runner in a clean install", () => {
  it("the package contains the runner, smoke spec and configs but no source tests or state", () => {
    expect(existsSync(join(pkg, "dist/runner-api/main.js"))).toBe(true);
    expect(
      existsSync(
        join(pkg, "dist/tests/credimi/issuance/credimi-flow.issuance.spec.js"),
      ),
    ).toBe(true);
    expect(existsSync(join(pkg, "vitest.issuance.config.js"))).toBe(true);
    expect(existsSync(join(pkg, "bin/wct-runner"))).toBe(true);
    expect(existsSync(join(pkg, "tests"))).toBe(false);
    expect(existsSync(join(pkg, "src"))).toBe(false);
    expect(existsSync(join(pkg, "data"))).toBe(false);
    expect(existsSync(join(pkg, "config.ini"))).toBe(false);
  });

  it(
    "serves health/capabilities on the real port, runs the built smoke, survives SIGTERM and restart",
    async () => {
      const state = join(work, "state");
      let runner = await launch(["--port", "0"], state);
      let runId: string;
      try {
        expect(runner.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(runner.url.endsWith(":0")).toBe(false);
        expect((await fetch(`${runner.url}/healthz`)).status).toBe(200);
        const caps = (await (
          await fetch(`${runner.url}/v1/capabilities`, { headers: auth })
        ).json()) as {
          categories: string[];
          engine: { revision: string; version: string };
          profiles: { id: string }[];
        };
        expect(caps.profiles.map((p) => p.id)).toEqual(["generic-smoke"]);
        expect(caps.categories).toEqual(["issuance"]);
        expect(caps.engine.version).toBe("1.2.1");
        expect(caps.engine.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(JSON.stringify(caps)).not.toContain(operatorDir);

        const post = await fetch(`${runner.url}/v1/runs`, {
          body: JSON.stringify({
            category: "issuance",
            contract_version: "1.0",
            profile_id: "generic-smoke",
            selection: { ids: ["credimi-issuance-smoke"] },
            target: { actor_name: "closed-port", actor_type: "issuer" },
          }),
          headers: {
            ...auth,
            "content-type": "application/json",
            "idempotency-key": "dist-1",
          },
          method: "POST",
        });
        expect(post.status).toBe(202);
        runId = ((await post.json()) as { run_id: string }).run_id;
        await waitTerminal(runner.url, runId);
        const result = (await (
          await fetch(`${runner.url}/v1/runs/${runId}/result`, {
            headers: auth,
          })
        ).json()) as {
          engine: { revision: string };
          execution: { status: string };
          native: { assertions: { file: string; native_status: string }[] };
          summary: { result: string };
        };
        // The emitted smoke was discovered and executed from dist/.
        expect(result.execution.status).toBe("completed");
        expect(result.native.assertions.length).toBeGreaterThan(0);
        expect(result.native.assertions[0]?.file).toContain(
          "dist/tests/credimi/issuance/credimi-flow.issuance.spec.js",
        );
        expect(result.summary.result).toBe("fail");
        expect(result.engine.revision).toBe(caps.engine.revision);
      } finally {
        runner.child.kill("SIGTERM");
      }
      await expect(runner.exit).resolves.toBe(0);
      expect(existsSync(join(state, ".owner.lock"))).toBe(false);

      // Restart on the same root: the previous result is still served.
      runner = await launch(["--port", "0"], state);
      try {
        const res = await fetch(`${runner.url}/v1/runs/${runId}/result`, {
          headers: auth,
        });
        expect(res.status).toBe(200);
      } finally {
        runner.child.kill("SIGTERM");
      }
      await expect(runner.exit).resolves.toBe(0);
    },
    SLOW,
  );

  it("startup failure exits 1 without leaving a lock; usage errors exit 2", () => {
    const state = join(work, "state-bad");
    const bad = join(operatorDir, "bad-profiles.json");
    writeFileSync(bad, JSON.stringify({ profiles: [{ id: "x" }] }));
    const run = (args: string[]) => {
      try {
        execFileSync(
          process.execPath,
          [join(pkg, "dist/runner-api/main.js"), ...args],
          {
            env: { ...process.env, CREDIMI_RUNNER_TOKEN: TOKEN },
            stdio: "pipe",
          },
        );
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    expect(run(["--profiles", bad, "--state-dir", state])).toBe(1);
    expect(existsSync(join(state, ".owner.lock"))).toBe(false);
    expect(run(["--state-dir", state])).toBe(2);
    expect(
      run(["--profiles", profilesPath, "--state-dir", state, "--port", "x"]),
    ).toBe(2);
  });

  it("the bin prints help, and importing main.js does not start a server", () => {
    const help = execFileSync(join(pkg, "bin/wct-runner"), ["--help"], {
      encoding: "utf-8",
    });
    expect(help).toContain("--state-dir");
    const imported = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(join(pkg, "dist/runner-api/main.js"))}); console.log("imported-only");`,
      ],
      { encoding: "utf-8", timeout: 20_000 },
    );
    expect(imported.trim()).toBe("imported-only");
  });
});
