/**
 * The Shelf (文献仓) take, its preview and the Shelf's read-only queries (shelf ticket 04; contracts「文献仓」;
 * docs/library.md「文献仓」「取入与查询」; answer shapes in contracts `shelf-take.ts`):
 *
 *   GET  /api/shelf                             the list, with sizes and states
 *   GET  /api/shelf/entries/:id                 one entry's summary, as its manifest says
 *   GET  /api/shelf/entries/:id/annotations     the annotations it carries, for the page that leaves some out
 *   GET  /api/shelf/lookup                      the entries that are the same paper (DOI / arXiv / OpenAlex)
 *   POST /api/shelf/entries/:id/take/preview    the plan of a take, written nowhere
 *   POST /api/shelf/entries/:id/take            copy the entry into this project
 *
 * A take reads the whole entry from the Shelf (infra `createShelfStore().read`, every file checked against the
 * manifest) before taking any lock. Then, inside the app's libraryLock and argumentGraphLock, in one synchronous
 * section (no other request, job or the file watcher runs in between), it works the plan out again from the project
 * as it is now ({@link planTake}, the same function the preview uses: which Work, which Docs, which annotations,
 * graph and note) and carries it out: the Docs are staged next to their place and renamed into it, the annotation
 * files placed, the argument graph written and the library written last. A failure at any step removes everything
 * this take added and leaves every existing file as it was. Nothing here archives or reads archived annotations;
 * the copied annotations keep their content fingerprint (checked), so they are the current annotations of the copied
 * Doc. A LaTeX Doc whose own identity would make the next library build put it elsewhere gets the target Work's
 * identity in its `source`/`meta` (`stampSource`, contracts「文献仓」局部修订二); its text does not change.
 *
 * Doc mutations of the same project from another process are not supported (I013): the take, like every project
 * write, only serializes within this server.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  AnnotationsFileSchema,
  type ArgumentGraph,
  ArgumentGraphSchema,
  PdfAnnotationsFileSchema,
  PdfDocMetadataSchema,
  PdfReadingPositionSchema,
  SHELF_ENTRY_ID_RE,
  SHELF_EXCLUDED_WORK_FIELDS,
  type ShelfAnnotationsResponse,
  type ShelfDocKind,
  type ShelfEntryResponse,
  type ShelfEntrySummary,
  type ShelfListResponse,
  type ShelfListRow,
  type ShelfLookupResponse,
  type ShelfTakePreview,
  type ShelfTakeRefusalCode,
  type ShelfTakeRequest,
  ShelfTakeRequestSchema,
  type ShelfTakeResult,
  type ShelfTakeSkipReason,
  StoredDocIrSchema,
  TextDocSourceSchema,
} from "@argelanderspace/contracts";
import {
  annotationsDocDir,
  annotationsRootDir,
  argumentGraphDir,
  argumentGraphPath,
  assignCiteKey,
  canonicalId,
  docContentFingerprintOfFiles,
  fillWorkNarrow,
  healGraph,
  isTextDocId,
  type LibraryPaths,
  LibraryStore,
  loadArgumentGraph,
  loadCurrentGraph,
  mergeWorkIntoGraph,
  planFor,
  planToDict,
  replaceArgumentGraph,
  saveWorksNarrow,
  seedWorkFor,
  stampSourceData,
  type Work,
  workFromJson,
  workToDict,
} from "@argelanderspace/core";
import {
  type ShelfDocContent,
  type ShelfEntry,
  ShelfIoError,
  type ShelfRead,
  type ShelfStore,
  shelfIdentityOf,
} from "@argelanderspace/infra";
import type { Context } from "hono";
import type { DocMutationRegistry } from "./doc-mutations.js";
import type { AsyncLock } from "./lock.js";
import type { ProtectedRoutes } from "./protected-app.js";

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** The name prefix of what a take stages in `output/` and `annotations/`; leftovers of a crash are removed by the next take. */
const STAGE_PREFIX = ".shelf-take-";

/** The steps a write goes through (test seam: `hooks.beforeStep` may throw to fail one). */
export type ShelfTakeStep = "place_doc" | "place_annotations" | "graph" | "library";

export interface ShelfTakeDeps {
  paths: LibraryPaths;
  /** The Shelf store, made at each request (its directory follows the global data directory this process uses). */
  store: () => ShelfStore;
  /** The app's one libraryLock (received, never made here). */
  libraryLock: AsyncLock;
  /** The app's one argumentGraphLock: the graph is decided and written under it (inside the libraryLock). */
  argumentGraphLock: AsyncLock;
  /** The app's one registry: a Doc id that is being written or deleted is not taken (409 busy). */
  docMutations: DocMutationRegistry;
  /** `library.changed{add}`, once per take that wrote something, after the locks are released. */
  libraryChanged: () => void;
  /** `argument-graph.changed` of the Work whose graph the take wrote. */
  argumentGraphChanged: (workId: string) => void;
  /** Test seam only: called before each write step (the Doc's id for the per-Doc steps); a throw fails that step. */
  hooks?: { beforeStep?: (step: ShelfTakeStep, docId?: string) => void };
}

type Refusal = {
  ok: false;
  status: 400 | 404 | 409 | 422 | 500;
  body: { detail: string; code: ShelfTakeRefusalCode } & Record<string, unknown>;
};
export type ShelfTakeOutcome = { ok: true; result: ShelfTakeResult } | Refusal;
export type ShelfPreviewOutcome = { ok: true; preview: ShelfTakePreview } | Refusal;

const refuse = (
  status: Refusal["status"],
  code: ShelfTakeRefusalCode,
  detail: string,
  extra: Record<string, unknown> = {}
): Refusal => ({ ok: false, status, body: { detail, code, ...extra } });

const errCode = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
};

/** A take refused while its content was being checked (nothing placed yet). */
class TakeRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.body.detail);
  }
}

type Raw = Record<string, unknown>;

/** A stored value that is not filled in (the rule of core `fillWorkNarrow`): absent, null, "", [] or {}. */
const blank = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  v === "" ||
  (typeof v === "object" && Object.keys(v as object).length === 0);

const jsonOf = (bytes: Uint8Array): unknown => JSON.parse(Buffer.from(bytes).toString("utf8"));

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if (errCode(e) === "ENOENT") return false;
    throw e;
  }
}

// ---- summaries ----------------------------------------------------------------------------------------------

function summaryOf(entry: ShelfEntry): ShelfEntrySummary {
  const m = entry.manifest;
  return {
    entryId: entry.entryId,
    rev: entry.rev,
    bytes: entry.bytes,
    addedAt: m.added_at,
    source: { project: m.source.project, workId: m.source.work_id },
    identity: m.identity,
    title: m.bibliography.title,
    authors: [...m.bibliography.authors],
    year: m.bibliography.year,
    docs: m.docs.map((d) => ({
      docId: d.doc_id,
      kind: d.kind,
      bytes: d.bytes,
      annotations: d.annotations?.count ?? null,
    })),
    annotations: m.docs.reduce((n, d) => n + (d.annotations?.count ?? 0), 0),
    argumentGraph: m.argument_graph !== null,
    note: m.note !== null,
  };
}

/** The refusal of a read that did not give an entry of this build's format. */
function readRefusal(read: Exclude<ShelfRead, { status: "ok" }>): Refusal {
  switch (read.status) {
    case "not_found":
      return refuse(404, "not_found", "no such Shelf entry");
    case "changed":
      return refuse(409, "changed", "the Shelf entry was replaced; look at it again", {
        currentRev: read.rev,
      });
    case "incompatible":
      return refuse(
        409,
        "incompatible",
        "the Shelf entry was written by a newer workbench; update the workbench to take it",
        { needsUpdate: true, currentRev: read.rev }
      );
    default:
      return refuse(422, "damaged", `the Shelf entry is damaged (${read.problem})`, {
        problem: read.problem,
      });
  }
}

const shelfUnreadable = (error: ShelfIoError): Refusal =>
  refuse(500, "shelf_unreadable", `the Shelf could not be read (${error.code})`, {
    errno: error.code,
  });

// ---- preparing one Doc -----------------------------------------------------------------------------------

interface PreparedDoc {
  docId: string;
  kind: ShelfDocKind;
  /** The Doc directory's files, as they go into `output/<docId>/` (PDF sidecars included). */
  files: { path: string; bytes: Uint8Array }[];
  /** LaTeX / text: the annotations file to place as `annotations/<docId>/current.json`, or null. */
  current: Uint8Array | null;
  /** How many annotations are taken with this Doc. */
  annotations: number;
  /** LaTeX: the stored JSON as the library build reads it (null when it is not a JSON object). */
  seedJson: Raw | null;
  stamped: boolean;
}

/**
 * The bytes to place for an annotation file with `exclude` left out: the copy's own bytes when nothing is left out
 * (unknown keys and all), else the parsed raw object with only the `annotations` array filtered; null when none is left.
 */
function filtered(
  copy: Uint8Array,
  ids: string[],
  exclude: "all" | string[] | undefined
): { bytes: Uint8Array; count: number } | null {
  if (exclude === "all") return null;
  const drop = new Set(exclude ?? []);
  const kept = ids.filter((id) => !drop.has(id)).length;
  if (kept === 0) return null;
  if (drop.size === 0) return { bytes: copy, count: kept };
  const raw = jsonOf(copy) as Raw;
  raw.annotations = (raw.annotations as { id: string }[]).filter((a) => !drop.has(a.id));
  return { bytes: Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, "utf8"), count: kept };
}

function invalid(docId: string | null, part: string, problem: string): TakeRefused {
  return new TakeRefused(
    refuse(
      422,
      "entry_invalid",
      `the Shelf entry does not hold together (${part}${docId ? ` of doc ${docId}` : ""}: ${problem})`,
      { docId, part, problem }
    )
  );
}

function checkExclusions(docId: string, ids: string[], exclude: "all" | string[] | undefined) {
  if (exclude === undefined || exclude === "all") return;
  const known = new Set(ids);
  const unknown = exclude.filter((id) => !known.has(id));
  if (unknown.length > 0)
    throw new TakeRefused(
      refuse(400, "invalid_request", `doc ${docId} has no annotation ${JSON.stringify(unknown[0])}`)
    );
}

const pretty = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

/** Check one Doc that is going to be taken and work out its files. Throws {@link TakeRefused}. */
function prepareDoc(doc: ShelfDocContent, exclude: "all" | string[] | undefined): PreparedDoc {
  const { docId, kind } = doc;
  const fileOf = (path: string) => doc.files.find((f) => f.path === path)?.bytes ?? null;
  const parse = (bytes: Uint8Array, part: string): unknown => {
    try {
      return jsonOf(bytes);
    } catch {
      throw invalid(docId, part, "not_json");
    }
  };
  if (kind === "text" && !isTextDocId(docId)) throw invalid(docId, "doc", "bad_text_doc_id");
  const files: PreparedDoc["files"] = doc.files.map((f) => ({ path: f.path, bytes: f.bytes }));
  const noCopy = () => {
    if (exclude !== undefined && exclude !== "all" && exclude.length > 0)
      throw new TakeRefused(
        refuse(400, "invalid_request", `doc ${docId} carries no annotations to leave out`)
      );
  };

  if (kind === "pdf") {
    const meta = PdfDocMetadataSchema.safeParse(parse(fileOf(`${docId}.json`) as Buffer, "doc"));
    if (!meta.success || meta.data.doc_id !== docId) throw invalid(docId, "doc", "pdf_metadata");
    const original = fileOf("original.pdf") as Buffer;
    if (
      original.length !== meta.data.byte_length ||
      createHash("sha256").update(original).digest("hex") !== meta.data.sha256
    )
      throw invalid(docId, "doc", "pdf_original");
    let sidecar: { bytes: Uint8Array; count: number } | null = null;
    if (doc.annotations && exclude !== "all") {
      const file = PdfAnnotationsFileSchema.safeParse(parse(doc.annotations.bytes, "annotations"));
      if (
        !file.success ||
        file.data.doc_id !== docId ||
        file.data.content_sha256 !== meta.data.sha256
      )
        throw invalid(docId, "annotations", "pdf_annotations");
      const ids = file.data.annotations.map((a) => a.id);
      checkExclusions(docId, ids, exclude);
      sidecar = filtered(doc.annotations.bytes, ids, exclude);
    } else if (!doc.annotations) noCopy();
    // A PDF Doc always has both sidecars: a fresh empty one when no annotation is taken, and a null reading position.
    const binding = { version: 1, doc_id: docId, content_sha256: meta.data.sha256, rev: 0 };
    files.push({
      path: "annotations.json",
      bytes:
        sidecar?.bytes ?? pretty(PdfAnnotationsFileSchema.parse({ ...binding, annotations: [] })),
    });
    files.push({
      path: "reading-position.json",
      bytes: pretty(PdfReadingPositionSchema.parse({ ...binding, position: null })),
    });
    return {
      docId,
      kind,
      files,
      current: null,
      annotations: sidecar?.count ?? 0,
      seedJson: null,
      stamped: false,
    };
  }

  if (kind === "text") {
    const source = TextDocSourceSchema.safeParse(
      parse(fileOf("text-source.json") as Buffer, "doc")
    );
    if (!source.success || source.data.doc_id !== docId) throw invalid(docId, "doc", "text_source");
  }
  // The reading text must be this Doc's: an IR naming another Doc id is not.
  const irBytes = fileOf(`${docId}.json`);
  let irJson: unknown = null;
  if (irBytes !== null) {
    try {
      irJson = jsonOf(irBytes);
    } catch {
      irJson = null; // not JSON: the project's own reading rules report it; the build skips it
    }
    const named = (irJson as { docId?: unknown } | null)?.docId;
    if (typeof named === "string" && named !== docId) throw invalid(docId, "doc", "ir_doc_id");
  }
  const seedJson =
    kind === "latex" && irJson !== null && typeof irJson === "object" && !Array.isArray(irJson)
      ? (irJson as Raw)
      : null;
  let current: Uint8Array | null = null;
  let annotations = 0;
  if (doc.annotations && exclude !== "all") {
    const file = AnnotationsFileSchema.safeParse(parse(doc.annotations.bytes, "annotations"));
    if (!file.success) throw invalid(docId, "annotations", "annotations_file");
    const ids = file.data.annotations.map((a) => a.id);
    checkExclusions(docId, ids, exclude);
    const kept = filtered(doc.annotations.bytes, ids, exclude);
    if (kept) {
      if (irBytes === null) throw invalid(docId, "annotations", "no_reading_text");
      // They must be the current annotations of the copied content: a fingerprint that can be computed and differs
      // would have the next access archive them. One that cannot be computed (a reading text this build cannot
      // read) leaves them as they are, as the project's own rule does.
      let fingerprint: string | null = null;
      const ir = StoredDocIrSchema.safeParse(irJson);
      if (ir.success) {
        try {
          fingerprint = docContentFingerprintOfFiles(
            ir.data,
            new Map(doc.files.map((f) => [f.path, f.bytes]))
          );
        } catch {
          fingerprint = null;
        }
      }
      if (fingerprint !== null && fingerprint !== file.data.content_fingerprint)
        throw invalid(docId, "annotations", "stale");
      current = kept.bytes;
      annotations = kept.count;
    }
  } else if (!doc.annotations) noCopy();
  return { docId, kind, files, current, annotations, seedJson, stamped: false };
}

// ---- the plan ---------------------------------------------------------------------------------------------

/** The fields of a bibliography snapshot as the typed Work model keeps them (project fields never included). */
function bibliographyFields(bibliography: Raw): Raw {
  const dict = workToDict(workFromJson({ ...bibliography, id: "-" }));
  const out: Raw = {};
  const excluded = new Set<string>(SHELF_EXCLUDED_WORK_FIELDS);
  for (const [key, value] of Object.entries(dict))
    if (!excluded.has(key) && Object.hasOwn(bibliography, key)) out[key] = value;
  return out;
}

interface Plan {
  result: ShelfTakeResult;
  digest: string;
  /** null: merge into `targetId`. */
  created: Work | null;
  targetId: string;
  fields: Raw;
  taking: PreparedDoc[];
  graph: ArgumentGraph | null;
  localGraphRev: number;
}

interface PlanInput {
  entryId: string;
  read: Extract<ShelfRead, { status: "ok" }>;
  request: ShelfTakeRequest;
  paths: LibraryPaths;
  docMutations: DocMutationRegistry;
  now: string;
}

/**
 * Work out what a take does, from the entry as read and the project as it is now, without writing anything (the
 * preview, and the take under its locks). Returns a refusal when the take cannot go ahead.
 */
function planTake(input: PlanInput): Plan | Refusal {
  const { read, request, paths } = input;
  const manifest = read.entry.manifest;
  const exclusions = request.excludeAnnotations ?? {};
  for (const docId of Object.keys(exclusions))
    if (!read.docs.some((d) => d.docId === docId))
      return refuse(400, "invalid_request", `the entry has no doc ${JSON.stringify(docId)}`);
  const excludeOf = (docId: string) =>
    Object.hasOwn(exclusions, docId) ? exclusions[docId] : undefined;

  // ---- the library, raw --------------------------------------------------------------------------------------
  let data: Raw;
  try {
    data = lexists(paths.libraryJson)
      ? (JSON.parse(readFileSync(paths.libraryJson, "utf8")) as Raw)
      : { works: [] };
    if (data === null || typeof data !== "object" || Array.isArray(data))
      throw new Error("not an object");
    if (data.works !== undefined && !Array.isArray(data.works)) throw new Error("no works");
  } catch {
    return refuse(500, "library_unreadable", "the library file could not be read");
  }
  const rawWorks = ((data.works as unknown[] | undefined) ?? []).filter(
    (w): w is Raw => w !== null && typeof w === "object" && !Array.isArray(w)
  );

  // ---- the target Work: the one Work that is the same paper (DOI, arXiv or OpenAlex), else a new one ------------
  const matched: Raw[] = [];
  for (const w of rawWorks) {
    const id = shelfIdentityOf({
      doi: typeof w.doi === "string" ? w.doi : null,
      arxiv_id: typeof w.arxiv_id === "string" ? w.arxiv_id : null,
      openalex_id: typeof w.openalex_id === "string" ? w.openalex_id : null,
    });
    if (
      (["doi", "arxiv", "openalex"] as const).some(
        (k) => manifest.identity[k] && id[k] === manifest.identity[k]
      )
    )
      matched.push(w);
  }
  if (matched.length > 1) {
    const workIds = matched.map((w) => String(w.id));
    return refuse(
      409,
      "multiple_works",
      `${workIds.length} Works of this project are this paper (${workIds.join(", ")}); merge them in the Library first`,
      { workIds }
    );
  }
  const bibliography = manifest.bibliography as Raw;
  const fields = bibliographyFields(bibliography);
  const targetRaw = matched[0];
  let created: Work | null = null;
  let targetId: string;
  if (targetRaw === undefined) {
    const w = workFromJson({ ...bibliography, id: "-" });
    w.id = canonicalId({
      doi: w.doi,
      arxiv: w.arxiv_id,
      openalex: w.openalex_id,
      title: w.title,
      year: w.year,
    });
    if (rawWorks.some((x) => String(x.id) === w.id))
      return refuse(
        409,
        "id_taken",
        `the new Work's id ${JSON.stringify(w.id)} (derived from its title and year) is already used by a different Work`,
        { workId: w.id }
      );
    w.origin = "manual";
    w.added_at = input.now;
    if (request.note !== false && read.note) w.note = read.note;
    created = w;
    targetId = w.id;
  } else targetId = String(targetRaw.id);
  const filled = created
    ? Object.keys(fields)
    : Object.keys(fields).filter(
        (k) => k !== "id" && k !== "doc_ids" && !blank(fields[k]) && blank(targetRaw?.[k])
      );

  // ---- the Docs: skipped where the project already has that id; the others checked and prepared ----------------
  const linked = new Set(
    rawWorks.flatMap((w) => (Array.isArray(w.doc_ids) ? w.doc_ids.map(String) : []))
  );
  const skip = new Map<string, { reason: ShelfTakeSkipReason; wouldJoin?: string | null }>();
  try {
    for (const d of read.docs) {
      if (lexists(join(paths.outputDir, d.docId))) skip.set(d.docId, { reason: "exists" });
      else if (linked.has(d.docId)) skip.set(d.docId, { reason: "linked" });
      else if (lexists(annotationsDocDir(paths.dataDir, d.docId)))
        skip.set(d.docId, { reason: "annotations_present" });
    }
  } catch (error) {
    return refuse(500, "write_failed", `the project's files could not be read (${errCode(error)})`);
  }
  let prepared: PreparedDoc[];
  let graph: ArgumentGraph | null = null;
  try {
    // A Doc that is skipped is neither checked nor written: nothing of it can make the take fail.
    prepared = read.docs
      .filter((d) => !skip.has(d.docId))
      .map((d) => prepareDoc(d, excludeOf(d.docId)));
    if (request.argumentGraph !== false && read.argumentGraph) {
      let raw: unknown;
      try {
        raw = jsonOf(read.argumentGraph);
      } catch {
        throw invalid(null, "argument_graph", "not_json");
      }
      const version = (raw as { version?: unknown } | null)?.version;
      if (typeof version === "number" && version > 1)
        throw invalid(null, "argument_graph", "future_version");
      const g = ArgumentGraphSchema.safeParse(raw);
      if (!g.success) throw invalid(null, "argument_graph", "schema");
      graph = g.data;
    }
  } catch (error) {
    if (error instanceof TakeRefused) return error.refusal;
    throw error;
  }

  // ---- where the next library build puts each LaTeX Doc ----------------------------------------------------------
  // The build seeds LaTeX Docs in name order and upserts each by its DOI / arXiv id / title. A Doc is taken only when
  // that lands in the target Work alone; else the target's identity is written into its source/meta (as an upload
  // does) and checked again; a Doc that would still land elsewhere, or fold another Work into the target, is skipped.
  const simWorks = rawWorks.map((w) => {
    if (w !== targetRaw) return workFromJson(w);
    const filledRaw: Raw = { ...w };
    for (const k of filled) filledRaw[k] = fields[k];
    return workFromJson(filledRaw);
  });
  if (created) simWorks.push(workFromJson(workToDict(created)));
  const sim = new LibraryStore(simWorks);
  const simTarget = sim.get(targetId) as Work;
  const alone = (seed: Work) => {
    const matches = sim.matchesAll(seed);
    return { ok: matches.length === 1 && matches[0] === simTarget, matches };
  };
  for (const d of [...prepared].sort((a, b) =>
    a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0
  )) {
    if (d.kind !== "latex" || d.seedJson === null) continue;
    let seed = seedWorkFor(d.docId, d.seedJson, join(paths.outputDir, d.docId));
    if (seed === null) continue;
    if (!alone(seed).ok) {
      const stamped = structuredClone(d.seedJson);
      stampSourceData(stamped, simTarget);
      const restamped = seedWorkFor(d.docId, stamped, join(paths.outputDir, d.docId));
      const check = restamped ? alone(restamped) : { ok: true, matches: [] };
      if (!check.ok) {
        const other = check.matches.find((m) => m !== simTarget);
        skip.set(d.docId, { reason: "seed_conflict", wouldJoin: other?.id ?? null });
        continue;
      }
      d.stamped = true;
      d.seedJson = stamped;
      const ir = `${d.docId}.json`;
      d.files = d.files.map((f) =>
        f.path === ir
          ? { path: ir, bytes: Buffer.from(JSON.stringify(stamped, null, 2), "utf8") }
          : f
      );
      seed = restamped;
    }
    if (seed) sim.upsert(seed);
  }
  const taking = prepared.filter((d) => !skip.has(d.docId));
  for (const d of taking)
    if (input.docMutations.isDocumentContentBusy(d.docId))
      return refuse(409, "busy", `doc ${d.docId} is being written or deleted; try again`, {
        docId: d.docId,
      });

  // ---- the argument graph and the note -------------------------------------------------------------------------
  let graphDecision: ShelfTakeResult["argumentGraph"] =
    read.argumentGraph === null
      ? "not_carried"
      : request.argumentGraph === false
        ? "not_chosen"
        : "written";
  let localGraphRev = 0;
  if (graphDecision === "written") {
    try {
      const local = loadArgumentGraph(paths.dataDir, targetId);
      if (local.arguments.length > 0 || local.edges.length > 0) graphDecision = "kept_local";
      localGraphRev = local.rev;
    } catch {
      return refuse(
        500,
        "argument_graph_unreadable",
        "the Work's argument graph in this project could not be read; nothing was written"
      );
    }
  }
  const projectNote = typeof targetRaw?.note === "string" ? targetRaw.note : "";
  const note: ShelfTakeResult["note"] =
    read.note === null
      ? "not_carried"
      : request.note === false
        ? "not_chosen"
        : created
          ? "written"
          : projectNote.trim() !== ""
            ? "kept_local"
            : "existing_work";

  // ---- the Work after the take -------------------------------------------------------------------------------
  let citeKey: string | null;
  let title: string;
  if (created) {
    created.doc_ids = taking.map((d) => d.docId);
    const used = new Set(
      rawWorks.map((w) => w.cite_key).filter((k): k is string => typeof k === "string")
    );
    created.cite_key = assignCiteKey(created, used);
    created.acquisition = planToDict(planFor(created));
    citeKey = created.cite_key;
    title = created.title;
  } else {
    citeKey = typeof targetRaw?.cite_key === "string" ? targetRaw.cite_key : null;
    title = filled.includes("title")
      ? String(fields.title)
      : typeof targetRaw?.title === "string"
        ? targetRaw.title
        : "";
  }
  const listed = Array.isArray(targetRaw?.doc_ids)
    ? (targetRaw.doc_ids as unknown[]).map(String)
    : [];
  const before = listed[0] ?? null;
  const after = before ?? taking[0]?.docId ?? null;

  const result: ShelfTakeResult = {
    work: { id: targetId, title, created: created !== null, citeKey, filled },
    mainDoc: { before, after, changed: before !== after },
    docs: {
      taken: taking.map((d) => ({
        docId: d.docId,
        kind: d.kind,
        annotations: d.annotations,
        stamped: d.stamped,
      })),
      skipped: read.docs.flatMap((d) => {
        const s = skip.get(d.docId);
        return s ? [{ docId: d.docId, kind: d.kind, ...s }] : [];
      }),
    },
    argumentGraph: graphDecision,
    note,
  };
  // The digest binds what the person is shown: the entry and rev, and the whole plan (not the time of the Work).
  const digest = createHash("sha256")
    .update(JSON.stringify({ entryId: input.entryId, rev: read.entry.rev, result }))
    .digest("hex");
  return {
    result,
    digest,
    created,
    targetId,
    fields,
    taking,
    graph: graphDecision === "written" ? graph : null,
    localGraphRev,
  };
}

// ---- the take ---------------------------------------------------------------------------------------------

export interface ShelfTake {
  take(entryId: string, body: unknown): Promise<ShelfTakeOutcome>;
  preview(entryId: string, body: unknown): Promise<ShelfPreviewOutcome>;
}

export function createShelfTake(deps: ShelfTakeDeps): ShelfTake {
  const { paths, libraryLock, argumentGraphLock, docMutations } = deps;
  const step = (name: ShelfTakeStep, docId?: string) => deps.hooks?.beforeStep?.(name, docId);

  /** Validate the request and read the whole entry (no lock). */
  const readEntry = async (
    entryId: string,
    body: unknown
  ): Promise<
    { ok: true; request: ShelfTakeRequest; read: Extract<ShelfRead, { status: "ok" }> } | Refusal
  > => {
    if (!SHELF_ENTRY_ID_RE.test(entryId))
      return refuse(400, "invalid_request", "not a Shelf entry id");
    const parsed = ShelfTakeRequestSchema.safeParse(body);
    if (!parsed.success)
      return refuse(
        400,
        "invalid_request",
        "invalid request body (expected {rev, excludeAnnotations?, argumentGraph?, note?, planDigest?})"
      );
    let read: ShelfRead;
    try {
      read = await deps.store().read(entryId, { rev: parsed.data.rev });
    } catch (error) {
      if (error instanceof ShelfIoError) return shelfUnreadable(error);
      throw error;
    }
    if (read.status !== "ok") return readRefusal(read);
    return { ok: true, request: parsed.data, read };
  };

  const preview = async (entryId: string, body: unknown): Promise<ShelfPreviewOutcome> => {
    const got = await readEntry(entryId, body);
    if (!got.ok) return got;
    // Synchronous and writes nothing: no write of this server can interleave with it.
    const plan = planTake({
      entryId,
      read: got.read,
      request: got.request,
      paths,
      docMutations,
      now: new Date().toISOString(),
    });
    if ("ok" in plan) return plan;
    return { ok: true, preview: { plan: plan.result, planDigest: plan.digest } };
  };

  const take = async (entryId: string, body: unknown): Promise<ShelfTakeOutcome> => {
    const got = await readEntry(entryId, body);
    if (!got.ok) return got;
    let outcome: ShelfTakeOutcome | undefined;
    let graphWritten: string | null = null;
    let changed = false;
    await libraryLock.run(() =>
      argumentGraphLock.run(() => {
        const plan = planTake({
          entryId,
          read: got.read,
          request: got.request,
          paths,
          docMutations,
          now: new Date().toISOString(),
        });
        if ("ok" in plan) {
          outcome = plan;
          return;
        }
        if (got.request.planDigest !== undefined && got.request.planDigest !== plan.digest) {
          outcome = refuse(
            409,
            "plan_changed",
            "the project or the entry changed since the preview; look at the plan again",
            { plan: plan.result, planDigest: plan.digest }
          );
          return;
        }
        const done = execute(plan);
        outcome = done.outcome;
        graphWritten = done.graphWritten;
        changed = done.changed;
      })
    );
    if (changed) deps.libraryChanged();
    if (graphWritten !== null) deps.argumentGraphChanged(graphWritten);
    return outcome as ShelfTakeOutcome;
  };

  /** Remove what a crashed take left staged (all of this server's takes run inside one synchronous section). */
  const clearLeftovers = () => {
    for (const root of [paths.outputDir, annotationsRootDir(paths.dataDir)]) {
      let names: string[] = [];
      try {
        names = readdirSync(root);
      } catch {
        continue;
      }
      for (const name of names)
        if (name.startsWith(STAGE_PREFIX)) {
          try {
            rmSync(join(root, name), { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
    }
  };

  const execute = (
    plan: Plan
  ): { outcome: ShelfTakeOutcome; graphWritten: string | null; changed: boolean } => {
    clearLeftovers();
    const undo: (() => void)[] = [];
    let cleanedUp = true;
    const runUndo = () => {
      for (const u of undo.reverse()) {
        try {
          u();
        } catch {
          cleanedUp = false;
        }
      }
    };
    const mkdirOwned = (dir: string) => {
      const made = mkdirSync(dir, { recursive: true });
      if (made !== undefined) undo.push(() => rmSync(made, { recursive: true, force: true }));
    };
    let graphWritten: string | null = null;
    let wrote = false;
    try {
      // Stage every Doc next to its place (hidden names the build and the readers skip), then place them.
      mkdirOwned(paths.outputDir);
      const staged: { doc: PreparedDoc; dir: string }[] = [];
      for (const d of plan.taking) {
        const dir = join(paths.outputDir, `${STAGE_PREFIX}${randomUUID()}`);
        mkdirSync(dir);
        undo.push(() => rmSync(dir, { recursive: true, force: true }));
        for (const f of d.files) {
          const target = join(dir, ...f.path.split("/"));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, f.bytes, { flag: "wx" });
        }
        staged.push({ doc: d, dir });
      }
      for (const { doc, dir } of staged) {
        step("place_doc", doc.docId);
        const place = join(paths.outputDir, doc.docId);
        renameSync(dir, place);
        undo.push(() => rmSync(place, { recursive: true, force: true }));
        wrote = true;
      }
      // The LaTeX / text annotations (`annotations/<docId>/current.json`).
      for (const { doc } of staged) {
        if (!doc.current) continue;
        const root = annotationsRootDir(paths.dataDir);
        mkdirOwned(root);
        const stage = join(root, `${STAGE_PREFIX}${randomUUID()}`);
        mkdirSync(stage);
        undo.push(() => rmSync(stage, { recursive: true, force: true }));
        writeFileSync(join(stage, "current.json"), doc.current, { flag: "wx" });
        step("place_annotations", doc.docId);
        const place = annotationsDocDir(paths.dataDir, doc.docId);
        renameSync(stage, place);
        undo.push(() => rmSync(place, { recursive: true, force: true }));
      }
      // The argument graph, its `work_id` naming the target Work.
      if (plan.graph) {
        step("graph");
        const file = argumentGraphPath(paths.dataDir, plan.targetId);
        const before = lexists(file) ? readFileSync(file) : null;
        const dirBefore = lexists(argumentGraphDir(paths.dataDir));
        const outcome = replaceArgumentGraph(paths.dataDir, {
          ...plan.graph,
          work_id: plan.targetId,
          rev: plan.localGraphRev,
        });
        if ("conflictRev" in outcome) throw new Error("argument graph changed meanwhile");
        undo.push(() => {
          if (before !== null) {
            const tmp = `${file}.shelf-undo`;
            writeFileSync(tmp, before);
            renameSync(tmp, file);
          } else {
            rmSync(file, { force: true });
            if (!dirBefore) rmdirSync(argumentGraphDir(paths.dataDir));
          }
        });
        graphWritten = plan.targetId;
      }
      // The library, last: a new Work appended, or the blank fields of the target filled and the Docs appended.
      step("library");
      const snapshot = (path: string) => (lexists(path) ? readFileSync(path) : null);
      const jsonBefore = snapshot(paths.libraryJson);
      const bibBefore = snapshot(paths.libraryBib);
      const libDirBefore = lexists(paths.libraryDir);
      undo.push(() => {
        for (const [path, bytes] of [
          [paths.libraryJson, jsonBefore],
          [paths.libraryBib, bibBefore],
        ] as const) {
          if (bytes === null) rmSync(path, { force: true });
          else {
            const tmp = `${path}.shelf-undo`;
            writeFileSync(tmp, bytes);
            renameSync(tmp, path);
          }
        }
        if (!libDirBefore) rmSync(paths.libraryDir, { recursive: true, force: true });
      });
      if (plan.created) {
        saveWorksNarrow(paths, { created: [plan.created] });
        wrote = true;
      } else {
        const filledFields: Raw = {};
        for (const k of plan.result.work.filled) filledFields[k] = plan.fields[k];
        const result = fillWorkNarrow(
          paths,
          plan.targetId,
          filledFields,
          plan.taking.map((d) => d.docId)
        );
        if (result.status === "not_found") throw new Error("the target Work is gone");
        if (result.status === "ok") wrote = true;
      }
    } catch (error) {
      runUndo();
      const detail = cleanedUp
        ? `the take could not be written (${errCode(error)}); what it had written was removed again`
        : `the take could not be written (${errCode(error)}); some of what it had written could not be removed`;
      return {
        outcome: refuse(500, "write_failed", detail, { cleanedUp }),
        graphWritten: null,
        changed: false,
      };
    }
    // The saved-only citation graph cache follows at once when it can; the next refresh converges it otherwise.
    if (wrote)
      try {
        const store = LibraryStore.load(paths);
        const w = store.get(plan.targetId);
        if (w) {
          const next = mergeWorkIntoGraph(loadCurrentGraph(paths) ?? healGraph(paths), store, w);
          mkdirSync(paths.cacheDir, { recursive: true });
          writeFileSync(paths.graphJson, JSON.stringify(next), "utf8");
        }
      } catch {
        /* derived cache only */
      }
    return { outcome: { ok: true, result: plan.result }, graphWritten, changed: wrote };
  };

  return { take, preview };
}

// ---- the annotation list ------------------------------------------------------------------------------------

const SNIPPET = 200;
const snippetOf = (s: unknown): string => {
  const t = (typeof s === "string" ? s : "").replace(/\s+/g, " ").trim();
  return t.length > SNIPPET ? `${t.slice(0, SNIPPET)}…` : t;
};

/** Section paths ("1 Introduction › 2.1 Data") of an IR's sections and of the blocks in them. */
function sectionPaths(irJson: unknown): Map<string, string> {
  const paths = new Map<string, string>();
  const ir = StoredDocIrSchema.safeParse(irJson);
  if (!ir.success) return paths;
  type Sec = {
    id: string;
    number?: string | null;
    heading?: string | null;
    blocks: { id: string }[];
    children: Sec[];
  };
  const walk = (secs: Sec[], parent: string | null) => {
    for (const sec of secs) {
      const label = `${sec.number ? `${sec.number} ` : ""}${sec.heading ?? ""}`.trim() || sec.id;
      const path = parent ? `${parent} › ${label}` : label;
      paths.set(sec.id, path);
      for (const b of sec.blocks) paths.set(b.id, path);
      walk(sec.children, path);
    }
  };
  walk(ir.data.sections as unknown as Sec[], null);
  return paths;
}

function annotationRows(
  doc: ShelfDocContent
): ShelfAnnotationsResponse["docs"][number]["annotations"] {
  if (!doc.annotations) return [];
  let raw: unknown;
  try {
    raw = jsonOf(doc.annotations.bytes);
  } catch {
    throw invalid(doc.docId, "annotations", "not_json");
  }
  if (doc.kind === "pdf") {
    const file = PdfAnnotationsFileSchema.safeParse(raw);
    if (!file.success) throw invalid(doc.docId, "annotations", "pdf_annotations");
    return file.data.annotations.map((a) => {
      const r = a as unknown as Raw;
      const target = r.target as
        | { quote?: string; fragments?: { page_index: number }[] }
        | undefined;
      const page =
        typeof r.page_index === "number"
          ? r.page_index
          : (target?.fragments?.[0]?.page_index ?? null);
      return {
        id: a.id,
        kind: a.kind,
        location: { sectionPath: null, number: null, pageIndex: page },
        snippet: snippetOf(target?.quote),
        body: a.body,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      };
    });
  }
  const file = AnnotationsFileSchema.safeParse(raw);
  if (!file.success) throw invalid(doc.docId, "annotations", "annotations_file");
  const irBytes = doc.files.find((f) => f.path === `${doc.docId}.json`)?.bytes;
  let paths = new Map<string, string>();
  if (irBytes)
    try {
      paths = sectionPaths(jsonOf(irBytes));
    } catch {
      paths = new Map();
    }
  return file.data.annotations.map((a) => {
    const t = a.target as unknown as Raw;
    const snap = (t.snapshot ?? {}) as Raw;
    const block =
      t.type === "text" ? String(t.block) : t.type === "structure" ? String(t.id) : null;
    const items = Array.isArray(snap.items) ? (snap.items as unknown[]) : [];
    const snippet =
      t.type === "text"
        ? t.quote
        : [
            snap.heading,
            snap.text,
            items[0],
            snap.latex,
            snap.caption,
            snap.body,
            snap.table_body,
          ].find((s) => typeof s === "string" && s.trim() !== "");
    return {
      id: a.id,
      kind: t.type === "structure" ? String(t.kind) : String(t.type),
      location: {
        sectionPath: block === null ? null : (paths.get(block) ?? null),
        number: typeof snap.number === "string" ? snap.number : null,
        pageIndex: null,
      },
      snippet: snippetOf(snippet),
      body: a.body,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    };
  });
}

// ---- routes -----------------------------------------------------------------------------------------------

/** Mount the Shelf read, preview and take routes; the reads are guarded too (the Shelf is the person's global data). */
export function mountShelfRoutes(app: ProtectedRoutes, deps: ShelfTakeDeps): void {
  const shelfTake = createShelfTake(deps);
  const unreadable = (c: Context, error: unknown) => {
    const code = error instanceof ShelfIoError ? error.code : errCode(error);
    return c.json(
      { detail: `the Shelf could not be read (${code})`, code: "shelf_unreadable", errno: code },
      500,
      NO_STORE
    );
  };
  const answer = (c: Context, r: Refusal) => c.json(r.body, r.status, NO_STORE);

  app.get("/api/shelf", { guard: true, noStore: true }, async (c) => {
    let items: Awaited<ReturnType<ShelfStore["list"]>>;
    try {
      items = await deps.store().list();
    } catch (error) {
      return unreadable(c, error);
    }
    const entries: ShelfListRow[] = items.map((item): ShelfListRow => {
      switch (item.status) {
        case "ok":
          return { status: "ok", ...summaryOf(item) };
        case "incompatible":
          return {
            status: "incompatible",
            entryId: item.entryId,
            rev: item.rev,
            bytes: item.bytes,
            format: item.format,
            title: item.title,
            needsUpdate: true,
          };
        case "damaged":
          return {
            status: "damaged",
            entryId: item.entryId,
            rev: item.rev,
            bytes: item.bytes,
            problem: item.problem,
          };
        default:
          return {
            status: "unreadable",
            entryId: item.entryId,
            rev: item.rev,
            bytes: 0,
            code: item.code,
          };
      }
    });
    return c.json({ entries } satisfies ShelfListResponse, 200, NO_STORE);
  });

  app.get("/api/shelf/lookup", { guard: true, noStore: true }, async (c) => {
    const q = (name: string) => {
      const v = c.req.query(name)?.trim();
      return v ? v : null;
    };
    const query = { doi: q("doi"), arxiv: q("arxiv"), openalex: q("openalex") };
    if (!query.doi && !query.arxiv && !query.openalex)
      return c.json(
        { detail: "give doi, arxiv or openalex", code: "invalid_request" },
        400,
        NO_STORE
      );
    try {
      const found = await deps.store().findByIdentity(query);
      const entries: ShelfLookupResponse["entries"] = found.map((e) => ({
        entryId: e.entryId,
        rev: e.rev,
        title: e.manifest.bibliography.title,
        matchedOn: e.matchedOn,
      }));
      return c.json({ entries } satisfies ShelfLookupResponse, 200, NO_STORE);
    } catch (error) {
      return unreadable(c, error);
    }
  });

  // The summary is what the manifest says (the list's reading; no file is hashed): the take and its preview check
  // every file.
  app.get("/api/shelf/entries/:entry_id", { guard: true, noStore: true }, async (c) => {
    const entryId = c.req.param("entry_id");
    if (!SHELF_ENTRY_ID_RE.test(entryId))
      return c.json({ detail: "not a Shelf entry id", code: "invalid_request" }, 400, NO_STORE);
    let item: Awaited<ReturnType<ShelfStore["list"]>>[number] | undefined;
    try {
      item = (await deps.store().list()).find((e) => e.entryId === entryId);
    } catch (error) {
      return unreadable(c, error);
    }
    if (item === undefined)
      return c.json({ detail: "no such Shelf entry", code: "not_found" }, 404, NO_STORE);
    const body: ShelfEntryResponse =
      item.status === "ok"
        ? { status: "ok", ...summaryOf(item), bibliography: item.manifest.bibliography }
        : item.status === "incompatible"
          ? { status: "incompatible", entryId, rev: item.rev, needsUpdate: true }
          : item.status === "damaged"
            ? { status: "damaged", entryId, rev: item.rev, problem: item.problem }
            : { status: "unreadable", entryId, rev: item.rev, code: item.code };
    return c.json(body, 200, NO_STORE);
  });

  app.get("/api/shelf/entries/:entry_id/annotations", { guard: true, noStore: true }, async (c) => {
    const entryId = c.req.param("entry_id");
    if (!SHELF_ENTRY_ID_RE.test(entryId))
      return c.json({ detail: "not a Shelf entry id", code: "invalid_request" }, 400, NO_STORE);
    const revText = c.req.query("rev");
    const rev = revText === undefined ? undefined : Number(revText);
    if (rev !== undefined && (!Number.isSafeInteger(rev) || rev < 1))
      return c.json(
        { detail: "rev must be a positive integer", code: "invalid_request" },
        400,
        NO_STORE
      );
    let read: ShelfRead;
    try {
      read = await deps.store().read(entryId, rev === undefined ? {} : { rev });
    } catch (error) {
      return unreadable(c, error);
    }
    if (read.status !== "ok") return answer(c, readRefusal(read));
    try {
      const docs = read.docs.map((d) => ({
        docId: d.docId,
        kind: d.kind,
        annotations: annotationRows(d),
      }));
      return c.json(
        { entryId, rev: read.entry.rev, docs } satisfies ShelfAnnotationsResponse,
        200,
        NO_STORE
      );
    } catch (error) {
      if (error instanceof TakeRefused) return answer(c, error.refusal);
      throw error;
    }
  });

  app.post("/api/shelf/entries/:entry_id/take/preview", { noStore: true }, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const outcome = await shelfTake.preview(c.req.param("entry_id"), body);
    return outcome.ok ? c.json(outcome.preview, 200, NO_STORE) : answer(c, outcome);
  });

  app.post("/api/shelf/entries/:entry_id/take", { noStore: true }, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const outcome = await shelfTake.take(c.req.param("entry_id"), body);
    return outcome.ok ? c.json(outcome.result, 200, NO_STORE) : answer(c, outcome);
  });
}
