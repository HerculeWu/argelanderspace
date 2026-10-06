/**
 * Library page context and the closed operation union of the Copilot `library` tool (copilot ticket 13).
 *
 * Every action mirrors something the Library page really does today:
 *  - read: the page's own list/search/detail data (`GET /api/library`), filtered by the page's own predicate;
 *  - set_main_doc: the Files tab "set as main" button (`PATCH /api/library/refs { doc_id }`), the only
 *    persistent per-work write the page has. There is no tool for note, tags, read or star: the page has no
 *    control that writes them (notes are read-only there);
 *  - filter_library / select_work / set_detail_tab / set_sidebar: the search box, list/graph selection, the
 *    detail tabs and the sidebar fold (bound-view state, no object has to be opened to read or edit);
 *  - import_works: the import menu's three dialogs (identifier, ADS bibcode, BibTeX text), i.e.
 *    `POST /api/library/works`; the tool takes only the text the dialog would receive;
 *  - set_temp_label: the right-click colour dot, which is a session-local display overlay that is never saved;
 *  - acquire_arxiv_pdf / attach_arxiv: the Files tab acquisition dialog's "fetch PDF from arXiv" and "get LaTeX
 *    source from arXiv" submits (`POST /api/library/acquire-arxiv-pdf`, `POST /api/library/attach-arxiv`); both
 *    start a job in the existing JobRunner and take only a work id. Refreshing an existing arXiv LaTeX Doc
 *    replaces its text, so it waits for the real user's confirmation, as the dialog's annotation-risk step does;
 *  - read_jobs: the acquisition status lines (queued/running/failed jobs of a work) from the JobRunner table.
 *  - delete_doc: the Files tab "delete document" dialog (`DELETE /api/paper/:doc_id`), the global physical delete.
 *    It only ever waits for the real user's confirmation card (the dialog's own confirm); there is no "unlink from
 *    this Work" variant, because the page has none.
 */
import { z } from "zod";
import { DISCOVERY_VIEW_ACTIONS, DiscoveryViewActionSchemas } from "./discovery-ops.js";
import {
  type LibraryRef,
  LibraryRefSchema,
  type ManualWorkRequest,
  ManualWorkRequestSchema,
} from "./library.js";

export const LIBRARY_DETAIL_TABS = ["meta", "info", "bib", "notes", "files"] as const;
export const LIBRARY_LABEL_KEYS = ["red", "amber", "green", "blue", "violet"] as const;
export type LibraryDetailTab = (typeof LIBRARY_DETAIL_TABS)[number];

/** The sidebar list's own search predicate (title + authors + cite key, case-insensitive substring). */
export function libraryRefMatches(
  ref: { title: string; authors: string; cite: string },
  query: string
): boolean {
  return !query || (ref.title + ref.authors + ref.cite).toLowerCase().includes(query.toLowerCase());
}

/**
 * `read` only: a query that is an identity (DOI, doi.org URL, `arXiv:` id or arxiv.org URL, ADS bibcode, or the
 * work id) matches the work holding it, so a bare stub with no title can be found by the identifier it was
 * imported with. The sidebar search box does not do this (the page has no such control).
 */
export function libraryRefIdentityMatches(
  ref: { id: string; doi?: string; arxiv_id?: string; bibcode?: string },
  query: string
): boolean {
  let q = query.trim().toLowerCase();
  if (!q) return false;
  q = q
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "doi:")
    .replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf)\//, "arxiv:")
    .replace(/\.pdf$/, "")
    .replace(/(arxiv:\d{4}\.\d{4,5})v\d+$/, "$1");
  const bare = q.replace(/^(doi|arxiv):/, "");
  const held = [ref.id, ref.doi, ref.arxiv_id, ref.bibcode]
    .filter((value): value is string => !!value)
    .map((value) => value.toLowerCase());
  return held.some(
    (value) => value === q || value === bare || value.replace(/^(doi|arxiv):/, "") === bare
  );
}

/** The BibTeX tab's text (derived from the displayed fields, exactly as the tab shows it). */
export function libraryRefBibtex(r: LibraryRef): string {
  return (
    "@" +
    (r.type === "conf" ? "inproceedings" : "article") +
    "{" +
    r.cite +
    ",\n" +
    "  title   = {" +
    r.title +
    "},\n" +
    "  author  = {" +
    r.authors.replace(/ & /g, " and ").replace(/ et al\./, " and others") +
    "},\n" +
    "  journal = {" +
    r.venue +
    "},\n  year    = {" +
    r.year +
    "}\n}"
  );
}

/** Citation links (citing, cited), as work ids, whose both ends are in `ids`. */
export function libraryLinksAmong(
  graph: { nodes: { id: string; ref?: string }[]; links: [string, string][] },
  ids: ReadonlySet<string>
): [string, string][] {
  const nodeToRef = new Map<string, string>();
  for (const node of graph.nodes) if (node.ref) nodeToRef.set(node.id, node.ref);
  const links: [string, string][] = [];
  for (const [from, to] of graph.links) {
    const a = nodeToRef.get(from);
    const b = nodeToRef.get(to);
    if (a && b && ids.has(a) && ids.has(b)) links.push([a, b]);
  }
  return links;
}

/** A list row: what the sidebar shows plus the identity an operation needs. */
export const LibraryRefSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    authors: z.string(),
    year: z.number().int(),
    venue: z.string(),
    type: z.enum(["article", "conf"]),
    cite: z.string(),
    tags: z.array(z.string()),
    pdf: z.boolean(),
    read: z.boolean(),
    star: z.boolean(),
    label: z.string().optional(),
    doi: z.string().optional(),
    arxiv_id: z.string().optional(),
    bibcode: z.string().optional(),
    doc_ids: z.array(z.string()).optional(),
    citedBy: z.number().int().optional(),
    needs_upload: z.boolean().optional(),
  })
  .strict();
export type LibraryRefSummary = z.infer<typeof LibraryRefSummarySchema>;

export function summarizeLibraryRef(ref: LibraryRef): LibraryRefSummary {
  const summary: LibraryRefSummary = {
    id: ref.id,
    title: ref.title,
    authors: ref.authors,
    year: ref.year,
    venue: ref.venue,
    type: ref.type,
    cite: ref.cite,
    tags: ref.tags,
    pdf: ref.pdf,
    read: ref.read,
    star: ref.star,
  };
  if (ref.label !== undefined) summary.label = ref.label;
  if (ref.doi !== undefined) summary.doi = ref.doi;
  if (ref.arxiv_id !== undefined) summary.arxiv_id = ref.arxiv_id;
  if (ref.bibcode !== undefined) summary.bibcode = ref.bibcode;
  if (ref.doc_ids !== undefined) summary.doc_ids = ref.doc_ids;
  else if (ref.doc_id !== undefined) summary.doc_ids = [ref.doc_id];
  if (ref.citedBy !== undefined) summary.citedBy = ref.citedBy;
  if (ref.needs_upload !== undefined) summary.needs_upload = ref.needs_upload;
  return summary;
}

/**
 * What the Library page shows right now. `refs` is the whole filtered list (not the mounted rows);
 * the rest of the library is only a count. `source: "demo"` is the built-in example data the page falls
 * back to when the service cannot be read: it is not the saved library and nothing in it can be edited.
 */
export const LibraryPageSchema = z
  .object({
    /**
     * `live`: the saved library. `demo`: the built-in example shown because the service could not be reached.
     * `error`: the service answered but the library could not be read (see `error`); the page then shows the example too.
     */
    source: z.enum(["live", "demo", "error"]),
    /** Why the library could not be read (only with `source: "error"`). */
    error: z.string().optional(),
    query: z.string(),
    total: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    refs: z.array(LibraryRefSummarySchema),
    /** Citation links (citing, cited) between works of `refs`; the graph itself shows the whole library. */
    links: z.array(z.tuple([z.string(), z.string()])),
    selectedRefId: z.string().nullable(),
    detail: z
      .object({
        ref: LibraryRefSchema,
        bibtex: z.string(),
        tab: z.enum(LIBRARY_DETAIL_TABS),
      })
      .strict()
      .nullable(),
    /** Colour dots set from the right-click menu: temporary, in this tab only, never written to the library. */
    temporaryLabels: z.record(z.string(), z.enum(LIBRARY_LABEL_KEYS).nullable()),
    sidebarCollapsed: z.boolean(),
    /** The citation graph's display state (the page draws the whole library; only the controls are state). */
    graph: z.object({ labelsOn: z.boolean() }).strict(),
    /**
     * Explorations this tab can resume (the toolbar's "resume exploration" shows only when there are some):
     * how many seed transitions it holds and the one it would return to. Absent from older views.
     */
    exploration: z
      .object({ sessions: z.number().int().nonnegative(), seed: z.string().nullable() })
      .strict()
      .optional(),
  })
  .strict();
export type LibraryPage = z.infer<typeof LibraryPageSchema>;

/** What a message records of the Library it carried (counts and identity; the content itself is in the history). */
export const LibraryContextSummarySchema = z
  .object({
    source: z.enum(["live", "demo", "error"]),
    error: z.string().optional(),
    query: z.string(),
    total: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    selectedRefId: z.string().nullable(),
  })
  .strict();
export type LibraryContextSummary = z.infer<typeof LibraryContextSummarySchema>;
export function summarizeLibraryPage(page: LibraryPage): LibraryContextSummary {
  return {
    source: page.source,
    ...(page.error !== undefined ? { error: page.error } : {}),
    query: page.query,
    total: page.total,
    matched: page.matched,
    selectedRefId: page.selectedRefId,
  };
}

export const GRAPH_CONTROLS = ["zoom_in", "zoom_out", "fit", "relayout"] as const;
const Id = z.string().min(1).max(500);

export const LibraryReadOperationSchema = z
  .object({
    action: z.literal("read"),
    /** The sidebar search; omitted reads the whole library page by page. */
    query: z.string().max(500).optional(),
    /** One work in full (abstract, note, Docs, BibTeX tab text). */
    refId: Id.optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    /** Add the citation links among the matched works. */
    links: z.boolean().optional(),
  })
  .strict();

/** The Files tab "set as main" button. `expectedMainDocId` is the main Doc the caller read. */
export const LibrarySetMainDocSchema = z
  .object({
    action: z.literal("set_main_doc"),
    refId: Id,
    docId: Id,
    expectedMainDocId: Id.nullable(),
  })
  .strict();

/**
 * The import menu's three dialogs (`POST /api/library/works`): one identifier, one ADS bibcode or pasted
 * BibTeX. Only the text the dialog would receive is accepted; there is no path, URL to fetch or file field.
 * Its limits are the dialog request's own (`ManualWorkRequestSchema`).
 */
export const LibraryImportWorksSchema = z
  .object({
    action: z.literal("import_works"),
    mode: z.enum(["identifier", "bibcode", "bib"]),
    text: z.string().min(1).max(1_000_000),
  })
  .strict()
  .superRefine((op, ctx) => {
    const request = ManualWorkRequestSchema.safeParse(libraryImportRequest(op));
    if (!request.success)
      for (const issue of request.error.issues)
        ctx.addIssue({ code: "custom", path: ["text"], message: issue.message });
  });
export type LibraryImportWorks = z.infer<typeof LibraryImportWorksSchema>;

/** The request the import dialog itself sends for this input (identifier/bibcode trimmed as the dialog does). */
export function libraryImportRequest(
  op: Pick<LibraryImportWorks, "mode" | "text">
): ManualWorkRequest {
  const text = op.text.trim();
  if (op.mode === "identifier") return { mode: "identifier", value: text };
  if (op.mode === "bibcode") return { mode: "bibcode", bibcode: text };
  return { mode: "bib", bib: text };
}

/** The acquisition dialog's "fetch PDF from arXiv" submit: `POST /api/library/acquire-arxiv-pdf?id=<workId>`. */
export const LibraryAcquireArxivPdfSchema = z
  .object({ action: z.literal("acquire_arxiv_pdf"), refId: Id })
  .strict();
/** The dialog's "get LaTeX source from arXiv" submit (new Doc, or refresh of the arXiv Doc): `POST /api/library/attach-arxiv`. */
export const LibraryAttachArxivSchema = z
  .object({ action: z.literal("attach_arxiv"), refId: Id })
  .strict();
/** The acquisition status lines: jobs of one work (or the latest jobs of any work) from the JobRunner table. */
export const LibraryReadJobsSchema = z
  .object({
    action: z.literal("read_jobs"),
    refId: Id.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
/**
 * The Files tab's "delete document" dialog: the GLOBAL physical delete of one Doc (its stored text or original,
 * assets, sidecars and all annotations including the archive), removed from every Work that lists it.
 */
export const LibraryDeleteDocSchema = z
  .object({ action: z.literal("delete_doc"), docId: Id })
  .strict();
export type LibraryDeleteDoc = z.infer<typeof LibraryDeleteDocSchema>;
export type LibraryAcquireArxivPdf = z.infer<typeof LibraryAcquireArxivPdfSchema>;
export type LibraryAttachArxiv = z.infer<typeof LibraryAttachArxivSchema>;
export type LibraryReadJobs = z.infer<typeof LibraryReadJobsSchema>;

/** View operations are executed by the bound browser view, never by the store. */
export const LibraryViewActionSchema = z.discriminatedUnion("action", [
  ...DiscoveryViewActionSchemas,
  z.object({ action: z.literal("filter_library"), query: z.string().max(500) }).strict(),
  /** The list row or graph node; null closes the detail panel. */
  z.object({ action: z.literal("select_work"), refId: Id.nullable() }).strict(),
  z
    .object({
      action: z.literal("set_detail_tab"),
      tab: z.enum(LIBRARY_DETAIL_TABS),
      refId: Id.optional(),
    })
    .strict(),
  z.object({ action: z.literal("set_sidebar"), collapsed: z.boolean() }).strict(),
  /** The graph's "show labels" toggle, set explicitly. */
  z.object({ action: z.literal("set_graph_labels"), on: z.boolean() }).strict(),
  /** The graph's zoom in / zoom out / fit / re-layout buttons. Dragging, panning and wheel zoom are user gestures. */
  z.object({ action: z.literal("graph_control"), control: z.enum(GRAPH_CONTROLS) }).strict(),
  /** The right-click colour dot: temporary and local to the bound tab. null clears it. */
  z
    .object({
      action: z.literal("set_temp_label"),
      refId: Id,
      label: z.enum(LIBRARY_LABEL_KEYS).nullable(),
    })
    .strict(),
]);
export type LibraryViewAction = z.infer<typeof LibraryViewActionSchema>;

/**
 * Sent by the service (never callable by the model) to the bound view after a Doc was deleted through the tool, so
 * the Shell makes the same three-state update the page makes after its own delete: a deleted non-current Doc
 * changes nothing; a deleted current Doc moves to `remaining[0]` (the Work's new main Doc) or, with nothing left,
 * to no Doc; the paper list drops the id at once. It is not part of LIBRARY_OPERATION_ACTIONS or any tool schema.
 */
export const DocDeletedViewActionSchema = z
  .object({
    action: z.literal("doc_deleted"),
    docId: Id,
    remaining: z.array(z.string()).max(1000),
  })
  .strict();
export type DocDeletedViewAction = z.infer<typeof DocDeletedViewActionSchema>;
export type LibrarySetMainDoc = z.infer<typeof LibrarySetMainDocSchema>;
export type LibraryReadOperation = z.infer<typeof LibraryReadOperationSchema>;

export const LIBRARY_OPERATION_ACTIONS = [
  "read",
  "set_main_doc",
  "import_works",
  "acquire_arxiv_pdf",
  "attach_arxiv",
  "delete_doc",
  "read_jobs",
  "filter_library",
  "select_work",
  "set_detail_tab",
  "set_sidebar",
  "set_graph_labels",
  "graph_control",
  "set_temp_label",
  "read_discovery",
  "save_candidate",
  ...DISCOVERY_VIEW_ACTIONS,
] as const;
