import {
  type CopilotFileToolsSetting,
  type CopilotOperation,
  DISCOVERY_DETAIL_TABS,
  DISCOVERY_DISPLAYS,
  DISCOVERY_FILTERS,
  DISCOVERY_GRAPH_CONTROLS,
  type DiscoverySavedViewAction,
  type DocDeletedViewAction,
  discoveryReachableBibcodes,
  LIBRARY_DETAIL_TABS,
  LIBRARY_LABEL_KEYS,
  LIBRARY_OPERATION_ACTIONS,
  LibraryAcquireArxivPdfSchema,
  LibraryAttachArxivSchema,
  LibraryAttachLocalPdfSchema,
  LibraryImportWorksSchema,
  LibraryListAdsLibrariesSchema,
  LibraryReadAdsLibrarySchema,
  LibraryReadDiscoverySchema,
  LibraryReadJobsSchema,
  LibrarySaveCandidateSchema,
  type LibraryViewAction,
  LibraryViewActionSchema,
  type PageContext,
  parseCatalogCall,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  askUser,
  confirmUnavailable,
  done,
  record as recordFor,
  runOperation,
  type ToolHostContext,
} from "./copilot-tool-kit.js";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";
import {
  DOC_DELETE_UNAVAILABLE,
  prepareDocDelete,
  recheckDocDelete,
} from "./doc-delete-operation.js";
import {
  type AcquireOutcome,
  type AttachLocalPdfOutcome,
  applyAcquireArxivPdf,
  applyAttachArxiv,
  applyAttachLocalPdf,
  applyDocDelete,
  applyLibraryBibcodeImport,
  applyLibraryImport,
  jobView,
  type LibraryImportOutcome,
  type LibraryOpDeps,
  type LibraryOpOutcome,
  type LibraryReadOutcome,
  listAdsLibraries,
  prepareArxivRefresh,
  readAdsLibrary,
  readJobs,
} from "./library-actions.js";
import { runCatalogOperation } from "./operation-catalog.js";

export const LIBRARY_TOOL_NAME = "library";

/** Writes are journaled; replacing an existing arXiv Doc and deleting a Doc wait for the user through `confirm`. */
export interface LibraryToolContext extends ToolHostContext {
  library: LibraryOpDeps;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: LibraryViewAction) => Promise<ViewActionOutcome>;
  /**
   * After a Doc was deleted: tell the bound view so its Shell makes the page's own three-state update (paper list,
   * current Doc). Best effort and not awaited: the delete is already committed, and a view that is offline simply
   * loads the real paper list when it reconnects. Not cancelled by Stop (it is state sync, not navigation).
   */
  shellSync?: (action: DocDeletedViewAction | DiscoverySavedViewAction) => void;
  /**
   * The page the bound view last published: `read_discovery` reports exactly this, and `save_candidate` checks the
   * candidate against the exploration it shows. Discovery has no service-side session to ask instead.
   */
  page?: () => PageContext | undefined;
  /**
   * The Copilot file and command permission (`copilot_file_tools`) as it is now, read at every call. `attach_local_pdf`
   * reads a file anywhere on this machine, so it follows the same switch as the file tools: off refuses it; ask and
   * auto both allow it without a confirmation card. A host that cannot say (no file tools) is treated as off.
   */
  fileToolsPermission?: () => CopilotFileToolsSetting;
}

const lit = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>({ type: "string", enum: [...values] });

const parameters = Type.Object(
  {
    action: lit(LIBRARY_OPERATION_ACTIONS),
    operationId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          "Optional idempotency key for set_main_doc, import_works and the acquisition actions. Repeating the same key with the same parameters returns the first result instead of writing again.",
      })
    ),
    query: Type.Optional(
      Type.String({
        description:
          "read: the sidebar search (title, authors, cite key; case-insensitive); an identifier (DOI, doi.org URL, arXiv:<id> or arxiv.org URL, bibcode, or a work id) also matches the work holding it, even one without a title. filter_library: the text to put in the search box (empty clears it). search_discovery: the exploration's own search box (title, authors, year, bibcode; empty clears it). search_ads: the ADS query string (required).",
      })
    ),
    refId: Type.Optional(
      Type.String({
        description:
          "The work id (for example doi:10.1051/..., arxiv:2603.03522). read: return that one work in full. acquire_arxiv_pdf/attach_arxiv/attach_local_pdf: the target work (required). read_jobs: only that work's jobs. explore_work: the work to explore (needs an ADS bibcode). Other actions: the target work; select_work accepts null to close the detail.",
      })
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "read: first match to return. read_ads_library: first bibcode to return.",
      })
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description:
          "read: page size, default 100. read_jobs: at most 50, default 10. read_ads_library: bibcodes per page, at most 200, default 200. search_ads: records, at most 50, default 10.",
      })
    ),
    links: Type.Optional(
      Type.Boolean({ description: "read: also return the citation links among the matched works." })
    ),
    docId: Type.Optional(
      Type.String({
        description:
          "set_main_doc: the Doc to make the main Doc. delete_doc: the Doc to delete everywhere (required).",
      })
    ),
    expectedMainDocId: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "set_main_doc: the main Doc (first of doc_ids) you read for this work, or null if it had none. Required.",
      })
    ),
    mode: Type.Optional(lit(["identifier", "bibcode", "bib"] as const)),
    batch: Type.Optional(
      Type.Boolean({
        description:
          "import_works, modes bibcode and identifier: no automatic arXiv PDF job (bibcode: also the per-entry batch result, even for one). Always set it when migrating a project.",
      })
    ),
    text: Type.Optional(
      Type.String({
        description:
          "import_works: exactly what the import dialog would receive for that mode. identifier: one DOI, doi.org URL, arXiv:<id> or arxiv.org URL (a bare arXiv id is rejected); bibcode: one ADS bibcode, or up to 200 separated by whitespace, commas or semicolons (a batch); bib: BibTeX text, one or many entries. Text only: no file paths.",
      })
    ),
    path: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4096,
        description: "attach_local_pdf: absolute local path of one PDF (required).",
      })
    ),
    fields: Type.Optional(
      Type.String({
        description:
          "search_ads: comma-separated record fields from title, author, year, pub, citation_count, doi, arxiv_id, abstract (default title,author,year,pub,citation_count,doi; bibcode is always there).",
      })
    ),
    libraryId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          "read_ads_library: the id of an ADS library, as list_ads_libraries returned it (required).",
      })
    ),
    tab: Type.Optional(lit([...LIBRARY_DETAIL_TABS, ...DISCOVERY_DETAIL_TABS] as const)),
    on: Type.Optional(
      Type.Boolean({
        description:
          "set_graph_labels / set_discovery_graph_labels: show (true) or hide the node labels.",
      })
    ),
    control: Type.Optional(lit(DISCOVERY_GRAPH_CONTROLS)),
    bibcode: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "save_candidate, explore_candidate, select_candidate, view_candidate_in_library: the ADS bibcode of a node of the exploration the user has open (read_discovery lists them). select_candidate accepts null to close the inspector.",
      })
    ),
    filter: Type.Optional(lit(DISCOVERY_FILTERS)),
    display: Type.Optional(lit(DISCOVERY_DISPLAYS)),
    direction: Type.Optional(lit(["back", "forward"] as const)),
    target: Type.Optional(lit(["failed", "current"] as const)),
    collapsed: Type.Optional(
      Type.Boolean({ description: "set_sidebar: fold (true) or open the list." })
    ),
    label: Type.Optional(
      Type.Union([lit(LIBRARY_LABEL_KEYS), Type.Null()], {
        description: "set_temp_label: the colour, or null to clear it.",
      })
    ),
  },
  { additionalProperties: false }
);

const description = [
  "Read and operate the user's Library page: the saved works, search, the detail panel and its tabs, the main-Doc choice, the arXiv full-text acquisition of the Files tab and the literature exploration (Discovery) opened from a work. It deletes a Doc only through delete_doc and the user's confirmation card; notes, tags and the read flag have no editing control in the application, so you cannot change them.",
  "read returns the page's own data: one page of the works matching query (title, authors, cite key), with the total, or one work in full with refId. Reading never opens or selects anything.",
  "set_main_doc is the Files tab's 'set as main': it needs expectedMainDocId, the main Doc from your latest read of that work. If it changed, the result is conflict: read the work again and form a new request; do not resend the stale one. Other fields of the work, including ones you did not read, are kept. If saving fails the status is error: the file was not replaced, except in the rare case of a failure between the two final renames, where library.json may already be updated, so read the work again before deciding. Writes wait their turn behind other library writes; they are not refused as busy.",
  "import_works is the import menu's submit, with the same checks, duplicate detection and results: mode identifier (one DOI or arXiv:<id>), bibcode (one ADS bibcode, or a batch of up to 200 in one text; fails without a stub when ADS cannot answer) or bib (pasted BibTeX; per-entry results, your cite keys are kept, a key held by another work is an error for that entry). Give it text only, never a path; with the file tools on, read the file yourself first and pass its text. Creating a Work does not select or open it; use select_work with a returned work id if the user wants it shown. An entry the library already holds comes back as exists and is not duplicated, but the import can still update that Work (blank fields are filled, its acquisition plan is recomputed, its type may change); the result lists those ids in updated, and your own data on it (note, tags, flags) is kept. A new entry without a DOI or arXiv id whose title-and-year derived work id is already used by a different paper (for example part II of a series) is an error for that entry with nothing written: ask the user for a DOI or arXiv id. A record that would merge two existing works into one is refused as rejected with nothing written: tell the user to resolve them in the Library page. In bib mode the whole text is refused then: the entry that would merge has reason merge_refused and works (the Work ids), every other entry reason batch_refused; import the batch_refused ones again without it. A single identifier or bibcode import may also start the default arXiv PDF download exactly as the page does (a separate background job); a bibcode batch never does, and batch true stops it for an identifier too (the project migration always sets it). A bibcode text with one bibcode is the single import unless you set batch true, which gives the batch result shape; an identifier keeps its single result shape; batch does not apply to mode bib. A batch is answered per bibcode in order as entries (bibcode, status, id, title, reason, works), with requested, created, existing, updated (distinct works that existed and were changed), refused and failed, and a reasons map that explains each reason used, once: an entry that would merge existing works is refused alone, nothing of it written (reason merge_refused, works names them), and the rest go on; other reasons are not_found, ads_unavailable (may be retried later), id_collision, repeated and same_paper_as_earlier. More than 200 is rejected whole: split it, and report the refused and failed entries to the user. Statuses: ok if something was created or updated, noop if the library was left exactly as it was, error if nothing was imported (the library is unchanged), rejected as above; results lists each entry. A partial batch is ok with some entries failed; report those. A status unknown means it may have saved some entries: search the library with read and the identifier (DOI, arXiv:<id> or bibcode) or the title as query before deciding, never repeat it blindly.",
  "acquire_arxiv_pdf is the acquisition dialog's 'fetch PDF from arXiv' for one work (refId): it needs the work to have an arXiv id and queues a job in the application's Job table (the same serial queue as the Files tab; you are not a job and hold no slot). Every successful run creates a NEW PDF Doc, even when the bytes equal an existing one, and never replaces or reorders anything: an existing main Doc stays main and a work without Doc gets the PDF as main. If a job for the same work and format is already queued or running you get that job back (reused: true) instead of a second one. The call waits for the job: ok means it finished (job.id and docId name the actual job and Doc), error means the job failed (job.error, read it to the user), pending means the job had not finished when the wait ended (about ten minutes, or the user pressed Stop): it keeps running by itself, check read_jobs, never submit it again. Stop never cancels a submitted job and starts no new one. The source is arXiv only; there is no OCR, publisher PDF or HTML route.",
  "attach_arxiv is the dialog's 'get LaTeX source from arXiv' for one work (refId): the work's own arXiv e-print is fetched fresh and compiled as an arXiv LaTeX Doc. A work without Doc gets it as main; a work whose Docs are all PDFs gets it appended after them (the PDF main stays); a work that already has its arXiv Doc has that Doc refreshed in place, which replaces its text and may archive the user's annotations on it: that case waits for the user's confirmation card (declined or expired means nothing was changed and no job was started; do not ask again unless the user wants it), you cannot approve it and nothing in chat does. A work holding other content (for example a LaTeX zip) is rejected. Results are like acquire_arxiv_pdf: ok with job.id and docId, error for a failed job (an arXiv submission without LaTeX source fails with errorCode arxiv_pdf_only), pending while unfinished. This job rebuilds the library index through the application's own routine, exactly as the Files tab does.",
  "attach_local_pdf (refId, path = absolute local path) is the PDF upload for a file on this machine, through the upload's own checks: the file is only read, once, and never changed, moved or deleted; a new PDF Doc is made (identical bytes already on the work come back as noop); the work must exist. Refused with reason file_tools_off when the user turned the file permission off, otherwise no confirmation card. A failure names a reason and attached nothing. It waits for the job like acquire_arxiv_pdf (ok, noop, error, pending).",
  "list_ads_libraries and read_ads_library read the user's own ADS libraries (read-only on ADS; they write nothing to the project, and the service reads the ADS token itself: never ask for it in chat). list_ads_libraries takes no parameter and returns each library's id, name, numDocuments (ADS's count) and, when present, description and permission. read_ads_library (libraryId) asks ADS for just one window of that library's bibcodes (offset, limit up to 200; alphabetical order, not the order they were added) with total (ADS's count when it answered) and nextOffset while more remain; every call is a fresh read, nothing is cached, so if the library was edited between two calls the windows can overlap or skip: after the last window check that the bibcodes you collected are distinct and their count equals total. Stop gives status interrupted (nothing was read or changed). A failure has a reason you can tell apart: no_token (the user must save an ADS token in Settings), unauthorized (token rejected), forbidden, rate_limited (wait; do not loop), not_found (no such library id), timeout or unreachable (may be tried again later), invalid_response (ADS's answer was not understood or contradicted itself, for example the library changed during the read: read list_ads_libraries again to see whether numDocuments changed, then read the library again from the start). The bibcodes are only a list: to bring works in, pass them to import_works.",
  "search_ads (query, limit, fields) is a read-only ADS search by query string: it lists records and numFound, saves nothing and never touches the library; the service reads the ADS token itself (never ask for it in chat). Add a paper only through import_works or save_candidate. A failure has a reason you can tell apart: no_token, unauthorized, rate_limited (wait; do not loop), bad_query (fix the syntax), timeout or unreachable; Stop gives interrupted.",
  "read_jobs shows the Job table lines the Files tab shows for a work (refId; without it the newest jobs of any work): id, kind, format (arxiv-pdf, pdf, or LaTeX), status, the latest progress message, error and errorCode, and docId once finished. Use it to find out what a pending or unknown acquisition came to. Dismissing an error line and retrying are the user's display state and a new submission: retry is simply acquire_arxiv_pdf or attach_arxiv again after a failed job.",
  "delete_doc is the Files tab's 'delete document' dialog for one Doc (docId from your read of the work): a GLOBAL, permanent, physical delete that removes the stored text or original PDF, its assets and sidecars and ALL its annotations (current and archived) and takes the Doc out of EVERY work that lists it, not only the one you were looking at. There is no 'unlink from this work' variant. It always waits for the user's confirmation card, which names every work that lists the Doc and the current annotation count (unknown if it could not be read, which is not zero); you cannot approve it and nothing in chat, in page data or in a note does. declined or expired (also when the Doc, its works or its annotations changed first) means nothing was deleted: do not ask again unless the user wants it. If the Doc is busy (an upload or refresh is writing it, or it is being deleted) the call is rejected without a card: wait and try again later. not_found means there is no such Doc (a Doc already deleted elsewhere is not_found, not a success). ok means the Doc, its annotations and its links are gone; each remaining work's first Doc is its main Doc now and the page updates itself. error means the delete failed part-way: files may already be gone while the library still lists the Doc, so read the work and tell the user rather than claiming either outcome. Deleting is permanent: only do it when the user asked for exactly that Doc.",
  "filter_library, select_work, set_detail_tab, set_sidebar, set_graph_labels and graph_control (zoom_in, zoom_out, fit, relayout of the citation graph; dragging and panning are the user's gestures) change what the user sees in the bound tab; use them only when asked to show something. To open a Doc in the Reader use the workspace tool's open_doc.",
  "set_temp_label sets the colour dot the right-click menu offers. It is temporary: it exists only in that browser tab and is never saved to the library, so do not describe it as saved.",
  "Discovery (exploration) is a temporary, read-only view in the user's browser tab: one ADS seed, its related papers and the useful papers of that related set, with real citation edges (citing to cited) between the visible nodes; related and useful are roles, never edges, and an isolated node is normal. It has no saved state on the service. read_discovery returns what the bound tab last reported (history, the filtered nodes and edges, totals, the open candidate with its abstract and in-graph citations, loading, error, saving); it is an observation the user may have changed since, and with nothing open it says so: ask for it again after a view action instead of assuming. The view actions drive the same controls as the user: explore_work (the work detail's explore button; needs a live library and a work with an ADS bibcode; refused while an exploration is open, so exit_exploration first), explore_candidate (Explore from here: the only way to change the seed; selecting a node never does), retry_exploration (the Retry buttons: the same full request again; target failed re-sends the seed whose request failed, current the seed shown for the useful-unavailable note or the empty state, default failed when a request failed), cancel_exploration, step_exploration (back or forward over the seeds already explored), exit_exploration, resume_exploration (only when the tab holds an exploration history: see library.exploration in the page), filter_discovery (all, related, useful), search_discovery, set_discovery_display (graph or list), select_candidate (opens or closes the inspector), set_discovery_tab (abstract or citations of the open candidate), dismiss_discovery_error, view_candidate_in_library (the inspector's in-library button: leaves exploration and selects the saved work), set_discovery_graph_labels and discovery_graph_control (zoom_in, zoom_out, fit, relayout, focus_seed). One explore action sends exactly one ADS request for one seed (the query is fixed by the application: similar then useful; there is no depth, no automatic next hop); the call waits for it: ok means the new exploration is shown, error with http means it failed (nothing was saved, the user's earlier exploration stays), and a call the user cancelled is not_displayed. A request that does not report in time is not_displayed or pending-like: read_discovery before doing anything else, never start the same exploration twice blindly. Only call these when the user asked to explore or to show something.",
  "save_candidate is the exploration's Add to library for one node (bibcode) of the exploration the bound tab shows; it is the only thing that writes. It is exactly the Library page's own bibcode import (import_works with mode bibcode): the same ADS export, duplicate detection, cite key, narrow write that keeps the other works and unknown fields, default arXiv PDF job and library change notification, with the same statuses and results: ok if the work was created or updated, noop if the library already held it and nothing changed (a candidate already saved just resolves to its existing work), error if ADS could not answer or nothing was imported (nothing was saved, and the candidate stays unsaved), rejected if the candidate is not part of the open exploration or the record would merge existing works, unknown if it may have been saved (read the library with the bibcode as query before deciding). After a successful save the user's exploration marks the node saved in place: nothing is re-queried and no other candidate is saved. Save one candidate only because the user asked for that paper; never save candidates in bulk, automatically or as a side effect of exploring.",
  "A page whose source is demo is built-in example data, and source error means the library could not be read (see its error): say so, and do not describe its works as the user's.",
  "Only report results whose status is ok or noop as done; pending is not done. A set_main_doc whose status is unknown may or may not have been applied: read the work to find out, never repeat it blindly.",
].join(" ");

/** One readable line for the journal, so a resume note can say what an unfinished import was. */
function importSummary(op: { mode: string; text: string } | undefined): string {
  if (!op) return "";
  const flat = op.text.replace(/\s+/g, " ").trim();
  return `${op.mode}: ${flat.length > 80 ? `${flat.slice(0, 80)}…` : flat}`;
}

const record = (id: string, action: string, partial: Partial<CopilotOperation>) =>
  recordFor(LIBRARY_TOOL_NAME, id, action, partial);

/** A recorded `pending` result, brought up to date from the Job table (other results are returned as recorded). */
function liveReplay(
  port: NonNullable<LibraryToolContext["library"]["acquisition"]>,
  operation: CopilotOperation,
  payload: Record<string, unknown>
): { operation: CopilotOperation; payload: Record<string, unknown> } {
  const recorded = payload.job as { id?: string } | undefined;
  const job =
    operation.status === "pending" && recorded?.id ? port.jobs.get(recorded.id) : undefined;
  if (!job) return { operation, payload };
  const view = jobView(job);
  if (job.status === "queued" || job.status === "running")
    return {
      operation: { ...operation, job: { id: job.id, status: job.status } },
      payload: { ...payload, job: view },
    };
  const skipped = (job.result as { status?: unknown } | null)?.status === "skipped";
  const status = job.status === "done" ? (skipped ? "rejected" : "ok") : "error";
  return {
    operation: {
      ...operation,
      status,
      job: { id: job.id, status: job.status },
      ...(view.docId && !skipped ? { docId: view.docId } : {}),
    },
    payload: {
      ...payload,
      ok: status === "ok",
      status,
      job: view,
      ...(view.docId && !skipped ? { docId: view.docId } : {}),
      detail: undefined,
    },
  };
}

/**
 * acquire_arxiv_pdf / attach_arxiv: the dialog's submit. Journaled like every durable action; a refresh of an
 * existing arXiv Doc replaces its text, so it first waits for the real user (the dialog's annotation-risk step)
 * and is submitted only if what the card showed is still true.
 */
async function runAcquisition(input: {
  context: LibraryToolContext;
  rest: Record<string, unknown>;
  requestedId: unknown;
  toolCallId: string;
  action: string;
  refId: string;
  kind: "pdf" | "source";
}) {
  const { context, rest, requestedId, toolCallId, action, refId, kind } = input;
  const workObject = { kind: "work" as const, id: refId };
  const port = context.library.acquisition;
  if (!port)
    return done(record(toolCallId, action, { status: "unsupported" }), {
      ok: false,
      status: "unsupported",
      detail: "acquisition is not available in this host",
    });
  return runOperation(
    context,
    {
      tool: LIBRARY_TOOL_NAME,
      toolCallId,
      action,
      rest,
      requestedId,
      readBack: (known) => ({
        detail: `this operation started earlier and its outcome was not recorded; ${known.jobId ? `its job is ${known.jobId}: read_jobs shows its state` : "read_jobs for this work shows whether its job exists"}, do not repeat it blindly`,
      }),
      // A pending result is replayed with what the Job table says now, never with the stale snapshot.
      replay: (known) => liveReplay(port, known.operation, known.payload),
    },
    async (op) => {
      // A replacement overwrites text that may carry annotations: the real user decides first.
      let label: string | undefined;
      type Replacement = {
        action: "refresh_arxiv_source";
        title: string;
        docId: string;
        docIds: string[];
        binding: Record<string, unknown>;
        /** The same check again against the library as it is now (null = no longer a replacement of this Doc). */
        current: () => { docId: string; title: string; docIds: string[] } | null;
      };
      let replacement: Replacement | null = null;
      if (kind === "source") {
        const plan = port.describeSource(refId);
        if (plan.kind === "refresh")
          replacement = {
            action: "refresh_arxiv_source",
            title: plan.title,
            docId: plan.docId,
            docIds: plan.docIds,
            binding: {},
            current: () => {
              const again = port.describeSource(refId);
              return again.kind === "refresh" ? again : null;
            },
          };
      }
      if (replacement) {
        const current = replacement;
        label = current.title;
        const prepared = await prepareArxivRefresh(
          context.library,
          refId,
          current,
          current.binding
        );
        if (!prepared.ok)
          return done(record(toolCallId, action, { status: prepared.status, object: workObject }), {
            ok: false,
            status: prepared.status,
            detail: prepared.detail,
          });
        const nothing = "changed and no job was started";
        const unavailable = confirmUnavailable(context, {
          tool: LIBRARY_TOOL_NAME,
          toolCallId,
          action,
          nothing,
          object: workObject,
        });
        if (unavailable) return unavailable;
        // The wait for the user is not tracked: Stop must still be able to end the card.
        const answer = await askUser(context, {
          tool: LIBRARY_TOOL_NAME,
          toolCallId,
          action,
          object: workObject,
          label: prepared.title,
          request: {
            toolCallId,
            action: current.action,
            workId: refId,
            docId: prepared.docId,
            label: prepared.title,
            impact: prepared.impact,
            baseRev: prepared.rev,
            objectDigest: prepared.digest,
          },
          nothing,
          changed: "the library or the document's annotations",
        });
        if (!answer.approved) return answer.result;
        // Approved. The same check the click made, now that the job is about to be submitted.
        const again = current.current();
        const recheck = again
          ? await prepareArxivRefresh(context.library, refId, again, current.binding)
          : null;
        if (!recheck?.ok || recheck.digest !== prepared.digest)
          return done(
            record(toolCallId, action, {
              status: "expired",
              object: workObject,
              label: prepared.title,
            }),
            {
              ok: false,
              status: "expired",
              detail:
                "the library or the document's annotations changed after the user confirmed; nothing was changed. Read again and ask only if it is still wanted",
            }
          );
      }
      // Nothing new starts once Stop or shutdown closed the door (a confirmation that came back after it too).
      if (!context.admitting())
        return done(record(toolCallId, action, { status: "expired", object: workObject }), {
          ok: false,
          status: "expired",
          detail: "the run was stopped before the job was submitted; nothing was changed",
        });
      if (!op.begin({ workId: refId })) return op.notSaved("written");
      const admitting = context.admitting;
      const onSubmitted = (jobId: string) => context.journal?.submitted?.(op.operationId, jobId);
      const ctx = { admitting, onSubmitted };
      const outcome = await op.track<AcquireOutcome>(
        kind === "pdf"
          ? applyAcquireArxivPdf(context.library, refId, ctx)
          : applyAttachArxiv(context.library, refId, ctx)
      );
      return op.finish(
        outcome.ok
          ? done(
              record(toolCallId, action, {
                status: outcome.status,
                object: outcome.object,
                ...((outcome.label ?? label) ? { label: outcome.label ?? label } : {}),
                job: { id: outcome.job.id, status: outcome.job.status },
                ...(outcome.docId ? { docId: outcome.docId } : {}),
              }),
              outcome
            )
          : done(
              record(toolCallId, action, {
                status: outcome.status,
                object: workObject,
                ...(outcome.job ? { job: { id: outcome.job.id, status: outcome.job.status } } : {}),
              }),
              outcome
            )
      );
    }
  );
}

/**
 * attach_local_pdf: project intake's attach of a local file. Journaled like the other durable actions (a repeated
 * operationId is answered, a begun one without an outcome is unknown). No confirmation card: the user's file-tool
 * permission decides, not a click. Everything before the job (permission, path, Work, the one read of the file) writes
 * nothing; the rest is the upload's own job (`applyAttachLocalPdf`).
 */
async function runAttachLocalPdf(input: {
  context: LibraryToolContext;
  rest: Record<string, unknown>;
  requestedId: unknown;
  toolCallId: string;
  refId: string;
  path: string;
}) {
  const { context, rest, requestedId, toolCallId, refId, path } = input;
  const action = "attach_local_pdf";
  const workObject = { kind: "work" as const, id: refId };
  const port = context.library.acquisition;
  const refuse = (
    status: "rejected" | "unsupported",
    reason: string,
    detail: string
  ): ReturnType<typeof done> =>
    done(record(toolCallId, action, { status, object: workObject }), {
      ok: false,
      status,
      reason,
      detail,
    });
  // Not settable by the model or the page: the setting is read from config.toml at this call.
  const permission = context.fileToolsPermission?.() ?? "off";
  if (permission === "off")
    return refuse(
      "rejected",
      "file_tools_off",
      "the user turned the file and command permission off, and this action reads a file anywhere on this machine, so it is refused; nothing was read or written. Tell the user, and do not try another route to the file"
    );
  if (!port)
    return refuse("unsupported", "queue_failed", "acquisition is not available in this host");
  return runOperation(
    context,
    {
      tool: LIBRARY_TOOL_NAME,
      toolCallId,
      action,
      rest,
      requestedId,
      readBack: (known) => ({
        detail: `this operation started earlier and its outcome was not recorded; ${known.jobId ? `its job is ${known.jobId}: read_jobs shows its state` : "read_jobs for this work shows whether its job exists"}, do not repeat it blindly`,
      }),
      // A pending result is replayed with what the Job table says now, never with the stale snapshot.
      replay: (known) => liveReplay(port, known.operation, known.payload),
      named: { object: workObject },
    },
    async (op) => {
      if (!context.admitting())
        return done(record(toolCallId, action, { status: "expired", object: workObject }), {
          ok: false,
          status: "expired",
          detail: "the run was stopped before the file was read; nothing was changed",
        });
      if (!op.begin({ workId: refId })) return op.notSaved("written");
      const onSubmitted = (jobId: string) => context.journal?.submitted?.(op.operationId, jobId);
      const outcome = await op.track<AttachLocalPdfOutcome>(
        applyAttachLocalPdf(
          context.library,
          { action, refId, path },
          { admitting: context.admitting, onSubmitted }
        )
      );
      return op.finish(
        outcome.ok
          ? done(
              record(toolCallId, action, {
                status: outcome.status,
                object: outcome.object,
                ...(outcome.label ? { label: outcome.label } : {}),
                job: { id: outcome.job.id, status: outcome.job.status },
                ...(outcome.docId ? { docId: outcome.docId } : {}),
              }),
              outcome
            )
          : done(
              record(toolCallId, action, {
                status: outcome.status,
                object: workObject,
                ...(outcome.job ? { job: { id: outcome.job.id, status: outcome.job.status } } : {}),
              }),
              outcome
            )
      );
    }
  );
}

/**
 * delete_doc: the Files tab's delete dialog. The page opens the dialog, shows the Doc, the Works and the annotation
 * count, and only then deletes; here the real user is asked the same way (a card) and the same shared global delete
 * (`DELETE /api/paper/:doc_id`: busy check, physical delete, narrow library write, `library.changed`) runs only after the
 * click. Nothing is held while the card waits, and everything is checked again after the click.
 */
async function runDocDelete(input: {
  context: LibraryToolContext;
  rest: Record<string, unknown>;
  requestedId: unknown;
  toolCallId: string;
  docId: string;
}) {
  const { context, rest, requestedId, toolCallId, docId } = input;
  const action = "delete_doc";
  const docObject = { kind: "doc" as const, id: docId };
  const fail = (status: CopilotOperation["status"], detail: string, extra: object = {}) =>
    done(record(toolCallId, action, { status, object: docObject, label: docId }), {
      ok: false,
      status,
      detail,
      ...extra,
    });
  const port = context.library.deletion;
  if (!port) return fail("unsupported", DOC_DELETE_UNAVAILABLE);
  return runOperation(
    context,
    {
      tool: LIBRARY_TOOL_NAME,
      toolCallId,
      action,
      rest,
      requestedId,
      readBack: () => ({
        detail:
          "this delete started earlier and its outcome was not recorded; read the work to see whether the Doc is still listed, do not repeat it blindly",
      }),
      named: { object: docObject, label: docId },
    },
    async (op) => {
      // What the dialog would show, read without writing anything (the catalog operation's own check).
      const prepared = await prepareDocDelete(port, docId);
      if (!prepared.ok) return fail(prepared.status, prepared.detail);
      const described = prepared.described;

      const unavailable = confirmUnavailable(context, {
        tool: LIBRARY_TOOL_NAME,
        toolCallId,
        action,
        nothing: "deleted",
        object: docObject,
        label: docId,
      });
      if (unavailable) return unavailable;
      // The wait for the user is not tracked: Stop must still be able to end the card.
      const answer = await askUser(context, {
        tool: LIBRARY_TOOL_NAME,
        toolCallId,
        action,
        object: docObject,
        label: docId,
        request: {
          toolCallId,
          action: "delete_doc",
          docId,
          format: described.format,
          works: described.works,
          impact: described.impact,
          baseRev: described.rev,
          objectDigest: described.digest,
        },
        nothing: "deleted",
        changed: "the Doc, the works that list it or its annotations",
      });
      if (!answer.approved) return answer.result;
      // Approved. The same check the click made, now that the delete is about to run.
      const again = await recheckDocDelete(port, docId, described);
      if (!again.ok) return fail(again.status, again.detail);
      // The click IS the commit, as on the page ("Delete permanently" deletes): a Stop after it does not undo it.
      if (!op.begin({ summary: `delete ${docId}` })) return op.notSaved("deleted");
      const outcome = await op.track(
        applyDocDelete(context.library, docId, { holders: again.holders })
      );
      if (outcome.ok) {
        // The page's own three-state update of the Shell, by the work that now holds Docs.
        const keeper = outcome.works.find((entry) => entry.remaining.length > 0);
        try {
          context.shellSync?.({
            action: "doc_deleted",
            docId,
            remaining: keeper?.remaining ?? [],
          });
        } catch {
          /* the view loads the real list when it reconnects */
        }
      }
      return op.finish(
        outcome.ok
          ? done(
              record(toolCallId, action, {
                status: outcome.status,
                object: outcome.object,
                label: outcome.label,
              }),
              outcome
            )
          : done(
              record(toolCallId, action, {
                status: outcome.status,
                object: docObject,
                label: docId,
              }),
              outcome
            )
      );
    }
  );
}

export function createLibraryTool(context: LibraryToolContext) {
  return defineTool({
    name: LIBRARY_TOOL_NAME,
    label: "Library",
    description,
    executionMode: "sequential",
    parameters,
    async execute(toolCallId, params, signal) {
      const action = typeof params.action === "string" ? params.action : "unknown";
      if (!context.admitting())
        return done(record(toolCallId, action, { status: "error" }), {
          ok: false,
          status: "closed",
        });
      try {
        const { operationId: requestedId, ...rest } = params as Record<string, unknown>;
        // The cataloged actions (contracts operation catalog): parameters and execution come from the catalog.
        const cataloged = parseCatalogCall(LIBRARY_TOOL_NAME, rest);
        const read = cataloged.match && cataloged.op.id === "library.read" ? cataloged : null;
        if (read?.success) {
          let outcome: LibraryReadOutcome;
          try {
            outcome = (await runCatalogOperation(
              { library: context.library },
              "library.read",
              read.params
            )) as LibraryReadOutcome;
          } catch {
            // An unreadable library is an error, never an empty one.
            return done(record(toolCallId, "read", { status: "error" }), {
              ok: false,
              status: "error",
              detail: "the library could not be read; nothing is known about its content",
            });
          }
          if (!outcome.ok)
            return done(record(toolCallId, "read", { status: "not_found" }), outcome);
          return done(
            record(toolCallId, "read", {
              status: "ok",
              ...("ref" in outcome
                ? {
                    object: { kind: "work" as const, id: outcome.ref.id },
                    label: outcome.ref.title,
                  }
                : {}),
            }),
            outcome
          );
        }
        const view = LibraryViewActionSchema.safeParse(rest);
        if (view.success) {
          const shown = viewOutcomeResult(await context.viewAction(view.data), view.data.action);
          const temporary =
            view.data.action === "set_temp_label" && shown.status === "ok"
              ? {
                  temporary: true,
                  detail:
                    "temporary colour dot in the user's current browser tab only; it is not saved in the library and is lost when the page reloads",
                }
              : {};
          return done(record(toolCallId, action, { status: shown.status }), {
            ...shown.payload,
            ...temporary,
          });
        }
        if (LibraryReadDiscoverySchema.safeParse(rest).success) {
          const page = context.page?.();
          const discovery = page?.discovery ?? null;
          return done(record(toolCallId, "read_discovery", { status: "ok" }), {
            ok: true,
            observed: page
              ? "the bound view's last report; the user may have changed it since"
              : "no browser view has reported yet",
            exploring: discovery !== null,
            discovery,
            ...(page?.library?.exploration ? { resumable: page.library.exploration } : {}),
            ...(discovery
              ? {}
              : {
                  detail: page
                    ? page.view === "library"
                      ? "no exploration is open in the pane the user is looking at (resume_exploration / explore_work opens one, when allowed)"
                      : `the bound tab shows the ${page.view} page; an exploration, if any, belongs to its Library tab and is not reported from here`
                    : "no exploration can be read without a connected browser view",
                }),
          });
        }
        const jobsRead = LibraryReadJobsSchema.safeParse(rest);
        if (jobsRead.success) {
          const outcome = readJobs(context.library, jobsRead.data);
          if (!outcome.ok)
            return done(record(toolCallId, "read_jobs", { status: "unsupported" }), outcome);
          return done(record(toolCallId, "read_jobs", { status: "ok" }), outcome);
        }
        // The read-only ADS search is a catalog operation of the discovery domain (the tool carries it as an action).
        const search = parseCatalogCall("discovery", rest);
        if (search.match && search.op.id === "discovery.search_ads") {
          if (!search.success)
            return done(record(toolCallId, action, { status: "unsupported" }), {
              ok: false,
              status: "unsupported",
              detail: "invalid parameters",
              issues: search.issues.slice(0, 5),
            });
          const outcome = (await runCatalogOperation(
            { library: context.library, signal },
            "discovery.search_ads",
            search.params
          )) as { status: CopilotOperation["status"] };
          return done(record(toolCallId, action, { status: outcome.status }), outcome);
        }
        const adsList = LibraryListAdsLibrariesSchema.safeParse(rest);
        const adsRead = LibraryReadAdsLibrarySchema.safeParse(rest);
        if (adsList.success || adsRead.success) {
          const outcome = adsRead.success
            ? await readAdsLibrary(context.library, adsRead.data, signal)
            : await listAdsLibraries(context.library, signal);
          return done(record(toolCallId, action, { status: outcome.status }), outcome);
        }
        // delete_doc is cataloged (confirm: "card"): its parameters come from the catalog; the card stays in this
        // conversation and the wait and the records stay with this tool, the checks around them are the operation's.
        if (cataloged.match && cataloged.op.id === "library.delete_doc" && cataloged.success)
          return await runDocDelete({
            context,
            rest,
            requestedId,
            toolCallId,
            docId: (cataloged.params as { docId: string }).docId,
          });
        const pdfJob = LibraryAcquireArxivPdfSchema.safeParse(rest);
        const sourceJob = LibraryAttachArxivSchema.safeParse(rest);
        if (pdfJob.success || sourceJob.success) {
          const refId = (
            pdfJob.success ? pdfJob.data : (sourceJob as { data: { refId: string } }).data
          ).refId;
          return await runAcquisition({
            context,
            rest,
            requestedId,
            toolCallId,
            action,
            refId,
            kind: pdfJob.success ? "pdf" : "source",
          });
        }
        const localPdf = LibraryAttachLocalPdfSchema.safeParse(rest);
        if (localPdf.success)
          return await runAttachLocalPdf({
            context,
            rest,
            requestedId,
            toolCallId,
            refId: localPdf.data.refId,
            path: localPdf.data.path,
          });
        const importOp = LibraryImportWorksSchema.safeParse(rest);
        const write =
          cataloged.match && cataloged.op.id === "library.set_main_doc" && cataloged.success
            ? { success: true as const, data: cataloged.params as { refId: string } }
            : { success: false as const };
        const save = LibrarySaveCandidateSchema.safeParse(rest);
        if (!importOp.success && !write.success && !save.success) {
          const failure =
            rest.action === "import_works"
              ? importOp
              : rest.action === "read_ads_library"
                ? adsRead
                : rest.action === "attach_local_pdf"
                  ? localPdf
                  : rest.action === "acquire_arxiv_pdf"
                    ? pdfJob
                    : rest.action === "attach_arxiv"
                      ? sourceJob
                      : rest.action === "read_jobs"
                        ? jobsRead
                        : rest.action === "save_candidate"
                          ? save
                          : null;
          const issues =
            cataloged.match && !cataloged.success
              ? cataloged.issues
              : (failure === null || failure.success ? [] : failure.error.issues).map((issue) => ({
                  path: issue.path.join("."),
                  message: issue.message,
                }));
          return done(record(toolCallId, action, { status: "unsupported" }), {
            ok: false,
            status: "unsupported",
            detail: "unknown action or invalid parameters",
            issues: issues.slice(0, 5),
          });
        }
        return await runOperation(
          context,
          {
            tool: LIBRARY_TOOL_NAME,
            toolCallId,
            action,
            rest,
            requestedId,
            readBack: "read the library (the work, or search the identifier or title) to find out",
          },
          async (op) => {
            // A candidate is something the exploration the user has open shows (its visible nodes, the open one and
            // the nodes its inspector lists); anything else is the import menu's business (import_works).
            if (save.success) {
              const shown = context.page?.()?.discovery;
              const candidates = shown ? discoveryReachableBibcodes(shown) : new Set<string>();
              if (!candidates.has(save.data.bibcode))
                return done(record(toolCallId, action, { status: "rejected" }), {
                  ok: false,
                  status: "rejected",
                  detail: shown?.graph
                    ? "that bibcode is not a candidate of the exploration the user has open (read_discovery lists them, and a filter or search may hide some); nothing was written. Papers outside it are added with import_works"
                    : "no exploration is open in the pane the user is looking at (the page you were given), so there is no candidate to save; nothing was written (the user opens one with the work's explore button)",
                });
            }
            if (
              !op.begin(
                write.success
                  ? { workId: write.data.refId }
                  : save.success
                    ? { summary: `candidate: ${save.data.bibcode}` }
                    : { summary: importSummary(importOp.success ? importOp.data : undefined) }
              )
            )
              return op.notSaved("written");
            const outcome = await op.track<LibraryOpOutcome | LibraryImportOutcome>(
              importOp.success
                ? applyLibraryImport(context.library, importOp.data)
                : save.success
                  ? applyLibraryBibcodeImport(context.library, save.data.bibcode)
                  : (runCatalogOperation(
                      { library: context.library },
                      "library.set_main_doc",
                      (write as { data: Record<string, unknown> }).data
                    ) as Promise<LibraryOpOutcome>)
            );
            const failedObject = write.success
              ? { object: { kind: "work" as const, id: write.data.refId } }
              : {};
            // The candidate stays named in the result and in the journal, so a repeated call answers the same way.
            const payload: LibraryOpOutcome | LibraryImportOutcome | Record<string, unknown> =
              save.success ? { ...outcome, candidate: save.data.bibcode } : outcome;
            const result = op.finish(
              outcome.ok
                ? done(
                    record(toolCallId, action, {
                      status: outcome.status,
                      object: outcome.object,
                      label: outcome.label,
                      ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
                    }),
                    payload
                  )
                : done(
                    record(toolCallId, action, {
                      status: outcome.status,
                      ...failedObject,
                    }),
                    payload
                  )
            );
            // The page's own Add marks the node saved in place; the bound view does the same for this save (state
            // sync, not navigation, not awaited: the save is already committed and a view that is gone loads the
            // real library).
            if (save.success && outcome.ok && outcome.object)
              context.shellSync?.({
                action: "discovery_saved",
                bibcode: save.data.bibcode,
                workId: outcome.object.id,
              });
            return result;
          }
        );
      } catch {
        return done(record(toolCallId, action, { status: "unknown" }), {
          ok: false,
          status: "unknown",
          detail:
            "unexpected failure; the outcome is not known, read the work again before retrying",
        });
      }
    },
  });
}
