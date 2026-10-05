import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { annotationsCurrentPath, loadAnnotationsFile, saveAnnotationsFile } from "../src/index.js";

const FP = "f".repeat(64);
const T = "2026-09-10T10:00:00.000Z";
function seed() {
  const dir = mkdtempSync(join(tmpdir(), "ann-preserve-"));
  mkdirSync(join(dir, "annotations", "d"), { recursive: true });
  const stored = {
    version: 1,
    rev: 2,
    content_fingerprint: FP,
    x_top: { nested: [1, 2] },
    annotations: [
      {
        id: "a_00000001",
        target: { type: "document", x_target: 1 },
        body: "one",
        created_at: T,
        updated_at: T,
        x_ann: "keep",
      },
      {
        id: "a_00000002",
        target: { type: "document" },
        body: "two",
        created_at: T,
        updated_at: T,
        x_two: true,
      },
    ],
  };
  writeFileSync(annotationsCurrentPath(dir, "d"), `${JSON.stringify(stored, null, 2)}\n`);
  return { dir, stored };
}

describe("saveAnnotationsFile preserveUnknown", () => {
  it("keeps unknown top-level and per-annotation keys of untouched and updated annotations, and the schema gate still holds", () => {
    const { dir, stored } = seed();
    const file = loadAnnotationsFile(dir, "d");
    if (!file) throw new Error("fixture");
    const next = {
      ...file,
      annotations: [
        {
          ...(file.annotations[0] as object),
          body: "ONE CHANGED",
          updated_at: "2026-10-01T00:00:00.000Z",
        },
        file.annotations[1],
        {
          id: "a_00000003",
          target: { type: "document" as const },
          body: "new",
          created_at: T,
          updated_at: T,
        },
      ],
    } as typeof file;
    saveAnnotationsFile(dir, "d", next, { bumpRev: true, preserveUnknown: true });
    const raw = JSON.parse(readFileSync(annotationsCurrentPath(dir, "d"), "utf8"));
    expect(raw.x_top).toEqual({ nested: [1, 2] });
    expect(raw.rev).toBe(3);
    expect(raw.annotations[0]).toMatchObject({
      x_ann: "keep",
      body: "ONE CHANGED",
      target: { type: "document", x_target: 1 },
      created_at: T,
    });
    expect(raw.annotations[1]).toEqual(stored.annotations[1]);
    expect(raw.annotations[2].body).toBe("new");
    expect(loadAnnotationsFile(dir, "d")?.annotations).toHaveLength(3);
  });

  it("without the option the stored unknown keys are dropped (the page's PUT behaviour is unchanged)", () => {
    const { dir } = seed();
    const file = loadAnnotationsFile(dir, "d");
    if (!file) throw new Error("fixture");
    saveAnnotationsFile(dir, "d", file, { bumpRev: true });
    const raw = JSON.parse(readFileSync(annotationsCurrentPath(dir, "d"), "utf8"));
    expect(raw.x_top).toBeUndefined();
    expect(raw.annotations[0].x_ann).toBeUndefined();
  });

  it("duplicate ids are matched in order", () => {
    const { dir } = seed();
    const raw = JSON.parse(readFileSync(annotationsCurrentPath(dir, "d"), "utf8"));
    raw.annotations.push({ ...raw.annotations[0], x_ann: "second" });
    writeFileSync(annotationsCurrentPath(dir, "d"), JSON.stringify(raw));
    const file = loadAnnotationsFile(dir, "d");
    if (!file) throw new Error("fixture");
    saveAnnotationsFile(dir, "d", file, { preserveUnknown: true });
    const out = JSON.parse(readFileSync(annotationsCurrentPath(dir, "d"), "utf8"));
    expect(out.annotations.map((a: { x_ann?: string }) => a.x_ann)).toEqual([
      "keep",
      undefined,
      "second",
    ]);
  });
});
