import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schema for engagement factory config
// ---------------------------------------------------------------------------

const headerValueSchema = z.union([
  z.string().min(1),
  z.object({ env: z.string().min(1) }),
]);

export const engagementFactoryConfigSchema = z
  .object({
    body: z.unknown().optional(),
    endpoint: z.string().url(),
    headers: z.record(z.string().min(1), headerValueSchema).optional(),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(1_048_576)
      .default(65_536),
    method: z.enum(["GET", "POST"]),
    responseProperty: z.string().min(1),
    timeoutMs: z.number().int().positive().max(60_000).default(15_000),
  })
  .strict();

export type EngagementFactoryConfig = z.infer<
  typeof engagementFactoryConfigSchema
>;

export type ResolvedHeaderMap = Record<string, string>;

// ---------------------------------------------------------------------------
// Header resolution (secrets from env, never returned in results)
// ---------------------------------------------------------------------------

export async function callEngagementFactory(
  config: EngagementFactoryConfig,
): Promise<string> {
  const headers = resolveHeaders(config.headers);

  const fetchHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  const requestInit: RequestInit = {
    headers: fetchHeaders,
    method: config.method,
    signal: AbortSignal.timeout(config.timeoutMs),
  };

  if (config.body !== undefined && config.method === "POST") {
    requestInit.body = JSON.stringify(config.body);
  }

  const response = await fetch(config.endpoint, requestInit);

  if (!response.ok) {
    throw new Error(
      `Engagement factory returned HTTP ${response.status} ${response.statusText}`,
    );
  }

  // Read with byte cap
  const raw = await readCapped(response, config.maxResponseBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Engagement factory response is not valid JSON");
  }

  const extracted = extractProperty(parsed, config.responseProperty);
  if (typeof extracted !== "string" || extracted.length === 0) {
    throw new Error(
      `Engagement factory response missing or invalid property '${config.responseProperty}'`,
    );
  }

  try {
    new URL(extracted);
  } catch {
    throw new Error(
      `Engagement factory property '${config.responseProperty}' is not a valid URI`,
    );
  }

  return extracted;
}

export function extractProperty(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Dotted property path extraction
// ---------------------------------------------------------------------------

export function parseEngagementFactoryConfig(
  raw: unknown,
): EngagementFactoryConfig {
  const result = engagementFactoryConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid engagement factory config: ${issues}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

export function resolveHeaders(
  headers: Record<string, string | { env: string }> | undefined,
): ResolvedHeaderMap {
  if (!headers) {
    return {};
  }
  const resolved: ResolvedHeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      resolved[name] = value;
    } else {
      const secret = process.env[value.env];
      if (!secret) {
        throw new Error(
          `Secret header '${name}' references unset environment variable '${value.env}'`,
        );
      }
      resolved[name] = secret;
    }
  }
  return resolved;
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return await response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.length;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(
        `Engagement factory response exceeded ${maxBytes} byte limit`,
      );
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(combined);
}
