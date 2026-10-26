import { describe, expect, it } from "vitest";

import { ArtifactStore, isSafeArtifactId } from "@/runner-api/artifacts";

describe("ArtifactStore", () => {
  it("registers and retrieves an artifact", () => {
    const store = new ArtifactStore();
    const buf = Buffer.from("hello world");
    store.register("run1:art1", "test.json", "application/json", buf);

    const record = store.get("run1:art1");
    expect(record).toBeDefined();
    expect(record?.filename).toBe("test.json");
    expect(record?.contentType).toBe("application/json");
    expect(record?.content).toEqual(buf);
    expect(record?.sizeBytes).toBe(11);
  });

  it("computes correct sha256", () => {
    const store = new ArtifactStore();
    const buf = Buffer.from("hello world");
    store.register("run1:art1", "t.json", "application/json", buf);

    // echo -n "hello world" | sha256sum
    expect(store.get("run1:art1")?.sha256).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("returns undefined for unknown artifact", () => {
    const store = new ArtifactStore();
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("lists artifacts for a run", () => {
    const store = new ArtifactStore();
    store.register("run1:art1", "a.json", "application/json", Buffer.from("a"));
    store.register("run1:art2", "b.json", "application/json", Buffer.from("b"));
    store.register("run2:art1", "c.json", "application/json", Buffer.from("c"));

    expect(store.list("run1")).toHaveLength(2);
    expect(store.list("run2")).toHaveLength(1);
  });

  it("builds manifest entry with download_url", () => {
    const store = new ArtifactStore();
    store.register(
      "run1:art1",
      "test.json",
      "application/json",
      Buffer.from("{}"),
    );
    const entry = store.toManifestEntry("run1", "run1:art1");
    expect(entry?.artifact_id).toBe("run1:art1");
    expect(entry?.download_url).toBe("/v1/runs/run1/artifacts/run1%3Aart1");
    expect(entry?.sha256).toHaveLength(64);
    expect(entry?.size_bytes).toBe(2);
  });
});

describe("isSafeArtifactId", () => {
  it("accepts safe opaque IDs", () => {
    expect(isSafeArtifactId("run1:art1")).toBe(true);
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
  });
});
