import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactStore, isSafeArtifactId } from "@/runner-api/artifacts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wct-art-"));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

function source(name: string, content: string): string {
  const path = join(root, "src", name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe("ArtifactStore", () => {
  it("publishes exact bytes with real sha256 and size", () => {
    const store = new ArtifactStore(root);
    const { entries, limitations } = store.publish("run1", [
      source("native-results.json", "hello world"),
    ]);
    expect(limitations).toEqual([]);
    // echo -n "hello world" | sha256sum
    expect(entries[0]).toEqual({
      artifact_id: "native-results.json",
      download_url: "/v1/runs/run1/artifacts/native-results.json",
      filename: "native-results.json",
      mime_type: "application/json",
      sha256:
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      size_bytes: 11,
    });
    expect(store.read("run1", "native-results.json")?.content).toEqual(
      Buffer.from("hello world"),
    );
  });

  it("binds lookups to the run that published the artifact", () => {
    const store = new ArtifactStore(root);
    store.publish("run1", [source("a.json", "a")]);
    store.publish("run2", [source("b.json", "b")]);
    expect(store.read("run1", "a.json")).toBeDefined();
    expect(store.read("run2", "a.json")).toBeUndefined();
    expect(store.read("run3", "a.json")).toBeUndefined();
  });

  it("the manifest is immutable and survives a new store instance", () => {
    const store = new ArtifactStore(root);
    const first = store.publish("run1", [source("a.json", "a")]);
    const again = new ArtifactStore(root).publish("run1", [
      source("a.json", "changed"),
    ]);
    expect(again.entries).toEqual(first.entries);
    expect(new ArtifactStore(root).manifest("run1")).toEqual(first.entries);
  });

  it("missing sources become limitations, never empty-hash entries", () => {
    const { entries, limitations } = new ArtifactStore(root).publish("run1", [
      join(root, "missing.json"),
    ]);
    expect(entries).toEqual([]);
    expect(limitations[0]).toMatch(/missing\.json.*missing/);
  });

  it("tampered stored bytes are reported as ARTIFACT_CORRUPT", () => {
    const store = new ArtifactStore(root);
    store.publish("run1", [source("a.json", "a")]);
    writeFileSync(join(root, "artifacts", "run1", "files", "a.json"), "b");
    expect(() => store.read("run1", "a.json")).toThrow(/does not match/);
  });
});

describe("isSafeArtifactId", () => {
  it("accepts safe opaque IDs", () => {
    expect(isSafeArtifactId("native-results.json")).toBe(true);
    expect(isSafeArtifactId("abc-def_123")).toBe(true);
    expect(isSafeArtifactId("a.b.c")).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isSafeArtifactId("../etc/passwd")).toBe(false);
    expect(isSafeArtifactId("a/../../b")).toBe(false);
    expect(isSafeArtifactId("..")).toBe(false);
  });

  it("rejects empty and special characters", () => {
    expect(isSafeArtifactId("")).toBe(false);
    expect(isSafeArtifactId("a b")).toBe(false);
    expect(isSafeArtifactId("a\nb")).toBe(false);
    expect(isSafeArtifactId("a/b")).toBe(false);
    expect(isSafeArtifactId("run1:art1")).toBe(false);
  });
});
