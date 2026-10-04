import {
  type CopilotAttachment,
  type CopilotOperation,
  GRAPH_CONTROLS,
  LIBRARY_DETAIL_TABS,
  LIBRARY_LABEL_KEYS,
  LIBRARY_OPERATION_ACTIONS,
  LibraryAcquireArxivPdfSchema,
  LibraryAttachArxivSchema,
  LibraryImportWorksSchema,
  LibraryReadJobsSchema,
  LibraryReadOperationSchema,
  LibraryReplaceUploadSourceSchema,
  type LibrarySetMainDoc,
  LibrarySetMainDocSchema,
  LibraryUploadLatexZipSchema,
  LibraryUploadPdfSchema,
  type LibraryViewAction,
  LibraryViewActionSchema,
  PDF_RESOURCE_WARNING_BYTES,
} from "@argelanderspace/contracts";
import { LibraryStore } from "@argelanderspace/core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type ConfirmationPort, digest, type OperationJournalPort } from "./copilot-plan-tool.js";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";
import {
  type AcquireOutcome,
  applyAcquireArxivPdf,
  applyAttachArxiv,
  applyLibraryImport,
  applyLibraryOperation,
  applyUploadPdf,
  applyUploadZip,
  jobView,
  type LibraryImportOutcome,
  type LibraryOpDeps,
  type LibraryOpOutcome,
  prepareArxivRefresh,
  readJobs,
  readLibrary,
} from "./library-actions.js";

export const LIBRARY_TOOL_NAME = "library";

export interface LibraryToolContext {
  library: LibraryOpDeps;
  /** Present in the real host; the write is journaled so a repeated operationId is answered, not rerun. */
  journal?: OperationJournalPort;
  /** Counts an operation as in flight until it settles, so a terminal run state waits for it. */
  track?: <T>(work: Promise<T>) => Promise<T>;
  runId?: string;
  /** Opens a file the user attached to a message of THIS conversation; anything else is null. */
  attachment?: (attachmentId: string) => { meta: CopilotAttachment; bytes: Buffer } | null;
  /** Present in the real host: replacing an existing arXiv Doc waits here for the user. Without it that refresh is refused. */
  confirm?: ConfirmationPort;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: LibraryViewAction) => Promise<ViewActionOutcome>;
  /** False once the host stopped admitting operations (Stop, shutdown). */
  admitting: () => boolean;
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
          "Optional idempotency key for set_main_doc, import_works and the acquisition/upload actions. Repeating the same key with the same parameters returns the first result instead of writing again.",
      })
    ),
    query: Type.Optional(
      Type.String({
        description:
          "read: the sidebar search (title, authors, cite key; case-insensitive); an identifier (DOI, doi.org URL, arXiv:<id> or arxiv.org URL, bibcode, or a work id) also matches the work holding it, even one without a title. filter_library: the text to put in the search box (empty clears it).",
      })
    ),
    refId: Type.Optional(
      Type.String({
        description:
          "The work id (for example doi:10.1051/..., arxiv:2603.03522). read: return that one work in full. acquire_arxiv_pdf/attach_arxiv: the target work (required). read_jobs: only that work's jobs. Other actions: the target work; select_work accepts null to close the detail.",
      })
    ),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: "read: first match to return." })
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description: "read: page size, default 100. read_jobs: at most 50, default 10.",
      })
    ),
    links: Type.Optional(
      Type.Boolean({ description: "read: also return the citation links among the matched works." })
    ),
    docId: Type.Optional(
      Type.String({
        description:
          "set_main_doc: the Doc to make the main Doc. replace_upload_source: the work's uploaded LaTeX source Doc to replace.",
      })
    ),
    attachmentId: Type.Optional(
      Type.String({
        description:
          "upload_pdf / upload_latex_zip / replace_upload_source: the id of a file the user attached to a message of this conversation (listed in that message's attachments).",
      })
    ),
    expectedMainDocId: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "set_main_doc: the main Doc (first of doc_ids) you read for this work, or null if it had none. Required.",
      })
    ),
    mode: Type.Optional(lit(["identifier", "bibcode", "bib"] as const)),
    text: Type.Optional(
      Type.String({
        description:
          "import_works: exactly what the import dialog would receive for that mode. identifier: one DOI, doi.org URL, arXiv:<id> or arxiv.org URL (a bare arXiv id is rejected); bibcode: one ADS bibcode; bib: BibTeX text, one or many entries. Text only: no file paths.",
      })
    ),
    tab: Type.Optional(lit(LIBRARY_DETAIL_TABS)),
    on: Type.Optional(
      Type.Boolean({ description: "set_graph_labels: show (true) or hide the node labels." })
    ),
    control: Type.Optional(lit(GRAPH_CONTROLS)),
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
  "Read and operate the user's Library page: the saved works, search, the detail panel and its tabs, the main-Doc choice and the arXiv full-text acquisition of the Files tab. It never deletes Docs or explores; notes, tags and the read flag have no editing control in the application, so you cannot change them.",
  "read returns the page's own data: one page of the works matching query (title, authors, cite key), with the total, or one work in full with refId. Reading never opens or selects anything.",
  "set_main_doc is the Files tab's 'set as main': it needs expectedMainDocId, the main Doc from your latest read of that work. If it changed, the result is conflict: read the work again and form a new request; do not resend the stale one. Other fields of the work, including ones you did not read, are kept. If saving fails the status is error: the file was not replaced, except in the rare case of a failure between the two final renames, where library.json may already be updated, so read the work again before deciding. Writes wait their turn behind other library writes; they are not refused as busy.",
  "import_works is the import menu's submit, with the same checks, duplicate detection and results: mode identifier (one DOI or arXiv:<id>), bibcode (one ADS bibcode; fails without a stub when ADS cannot answer) or bib (pasted BibTeX; per-entry results, your cite keys are kept, a key held by another work is an error for that entry). Give it text only; it cannot read files. Creating a Work does not select or open it; use select_work with a returned work id if the user wants it shown. An entry the library already holds comes back as exists and is not duplicated, but the import can still update that Work (blank fields are filled, its acquisition plan is recomputed, its type may change); the result lists those ids in updated, and your own data on it (note, tags, flags) is kept. A new entry without a DOI or arXiv id whose title-and-year derived work id is already used by a different paper (for example part II of a series) is an error for that entry with nothing written: ask the user for a DOI or arXiv id. A record that would merge two existing works into one is refused as rejected with nothing written: tell the user to resolve them in the Library page. Identifier and bibcode imports may also start the default arXiv PDF download exactly as the page does (a separate background job). Statuses: ok if something was created or updated, noop if the library was left exactly as it was, error if nothing was imported (the library is unchanged), rejected as above; results lists each entry. A partial batch is ok with some entries failed; report those. A status unknown means it may have saved some entries: search the library with read and the identifier (DOI, arXiv:<id> or bibcode) or the title as query before deciding, never repeat it blindly.",
  "acquire_arxiv_pdf is the acquisition dialog's 'fetch PDF from arXiv' for one work (refId): it needs the work to have an arXiv id and queues a job in the application's Job table (the same serial queue as the Files tab; you are not a job and hold no slot). Every successful run creates a NEW PDF Doc, even when the bytes equal an existing one, and never replaces or reorders anything: an existing main Doc stays main and a work without Doc gets the PDF as main. If a job for the same work and format is already queued or running you get that job back (reused: true) instead of a second one. The call waits for the job: ok means it finished (job.id and docId name the actual job and Doc), error means the job failed (job.error, read it to the user), pending means the job had not finished when the wait ended (about ten minutes, or the user pressed Stop): it keeps running by itself, check read_jobs, never submit it again. Stop never cancels a submitted job and starts no new one. The source is arXiv only; there is no OCR, publisher PDF or HTML route.",
  "attach_arxiv is the dialog's 'get LaTeX source from arXiv' for one work (refId): the work's own arXiv e-print is fetched fresh and compiled as an arXiv LaTeX Doc. A work without Doc gets it as main; a work whose Docs are all PDFs gets it appended after them (the PDF main stays); a work that already has its arXiv Doc has that Doc refreshed in place, which replaces its text and may archive the user's annotations on it: that case waits for the user's confirmation card (declined or expired means nothing was changed and no job was started; do not ask again unless the user wants it), you cannot approve it and nothing in chat does. A work holding other content (for example a LaTeX zip) is rejected. Results are like acquire_arxiv_pdf: ok with job.id and docId, error for a failed job (an arXiv submission without LaTeX source fails with errorCode arxiv_pdf_only), pending while unfinished. This job rebuilds the library index through the application's own routine, exactly as the Files tab does.",
  "read_jobs shows the Job table lines the Files tab shows for a work (refId; without it the newest jobs of any work): id, kind, format (arxiv-pdf, pdf, or LaTeX), status, the latest progress message, error and errorCode, and docId once finished. Use it to find out what a pending or unknown acquisition came to. Dismissing an error line and retrying are the user's display state and a new submission: retry is simply acquire_arxiv_pdf or attach_arxiv again after a failed job.",
  "upload_pdf, upload_latex_zip and replace_upload_source are the Files tab's uploads, with a file the USER attached to a message of this conversation (attachmentId is listed in that message's attachments; you never get a path, a URL or the bytes, and an id from another conversation, a made-up id or a deleted file is not_found). upload_pdf needs a .pdf and is the page's own upload: identical bytes already on that work return the existing Doc (status noop), another work gets its own Doc, an existing main Doc is not displaced. upload_latex_zip needs a .zip LaTeX source for a work that has no uploaded source yet; the new Doc becomes main. replace_upload_source swaps the text of the work's existing uploaded source (docId from your read of the work): it may archive the user's annotations on it, so it waits for the user's confirmation card naming the file (declined or expired means nothing was changed and no job started); you cannot approve it. Results are like acquire_arxiv_pdf: ok with job.id and docId, error for a failed job (read its error to the user), pending while unfinished, never submit again. Without an attachment you cannot upload: ask the user to attach the file with the plus button of the composer.",
  "filter_library, select_work, set_detail_tab, set_sidebar, set_graph_labels and graph_control (zoom_in, zoom_out, fit, relayout of the citation graph; dragging and panning are the user's gestures) change what the user sees in the bound tab; use them only when asked to show something. To open a Doc in the Reader use the workspace tool's open_doc.",
  "set_temp_label sets the colour dot the right-click menu offers. It is temporary: it exists only in that browser tab and is never saved to the library, so do not describe it as saved.",
  "A page whose source is demo is built-in example data, and source error means the library could not be read (see its error): say so, and do not describe its works as the user's.",
  "Only report results whose status is ok or noop as done; pending is not done. A set_main_doc whose status is unknown may or may not have been applied: read the work to find out, never repeat it blindly.",
].join(" ");

/** One readable line for the journal, so a resume note can say what an unfinished import was. */
function importSummary(op: { mode: string; text: string } | undefined): string {
  if (!op) return "";
  const flat = op.text.replace(/\s+/g, " ").trim();
  return `${op.mode}: ${flat.length > 80 ? `${flat.slice(0, 80)}…` : flat}`;
}

function record(id: string, action: string, partial: Partial<CopilotOperation>): CopilotOperation {
  return { id, tool: LIBRARY_TOOL_NAME, action, status: "error", ...partial };
}

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

type DoneFn = (
  operation: CopilotOperation,
  payload: object
) => { content: { type: "text"; text: string }[]; details: CopilotOperation };

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
  kind: "pdf" | "source" | "upload_pdf" | "upload_zip" | "replace_upload";
  attachmentId?: string;
  docId?: string;
  done: DoneFn;
}) {
  const { context, rest, requestedId, toolCallId, action, refId, kind, done } = input;
  const workObject = { kind: "work" as const, id: refId };
  const port = context.library.acquisition;
  if (!port)
    return done(record(toolCallId, action, { status: "unsupported" }), {
      ok: false,
      status: "unsupported",
      detail: "acquisition is not available in this host",
    });
  const journal = context.journal;
  const operationId =
    typeof requestedId === "string" && requestedId
      ? requestedId
      : `${context.runId ?? "run"}:${toolCallId}`;
  const hash = digest(rest);
  const known = journal?.lookup(operationId);
  if (known && known.hash !== hash)
    return done(record(toolCallId, action, { status: "rejected" }), {
      ok: false,
      status: "rejected",
      detail: "operationId was already used for a different request",
    });
  if (known?.state === "done") {
    // A pending result is replayed with what the Job table says now, never with the stale snapshot.
    const live = liveReplay(port, known.operation, known.payload);
    return done({ ...live.operation, id: toolCallId }, { ...live.payload, duplicate: true });
  }
  if (known)
    return done(record(toolCallId, action, { status: "unknown" }), {
      ok: false,
      status: "unknown",
      detail: `this operation started earlier and its outcome was not recorded; ${known.jobId ? `its job is ${known.jobId}: read_jobs shows its state` : "read_jobs for this work shows whether its job exists"}, do not repeat it blindly`,
    });

  // A file the user attached to THIS conversation (an id, never a path); anything else is not found.
  let file: { meta: CopilotAttachment; bytes: Buffer } | undefined;
  if (kind === "upload_pdf" || kind === "upload_zip" || kind === "replace_upload") {
    const held = input.attachmentId ? context.attachment?.(input.attachmentId) : null;
    if (!held)
      return done(record(toolCallId, action, { status: "not_found", object: workObject }), {
        ok: false,
        status: "not_found",
        detail:
          "no such attachment: only a file the user attached to a message of this conversation can be used",
      });
    const wanted = kind === "upload_pdf" ? ".pdf" : ".zip";
    if (!held.meta.filename.toLowerCase().endsWith(wanted))
      return done(record(toolCallId, action, { status: "rejected", object: workObject }), {
        ok: false,
        status: "rejected",
        detail: `the Files tab takes ${kind === "upload_pdf" ? "a .pdf file" : "a .zip LaTeX source"} here; this attachment is named ${held.meta.filename}`,
      });
    if ((kind === "upload_zip" || kind === "replace_upload") && !port.checkZip(held.bytes))
      return done(record(toolCallId, action, { status: "rejected", object: workObject }), {
        ok: false,
        status: "rejected",
        detail: "the attachment is not a readable zip archive; nothing was changed",
      });
    file = held;
  }

  // A replacement overwrites text that may carry annotations: the real user decides first.
  let label: string | undefined;
  type Replacement = {
    action: "refresh_arxiv_source" | "replace_upload_source";
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
  } else if (kind === "upload_zip" || kind === "replace_upload") {
    const target = port.describeUpload(refId);
    if (target.kind === "not_found")
      return done(record(toolCallId, action, { status: "not_found" }), {
        ok: false,
        status: "not_found",
        detail: "no such work",
      });
    if (kind === "upload_zip" && target.hasUpload)
      return done(record(toolCallId, action, { status: "rejected", object: workObject }), {
        ok: false,
        status: "rejected",
        detail: `this work already has an uploaded LaTeX source (${target.docId}); use replace_upload_source with that docId to replace it`,
      });
    if (kind === "replace_upload" && (!target.hasUpload || target.docId !== input.docId))
      return done(record(toolCallId, action, { status: "rejected", object: workObject }), {
        ok: false,
        status: "rejected",
        detail: "that Doc is not this work's uploaded LaTeX source; there is nothing to replace",
      });
    if (kind === "replace_upload")
      replacement = {
        action: "replace_upload_source",
        title: target.title,
        docId: target.docId,
        docIds: target.docIds,
        binding: { attachment: file?.meta.sha256 },
        current: () => {
          const again = port.describeUpload(refId);
          return again.kind === "work" && again.hasUpload ? again : null;
        },
      };
  }
  /**
   * Ask the real user and hear the decision. Returns the tool result when the answer is anything but "approved"
   * (nothing was changed, no job started); null when approved and `recheck` still holds.
   */
  const askUser = async (
    request: Parameters<ConfirmationPort["request"]>[0],
    title: string,
    recheck: () => Promise<boolean>
  ) => {
    const common = { object: workObject, label: title };
    if (!context.confirm)
      return done(record(toolCallId, action, { status: "unsupported", object: workObject }), {
        ok: false,
        status: "unsupported",
        detail: "this step needs the user's confirmation and none is available here",
      });
    let decision: Awaited<ReturnType<ConfirmationPort["request"]>>;
    try {
      decision = await context.confirm.request(request);
    } catch {
      return done(record(toolCallId, action, { status: "error", object: workObject }), {
        ok: false,
        status: "error",
        detail: "the confirmation could not be saved; nothing was changed and no job was started",
      });
    }
    if (decision.outcome === "declined")
      return done(record(toolCallId, action, { status: "declined", ...common }), {
        ok: false,
        status: "declined",
        detail: "the user declined; nothing was changed and no job was started",
      });
    if (decision.outcome === "expired")
      return done(record(toolCallId, action, { status: "expired", ...common }), {
        ok: false,
        status: "expired",
        detail:
          decision.reason === "stale"
            ? "the library, the document's annotations or the attachment changed before the user confirmed; nothing was changed. Read again and ask only if it is still wanted"
            : "the request ended before the user confirmed; nothing was changed and no job was started",
      });
    // Approved. The same check the click made, now that the job is about to be submitted.
    if (!(await recheck()))
      return done(record(toolCallId, action, { status: "expired", ...common }), {
        ok: false,
        status: "expired",
        detail:
          "the library, the document's annotations or the attachment changed after the user confirmed; nothing was changed. Read again and ask only if it is still wanted",
      });
    return null;
  };
  const stillHeld = () =>
    !file || context.attachment?.(file.meta.id)?.meta.sha256 === file.meta.sha256;

  // A big PDF: the Files tab makes the user tick "continue" for files of 25 MiB and more; here the user decides on a card.
  if (kind === "upload_pdf" && file && file.meta.size >= PDF_RESOURCE_WARNING_BYTES) {
    const title = LibraryStore.load(context.library.paths).get(refId)?.title ?? refId;
    const resourceDigest = digest({ refId, sha256: file.meta.sha256, size: file.meta.size });
    const early = await askUser(
      {
        toolCallId,
        action: "accept_pdf_resource_warning",
        workId: refId,
        label: title,
        attachment: {
          id: file.meta.id,
          filename: file.meta.filename,
          size: file.meta.size,
          sha256: file.meta.sha256,
        },
        baseRev: 0,
        objectDigest: resourceDigest,
      },
      title,
      async () => stillHeld()
    );
    if (early) return early;
  }

  if (replacement) {
    const current = replacement;
    label = current.title;
    const prepared = await prepareArxivRefresh(context.library, refId, current, current.binding);
    if (!prepared.ok)
      return done(record(toolCallId, action, { status: prepared.status, object: workObject }), {
        ok: false,
        status: prepared.status,
        detail: prepared.detail,
      });
    const early = await askUser(
      {
        toolCallId,
        action: current.action,
        workId: refId,
        docId: prepared.docId,
        label: prepared.title,
        impact: prepared.impact,
        ...(file && current.action === "replace_upload_source"
          ? {
              attachment: {
                id: file.meta.id,
                filename: file.meta.filename,
                size: file.meta.size,
                sha256: file.meta.sha256,
              },
            }
          : {}),
        baseRev: prepared.rev,
        objectDigest: prepared.digest,
      },
      prepared.title,
      async () => {
        const again = current.current();
        const recheck = again
          ? await prepareArxivRefresh(context.library, refId, again, current.binding)
          : null;
        return !!recheck?.ok && recheck.digest === prepared.digest && stillHeld();
      }
    );
    if (early) return early;
  }
  // Nothing new starts once Stop or shutdown closed the door (a confirmation that came back after it too).
  if (!context.admitting())
    return done(record(toolCallId, action, { status: "expired", object: workObject }), {
      ok: false,
      status: "expired",
      detail: "the run was stopped before the job was submitted; nothing was changed",
    });
  try {
    journal?.begin({
      operationId,
      toolCallId,
      action,
      hash,
      object: { workId: refId, ...(file ? { summary: file.meta.filename.slice(0, 80) } : {}) },
    });
  } catch {
    return done(record(toolCallId, action, { status: "error" }), {
      ok: false,
      status: "error",
      detail: "the conversation could not be saved; nothing was written",
    });
  }
  const admitting = context.admitting;
  const onSubmitted = (jobId: string) => journal?.submitted?.(operationId, jobId);
  const ctx = { admitting, onSubmitted };
  const work: Promise<AcquireOutcome> =
    kind === "pdf"
      ? applyAcquireArxivPdf(context.library, refId, ctx)
      : kind === "source"
        ? applyAttachArxiv(context.library, refId, ctx)
        : kind === "upload_pdf"
          ? applyUploadPdf(
              context.library,
              refId,
              {
                bytes: (file as NonNullable<typeof file>).bytes,
                filename: (file as NonNullable<typeof file>).meta.filename,
              },
              ctx
            )
          : applyUploadZip(
              context.library,
              refId,
              { bytes: (file as NonNullable<typeof file>).bytes },
              ctx,
              { expectNoUpload: kind === "upload_zip" }
            );
  const outcome = await (context.track ? context.track(work) : work);
  const result = outcome.ok
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
      );
  journal?.done(operationId, outcome as unknown as Record<string, unknown>, result.details);
  return result;
}

export function createLibraryTool(context: LibraryToolContext) {
  return defineTool({
    name: LIBRARY_TOOL_NAME,
    label: "Library",
    description,
    executionMode: "sequential",
    parameters,
    async execute(toolCallId, params) {
      const action = typeof params.action === "string" ? params.action : "unknown";
      const done = (operation: CopilotOperation, payload: object) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        details: operation,
      });
      if (!context.admitting())
        return done(record(toolCallId, action, { status: "error" }), {
          ok: false,
          status: "closed",
        });
      try {
        const { operationId: requestedId, ...rest } = params as Record<string, unknown>;
        const read = LibraryReadOperationSchema.safeParse(rest);
        if (read.success) {
          let outcome: Awaited<ReturnType<typeof readLibrary>>;
          try {
            outcome = await readLibrary(context.library, read.data);
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
          const shown = viewOutcomeResult(await context.viewAction(view.data));
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
        const jobsRead = LibraryReadJobsSchema.safeParse(rest);
        if (jobsRead.success) {
          const outcome = readJobs(context.library, jobsRead.data);
          if (!outcome.ok)
            return done(record(toolCallId, "read_jobs", { status: "unsupported" }), outcome);
          return done(record(toolCallId, "read_jobs", { status: "ok" }), outcome);
        }
        const uploads = [
          LibraryUploadPdfSchema.safeParse(rest),
          LibraryUploadLatexZipSchema.safeParse(rest),
          LibraryReplaceUploadSourceSchema.safeParse(rest),
        ] as const;
        const upload = uploads.find((candidate) => candidate.success);
        if (upload?.success) {
          const data = upload.data;
          return await runAcquisition({
            context,
            rest,
            requestedId,
            toolCallId,
            action,
            refId: data.refId,
            kind:
              data.action === "upload_pdf"
                ? "upload_pdf"
                : data.action === "upload_latex_zip"
                  ? "upload_zip"
                  : "replace_upload",
            attachmentId: data.attachmentId,
            ...(data.action === "replace_upload_source" ? { docId: data.docId } : {}),
            done,
          });
        }
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
            done,
          });
        }
        const importOp = LibraryImportWorksSchema.safeParse(rest);
        const write = LibrarySetMainDocSchema.safeParse(rest);
        if (!importOp.success && !write.success) {
          const failure =
            rest.action === "import_works"
              ? importOp
              : rest.action === "upload_pdf"
                ? uploads[0]
                : rest.action === "upload_latex_zip"
                  ? uploads[1]
                  : rest.action === "replace_upload_source"
                    ? uploads[2]
                    : rest.action === "acquire_arxiv_pdf"
                      ? pdfJob
                      : rest.action === "attach_arxiv"
                        ? sourceJob
                        : rest.action === "read_jobs"
                          ? jobsRead
                          : write;
          return done(record(toolCallId, action, { status: "unsupported" }), {
            ok: false,
            status: "unsupported",
            detail: "unknown action or invalid parameters",
            issues: (failure.success ? [] : failure.error.issues)
              .slice(0, 5)
              .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
        }
        const journal = context.journal;
        const operationId =
          typeof requestedId === "string" && requestedId
            ? requestedId
            : `${context.runId ?? "run"}:${toolCallId}`;
        const hash = digest(rest);
        const known = journal?.lookup(operationId);
        if (known && known.hash !== hash)
          return done(record(toolCallId, action, { status: "rejected" }), {
            ok: false,
            status: "rejected",
            detail: "operationId was already used for a different request",
          });
        if (known?.state === "done")
          return done(
            { ...known.operation, id: toolCallId },
            { ...known.payload, duplicate: true }
          );
        if (known)
          return done(record(toolCallId, action, { status: "unknown" }), {
            ok: false,
            status: "unknown",
            detail:
              "this operation started earlier and its outcome was not recorded; read the library (the work, or search the identifier or title) to find out, do not repeat it blindly",
          });
        try {
          journal?.begin({
            operationId,
            toolCallId,
            action,
            hash,
            object: write.success
              ? { workId: write.data.refId }
              : { summary: importSummary(importOp.success ? importOp.data : undefined) },
          });
        } catch {
          return done(record(toolCallId, action, { status: "error" }), {
            ok: false,
            status: "error",
            detail: "the conversation could not be saved; nothing was written",
          });
        }
        const work: Promise<LibraryOpOutcome | LibraryImportOutcome> = importOp.success
          ? applyLibraryImport(context.library, importOp.data)
          : applyLibraryOperation(context.library, (write as { data: LibrarySetMainDoc }).data);
        const outcome = await (context.track ? context.track(work) : work);
        const failedObject = write.success
          ? { object: { kind: "work" as const, id: write.data.refId } }
          : {};
        const result = outcome.ok
          ? done(
              record(toolCallId, action, {
                status: outcome.status,
                object: outcome.object,
                label: outcome.label,
                ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
              }),
              outcome
            )
          : done(
              record(toolCallId, action, {
                status: outcome.status,
                ...failedObject,
              }),
              outcome
            );
        journal?.done(operationId, outcome as unknown as Record<string, unknown>, result.details);
        return result;
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
