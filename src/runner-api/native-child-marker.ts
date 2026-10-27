import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * `<run workspace>/native-child.json` records the detached native process
 * group of a run. It is written right after spawn and removed only once the
 * group is confirmed gone, so a marker that is still present after a crash
 * or an expired abort grace means the group may still be running.
 */
const MARKER_FILE = "native-child.json";

const markerSchema = z.object({
  /** Kernel boot ID when written; a different boot means the group is gone. */
  bootId: z.string().optional(),
  pid: z.number().int().positive(),
  /** Leader start time (/proc/<pid>/stat field 22) to detect pid reuse. */
  startTime: z.string().optional(),
});

type Marker = z.infer<typeof markerSchema>;

/**
 * Startup guard: for every run workspace (whatever the run's status) that
 * still has a marker, refuse to start if its process group is alive; clear
 * markers of groups that are gone. A corrupt marker is probed by any pid
 * still readable from its bytes before it is set aside.
 */
export function assertNoOrphanedNativeGroups(stateRoot: string): void {
  const workRoot = join(stateRoot, "work");
  if (!existsSync(workRoot)) return;
  for (const runId of readdirSync(workRoot)) {
    const path = markerPath(join(workRoot, runId));
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf-8");
    const parsed = markerSchema.safeParse(safeJson(text));
    const marker: Marker | undefined = parsed.success
      ? parsed.data
      : salvagePid(text);

    if (marker && isGroupAlive(marker)) {
      throw new Error(
        `native process group ${marker.pid} of run ${runId} is still running; stop it (kill -- -${marker.pid}) before starting the runner`,
      );
    }
    if (parsed.success) {
      rmSync(path, { force: true });
    } else {
      renameSync(path, `${path}.corrupt`);
      console.error(
        `[runner] corrupt native-child marker of run ${runId} set aside (no live process group found)`,
      );
    }
  }
}

/** Removes the marker if the group is confirmed gone; returns whether it did. */
export function clearNativeChildMarkerIfGone(
  runRoot: string,
  pid: number,
): boolean {
  if (isGroupAlive({ pid })) return false;
  rmSync(markerPath(runRoot), { force: true });
  return true;
}

export function markerPath(runRoot: string): string {
  return join(runRoot, MARKER_FILE);
}

/** Atomically records the native process group of a run. */
export function writeNativeChildMarker(runRoot: string, pid: number): void {
  const marker: Marker = {
    bootId: readBootId(),
    pid,
    startTime: readStartTime(pid),
  };
  const target = markerPath(runRoot);
  writeFileSync(`${target}.tmp`, JSON.stringify(marker), { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
}

function isGroupAlive(marker: Marker): boolean {
  const bootId = readBootId();
  if (marker.bootId && bootId && marker.bootId !== bootId) return false;
  try {
    process.kill(-marker.pid, 0);
  } catch (error) {
    // EPERM: the group exists but belongs to someone else — treat as alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  // While any member of the old group lives its pgid cannot be reused, so a
  // live leader with a different start time is a new, unrelated group.
  const startTime = readStartTime(marker.pid);
  return !(marker.startTime && startTime && marker.startTime !== startTime);
}

function readBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
  } catch {
    return undefined;
  }
}

function readStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // Fields after the parenthesized command name; starttime is field 22.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function salvagePid(text: string): Marker | undefined {
  const match = /"pid"\s*:\s*(\d+)/.exec(text);
  const pid = Number(match?.[1]);
  return Number.isInteger(pid) && pid > 0 ? { pid } : undefined;
}
