import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  RunnerError,
  type RunnerResult,
  type RunRequest,
  runRequestSchema,
  type RunStatus,
  runStatusSchema,
} from "./contract";

// ---------------------------------------------------------------------------
// Stored run record
// ---------------------------------------------------------------------------

/** Current request-hash algorithm: recursive key sort, array order kept. */
export const REQUEST_HASH_VERSION = 2;

export interface StoredRun {
  cancelRequested: boolean;
  createdAt: string;
  idempotencyKeyHash: string;
  namespace: string;
  request: RunRequest;
  requestHash: string;
  /** Absent on records written before the hash migration (version 1). */
  requestHashVersion?: number;
  result?: RunnerResult;
  runId: string;
  status: RunStatus;
  updatedAt: string;
}

/**
 * Authoritative fields are validated strictly; the result is validated by
 * the wire schema at publication, so here it only has to be an object.
 */
const storedRunSchema = z
  .object({
    cancelRequested: z.boolean(),
    createdAt: z.string().min(1),
    idempotencyKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
    namespace: z.string().min(1),
    request: runRequestSchema,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestHashVersion: z.number().int().optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    status: runStatusSchema,
    updatedAt: z.string().min(1),
  })
  .strict();

const indexEntrySchema = z.object({
  keyHash: z.string(),
  runId: z.string(),
});

export interface CorruptRecord {
  file: string;
  /** Validation issue paths/codes only — never record values. */
  reason: string;
  runId: string;
}

interface LockInfo {
  acquiredAt: string;
  hostname: string;
  pid: number;
  token: string;
}

const LOCK_FILE = ".owner.lock";

// ---------------------------------------------------------------------------
// JobStore
// ---------------------------------------------------------------------------

export class JobStore {
  readonly rootDir: string;

  private readonly corrupt = new Map<string, CorruptRecord>();

  private ownerToken: string | undefined;

  private get indexDir(): string {
    return join(this.rootDir, "index");
  }

  private get lockPath(): string {
    return join(this.rootDir, LOCK_FILE);
  }

  private get quarantineDir(): string {
    return join(this.rootDir, "quarantine");
  }

  private get runsDir(): string {
    return join(this.rootDir, "runs");
  }

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(this.runsDir, { recursive: true });
    mkdirSync(this.indexDir, { recursive: true });
    // Records quarantined by an earlier process stay blocked: their index
    // entries still exist, and their keys must never start new work.
    if (existsSync(this.quarantineDir)) {
      for (const file of readdirSync(this.quarantineDir)) {
        if (!file.endsWith(".json")) continue;
        const runId = file.slice(0, -".json".length);
        this.corrupt.set(runId, {
          file,
          reason: "quarantined by a previous runner process",
          runId,
        });
      }
    }
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

  /**
   * The pre-migration algorithm (replacer array of top-level keys). It drops
   * nested keys, so it is only used to authenticate a stored record before
   * recomputing its hash from the authoritative stored request.
   */
  static legacyRequestHash(request: RunRequest): string {
    return createHash("sha256")
      .update(JSON.stringify(request, Object.keys(request).sort()))
      .digest("hex");
  }

  // -- root lock -------------------------------------------------------------

  /**
   * Exclusively creates the state-root lock with a fresh unpredictable owner
   * token kept by this store. Returns false if any lock already exists
   * (including one this store holds). Stale locks are never removed
   * automatically; see {@link describeRootLock}.
   */
  acquireRootLock(): boolean {
    if (this.ownerToken) {
      return false;
    }
    const info: LockInfo = {
      acquiredAt: new Date().toISOString(),
      hostname: hostname(),
      pid: process.pid,
      token: randomBytes(32).toString("hex"),
    };
    try {
      const fd = openSync(this.lockPath, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
    this.ownerToken = info.token;
    return true;
  }

  allRuns(): StoredRun[] {
    const runs: StoredRun[] = [];
    for (const f of readdirSync(this.runsDir)) {
      if (!f.endsWith(".json")) continue;
      const run = this.readRecord(f.slice(0, -".json".length));
      if (run) runs.push(run);
    }
    return runs;
  }

  /** Records quarantined since this store was opened. */
  corruptRecords(): CorruptRecord[] {
    return [...this.corrupt.values()];
  }

  /** Human-readable owner of an existing lock, for startup errors. */
  describeRootLock(): string {
    try {
      const info = JSON.parse(readFileSync(this.lockPath, "utf-8")) as
        | Partial<LockInfo>
        | undefined;
      return `state root ${this.rootDir} is locked by another runner (pid ${String(info?.pid)} on ${String(info?.hostname)} since ${String(info?.acquiredAt)}). If no runner uses it, remove ${this.lockPath} manually.`;
    } catch {
      return `state root ${this.rootDir} is locked by another runner (unreadable lock ${this.lockPath}); remove it manually only if no runner uses this root.`;
    }
  }

  /**
   * Finds the run that owns an idempotency key. Throws RUN_RECORD_CORRUPT if
   * the key belongs to a quarantined record, so the key can never silently
   * launch new work.
   */
  findByKeyHash(keyHash: string): StoredRun | undefined {
    const ip = this.indexPath(keyHash);
    if (existsSync(ip)) {
      const parsed = indexEntrySchema.safeParse(
        safeJson(readFileSync(ip, "utf-8")),
      );
      if (parsed.success) {
        const run = this.readRecord(parsed.data.runId);
        if (run) return run;
        if (this.corrupt.has(parsed.data.runId)) {
          throw corruptRecordError(parsed.data.runId);
        }
      }
    }
    // Fallback: rebuild from authoritative records
    return this.rebuildFind(keyHash);
  }

  getRun(runId: string): StoredRun | undefined {
    const run = this.readRecord(runId);
    if (!run && this.corrupt.has(runId)) {
      throw corruptRecordError(runId);
    }
    return run;
  }

  hasRootLock(): boolean {
    return existsSync(this.lockPath);
  }

  /**
   * Validates every record (quarantining corrupt ones), migrates records
   * hashed with the previous algorithm, and rebuilds the key index.
   */
  rebuildIndex(): void {
    for (const run of this.allRuns()) {
      this.writeIndex(run);
    }
  }

  /**
   * Releases the lock only if this store acquired it and the file still
   * carries its token. Safe to call any number of times.
   */
  releaseRootLock(): void {
    const token = this.ownerToken;
    if (!token) return;
    this.ownerToken = undefined;
    try {
      const info = JSON.parse(readFileSync(this.lockPath, "utf-8")) as
        | Partial<LockInfo>
        | undefined;
      if (info?.token === token) {
        rmSync(this.lockPath, { force: true });
      }
    } catch {
      // lock already gone or unreadable: never remove what we cannot verify
    }
  }

  saveRun(run: StoredRun): void {
    const target = this.runPath(run.runId);
    const tmp = `${target}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(
        { ...run, requestHashVersion: REQUEST_HASH_VERSION },
        null,
        2,
      ),
      "utf-8",
    );
    renameSync(tmp, target);
    this.writeIndex(run);
  }

  workDir(runId: string): string {
    return join(this.rootDir, "work", runId);
  }

  private indexPath(keyHash: string): string {
    return join(this.indexDir, `${keyHash}.json`);
  }

  private quarantine(runId: string, file: string, reason: string): void {
    mkdirSync(this.quarantineDir, { recursive: true });
    try {
      renameSync(join(this.runsDir, file), join(this.quarantineDir, file));
    } catch {
      // already moved
    }
    this.corrupt.set(runId, { file, reason, runId });
  }

  /**
   * Reads and validates one record. Corrupt records are quarantined. A
   * record hashed with the previous algorithm is authenticated against that
   * algorithm and rewritten with the hash recomputed from its stored request.
   */
  private readRecord(runId: string): StoredRun | undefined {
    if (this.corrupt.has(runId)) return undefined;
    const file = `${runId}.json`;
    const p = join(this.runsDir, file);
    if (!existsSync(p)) return undefined;

    const parsed = storedRunSchema.safeParse(
      safeJson(readFileSync(p, "utf-8")),
    );
    if (!parsed.success) {
      const reason = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`)
        .join("; ");
      this.quarantine(runId, file, reason);
      return undefined;
    }
    const run = parsed.data as StoredRun;
    if (run.runId !== runId) {
      this.quarantine(runId, file, "runId does not match file name");
      return undefined;
    }

    const current = JobStore.canonicalRequestHash(run.request);
    if (run.requestHashVersion === REQUEST_HASH_VERSION) {
      if (run.requestHash !== current) {
        this.quarantine(runId, file, "requestHash does not match request");
        return undefined;
      }
      return run;
    }
    if (run.requestHash !== JobStore.legacyRequestHash(run.request)) {
      this.quarantine(runId, file, "legacy requestHash does not match request");
      return undefined;
    }
    const migrated: StoredRun = { ...run, requestHash: current };
    this.saveRun(migrated);
    return { ...migrated, requestHashVersion: REQUEST_HASH_VERSION };
  }

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

function corruptRecordError(runId: string): RunnerError {
  return new RunnerError(
    "RUN_RECORD_CORRUPT",
    500,
    `Run record '${runId}' is corrupt and was quarantined; its idempotency key cannot start new work`,
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
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
