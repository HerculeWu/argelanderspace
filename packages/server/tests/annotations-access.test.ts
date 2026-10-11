/**
 * The annotations access path as its own module (ticket 38): the archive authority of the contract, tested without
 * the app. A real AsyncLock, a real DocMutationRegistry, a recording `onChanged`, synthetic data under a temp dir.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Annotation, AnnotationsFile, TexDocIr } from "@argelanderspace/contracts";
import {
  AnnotationsError,
  type AnnotationsErrorCode,
  annotationsArchiveDir,
  annotationsCurrentPath,
  type LibraryPaths,
  libraryPaths,
  readDocumentForReading,
  saveAnnotationsFile,
} from "@argelanderspace/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAnnotationAccess, DocMetadataError } from "../src/annotations-access.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { AsyncLock } from "../src/lock.js";

const DOC = "demo";
const NOTE: Annotation = {
  id: "a_12345678",
  target: { type: "document" },
  body: "  keep\nme  ",
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
};

let dataDir: string;
let paths: LibraryPaths;
let docDir: string;
let currentPath: string;
let archiveDir: string;
let ir: TexDocIr;
let lock: AsyncLock;
let held: boolean;
let registry: DocMutationRegistry;
/** Each notification with whether the lock was held when it was sent and what current.json held then. */
let changes: { docId: string; kind: "put" | "invalidate"; inLock: boolean; disk: string | null }[];
let access: ReturnType<typeof createAnnotationAccess>;

const persist = () => fs.writeFileSync(join(docDir, `${DOC}.json`), JSON.stringify(ir));
const disk = () => (fs.existsSync(currentPath) ? fs.readFileSync(currentPath, "utf8") : null);
const archives = () =>
  fs.existsSync(archiveDir) && fs.statSync(archiveDir).isDirectory()
    ? fs.readdirSync(archiveDir).filter((n) => n.endsWith(".json"))
    : [];
const fingerprintNow = () => readDocumentForReading(dataDir, DOC).file.content_fingerprint;
function changeText() {
  const first = ir.sections[0];
  if (!first) throw new Error("missing synthetic section");
  first.heading = "Replacement";
  persist();
}
/** A saved current with one note, rev 3, bound to `fingerprint`, plus a top-level key the schema does not know. */
function seed(fingerprint = fingerprintNow()): AnnotationsFile {
  const file: AnnotationsFile = {
    version: 1,
    rev: 3,
    content_fingerprint: fingerprint,
    annotations: [NOTE],
  };
  saveAnnotationsFile(dataDir, DOC, file);
  fs.writeFileSync(currentPath, `${JSON.stringify({ ...file, x_top: { keep: true } }, null, 3)}\n`);
  return file;
}
const withNote = (file: AnnotationsFile, body: string): AnnotationsFile => ({
  ...file,
  annotations: [...file.annotations, { ...NOTE, id: "a_0000beef", body }],
});
const errorOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(join(tmpdir(), "annotations-access-"));
  paths = libraryPaths(dataDir);
  docDir = join(dataDir, "output", DOC);
  currentPath = annotationsCurrentPath(dataDir, DOC);
  archiveDir = annotationsArchiveDir(dataDir, DOC);
  fs.mkdirSync(join(docDir, "assets"), { recursive: true });
  fs.writeFileSync(join(docDir, "assets", "a.svg"), "asset A");
  ir = {
    version: 1,
    docId: DOC,
    sections: [
      {
        id: "s",
        level: 1,
        heading: "Heading",
        children: [],
        blocks: [
          { id: "p", type: "paragraph", segments: [{ type: "text", text: "Body" }] },
          { id: "f", type: "figure", imgPath: "a.svg" },
        ],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: "/tmp/synthetic", main_tex: "main.tex" },
    meta: { title: "A" },
  };
  persist();
  lock = new AsyncLock();
  held = false;
  const run = lock.run.bind(lock);
  vi.spyOn(lock, "run").mockImplementation(((fn: () => unknown) =>
    run(() => {
      held = true;
      try {
        return fn();
      } finally {
        held = false;
      }
    })) as AsyncLock["run"]);
  registry = new DocMutationRegistry();
  changes = [];
  access = createAnnotationAccess({
    paths,
    lock,
    docMutations: registry,
    onChanged: (docId, kind) => changes.push({ docId, kind, inLock: held, disk: disk() }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("commit: every outcome", () => {
  test.each(["writer", "delete"])(
    "busy (%s) is the first step: no ensure even without the IR, no archive, no notification",
    async (kind) => {
      seed("e".repeat(64)); // would archive if ensure ran
      const before = fs.readFileSync(currentPath);
      if (kind === "writer") registry.pinWriter(DOC);
      else expect(registry.tryBeginDelete(DOC)).toBe(true);
      fs.unlinkSync(join(docDir, `${DOC}.json`)); // not_found if anything past busy ran
      const build = vi.fn();
      expect(await access.commit(DOC, { fingerprint: "e".repeat(64), rev: 3 }, build)).toEqual({
        kind: "busy",
      });
      expect(await access.read(DOC)).toEqual({ kind: "busy" });
      expect(await access.peek(DOC)).toEqual({ kind: "busy" });
      expect(build).not.toHaveBeenCalled();
      expect(fs.readFileSync(currentPath)).toEqual(before);
      expect(fs.existsSync(archiveDir)).toBe(false);
      expect(changes).toEqual([]);
    }
  );

  test("busy is checked inside the lock, after waiting for it", async () => {
    const file = seed();
    const before = fs.readFileSync(currentPath);
    let release!: () => void;
    const gate = lock.run(() => new Promise<void>((resolve) => (release = resolve)));
    const pending = access.commit(DOC, { fingerprint: file.content_fingerprint, rev: 3 }, () => ({
      next: withNote(file, "late"),
    }));
    await Promise.resolve();
    registry.pinWriter(DOC); // the Doc became busy while the commit waited for the same lock
    release();
    await gate;
    expect(await pending).toEqual({ kind: "busy" });
    expect(fs.readFileSync(currentPath)).toEqual(before);
    expect(changes).toEqual([]);
  });

  test("a PDF Doc is refused before ensure; read and peek refuse it too", async () => {
    const pdfDir = join(dataDir, "output", "pdfdoc");
    fs.mkdirSync(pdfDir, { recursive: true });
    fs.writeFileSync(
      join(pdfDir, "pdfdoc.json"),
      JSON.stringify({
        version: 1,
        doc_id: "pdfdoc",
        format: "pdf",
        display_name: "P",
        original_filename: "p.pdf",
        acquired_via: "user_pdf_upload",
        acquired_at: "2026-09-10T10:00:00.000Z",
        byte_length: 10,
        sha256: "a".repeat(64),
        page_count: 1,
        pages: [{ width: 100, height: 100, rotation: 0 }],
      })
    );
    const build = vi.fn();
    expect(await access.commit("pdfdoc", { fingerprint: "a".repeat(64), rev: 0 }, build)).toEqual({
      kind: "pdf",
    });
    expect(await access.read("pdfdoc")).toEqual({ kind: "pdf" });
    expect(await access.peek("pdfdoc")).toEqual({ kind: "pdf" });
    expect(build).not.toHaveBeenCalled();
    expect(fs.existsSync(join(dataDir, "annotations", "pdfdoc"))).toBe(false);
    expect(changes).toEqual([]);
  });

  test("a corrupt PDF metadata file is a DocMetadataError, never a mismatch or a reset", async () => {
    const badDir = join(dataDir, "output", "bad-pdf");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(join(badDir, "original.pdf"), "%PDF-broken"); // a PDF marker without its metadata
    const build = vi.fn();
    for (const attempt of [
      () => access.commit("bad-pdf", { fingerprint: "a".repeat(64), rev: 0 }, build),
      () => access.read("bad-pdf"),
      () => access.peek("bad-pdf"),
    ]) {
      const err = await errorOf(attempt());
      expect(err).toBeInstanceOf(DocMetadataError);
      expect((err as Error).message).toBe("the Doc's metadata could not be read");
    }
    expect(build).not.toHaveBeenCalled();
    expect(fs.existsSync(join(dataDir, "annotations", "bad-pdf"))).toBe(false);
    expect(changes).toEqual([]);
  });

  test("document_changed: the fingerprint check precedes the rev check; nothing is written", async () => {
    const file = seed();
    const before = fs.readFileSync(currentPath);
    const build = vi.fn();
    const result = await access.commit(DOC, { fingerprint: "f".repeat(64), rev: 999 }, build);
    expect(result).toEqual({ kind: "document_changed", file });
    expect(build).not.toHaveBeenCalled();
    expect(fs.readFileSync(currentPath)).toEqual(before);
    expect(changes).toEqual([]);
  });

  test("document_changed after a replacement: the old batch is archived, invalidate is sent in the lock, archived counts it", async () => {
    seed();
    const before = fs.readFileSync(currentPath);
    changeText();
    const result = await access.commit(DOC, { fingerprint: "f".repeat(64), rev: 3 }, vi.fn());
    expect(result).toMatchObject({
      kind: "document_changed",
      archived: 1,
      file: { rev: 0, annotations: [], content_fingerprint: fingerprintNow() },
    });
    expect(archives()).toHaveLength(1);
    expect(fs.readFileSync(join(archiveDir, archives()[0] as string))).toEqual(before);
    expect(changes).toEqual([
      { docId: DOC, kind: "invalidate", inLock: true, disk: expect.any(String) },
    ]);
  });

  test("rev_mismatch carries the current rev; nothing is written", async () => {
    const file = seed();
    const before = fs.readFileSync(currentPath);
    const build = vi.fn();
    expect(
      await access.commit(DOC, { fingerprint: file.content_fingerprint, rev: 2 }, build)
    ).toEqual({ kind: "rev_mismatch", rev: 3 });
    expect(build).not.toHaveBeenCalled();
    expect(fs.readFileSync(currentPath)).toEqual(before);
    expect(changes).toEqual([]);
  });

  test("skipped: build sees the ensured epoch, its value comes back, nothing is written or announced", async () => {
    const file = seed();
    const before = fs.readFileSync(currentPath);
    const result = await access.commit<string>(
      DOC,
      { fingerprint: file.content_fingerprint, rev: 3 },
      (epoch) => {
        expect(epoch.file).toEqual(file);
        expect(epoch.invalidated).toBe(false);
        return { skip: "nothing to do" };
      }
    );
    expect(result).toEqual({ kind: "skipped", file, value: "nothing to do" });
    expect(fs.readFileSync(currentPath)).toEqual(before);
    expect(changes).toEqual([]);
  });

  test("saved: the returned file is {...next, rev + 1}, not a re-read; put is sent once, after the lock is released", async () => {
    const file = seed();
    const next = withNote(file, "added");
    const result = await access.commit(
      DOC,
      { fingerprint: file.content_fingerprint, rev: 3 },
      () => ({ next, preserveUnknown: true })
    );
    expect(result).toEqual({ kind: "saved", file: { ...next, rev: 4 } });
    // the stored file kept its unknown key; the returned file was not read back, so it has none
    expect(JSON.parse(disk() as string)).toMatchObject({ rev: 4, x_top: { keep: true } });
    expect(changes).toEqual([{ docId: DOC, kind: "put", inLock: false, disk: disk() }]);
  });

  test("saved over a replacement: invalidate in the lock once the new current exists and before the save, put after the lock", async () => {
    seed();
    changeText();
    const fingerprint = fingerprintNow();
    const result = await access.commit(DOC, { fingerprint, rev: 0 }, (epoch) => ({
      next: withNote(epoch.file, "new epoch"),
    }));
    expect(result).toMatchObject({ kind: "saved", archived: 1, file: { rev: 1 } });
    expect(changes.map(({ kind, inLock }) => ({ kind, inLock }))).toEqual([
      { kind: "invalidate", inLock: true },
      { kind: "put", inLock: false },
    ]);
    // at invalidate the new, empty current was on disk and the request was not yet saved
    expect(JSON.parse(changes[0]?.disk as string)).toEqual({
      version: 1,
      rev: 0,
      content_fingerprint: fingerprint,
      annotations: [],
    });
    expect(JSON.parse(changes[1]?.disk as string)).toMatchObject({ rev: 1 });
  });

  test.each([true, false])(
    "preserveUnknown %s: the Copilot's narrow write keeps unknown keys, the page's whole-file PUT does not",
    async (preserveUnknown) => {
      const file = seed();
      await access.commit(DOC, { fingerprint: file.content_fingerprint, rev: 3 }, () => ({
        next: withNote(file, "x"),
        ...(preserveUnknown ? { preserveUnknown: true } : {}),
      }));
      const stored = JSON.parse(disk() as string);
      if (preserveUnknown) expect(stored.x_top).toEqual({ keep: true });
      else expect(stored).not.toHaveProperty("x_top");
    }
  );

  test("two commits on the same rev: exactly one is saved, the other is a rev mismatch", async () => {
    const file = seed();
    const expect_ = { fingerprint: file.content_fingerprint, rev: 3 };
    const results = await Promise.all([
      access.commit(DOC, expect_, () => ({ next: withNote(file, "one") })),
      access.commit(DOC, expect_, () => ({ next: withNote(file, "two") })),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["rev_mismatch", "saved"]);
    expect(results.find((r) => r.kind === "rev_mismatch")).toEqual({
      kind: "rev_mismatch",
      rev: 4,
    });
    expect(changes.map((c) => c.kind)).toEqual(["put"]);
  });
});

describe("cannot compute: a system error that leaves every byte, never a mismatch", () => {
  const failures: [string, AnnotationsErrorCode, () => void][] = [
    ["doc missing", "not_found", () => fs.unlinkSync(join(docDir, `${DOC}.json`))],
    [
      "IR schema-invalid",
      "corrupt_ir",
      () => fs.writeFileSync(join(docDir, `${DOC}.json`), '{"version":1}'),
    ],
    ["current.json damaged", "corrupt_store", () => fs.writeFileSync(currentPath, "{user broken")],
    [
      "hash cannot be computed",
      "fingerprint",
      () => {
        vi.spyOn(crypto, "createHash").mockImplementation(() => {
          throw new Error("synthetic hash failure");
        });
        syncBuiltinESMExports();
      },
    ],
    ["asset lost", "fingerprint", () => fs.unlinkSync(join(docDir, "assets", "a.svg"))],
    [
      "asset unreadable",
      "fingerprint",
      () => {
        fs.unlinkSync(join(docDir, "assets", "a.svg"));
        fs.mkdirSync(join(docDir, "assets", "a.svg"));
      },
    ],
    [
      "archive cannot be written",
      "archive",
      () => {
        changeText();
        fs.writeFileSync(archiveDir, "not a directory");
      },
    ],
    [
      "archived but the new current cannot be created",
      "new_current",
      () => {
        changeText();
        fs.mkdirSync(`${currentPath}.tmp`);
      },
    ],
  ];

  test.each(failures)("%s → AnnotationsError %s from commit and read", async (_, code, fail) => {
    const file = seed();
    fail();
    const before = fs.readFileSync(currentPath);
    const build = vi.fn();
    for (const attempt of [
      () => access.commit(DOC, { fingerprint: file.content_fingerprint, rev: 3 }, build),
      () => access.read(DOC),
    ]) {
      const err = await errorOf(attempt());
      expect(err).toBeInstanceOf(AnnotationsError);
      expect((err as AnnotationsError).code).toBe(code);
      expect(fs.readFileSync(currentPath)).toEqual(before);
    }
    expect(build).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
    if (code === "new_current") {
      // the old batch is safe in the archive (once per access); the next access rebuilds the new current
      expect(archives()).toHaveLength(2);
      for (const name of archives())
        expect(fs.readFileSync(join(archiveDir, name))).toEqual(before);
      fs.rmSync(`${currentPath}.tmp`, { recursive: true });
      expect(await access.read(DOC)).toMatchObject({ kind: "ok", epoch: { invalidated: true } });
      expect(changes.map((c) => c.kind)).toEqual(["invalidate"]);
    } else expect(archives()).toEqual([]);
  });

  test.each(failures.filter(([, code]) => code !== "archive" && code !== "new_current"))(
    "%s → peek throws AnnotationsError %s and writes nothing",
    async (_, code, fail) => {
      seed();
      fail();
      const before = fs.readFileSync(currentPath);
      const err = await errorOf(access.peek(DOC));
      expect((err as AnnotationsError).code).toBe(code);
      expect(fs.readFileSync(currentPath)).toEqual(before);
      expect(changes).toEqual([]);
    }
  );
});

describe("read and peek", () => {
  test("read ensures: a replaced text archives the old batch, sends invalidate in the lock and returns the new epoch", async () => {
    seed();
    const before = fs.readFileSync(currentPath);
    changeText();
    const result = await access.read(DOC);
    expect(result).toMatchObject({
      kind: "ok",
      epoch: {
        invalidated: true,
        archivedCount: 1,
        file: { rev: 0, annotations: [], content_fingerprint: fingerprintNow() },
        ir: { docId: DOC },
      },
    });
    expect(archives()).toHaveLength(1);
    expect(fs.readFileSync(join(archiveDir, archives()[0] as string))).toEqual(before);
    expect(changes.map(({ kind, inLock }) => ({ kind, inLock }))).toEqual([
      { kind: "invalidate", inLock: true },
    ]);
  });

  test("read of an unchanged Doc does not write the ephemeral empty file and sends nothing", async () => {
    const result = await access.read(DOC);
    expect(result).toMatchObject({ kind: "ok", epoch: { invalidated: false, file: { rev: 0 } } });
    expect(fs.existsSync(currentPath)).toBe(false);
    expect(changes).toEqual([]);
  });

  test("peek is read-only: a replaced text is reported stale, nothing is archived, written or announced", async () => {
    seed();
    const before = fs.readFileSync(currentPath);
    changeText();
    const result = await access.peek(DOC);
    expect(result).toMatchObject({
      kind: "ok",
      reading: {
        stale: true,
        file: { rev: 0, annotations: [], content_fingerprint: fingerprintNow() },
        ir: { docId: DOC },
      },
    });
    expect(fs.readFileSync(currentPath)).toEqual(before);
    expect(fs.existsSync(archiveDir)).toBe(false);
    expect(changes).toEqual([]);
  });

  test("peek waits for the same lock", async () => {
    let release!: () => void;
    const gate = lock.run(() => new Promise<void>((resolve) => (release = resolve)));
    let done = false;
    const pending = access.peek(DOC).then((r) => {
      done = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    release();
    await gate;
    expect(await pending).toMatchObject({ kind: "ok" });
  });
});

describe("describeError: the one code → status/detail table; no detail names a path", () => {
  const table: [AnnotationsErrorCode, 404 | 500, string][] = [
    [
      "corrupt_ir",
      500,
      "the stored document is damaged or outdated and cannot be read; nothing was changed",
    ],
    [
      "corrupt_store",
      500,
      "the saved annotations file is damaged; nothing was changed and nothing was read",
    ],
    [
      "fingerprint",
      500,
      "an image or other asset the document declares is missing or unreadable, so the document cannot be verified; nothing was changed",
    ],
    [
      "archive",
      500,
      "the annotations of older text could not be moved to the archive, so the saved annotations were left exactly as they were; nothing was changed",
    ],
    [
      "new_current",
      500,
      "the annotations of older text were archived (they are no longer current), but the new, empty annotations file could not be created, so nothing of your request was written; the next access creates it",
    ],
    ["not_found", 404, "no such Doc"],
  ];
  test.each(table)("%s → %s", (code, status, detail) => {
    const err = new AnnotationsError(
      code,
      `annotations store: ${dataDir}/annotations/x/current.json`
    );
    expect(access.describeError(err)).toEqual({ status, detail });
  });
});
