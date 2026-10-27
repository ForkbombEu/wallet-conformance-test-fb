import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import type { RunnerResult, RunRequest, RunStatus } from "./contract";

// ---------------------------------------------------------------------------
// Stored run record
// ---------------------------------------------------------------------------

export interface StoredRun {
  cancelRequested: boolean;
  createdAt: string;
  idempotencyKeyHash: string;
  namespace: string;
  request: RunRequest;
  requestHash: string;
  result?: RunnerResult;
  runId: string;
  status: RunStatus;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// JobStore
// ---------------------------------------------------------------------------

export class JobStore {
  readonly rootDir: string;

  private get indexDir(): string {
    return join(this.rootDir, "index");
  }

  private get runsDir(): string {
    return join(this.rootDir, "runs");
  }

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(this.runsDir, { recursive: true });
    mkdirSync(this.indexDir, { recursive: true });
  }

  static canonicalRequestHash(request: RunRequest): string {
    const canonical = JSON.stringify(sortKeysDeep(request));
    return createHash("sha256").update(canonical).digest("hex");
  }

  static keyHash(namespace: string, idempotencyKey: string): string {
    return createHash("sha256")
      .update(`${namespace}\n${idempotencyKey}`)
      .digest("hex");
  }

  // -- canonical hashing ---------------------------------------------------

  acquireRootLock(ownerId: string): boolean {
    const lockPath = join(this.rootDir, ".owner.lock");
    try {
      // Atomic exclusive creation — O_CREAT | O_EXCL
      const fd = openSync(lockPath, "wx");
      writeSync(fd, ownerId);
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }

  allRuns(): StoredRun[] {
    const runs: StoredRun[] = [];
    for (const f of readdirSync(this.runsDir)) {
      if (f.endsWith(".json") && !f.endsWith(".tmp")) {
        try {
          runs.push(
            JSON.parse(
              readFileSync(join(this.runsDir, f), "utf-8"),
            ) as StoredRun,
          );
        } catch {
          // skip corrupt files
        }
      }
    }
    return runs;
  }

  findByKeyHash(keyHash: string): StoredRun | undefined {
    const ip = this.indexPath(keyHash);
    if (existsSync(ip)) {
      const idx = JSON.parse(readFileSync(ip, "utf-8")) as {
        runId: string;
      };
      return this.getRun(idx.runId);
    }
    // Fallback: rebuild from authoritative records
    return this.rebuildFind(keyHash);
  }

  getRun(runId: string): StoredRun | undefined {
    const p = this.runPath(runId);
    if (!existsSync(p)) {
      return undefined;
    }
    return JSON.parse(readFileSync(p, "utf-8")) as StoredRun;
  }

  // -- record CRUD ---------------------------------------------------------

  hasRootLock(): boolean {
    return existsSync(join(this.rootDir, ".owner.lock"));
  }

  rebuildIndex(): void {
    for (const run of this.allRuns()) {
      this.writeIndex(run);
    }
  }

  releaseRootLock(ownerToken?: string): void {
    const lockPath = join(this.rootDir, ".owner.lock");
    if (ownerToken && existsSync(lockPath)) {
      const current = readFileSync(lockPath, "utf-8");
      if (current !== ownerToken) return;
    }
    rmSync(lockPath, { force: true });
  }

  saveRun(run: StoredRun): void {
    const target = this.runPath(run.runId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(run, null, 2), "utf-8");
    renameSync(tmp, target);
    this.writeIndex(run);
  }

  workDir(runId: string): string {
    return join(this.rootDir, "work", runId);
  }

  // -- idempotency index recovery -------------------------------------------

  private indexPath(keyHash: string): string {
    return join(this.indexDir, `${keyHash}.json`);
  }

  // -- lock ------------------------------------------------------------------

  private rebuildFind(keyHash: string): StoredRun | undefined {
    for (const run of this.allRuns()) {
      if (run.idempotencyKeyHash === keyHash) {
        this.writeIndex(run);
        return run;
      }
    }
    return undefined;
  }

  private runPath(runId: string): string {
    return join(this.runsDir, `${runId}.json`);
  }

  private writeIndex(run: StoredRun): void {
    const target = this.indexPath(run.idempotencyKeyHash);
    const tmp = `${target}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ keyHash: run.idempotencyKeyHash, runId: run.runId }),
      "utf-8",
    );
    renameSync(tmp, target);
  }
}

export function generateRunId(): string {
  return randomUUID();
}

/**
 * Recursively sorts object keys at every depth. Preserves array order.
 */
function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortKeysDeep);
  }
  if (obj !== null && typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}
