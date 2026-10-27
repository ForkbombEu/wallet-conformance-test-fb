import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { z } from "zod";

import { RunnerError } from "./contract";

/** Largest single artifact published; larger files become a limitation. */
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const manifestEntrySchema = z
  .object({
    artifact_id: z.string().refine(isSafeArtifactId),
    download_url: z.string(),
    filename: z.string(),
    mime_type: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z.number().int().min(0),
  })
  .strict();

const manifestSchema = z
  .object({
    artifacts: z.array(manifestEntrySchema),
    run_id: z.string().regex(RUN_ID_RE),
  })
  .strict();

export interface ArtifactContent {
  content: Buffer;
  entry: ArtifactManifestEntry;
}

export type ArtifactManifestEntry = z.infer<typeof manifestEntrySchema>;

export interface ArtifactStoreOptions {
  /**
   * Reads a declared private source file (internal seam; tests only).
   * Production reads the file system directly.
   */
  readSource?: (path: string) => Buffer;
}

/** A declared artifact whose initial publication failed. */
export interface PublicationFailure {
  filename: string;
  reason:
    | "duplicate"
    | "missing"
    | "oversize"
    | "unreadable"
    | "unsafe_name"
    | "write_failed";
}

export interface PublishedArtifacts {
  entries: ArtifactManifestEntry[];
  /** Declared artifacts that were not published, with a typed reason. */
  failed: PublicationFailure[];
  /** Human-readable problems; never contain private filesystem paths. */
  limitations: string[];
}

/**
 * Durable, run-scoped evidence store.
 *
 * Layout under the runner state root:
 *   artifacts/<runId>/manifest.json   immutable, written atomically once
 *   artifacts/<runId>/files/<id>      exact copied bytes
 *
 * Manifest entries are computed from the copied bytes. Downloads are looked
 * up by (runId, artifactId) in that run's manifest and re-verified against
 * the recorded SHA-256 before being served. Retention: files live until the
 * operator removes the state root.
 */
export class ArtifactStore {
  private readonly readSource: (path: string) => Buffer;
  private readonly root: string;

  constructor(stateRoot: string, options: ArtifactStoreOptions = {}) {
    this.root = join(stateRoot, "artifacts");
    this.readSource = options.readSource ?? ((path) => readFileSync(path));
  }

  /** The persisted manifest of a run, if it was published. */
  manifest(runId: string): ArtifactManifestEntry[] | undefined {
    if (!RUN_ID_RE.test(runId)) return undefined;
    const path = this.manifestPath(runId);
    if (!existsSync(path)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    } catch {
      raw = undefined;
    }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.run_id !== runId) {
      throw new RunnerError(
        "ARTIFACT_CORRUPT",
        500,
        `Artifact manifest of run '${runId}' is invalid`,
      );
    }
    return parsed.data.artifacts;
  }

  /**
   * Copies the given private files into the run's artifact area and writes
   * the immutable manifest. Publishing an already published run returns the
   * existing manifest unchanged.
   */
  publish(runId: string, sourcePaths: readonly string[]): PublishedArtifacts {
    if (!RUN_ID_RE.test(runId)) {
      throw new Error(`Unsafe run id for artifacts: ${runId}`);
    }
    const existing = this.manifest(runId);
    if (existing) return { entries: existing, failed: [], limitations: [] };

    const filesDir = join(this.root, runId, "files");
    mkdirSync(filesDir, { recursive: true });
    const entries: ArtifactManifestEntry[] = [];
    const failed: PublicationFailure[] = [];
    const limitations: string[] = [];
    const fail = (
      filename: string,
      reason: PublicationFailure["reason"],
      limitation: string,
    ) => {
      failed.push({ filename, reason });
      limitations.push(limitation);
    };

    for (const source of sourcePaths) {
      const filename = basename(source);
      const artifactId = filename;
      if (!isSafeArtifactId(artifactId)) {
        fail(
          filename,
          "unsafe_name",
          `Artifact '${filename}' has an unsafe name`,
        );
        continue;
      }
      if (entries.some((e) => e.artifact_id === artifactId)) {
        fail(
          filename,
          "duplicate",
          `Duplicate artifact '${filename}' was skipped`,
        );
        continue;
      }
      const read = this.readDeclared(source, filename);
      if ("reason" in read) {
        fail(filename, read.reason, read.limitation);
        continue;
      }
      const content = read.content;
      const target = join(filesDir, artifactId);
      try {
        writeFileSync(`${target}.tmp`, content, { mode: 0o600 });
        renameSync(`${target}.tmp`, target);
      } catch (error) {
        fail(
          filename,
          "write_failed",
          `Artifact '${filename}' could not be stored (${errorCode(error)})`,
        );
        continue;
      }
      entries.push({
        artifact_id: artifactId,
        download_url: `/v1/runs/${runId}/artifacts/${encodeURIComponent(artifactId)}`,
        filename,
        mime_type: mimeTypeFor(filename),
        sha256: createHash("sha256").update(content).digest("hex"),
        size_bytes: content.length,
      });
    }

    const manifestPath = this.manifestPath(runId);
    writeFileSync(
      `${manifestPath}.tmp`,
      JSON.stringify({ artifacts: entries, run_id: runId }, null, 2),
      { mode: 0o600 },
    );
    renameSync(`${manifestPath}.tmp`, manifestPath);
    return { entries, failed, limitations };
  }

  /**
   * Reads one artifact bound to BOTH the run and the artifact ID. Returns
   * undefined when the run has no such manifest entry; throws
   * ARTIFACT_CORRUPT if the stored bytes are missing or do not match the
   * manifest hash/size.
   */
  read(runId: string, artifactId: string): ArtifactContent | undefined {
    if (!isSafeArtifactId(artifactId)) return undefined;
    const entry = this.manifest(runId)?.find(
      (e) => e.artifact_id === artifactId,
    );
    if (!entry) return undefined;
    let content: Buffer;
    try {
      content = readFileSync(join(this.root, runId, "files", artifactId));
    } catch {
      throw new RunnerError(
        "ARTIFACT_CORRUPT",
        500,
        `Artifact '${artifactId}' of run '${runId}' is missing from storage`,
      );
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== entry.sha256 || content.length !== entry.size_bytes) {
      throw new RunnerError(
        "ARTIFACT_CORRUPT",
        500,
        `Artifact '${artifactId}' of run '${runId}' does not match its manifest`,
      );
    }
    return { content, entry };
  }

  private manifestPath(runId: string): string {
    return join(this.root, runId, "manifest.json");
  }

  /** Reads a declared source within the size cap, or explains why not. */
  private readDeclared(
    source: string,
    filename: string,
  ):
    | { content: Buffer }
    | { limitation: string; reason: PublicationFailure["reason"] } {
    const unavailable = (error: unknown) =>
      errorCode(error) === "ENOENT"
        ? {
            limitation: `Declared artifact '${filename}' is missing`,
            reason: "missing" as const,
          }
        : {
            limitation: `Declared artifact '${filename}' could not be read (${errorCode(error)})`,
            reason: "unreadable" as const,
          };
    let size: number;
    try {
      size = statSync(source).size;
    } catch (error) {
      return unavailable(error);
    }
    if (size > MAX_ARTIFACT_BYTES) {
      return {
        limitation: `Artifact '${filename}' (${size} bytes) exceeds the ${MAX_ARTIFACT_BYTES}-byte cap and was not published`,
        reason: "oversize",
      };
    }
    try {
      return { content: this.readSource(source) };
    } catch (error) {
      return unavailable(error);
    }
  }
}

/** The error's code (e.g. ENOENT); never its message, which has paths. */
export function errorCode(error: unknown): string {
  const code =
    error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" && code.length > 0 ? code : "error";
}

/**
 * Validates that an artifact ID is a safe opaque name (no path traversal).
 */
export function isSafeArtifactId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) && !id.includes("..");
}

function mimeTypeFor(filename: string): string {
  switch (extname(filename)) {
    case ".json":
      return "application/json";
    case ".log":
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}
