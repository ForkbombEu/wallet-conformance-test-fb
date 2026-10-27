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

export interface PublishedArtifacts {
  entries: ArtifactManifestEntry[];
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
  private readonly root: string;

  constructor(stateRoot: string) {
    this.root = join(stateRoot, "artifacts");
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
    if (existing) return { entries: existing, limitations: [] };

    const filesDir = join(this.root, runId, "files");
    mkdirSync(filesDir, { recursive: true });
    const entries: ArtifactManifestEntry[] = [];
    const limitations: string[] = [];

    for (const source of sourcePaths) {
      const filename = basename(source);
      const artifactId = filename;
      if (!isSafeArtifactId(artifactId)) {
        limitations.push(`Artifact '${filename}' has an unsafe name`);
        continue;
      }
      if (entries.some((e) => e.artifact_id === artifactId)) {
        limitations.push(`Duplicate artifact '${filename}' was skipped`);
        continue;
      }
      let content: Buffer;
      try {
        const size = statSync(source).size;
        if (size > MAX_ARTIFACT_BYTES) {
          limitations.push(
            `Artifact '${filename}' (${size} bytes) exceeds the ${MAX_ARTIFACT_BYTES}-byte cap and was not published`,
          );
          continue;
        }
        content = readFileSync(source);
      } catch {
        limitations.push(`Declared artifact '${filename}' is missing`);
        continue;
      }
      const target = join(filesDir, artifactId);
      writeFileSync(`${target}.tmp`, content, { mode: 0o600 });
      renameSync(`${target}.tmp`, target);
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
    return { entries, limitations };
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
