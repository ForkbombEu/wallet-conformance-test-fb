import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ArtifactRecord {
  artifactId: string;
  content: Buffer;
  contentType: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactRecord>();

  get(artifactId: string): ArtifactRecord | undefined {
    return this.artifacts.get(artifactId);
  }

  list(runId: string): ArtifactRecord[] {
    return [...this.artifacts.values()].filter((a) =>
      a.artifactId.startsWith(`${runId}:`),
    );
  }

  register(
    artifactId: string,
    filename: string,
    contentType: string,
    content: Buffer,
  ): ArtifactRecord {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const record: ArtifactRecord = {
      artifactId,
      content,
      contentType,
      filename,
      sha256,
      sizeBytes: content.length,
    };
    this.artifacts.set(artifactId, record);
    return record;
  }

  registerFile(
    artifactId: string,
    filename: string,
    contentType: string,
    filePath: string,
  ): ArtifactRecord {
    const content = readFileSync(filePath);
    return this.register(artifactId, filename, contentType, content);
  }

  toManifestEntry(runId: string, artifactId: string) {
    const record = this.get(artifactId);
    if (!record) {
      return undefined;
    }
    return {
      artifact_id: artifactId,
      download_url: `/v1/runs/${runId}/artifacts/${encodeURIComponent(artifactId)}`,
      filename: record.filename,
      mime_type: record.contentType,
      sha256: record.sha256,
      size_bytes: record.sizeBytes,
    };
  }
}

/**
 * Validates that an artifact ID is a safe opaque name (no path traversal).
 */
export function isSafeArtifactId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id) && !id.includes("..");
}
