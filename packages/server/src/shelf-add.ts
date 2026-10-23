/**
 * Adding to the Shelf (文献仓), replacing an entry of the same paper, and deleting an entry (shelf ticket 03;
 * docs/contracts.md「文献仓」; docs/library.md「文献仓」; shapes in contracts `shelf-write.ts`):
 *
 *   POST   /api/shelf/entries                   add; with `confirm`, replace the entries of the same paper
 *   POST   /api/shelf/entries/preview           what that add would do now, read only (no ensure, nothing written)
 *   DELETE /api/shelf/entries/:entryId?rev=<n>   delete one entry at the rev the page showed
 *
 * The Shelf is global data, written by infra's store (`createShelfStore`: a cross-process lock, the entry written
 * beside and renamed into place). This module reads the project and hands the store bytes; it never writes the
 * project, with one exception the contract names: reading the current annotations of a LaTeX/text Doc goes through
 * the annotations access path (annotations-access.ts `together`), whose ensure archives a batch made stale by a
 * content change, exactly as any other access would.
 *
 * Reading an add happens in ONE synchronous critical section on the app's annotationLock (through the access path's
 * `together`), so every file it copies is of one moment for this process and no write of this server (annotation
 * saves, PDF annotation writes, text publications, a Doc delete's claim, an upload's pin) can come between two reads.
 * In that section, in this order, so that a refusal leaves the project untouched:
 *   1. the library: the Work, and every chosen Doc listed by it;
 *   2. no chosen Doc is busy in the DocMutationRegistry (written or being deleted);
 *   3. each Doc's kind (a text Doc by its id, a PDF Doc by its metadata, else LaTeX), its files (contracts
 *      `shelfDocFileAllowed` is the one rule of which files go) and checks: a PDF Doc's single owner, its original
 *      against the recorded size and SHA-256 and its annotation sidecar's binding; a text Doc's source and its
 *      registered images; the reading text of a LaTeX/text Doc, every image it declares among the carried files, and
 *      the read-only fingerprint — nothing is written;
 *   4. the argument graph and the note, when chosen;
 *   5. only then, for the Docs whose annotations were chosen, the current annotations: the access path's ensure
 *      (LaTeX/text) or the verified sidecar (PDF), filtered to the chosen ids. The archive is never read. The preview
 *      reads the current file instead (no ensure) and counts a file of older content as carrying none.
 * Anything that cannot be read or does not verify stops the add before the Shelf is touched, naming the object, the
 * file when it is one (a path inside the Doc's folder) and a reason category (never content). Annotations chosen but
 * not current any more (deleted meanwhile, or archived by that ensure) do not go in and are reported in `notCarried`.
 * A PDF's reading position never goes.
 *
 * Replacing: a Work with a DOI, arXiv or OpenAlex id that the Shelf already has is answered 409
 * `confirmation_required` with what a replacement removes (every entry of the same paper, at its rev). Only a request
 * that brings that impact back unchanged as `confirm` replaces: the impact is compared with the Shelf as it is now,
 * and the store compares the entries and revs again under its lock; any difference is 409 `confirmation_changed` and
 * nothing is written. Nothing is held while the person decides. A Work without any of the three ids is never "the
 * same paper": each add makes a new entry.
 *
 * Only the failures this module knows are answered with a code: a refusal, a part that cannot be read, a Shelf entry
 * that cannot be read, the store's input refusal or a system error of its write. Anything else is thrown to the app
 * (its error answer and the request record), never reported as a failed write.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isShelfRelativePath,
  SHELF_EXCLUDED_WORK_FIELDS,
  type ShelfAddPreviewRequest,
  ShelfAddPreviewRequestSchema,
  type ShelfAddPreviewResponse,
  ShelfAddRequestSchema,
  type ShelfAddResponse,
  type ShelfArchived,
  type ShelfBibliography,
  type ShelfDocKind,
  type ShelfEntryRefDto,
  type ShelfIdentity,
  type ShelfItem,
  type ShelfItemProblem,
  type ShelfReplacedEntry,
  type ShelfReplaceImpact,
  type ShelfWriteRefusal,
  shelfAnnotationCount,
  shelfDocFileAllowed,
  shelfDocRequiredFiles,
} from "@argelanderspace/contracts";
import {
  AnnotationsError,
  ArgumentGraphFileError,
  annotationsCurrentPath,
  argumentGraphPath,
  docContentFingerprint,
  isTextDocId,
  type LibraryPaths,
  LibraryStore,
  loadAnnotationsFile,
  loadArgumentGraph,
  loadStoredDocIr,
  PdfContentChangedError,
  readPdfAnnotationsFile,
  readPdfMetadataIfPresent,
  readTextSource,
  readVerifiedPdf,
  type Work,
} from "@argelanderspace/core";
import {
  configFilePath,
  createShelfStore,
  pinnedGlobalDirs,
  readConfigLeniently,
  resolveGlobalDirsLeniently,
  SHELF_DIR,
  type ShelfDocInput,
  type ShelfEntry,
  ShelfInputError,
  ShelfIoError,
  type ShelfPutInput,
  type ShelfPutResult,
  type ShelfStore,
  shelfIdentityOf,
} from "@argelanderspace/infra";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AnnotationAccess, TogetherAccess } from "./annotations-access.js";
import type { ProtectedRoutes } from "./protected-app.js";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface ShelfWriteDeps {
  paths: LibraryPaths;
  /** The project folder, recorded in the entry as where it was added from. */
  projectRoot: string;
  /** The app's one annotations access path (its `together` section is on the one annotationLock). */
  annotations: Pick<AnnotationAccess, "together">;
  /** The Shelf store, looked up at each request (the global data directory may be resolved per request). */
  store: () => ShelfStore;
  /**
   * After the Shelf changed: the app's `shelf.changed` notification. `removed` are the entry revs gone with it (every
   * target of a replacement as confirmed, the deleted one of a delete, none for an add).
   */
  onChanged: (
    cause: "add" | "replace" | "delete",
    entry: ShelfEntryRefDto,
    removed: ShelfEntryRefDto[]
  ) => void;
}

export interface ShelfAnswer {
  status: ContentfulStatusCode;
  body: Record<string, unknown>;
}

export interface ShelfWriter {
  add(body: unknown): Promise<ShelfAnswer>;
  preview(body: unknown): Promise<ShelfAnswer>;
  remove(entryId: string, rev: string | undefined): Promise<ShelfAnswer>;
}

const refusal = (
  status: ContentfulStatusCode,
  code: ShelfWriteRefusal,
  detail: string,
  extra: Record<string, unknown> = {}
): ShelfAnswer => ({ status, body: { detail, code, ...extra } });

/** A part of the add that could not be read or did not verify. Thrown inside the read section, answered as 500. */
class ItemProblem extends Error {
  constructor(
    readonly item: ShelfItem,
    readonly problem: ShelfItemProblem
  ) {
    super(`${item.kind} ${problem}`);
  }
}

/** A refusal decided inside the read section (not a read failure). */
class Refused extends Error {
  constructor(readonly answer: ShelfAnswer) {
    super(String(answer.body.code));
  }
}

const docItem = (docId: string, path?: string): ShelfItem =>
  path === undefined ? { kind: "doc", docId } : { kind: "doc", docId, path };

const errnoOf = (err: unknown): string | null => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : null;
};

/** A file not there is `incomplete`, any other system error `unreadable`; anything else (a check) is `fallback`. */
const problemOf = (err: unknown, fallback: ShelfItemProblem): ShelfItemProblem => {
  const code = errnoOf(err);
  if (code === "ENOENT" || code === "ENOTDIR") return "incomplete";
  return code ? "unreadable" : fallback;
};

/**
 * What an AnnotationsError of the reading text / annotations is, as an item problem (the categories of the access
 * path's own `describeError`): the two write failures of the ensure keep their own names.
 */
const annotationsProblem = (err: AnnotationsError): ShelfItemProblem => {
  switch (err.code) {
    case "not_found":
      return "missing";
    case "corrupt_ir":
      return "invalid";
    case "fingerprint":
      return "asset_mismatch";
    case "corrupt_store":
      return "annotations_invalid";
    case "archive":
      return "annotations_archive_failed";
    case "new_current":
      return "annotations_new_current_failed";
  }
};

const ITEM_DETAIL: Record<ShelfItemProblem, string> = {
  missing: "is not there",
  incomplete: "lacks a file it needs",
  not_a_regular_file:
    "has a link or something other than a plain file or folder where a file is expected",
  unreadable: "could not be read",
  invalid: "is damaged or of a later version",
  asset_mismatch:
    "declares an image or other asset that is missing or does not match its recorded hash",
  asset_outside_carried:
    "declares an image at a place the Shelf does not carry (outside its assets folder)",
  content_changed: "does not match its recorded size and hash",
  ownership: "is not listed by exactly one Work",
  annotations_invalid: "is damaged or not bound to its Doc",
  annotations_archive_failed:
    "were of older content and could not be moved to the archive; they were left exactly as they were",
  annotations_new_current_failed:
    "were of older content and were archived, but the new empty annotations file could not be created (the next access creates it)",
};

const itemName = (item: ShelfItem): string => {
  const at =
    (item.kind === "doc" || item.kind === "annotations") && item.path ? ` (${item.path})` : "";
  return item.kind === "doc"
    ? `Doc ${item.docId}${at}`
    : item.kind === "annotations"
      ? `the annotations of Doc ${item.docId}${at}`
      : item.kind === "argument_graph"
        ? "the argument graph"
        : "the library";
};

const itemRefusal = (err: ItemProblem): ShelfAnswer =>
  refusal(
    500,
    "item_unreadable",
    `${itemName(err.item)} ${ITEM_DETAIL[err.problem]}; nothing was written to the Shelf`,
    { item: err.item, problem: err.problem }
  );

/** The bibliography snapshot: every field of the Work but the project's own (contracts `SHELF_EXCLUDED_WORK_FIELDS`). */
function bibliographyOf(work: Work): ShelfBibliography {
  const out: Record<string, unknown> = { ...work };
  for (const key of SHELF_EXCLUDED_WORK_FIELDS) delete out[key];
  return out as ShelfBibliography;
}

/** One chosen Doc's files, as `shelfDocFileAllowed` picks them; links and odd entries where a file goes refuse. */
function docFiles(
  kind: ShelfDocKind,
  docId: string,
  docDir: string
): { path: string; bytes: Buffer }[] {
  const files: { path: string; bytes: Buffer }[] = [];
  const read = (rel: string) => {
    try {
      files.push({ path: rel, bytes: readFileSync(join(docDir, rel)) });
    } catch (err) {
      throw new ItemProblem(docItem(docId, rel), problemOf(err, "unreadable"));
    }
  };
  const list = (rel: string) => {
    try {
      return readdirSync(rel ? join(docDir, rel) : docDir, { withFileTypes: true });
    } catch (err) {
      throw new ItemProblem(docItem(docId, rel || undefined), problemOf(err, "unreadable"));
    }
  };
  const walkAssets = (rel: string) => {
    for (const entry of list(rel)) {
      const path = `${rel}/${entry.name}`;
      // Hidden names are the writers' temporary files, never part of a Doc.
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        walkAssets(path);
        continue;
      }
      if (!entry.isFile()) throw new ItemProblem(docItem(docId, path), "not_a_regular_file");
      // A file under assets/ the Shelf could not carry (a too deep or too long path) would be lost silently.
      if (!isShelfRelativePath(path) || !shelfDocFileAllowed(kind, docId, path))
        throw new ItemProblem(docItem(docId, path), "invalid");
      read(path);
    }
  };
  for (const entry of list("")) {
    if (entry.name === "assets" && kind !== "pdf") {
      if (!entry.isDirectory())
        throw new ItemProblem(docItem(docId, "assets"), "not_a_regular_file");
      walkAssets("assets");
      continue;
    }
    // src/, build/, reading-position.json, the PDF annotation sidecar, temporary files: not Doc files of the Shelf.
    if (!shelfDocFileAllowed(kind, docId, entry.name)) continue;
    if (!entry.isFile()) throw new ItemProblem(docItem(docId, entry.name), "not_a_regular_file");
    read(entry.name);
  }
  const have = new Set(files.map((f) => f.path));
  for (const required of shelfDocRequiredFiles(kind, docId))
    if (!have.has(required)) throw new ItemProblem(docItem(docId, required), "incomplete");
  return files;
}

/** Every `imgPath` the reading text declares (figures and tables: what the content fingerprint hashes). */
function declaredImages(ir: { sections: unknown[] }): string[] {
  const out: string[] = [];
  const walk = (sections: unknown[]) => {
    for (const s of sections as { blocks?: unknown[]; children?: unknown[] }[]) {
      for (const b of (s.blocks ?? []) as { imgPath?: unknown }[])
        if (typeof b.imgPath === "string") out.push(b.imgPath);
      walk(s.children ?? []);
    }
  };
  walk(ir.sections);
  return out;
}

/**
 * Every image the reading text declares must be among the files that go, at the place the Reader looks for it (core's
 * rule: a bare name is under `assets/`, a path with a folder is relative to the Doc's folder). One outside `assets/`
 * cannot go, and an entry without it would show a missing image: the Doc does not verify.
 */
function checkDeclaredImages(
  docId: string,
  docDir: string,
  ir: { sections: unknown[] },
  carried: Set<string>
): void {
  for (const imgPath of declaredImages(ir)) {
    if (
      imgPath.includes("\\") ||
      imgPath.includes("\0") ||
      imgPath.split("/").some((s) => s === "" || s === ".." || s.startsWith("."))
    )
      throw new ItemProblem(docItem(docId), "invalid");
    const path = imgPath.includes("/") ? imgPath : `assets/${imgPath}`;
    if (carried.has(path)) continue;
    if (!path.startsWith("assets/") && existsSync(join(docDir, path)))
      throw new ItemProblem(docItem(docId, path), "asset_outside_carried");
    throw new ItemProblem(docItem(docId, path), "asset_mismatch");
  }
}

/** The raw annotations file filtered to the chosen ids, every other key as stored; null when none of them is in it. */
function filterAnnotations(
  raw: Buffer,
  chosen: readonly string[],
  item: ShelfItem
): {
  copy: { count: number; bytes: Buffer } | null;
  missing: string[];
  parsed: Record<string, unknown>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ItemProblem(item, "annotations_invalid");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as { annotations?: unknown }).annotations)
  )
    throw new ItemProblem(item, "annotations_invalid");
  const file = parsed as Record<string, unknown> & { annotations: unknown[] };
  const wanted = new Set(chosen);
  const kept = file.annotations.filter(
    (a) => a !== null && typeof a === "object" && wanted.has((a as { id?: unknown }).id as string)
  );
  const found = new Set(kept.map((a) => (a as { id: string }).id));
  const missing = [...wanted].filter((id) => !found.has(id));
  if (kept.length === 0) return { copy: null, missing, parsed: file };
  const bytes = Buffer.from(`${JSON.stringify({ ...file, annotations: kept }, null, 2)}\n`, "utf8");
  return { copy: { count: kept.length, bytes }, missing, parsed: file };
}

/** What the read of an add did on the way: whether it got to the annotations (step 5), and what was archived. */
interface ReadTrace {
  reading: boolean;
  archived: ShelfArchived;
}
const newTrace = (): ReadTrace => ({ reading: false, archived: [] });

interface Collected {
  input: ShelfPutInput;
  carried: ShelfAddResponse["carried"];
  notCarried: ShelfAddResponse["notCarried"];
}

/** The impact entry of an entry at its rev: a function of the (immutable) entry. */
function impactEntry(entry: ShelfEntry): ShelfReplacedEntry {
  const m = entry.manifest;
  return {
    entryId: entry.entryId,
    rev: entry.rev,
    title: m.bibliography.title,
    addedAt: m.added_at,
    sourceProject: m.source.project,
    docs: m.docs.map((d) => ({ docId: d.doc_id, kind: d.kind, bytes: d.bytes })),
    annotations: shelfAnnotationCount(m),
    argumentGraph: m.argument_graph !== null,
    note: m.note !== null,
  };
}

const sameImpactEntry = (a: ShelfReplacedEntry, b: ShelfReplacedEntry): boolean =>
  a.entryId === b.entryId &&
  a.rev === b.rev &&
  a.title === b.title &&
  a.addedAt === b.addedAt &&
  a.sourceProject === b.sourceProject &&
  a.docs.length === b.docs.length &&
  a.docs.every(
    (d, i) =>
      d.docId === b.docs[i]?.docId && d.kind === b.docs[i]?.kind && d.bytes === b.docs[i]?.bytes
  ) &&
  a.annotations === b.annotations &&
  a.argumentGraph === b.argumentGraph &&
  a.note === b.note;

export function createShelfWriter(deps: ShelfWriteDeps): ShelfWriter {
  const { paths } = deps;
  const busyRefusal = (docId: string) =>
    new Refused(
      refusal(409, "doc_busy", `Doc ${docId} is being changed or deleted; nothing was written`, {
        docId,
      })
    );

  /** Steps 1–5 of the module comment, in the one critical section. `preview`: step 5 without the ensure. */
  const collect = (
    request: ShelfAddPreviewRequest,
    mode: "add" | "preview",
    trace: ReadTrace = newTrace()
  ): Promise<Collected> =>
    deps.annotations.together((access: TogetherAccess): Collected => {
      // 1. the library, the Work, its Docs
      let store: LibraryStore;
      try {
        store = LibraryStore.load(paths);
      } catch (err) {
        throw new ItemProblem({ kind: "library" }, problemOf(err, "invalid"));
      }
      const work = store.get(request.workId);
      if (!work)
        throw new Refused(refusal(404, "work_not_found", "there is no such Work in this project"));
      const chosen = new Map(request.docs.map((d) => [d.docId, d.annotationIds]));
      for (const docId of chosen.keys())
        if (!work.doc_ids.includes(docId))
          throw new Refused(
            refusal(409, "doc_not_in_work", `the Work does not list Doc ${docId}`, { docId })
          );
      // The entry keeps the Work's order (its main Doc first when it was chosen).
      const docIds = [...new Set(work.doc_ids)].filter((id) => chosen.has(id));

      // 2. nothing chosen is being written or deleted
      for (const docId of docIds) if (access.busy(docId)) throw busyRefusal(docId);

      // 3. each Doc: kind, files, checks (read only)
      const docs: (ShelfDocInput & { fingerprint: string | null })[] = [];
      for (const docId of docIds) {
        const docDir = join(paths.outputDir, docId);
        try {
          if (!lstatSync(docDir).isDirectory())
            throw new ItemProblem(docItem(docId), "not_a_regular_file");
        } catch (err) {
          if (err instanceof ItemProblem) throw err;
          const code = errnoOf(err);
          throw new ItemProblem(
            docItem(docId),
            code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable"
          );
        }
        // A text Doc is one by its id (never by whether its source file happens to be readable); then PDF by metadata.
        let kind: ShelfDocKind = "latex";
        if (isTextDocId(docId)) kind = "text";
        else {
          try {
            if (readPdfMetadataIfPresent(paths, docId)) kind = "pdf";
          } catch (err) {
            throw new ItemProblem(docItem(docId, `${docId}.json`), problemOf(err, "invalid"));
          }
        }
        let files = docFiles(kind, docId, docDir);
        if (kind === "pdf") {
          if (store.works.filter((w) => w.doc_ids.includes(docId)).length !== 1)
            throw new ItemProblem(docItem(docId), "ownership");
          let original: Buffer;
          try {
            original = readVerifiedPdf(paths, docId);
          } catch (err) {
            throw new ItemProblem(
              docItem(docId, "original.pdf"),
              err instanceof PdfContentChangedError ? "content_changed" : problemOf(err, "invalid")
            );
          }
          files = files.map((f) =>
            f.path === "original.pdf" ? { path: f.path, bytes: original } : f
          );
          // The sidecar is bound to the original: a PDF Doc whose sidecar does not verify is not read at all.
          try {
            readPdfAnnotationsFile(paths, docId);
          } catch (err) {
            throw new ItemProblem(
              { kind: "annotations", docId, path: "annotations.json" },
              problemOf(err, "annotations_invalid")
            );
          }
        }
        if (kind === "text") {
          let source: ReturnType<typeof readTextSource>;
          try {
            source = readTextSource(paths, docId);
          } catch (err) {
            throw new ItemProblem(docItem(docId, "text-source.json"), problemOf(err, "invalid"));
          }
          const byPath = new Map(files.map((f) => [f.path, f.bytes]));
          for (const asset of source.assets) {
            const path = `assets/${asset.name}`;
            const bytes = byPath.get(path);
            if (!bytes || bytes.length !== asset.byte_length || sha256(bytes) !== asset.sha256)
              throw new ItemProblem(docItem(docId, path), "asset_mismatch");
          }
        }
        let fingerprint: string | null = null;
        if (kind !== "pdf" && files.some((f) => f.path === `${docId}.json`)) {
          // The reading text parses and is this Doc's, every image it declares goes with it, and the read-only
          // fingerprint (every declared asset hashes) can be computed.
          const irItem = docItem(docId, `${docId}.json`);
          try {
            const ir = loadStoredDocIr(paths.dataDir, docId);
            if (ir.docId !== docId) throw new ItemProblem(irItem, "invalid");
            checkDeclaredImages(docId, docDir, ir, new Set(files.map((f) => f.path)));
            fingerprint = docContentFingerprint(ir, { docDir });
          } catch (err) {
            if (err instanceof ItemProblem) throw err;
            if (err instanceof AnnotationsError) {
              const problem = annotationsProblem(err);
              throw new ItemProblem(problem === "invalid" ? irItem : docItem(docId), problem);
            }
            throw new ItemProblem(irItem, problemOf(err, "invalid"));
          }
        }
        docs.push({ docId, kind, files, annotations: null, fingerprint });
      }

      // 4. the argument graph and the note
      let argumentGraph: Buffer | null = null;
      if (request.argumentGraph) {
        try {
          const graph = loadArgumentGraph(paths.dataDir, work.id);
          if (graph.arguments.length > 0)
            argumentGraph = readFileSync(argumentGraphPath(paths.dataDir, work.id));
        } catch (err) {
          // A Work whose id cannot name a file has no graph.
          if (!(err instanceof ArgumentGraphFileError && err.kind === "unsafe_id"))
            throw new ItemProblem(
              { kind: "argument_graph" },
              err instanceof ArgumentGraphFileError
                ? err.problem?.reason === "unreadable"
                  ? "unreadable"
                  : "invalid"
                : problemOf(err, "unreadable")
            );
        }
      }
      const note = request.note && work.note && work.note.trim() !== "" ? work.note : null;

      // 5. the chosen annotations: only now, through the access path (LaTeX/text) or the verified sidecar (PDF)
      trace.reading = true;
      const notCarried: ShelfAddResponse["notCarried"] = [];
      for (const doc of docs) {
        const ids = [...new Set(chosen.get(doc.docId) ?? [])];
        if (ids.length === 0) continue;
        const item: ShelfItem = { kind: "annotations", docId: doc.docId };
        let raw: Buffer | null = null;
        /** LaTeX/text: the content fingerprint the current file must be bound to. */
        let bound: string | null = null;
        const readCurrent = (): Buffer | null => {
          try {
            return readFileSync(annotationsCurrentPath(paths.dataDir, doc.docId));
          } catch (err) {
            if (errnoOf(err) !== "ENOENT")
              throw new ItemProblem(item, problemOf(err, "unreadable"));
            return null; // no current file: no annotations
          }
        };
        if (doc.kind === "pdf") {
          const pdfItem: ShelfItem = {
            kind: "annotations",
            docId: doc.docId,
            path: "annotations.json",
          };
          try {
            raw = readFileSync(join(paths.outputDir, doc.docId, "annotations.json"));
          } catch (err) {
            throw new ItemProblem(pdfItem, problemOf(err, "annotations_invalid"));
          }
        } else if (doc.fingerprint !== null && mode === "add") {
          let ensured: ReturnType<TogetherAccess["ensure"]>;
          // How many annotations an archive by this ensure would move (read only, before it): what gets reported.
          let prior: number | null = null;
          try {
            prior = loadAnnotationsFile(paths.dataDir, doc.docId)?.annotations.length ?? null;
          } catch {
            prior = null; // the ensure meets the same error and stops without archiving
          }
          try {
            ensured = access.ensure(doc.docId);
          } catch (err) {
            // Archived, but the new empty file is not there: the project did change.
            if (err instanceof AnnotationsError && err.code === "new_current")
              trace.archived.push({ docId: doc.docId, count: prior });
            throw new ItemProblem(
              err instanceof AnnotationsError && err.code === "corrupt_ir"
                ? docItem(doc.docId, `${doc.docId}.json`)
                : item,
              err instanceof AnnotationsError
                ? annotationsProblem(err)
                : problemOf(err, "unreadable")
            );
          }
          if (ensured.kind === "busy") throw busyRefusal(doc.docId);
          if (ensured.kind !== "ok") throw new ItemProblem(docItem(doc.docId), "invalid");
          if (ensured.epoch.invalidated)
            trace.archived.push({
              docId: doc.docId,
              count: ensured.epoch.archivedCount ?? prior,
            });
          bound = ensured.epoch.file.content_fingerprint;
          raw = readCurrent();
        } else if (doc.fingerprint !== null) {
          // preview: the current file as it is, read only; one of older content would be archived at the add
          let current: ReturnType<typeof loadAnnotationsFile>;
          try {
            current = loadAnnotationsFile(paths.dataDir, doc.docId);
          } catch (err) {
            throw new ItemProblem(
              item,
              err instanceof AnnotationsError
                ? annotationsProblem(err)
                : problemOf(err, "unreadable")
            );
          }
          if (current !== null && current.content_fingerprint === doc.fingerprint) {
            bound = doc.fingerprint;
            raw = readCurrent();
          }
        }
        // No annotations file (a text draft never generated, a Doc never annotated, or — preview — one of older
        // content): none of them is current.
        if (raw === null) {
          notCarried.push({ docId: doc.docId, annotationIds: ids });
          continue;
        }
        const { copy, missing, parsed } = filterAnnotations(
          raw,
          ids,
          doc.kind === "pdf"
            ? { kind: "annotations", docId: doc.docId, path: "annotations.json" }
            : item
        );
        // The file is the one the ensure just answered for (one critical section): anything else is not current.
        if (bound !== null && parsed.content_fingerprint !== bound)
          throw new ItemProblem(item, "annotations_invalid");
        doc.annotations = copy;
        if (missing.length > 0) notCarried.push({ docId: doc.docId, annotationIds: missing });
      }

      const input: ShelfPutInput = {
        bibliography: bibliographyOf(work),
        source: { project: deps.projectRoot, workId: work.id },
        docs: docs.map(({ fingerprint: _, ...d }) => d),
        argumentGraph,
        note,
      };
      return {
        input,
        carried: {
          docs: docs.map((d) => ({
            docId: d.docId,
            kind: d.kind,
            annotations: d.annotations?.count ?? 0,
          })),
          argumentGraph: argumentGraph !== null,
          note: note !== null,
        },
        notCarried,
      };
    });

  /** The Work's identity, from the library (read without the lock: only a pre-check, the store decides). */
  const identityOf = (workId: string): ShelfIdentity | null => {
    const work = LibraryStore.load(paths).get(workId);
    return work ? shelfIdentityOf(work) : null;
  };

  /** The entries a replacement would remove now, by the Shelf's identity rule (no lock: the put decides). */
  const currentImpact = async (
    shelf: ShelfStore,
    identity: ShelfIdentity
  ): Promise<ShelfReplaceImpact | null> => {
    if (!identity.doi && !identity.arxiv && !identity.openalex) return null;
    const same = await shelf.findByIdentity(identity);
    return same.length > 0 ? { entries: same.map(impactEntry) } : null;
  };

  /** The impact of what `put` reported as the same paper, at exactly those revs (null when any moved meanwhile). */
  const impactOfRefs = async (
    shelf: ShelfStore,
    refs: readonly { entryId: string; rev: number }[]
  ): Promise<ShelfReplaceImpact | null> => {
    const listed = await shelf.list();
    const entries: ShelfReplacedEntry[] = [];
    for (const ref of refs) {
      const item = listed.find((i) => i.entryId === ref.entryId);
      if (item?.status !== "ok" || item.rev !== ref.rev) return null;
      entries.push(impactEntry(item));
    }
    return entries.length > 0 ? { entries } : null;
  };

  const changed = async (
    shelf: ShelfStore,
    identity: ShelfIdentity | null
  ): Promise<ShelfAnswer> => {
    const impact = identity ? await currentImpact(shelf, identity) : null;
    return refusal(
      409,
      "confirmation_changed",
      "the Shelf changed since the replacement was confirmed; nothing was written",
      impact ? { impact } : {}
    );
  };

  const putFailure = (
    result: Exclude<ShelfPutResult, { ok: true }>,
    removed: ShelfEntryRefDto[]
  ): ShelfAnswer | null => {
    switch (result.reason) {
      case "busy":
        return refusal(
          503,
          "shelf_busy",
          "another workbench is writing the Shelf; nothing was written, try again"
        );
      case "lock_lost":
        return refusal(
          500,
          "lock_lost",
          result.written
            ? "the Shelf's lock was taken over by another workbench while writing: the new entry is in place, but an old one may still be listed"
            : "the Shelf's lock was taken over by another workbench while writing; nothing was written",
          { written: result.written, removed }
        );
      default:
        return null;
    }
  };

  /** The library read of the pre-check: a system error or a file that is not JSON is the library item; else thrown. */
  const libraryIdentity = (
    workId: string
  ): { ok: true; identity: ShelfIdentity } | { ok: false; answer: ShelfAnswer } => {
    let identity: ShelfIdentity | null;
    try {
      identity = identityOf(workId);
    } catch (err) {
      if (!(errnoOf(err) || err instanceof SyntaxError)) throw err;
      return {
        ok: false,
        answer: itemRefusal(
          new ItemProblem({ kind: "library" }, errnoOf(err) ? "unreadable" : "invalid")
        ),
      };
    }
    return identity
      ? { ok: true, identity }
      : {
          ok: false,
          answer: refusal(404, "work_not_found", "there is no such Work in this project"),
        };
  };

  /** Run `collect`, answering its refusals and unreadable parts; anything else is thrown. */
  const collectOrAnswer = async (
    request: ShelfAddPreviewRequest,
    mode: "add" | "preview",
    trace?: ReadTrace
  ): Promise<{ ok: true; collected: Collected } | { ok: false; answer: ShelfAnswer }> => {
    try {
      return { ok: true, collected: await collect(request, mode, trace) };
    } catch (err) {
      if (err instanceof Refused) return { ok: false, answer: err.answer };
      if (err instanceof ItemProblem) return { ok: false, answer: itemRefusal(err) };
      throw err;
    }
  };

  /** A Shelf entry that cannot be read is answered; anything else is thrown. */
  const shelfIo = async (run: () => Promise<ShelfAnswer>): Promise<ShelfAnswer> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof ShelfIoError)
        return refusal(
          500,
          "shelf_unreadable",
          "an entry of the Shelf could not be read; nothing was written",
          { errno: err.code }
        );
      throw err;
    }
  };

  const add = async (body: unknown): Promise<ShelfAnswer> => {
    const parsed = ShelfAddRequestSchema.safeParse(body);
    if (!parsed.success)
      return refusal(400, "invalid_request", "the body is not a request to add to the Shelf");
    const request = parsed.data;
    if (new Set(request.docs.map((d) => d.docId)).size !== request.docs.length)
      return refusal(400, "invalid_request", "a Doc is named twice");
    const confirmedIds = request.confirm?.entries.map((e) => e.entryId) ?? [];
    if (new Set(confirmedIds).size !== confirmedIds.length)
      return refusal(400, "invalid_request", "an entry is named twice in the confirmation");
    const shelf = deps.store();
    const trace = newTrace();
    const answer = await shelfIo(async () => {
      const known = libraryIdentity(request.workId);
      if (!known.ok) return known.answer;
      const { identity } = known;

      // Before anything of the project is read: ask first, and check that a confirmation is still what it says.
      if (!request.confirm) {
        const impact = await currentImpact(shelf, identity);
        if (impact)
          return refusal(
            409,
            "confirmation_required",
            "the Shelf already has this paper; confirm to replace it",
            { impact }
          );
      } else {
        // The confirmed entries must be exactly those of the same paper now, each as it was shown.
        const confirmed = request.confirm.entries;
        const now = await currentImpact(shelf, identity);
        if (
          !now ||
          now.entries.length !== confirmed.length ||
          !confirmed.every((c) => now.entries.some((e) => sameImpactEntry(e, c)))
        )
          return await changed(shelf, identity);
      }

      const got = await collectOrAnswer(request, "add", trace);
      if (!got.ok) return got.answer;
      const { collected } = got;

      const targets = request.confirm?.entries.map((e) => ({ entryId: e.entryId, rev: e.rev }));
      let result: ShelfPutResult;
      try {
        result = await shelf.put(
          collected.input,
          targets ? { mode: "replace", targets } : { mode: "new" }
        );
      } catch (err) {
        // The store's own refusal of the input (e.g. a year that is not an integer) or a system error of its write:
        // it removed what it staged, no entry was changed. Anything else is not a failed write.
        if (err instanceof ShelfIoError) throw err;
        if (err instanceof ShelfInputError || errnoOf(err))
          return refusal(
            500,
            "shelf_write_failed",
            "the entry could not be written; nothing of it is in the Shelf"
          );
        throw err;
      }
      if (!result.ok) {
        // The lock was lost after the new entry landed: only the targets really gone count as removed (the store
        // stopped somewhere among them; the first one's old rev is superseded by the new one).
        let removed: ShelfEntryRefDto[] = [];
        if (result.reason === "lock_lost" && result.written && targets) {
          const listed = await shelf.list();
          removed = targets.filter(
            (t) => !listed.some((i) => i.entryId === t.entryId && i.rev === t.rev)
          );
        }
        const failure = putFailure(result, removed);
        if (failure) {
          if (result.reason === "lock_lost" && result.written)
            deps.onChanged(targets ? "replace" : "add", result.written, removed);
          return failure;
        }
        if (!targets && result.reason === "identity_taken") {
          // Another add of the same paper got in first: ask, with what is there now.
          const impact = await impactOfRefs(shelf, result.entries);
          return impact
            ? refusal(
                409,
                "confirmation_required",
                "the Shelf already has this paper; confirm to replace it",
                { impact }
              )
            : refusal(503, "shelf_busy", "the Shelf kept changing; nothing was written, try again");
        }
        // identity_taken / rev_mismatch / not_found / incompatible / damaged of a replacement
        return await changed(shelf, identity);
      }
      const entry = { entryId: result.entry.entryId, rev: result.entry.rev };
      deps.onChanged(targets ? "replace" : "add", entry, targets ?? []);
      const response: ShelfAddResponse = {
        entry,
        replaced: targets ?? [],
        carried: collected.carried,
        notCarried: collected.notCarried,
        archived: trace.archived,
      };
      return { status: 200, body: response };
    });
    // An add that stopped after reading annotations says what the access path archived on the way (contracts
    // 「文献仓」: the result is reported as it is).
    if (answer.status === 200 || !trace.reading) return answer;
    const archived = trace.archived;
    const said =
      archived.length === 0
        ? ""
        : ` Before it stopped, the annotations access path archived the annotations of older content of ${archived
            .map((a) => `Doc ${a.docId} (${a.count === null ? "an unknown number" : a.count})`)
            .join(", ")}, as any access would; they are in the project's archive.`;
    return {
      status: answer.status,
      body: { ...answer.body, detail: `${String(answer.body.detail)}${said}`, archived },
    };
  };

  const preview = async (body: unknown): Promise<ShelfAnswer> => {
    const parsed = ShelfAddPreviewRequestSchema.safeParse(body);
    if (!parsed.success)
      return refusal(400, "invalid_request", "the body is not a request to add to the Shelf");
    const request = parsed.data;
    if (new Set(request.docs.map((d) => d.docId)).size !== request.docs.length)
      return refusal(400, "invalid_request", "a Doc is named twice");
    const shelf = deps.store();
    return shelfIo(async () => {
      const got = await collectOrAnswer(request, "preview");
      if (!got.ok) return got.answer;
      const { collected } = got;
      const response: ShelfAddPreviewResponse = {
        impact: await currentImpact(shelf, shelfIdentityOf(collected.input.bibliography)),
        carried: collected.carried,
        notCarried: collected.notCarried,
      };
      return { status: 200, body: response };
    });
  };

  const remove = async (entryId: string, revText: string | undefined): Promise<ShelfAnswer> => {
    const rev = Number(revText);
    if (revText === undefined || !/^[1-9][0-9]*$/.test(revText) || !Number.isSafeInteger(rev))
      return refusal(400, "invalid_request", "rev must be the entry's rev (a positive integer)");
    let result: Awaited<ReturnType<ShelfStore["delete"]>>;
    try {
      result = await deps.store().delete(entryId, rev);
    } catch (err) {
      // a system error of the store's removal; anything else is not a failed delete
      if (!errnoOf(err)) throw err;
      return refusal(500, "shelf_write_failed", "the entry could not be deleted");
    }
    if (result.ok) {
      deps.onChanged("delete", { entryId, rev }, [{ entryId, rev }]);
      return { status: 200, body: { deleted: { entryId, rev } } };
    }
    switch (result.reason) {
      case "not_found":
        return refusal(404, "not_found", "there is no such entry in the Shelf");
      case "rev_mismatch":
        return refusal(
          409,
          "rev_mismatch",
          "the entry was replaced since it was shown; nothing was deleted",
          { currentRev: result.currentRev }
        );
      case "busy":
        return refusal(
          503,
          "shelf_busy",
          "another workbench is writing the Shelf; nothing was deleted, try again"
        );
      case "lock_lost":
        return refusal(
          500,
          "lock_lost",
          "the Shelf's lock was taken over by another workbench; the entry was not deleted"
        );
    }
  };

  return { add, preview, remove };
}

/**
 * The Shelf store of this process: `shelf/` in the global data directory as pinned for the process (`serve`), or as
 * config.toml gives it now (an app made without a server) — the same lookup as the tutorial progress and the logs.
 */
export function shelfStoreOf(configPath: string | undefined): ShelfStore {
  const dirs =
    pinnedGlobalDirs() ??
    resolveGlobalDirsLeniently(readConfigLeniently(configPath ?? configFilePath())).dirs;
  return createShelfStore({ dir: join(dirs.dataDir, SHELF_DIR) });
}

/** The three routes; the two writes and the preview are guarded by the protected base (protected-app.ts). */
export function mountShelfWriteRoutes(routes: ProtectedRoutes, writer: ShelfWriter): void {
  const app = routes.withDefaults({ noStore: true });
  app.post("/api/shelf/entries", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const answer = await writer.add(body);
    return c.json(answer.body, answer.status, NO_STORE);
  });
  app.post("/api/shelf/entries/preview", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const answer = await writer.preview(body);
    return c.json(answer.body, answer.status, NO_STORE);
  });
  app.delete("/api/shelf/entries/:entryId", async (c) => {
    const answer = await writer.remove(c.req.param("entryId"), c.req.query("rev"));
    return c.json(answer.body, answer.status, NO_STORE);
  });
}
