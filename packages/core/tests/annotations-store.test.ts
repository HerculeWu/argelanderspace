/**
 * The document-annotation store (Stage 8 MS1): load/save against tmp dirs
 * (no network, no repo state), atomic-write behavior, error paths for
 * corrupt/invalid `current.json`, rev bump semantics, id generation, and the
 * pure CRUD helpers.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Annotation, AnnotationsFile } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import {
  AnnotationsError,
  addAnnotation,
  annotationsArchiveDir,
  annotationsCurrentPath,
  annotationsDocDir,
  annotationsRootDir,
  deleteAnnotation,
  emptyAnnotationsFile,
  loadAnnotationsFile,
  newAnnotationId,
  saveAnnotationsFile,
  updateAnnotationBody,
} from "../src/annotations/store.js";

const DOC = "arxiv-2501.17225";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "annotations-store-"));
}

function mkAnnotation(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    target: {
      type: "text",
      block: "p-1",
      container: { type: "content" },
      start: 0,
      end: 3,
      quote: "The",
    },
    body: `note for ${id}`,
    created_at: "2026-09-10T10:00:00.000Z",
    updated_at: "2026-09-10T10:00:00.000Z",
    ...overrides,
  };
}

function mkFile(annotations: Annotation[], rev = 0): AnnotationsFile {
  return { version: 1, rev, content_fingerprint: "f".repeat(64), annotations };
}

// --------------------------------------------------------------------------- //
// paths / id generation
// --------------------------------------------------------------------------- //

describe("paths + id generation", () => {
  it("resolves the standard layout under dataDir", () => {
    expect(annotationsRootDir("/d")).toBe("/d/annotations");
    expect(annotationsDocDir("/d", DOC)).toBe(`/d/annotations/${DOC}`);
    expect(annotationsCurrentPath("/d", DOC)).toBe(`/d/annotations/${DOC}/current.json`);
    expect(annotationsArchiveDir("/d", DOC)).toBe(`/d/annotations/${DOC}/archive`);
  });

  it("newAnnotationId matches a_ + 8 lowercase hex, and looks unique", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAnnotationId()));
    for (const id of ids) expect(id).toMatch(/^a_[0-9a-f]{8}$/);
    expect(ids.size).toBe(200);
  });

  it("emptyAnnotationsFile starts a fingerprint epoch at rev 0", () => {
    expect(emptyAnnotationsFile("abc")).toEqual({
      version: 1,
      rev: 0,
      content_fingerprint: "abc",
      annotations: [],
    });
  });
});

// --------------------------------------------------------------------------- //
// load / save
// --------------------------------------------------------------------------- //

describe("loadAnnotationsFile", () => {
  it("returns null when current.json does not exist (an empty file needs a fingerprint)", () => {
    expect(loadAnnotationsFile(tmpDataDir(), DOC)).toBeNull();
  });

  it("throws a typed corrupt_store error on corrupt JSON (never silently resets)", () => {
    const dir = tmpDataDir();
    saveAnnotationsFile(dir, DOC, mkFile([]));
    writeFileSync(annotationsCurrentPath(dir, DOC), "{ not json");
    let err: unknown;
    try {
      loadAnnotationsFile(dir, DOC);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AnnotationsError);
    expect((err as AnnotationsError).code).toBe("corrupt_store");
    expect((err as AnnotationsError).message).toMatch(/not valid JSON/);
    expect((err as AnnotationsError).message).toContain(annotationsCurrentPath(dir, DOC));
  });

  it("throws a typed corrupt_store error on schema-invalid JSON", () => {
    const dir = tmpDataDir();
    saveAnnotationsFile(dir, DOC, mkFile([]));
    writeFileSync(
      annotationsCurrentPath(dir, DOC),
      JSON.stringify({ version: 1, rev: -1, content_fingerprint: "f", annotations: [] })
    );
    let err: unknown;
    try {
      loadAnnotationsFile(dir, DOC);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AnnotationsError);
    expect((err as AnnotationsError).code).toBe("corrupt_store");
    expect((err as AnnotationsError).message).toMatch(/failed schema validation/);
  });
});

describe("saveAnnotationsFile", () => {
  it("round-trips a document with full fidelity", () => {
    const dir = tmpDataDir();
    const file = mkFile(
      [
        mkAnnotation("a_0123abcd"),
        mkAnnotation("a_beef0123", {
          target: { type: "structure", id: "fig-1", kind: "figure", snapshot: { number: "1" } },
          body: "带 $E=mc^2$ 的标注\n第二行",
        }),
      ],
      7
    );
    saveAnnotationsFile(dir, DOC, file);
    expect(loadAnnotationsFile(dir, DOC)).toEqual(file);
  });

  it("writes atomically: pretty-printed current.json, no .tmp residue, recursive mkdir", () => {
    const dir = join(tmpDataDir(), "nested", "literatures");
    const file = mkFile([mkAnnotation("a_0123abcd")], 1);
    saveAnnotationsFile(dir, DOC, file);
    expect(readFileSync(annotationsCurrentPath(dir, DOC), "utf8")).toBe(
      JSON.stringify(file, null, 2)
    );
    expect(readdirSync(annotationsDocDir(dir, DOC))).toEqual(["current.json"]);
  });

  it("keeps rev as given, or persists rev+1 with bumpRev (the PUT path)", () => {
    const dir = tmpDataDir();
    saveAnnotationsFile(dir, DOC, mkFile([], 5));
    expect(loadAnnotationsFile(dir, DOC)?.rev).toBe(5);
    saveAnnotationsFile(dir, DOC, mkFile([], 5), { bumpRev: true });
    expect(loadAnnotationsFile(dir, DOC)?.rev).toBe(6);
  });

  it("refuses to write an invalid document (nothing hits the disk)", () => {
    const dir = tmpDataDir();
    const bad = {
      version: 1,
      rev: 0,
      content_fingerprint: "f".repeat(64),
      annotations: [{ ...mkAnnotation("a_0123abcd"), body: "   " }],
    } as unknown as AnnotationsFile;
    expect(() => saveAnnotationsFile(dir, DOC, bad)).toThrowError(/refusing to write/);
    expect(existsSync(annotationsCurrentPath(dir, DOC))).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// CRUD helpers
// --------------------------------------------------------------------------- //

const BASE = mkFile(
  [
    mkAnnotation("a_aaaa0001"),
    mkAnnotation("a_bbbb0002", { target: { type: "document" } }),
    mkAnnotation("a_cccc0003"),
  ],
  4
);

describe("annotation CRUD", () => {
  it("addAnnotation appends and rejects a duplicate id", () => {
    const next = addAnnotation(BASE, mkAnnotation("a_dddd0004"));
    expect(next.annotations.map((a) => a.id)).toEqual([
      "a_aaaa0001",
      "a_bbbb0002",
      "a_cccc0003",
      "a_dddd0004",
    ]);
    expect(next.rev).toBe(BASE.rev); // helpers never touch rev
    expect(next.content_fingerprint).toBe(BASE.content_fingerprint);
    expect(() => addAnnotation(BASE, mkAnnotation("a_aaaa0001"))).toThrowError(
      /duplicate annotation id/
    );
  });

  it("updateAnnotationBody replaces the body and bumps updated_at", () => {
    const now = "2026-09-10T12:34:56.789Z";
    const next = updateAnnotationBody(BASE, "a_bbbb0002", "改过的正文", now);
    const a = next.annotations[1];
    expect(a?.body).toBe("改过的正文");
    expect(a?.updated_at).toBe(now);
    expect(a?.created_at).toBe(BASE.annotations[1]?.created_at); // immutable
    expect(a?.target).toEqual(BASE.annotations[1]?.target); // immutable
    // siblings untouched
    expect(next.annotations[0]).toEqual(BASE.annotations[0]);
    expect(() => updateAnnotationBody(BASE, "a_deadbeef", "x", now)).toThrowError(
      /no annotation with id/
    );
  });

  it("updateAnnotationBody is a byte-exact no-op when the body is unchanged", () => {
    const same = updateAnnotationBody(BASE, "a_aaaa0001", "note for a_aaaa0001");
    expect(same).toBe(BASE); // same reference: updated_at must NOT move
    // a trailing-space change IS a byte change and bumps updated_at
    const next = updateAnnotationBody(
      BASE,
      "a_aaaa0001",
      "note for a_aaaa0001 ",
      "2026-09-11T00:00:00.000Z"
    );
    expect(next.annotations[0]?.updated_at).toBe("2026-09-11T00:00:00.000Z");
  });

  it("updateAnnotationBody rejects a trim-empty body (fail fast; raw whitespace kept otherwise)", () => {
    for (const body of ["", "  ", "\n\t"]) {
      expect(() => updateAnnotationBody(BASE, "a_aaaa0001", body)).toThrowError(
        /body must not be empty/
      );
    }
    const next = updateAnnotationBody(BASE, "a_aaaa0001", "  留白也算内容  \n");
    expect(next.annotations[0]?.body).toBe("  留白也算内容  \n"); // no trimming
  });

  it("deleteAnnotation removes the annotation and rejects an unknown id", () => {
    const next = deleteAnnotation(BASE, "a_bbbb0002");
    expect(next.annotations.map((a) => a.id)).toEqual(["a_aaaa0001", "a_cccc0003"]);
    expect(() => deleteAnnotation(BASE, "a_deadbeef")).toThrowError(/no annotation with id/);
  });
});

describe("helper purity", () => {
  it("no helper mutates its input AnnotationsFile", () => {
    const ops: ((f: AnnotationsFile) => AnnotationsFile)[] = [
      (f) => addAnnotation(f, mkAnnotation("a_dddd0004")),
      (f) => updateAnnotationBody(f, "a_aaaa0001", "改名", "2026-09-10T13:00:00.000Z"),
      (f) => deleteAnnotation(f, "a_bbbb0002"),
    ];
    for (const op of ops) {
      const input = structuredClone(BASE);
      const snapshot = structuredClone(BASE);
      op(input);
      expect(input).toEqual(snapshot);
    }
  });
});
