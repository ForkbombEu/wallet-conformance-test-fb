import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "@/types";

import { getAuthorizeRequestUrl } from "@/logic/authorization-request-url";
import {
  callEngagementFactory,
  extractProperty,
  parseEngagementFactoryConfig,
  resolveHeaders,
} from "@/logic/engagement-factory";

// ---------------------------------------------------------------------------
// Fake RP server that increments session IDs
// ---------------------------------------------------------------------------

interface FakeRpState {
  postCount: number;
  server: Server;
  sessionIds: string[];
  url: string;
}

let fakeRp: FakeRpState;

function makePresentation(
  overrides: Partial<Config["presentation"]> = {},
): Config["presentation"] {
  return {
    authorize_request_url: "https://static.example/auth",
    tests_dir: "./tests/presentation",
    ...overrides,
  } as Config["presentation"];
}

function startFakeRp(
  handler?: (req: unknown, res: unknown) => void,
): Promise<FakeRpState> {
  return new Promise((resolve) => {
    let postCount = 0;
    const sessionIds: string[] = [];

    const server = createServer((req, res) => {
      if (handler) {
        handler(req, res);
        return;
      }

      if (req.method === "POST") {
        postCount++;
        const sessionId = `session-${postCount}`;
        sessionIds.push(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              deeplink: `openid4vp://authorize?request_uri=https://rp.example/request/${sessionId}`,
            },
          }),
        );
      } else {
        // GET
        const sessionId = `session-${postCount + 1}`;
        sessionIds.push(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              deeplink: `openid4vp://authorize?request_uri=https://rp.example/request/${sessionId}`,
            },
          }),
        );
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        postCount: 0,
        server,
        sessionIds,
        url: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function stopFakeRp(): Promise<void> {
  if (fakeRp) {
    await new Promise<void>((resolve) => fakeRp.server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(async () => {
  fakeRp = await startFakeRp();
});

afterEach(async () => {
  await stopFakeRp();
  Reflect.deleteProperty(process.env, "TEST_SECRET_HEADER");
});

describe("callEngagementFactory — two POSTs produce two distinct URIs", () => {
  it("sends two POSTs and gets two different request_uri values", async () => {
    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/openid4vp/sessions`,
      method: "POST",
      responseProperty: "data.deeplink",
    });

    const uri1 = await callEngagementFactory(config);
    const uri2 = await callEngagementFactory(config);

    expect(uri1).toContain("session-1");
    expect(uri2).toContain("session-2");
    expect(uri1).not.toBe(uri2);
  });
});

describe("callEngagementFactory — GET method", () => {
  it("works with GET", async () => {
    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/session`,
      method: "GET",
      responseProperty: "data.deeplink",
    });

    const uri = await callEngagementFactory(config);
    expect(uri).toContain("session-");
  });
});

describe("callEngagementFactory — static body", () => {
  it("sends POST body as JSON", async () => {
    const body = { profile: "pid", type: "vp_token" };
    const config = parseEngagementFactoryConfig({
      body,
      endpoint: `${fakeRp.url}/sessions`,
      method: "POST",
      responseProperty: "data.deeplink",
    });

    const uri = await callEngagementFactory(config);
    expect(uri).toContain("session-");
  });
});

describe("callEngagementFactory — secret header redaction", () => {
  it("resolves secret headers from env but does not include them in result", async () => {
    process.env.TEST_SECRET_HEADER = "super-secret-value";

    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/sessions`,
      headers: { Authorization: { env: "TEST_SECRET_HEADER" } },
      method: "POST",
      responseProperty: "data.deeplink",
    });

    const uri = await callEngagementFactory(config);
    expect(uri).not.toContain("super-secret-value");
  });

  it("throws when secret env var is unset", async () => {
    Reflect.deleteProperty(process.env, "TEST_SECRET_HEADER");

    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/sessions`,
      headers: { Authorization: { env: "TEST_SECRET_HEADER" } },
      method: "POST",
      responseProperty: "data.deeplink",
    });

    await expect(callEngagementFactory(config)).rejects.toThrow(
      /unset environment variable/,
    );
  });
});

describe("callEngagementFactory — non-2xx rejection", () => {
  it("throws on 500", async () => {
    await stopFakeRp();
    fakeRp = await startFakeRp((_req, res) => {
      (res as { writeHead: (n: number) => void }).writeHead(500);
      (res as { end: () => void }).end();
    });

    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/fail`,
      method: "POST",
      responseProperty: "data.deeplink",
    });

    await expect(callEngagementFactory(config)).rejects.toThrow(/HTTP 500/);
  });

  it("throws on 404", async () => {
    await stopFakeRp();
    fakeRp = await startFakeRp((_req, res) => {
      (res as { writeHead: (n: number) => void }).writeHead(404);
      (res as { end: () => void }).end();
    });

    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/missing`,
      method: "GET",
      responseProperty: "data.deeplink",
    });

    await expect(callEngagementFactory(config)).rejects.toThrow(/HTTP 404/);
  });
});

describe("callEngagementFactory — malformed response", () => {
  it("throws on non-JSON body", async () => {
    await stopFakeRp();
    fakeRp = await startFakeRp((_req, res) => {
      (res as { writeHead: (n: number, h: object) => void }).writeHead(200, {
        "Content-Type": "text/plain",
      });
      (res as { end: (s: string) => void }).end("not json");
    });

    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/bad`,
      method: "GET",
      responseProperty: "data.deeplink",
    });

    await expect(callEngagementFactory(config)).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe("callEngagementFactory — missing property", () => {
  it("throws when responseProperty is not in response", async () => {
    await stopFakeRp();
    fakeRp = await startFakeRp((_req, res) => {
      (res as { writeHead: (n: number, h: object) => void }).writeHead(200, {
        "Content-Type": "application/json",
      });
      (res as { end: (s: string) => void }).end(JSON.stringify({ foo: "bar" }));
    });

    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/wrong`,
      method: "GET",
      responseProperty: "data.deeplink",
    });

    await expect(callEngagementFactory(config)).rejects.toThrow(
      /missing or invalid property/,
    );
  });
});

describe("callEngagementFactory — invalid URI", () => {
  it("throws when extracted value is not a valid URL", async () => {
    await stopFakeRp();
    fakeRp = await startFakeRp((_req, res) => {
      (res as { writeHead: (n: number, h: object) => void }).writeHead(200, {
        "Content-Type": "application/json",
      });
      (res as { end: (s: string) => void }).end(
        JSON.stringify({ data: { deeplink: "not-a-url" } }),
      );
    });

    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/bad-uri`,
      method: "GET",
      responseProperty: "data.deeplink",
    });

    await expect(callEngagementFactory(config)).rejects.toThrow(
      /not a valid URI/,
    );
  });
});

describe("callEngagementFactory — timeout", () => {
  it("throws on timeout", async () => {
    await stopFakeRp();
    fakeRp = await startFakeRp(() => {
      // Never respond — let timeout fire
    });

    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/slow`,
      method: "GET",
      responseProperty: "data.deeplink",
      timeoutMs: 100,
    });

    await expect(callEngagementFactory(config)).rejects.toThrow();
  });
});

describe("callEngagementFactory — byte cap", () => {
  it("throws on oversized response", async () => {
    await stopFakeRp();
    fakeRp = await startFakeRp((_req, res) => {
      (res as { writeHead: (n: number, h: object) => void }).writeHead(200, {
        "Content-Type": "application/json",
      });
      const big = JSON.stringify({
        data: { deeplink: "https://x.com", filler: "a".repeat(100_000) },
      });
      (res as { end: (s: string) => void }).end(big);
    });

    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/big`,
      maxResponseBytes: 1024,
      method: "GET",
      responseProperty: "data.deeplink",
    });

    await expect(callEngagementFactory(config)).rejects.toThrow(/byte limit/);
  });
});

describe("callEngagementFactory — query encoding", () => {
  it("passes query params in endpoint", async () => {
    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/sessions?profile=pid&scope=vp_token`,
      method: "POST",
      responseProperty: "data.deeplink",
    });

    const uri = await callEngagementFactory(config);
    expect(uri).toContain("session-");
  });
});

describe("getAuthorizeRequestUrl — precedence", () => {
  it("uses factory when factoryConfig is provided", async () => {
    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/sessions`,
      method: "POST",
      responseProperty: "data.deeplink",
    });

    const uri = await getAuthorizeRequestUrl(makePresentation(), config);
    expect(uri).toContain("session-");
  });

  it("rejects ambiguous factory + script configuration", async () => {
    const config = parseEngagementFactoryConfig({
      endpoint: `${fakeRp.url}/sessions`,
      method: "POST",
      responseProperty: "data.deeplink",
    });

    await expect(
      getAuthorizeRequestUrl(
        makePresentation({ authorize_request_script: "/bin/echo" }),
        config,
      ),
    ).rejects.toThrow(/Ambiguous configuration/);
  });

  it("falls back to static URL when no factory and no script", async () => {
    const uri = await getAuthorizeRequestUrl(makePresentation());
    expect(uri).toBe("https://static.example/auth");
  });
});

describe("extractProperty — dotted path", () => {
  it("extracts nested property", () => {
    expect(extractProperty({ a: { b: { c: "hello" } } }, "a.b.c")).toBe(
      "hello",
    );
  });

  it("returns undefined for missing path", () => {
    expect(extractProperty({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined for non-object intermediate", () => {
    expect(extractProperty({ a: "string" }, "a.b")).toBeUndefined();
  });
});

describe("resolveHeaders", () => {
  it("resolves static and env headers", () => {
    process.env.TEST_SECRET_HEADER = "resolved-value";
    const resolved = resolveHeaders({
      "X-Secret": { env: "TEST_SECRET_HEADER" },
      "X-Static": "static-value",
    });
    expect(resolved["X-Static"]).toBe("static-value");
    expect(resolved["X-Secret"]).toBe("resolved-value");
    Reflect.deleteProperty(process.env, "TEST_SECRET_HEADER");
  });

  it("returns empty for undefined headers", () => {
    expect(resolveHeaders(undefined)).toEqual({});
  });
});

describe("parseEngagementFactoryConfig", () => {
  it("applies defaults", () => {
    const config = parseEngagementFactoryConfig({
      endpoint: "https://rp.example/sessions",
      method: "POST",
      responseProperty: "deeplink",
    });
    expect(config.maxResponseBytes).toBe(65_536);
    expect(config.timeoutMs).toBe(15_000);
  });

  it("rejects unknown properties", () => {
    expect(() =>
      parseEngagementFactoryConfig({
        endpoint: "https://rp.example/sessions",
        evil: true,
        method: "POST",
        responseProperty: "deeplink",
      }),
    ).toThrow();
  });

  it("rejects invalid method", () => {
    expect(() =>
      parseEngagementFactoryConfig({
        endpoint: "https://rp.example/sessions",
        method: "PUT",
        responseProperty: "deeplink",
      }),
    ).toThrow();
  });
});
