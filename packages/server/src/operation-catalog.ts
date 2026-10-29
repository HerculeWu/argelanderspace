/**
 * Execution of the operation catalog (contracts `operation-catalog.ts`; ADR 0015, release-0.2 ticket 01): one handler
 * per catalog entry, run by the Copilot tool and by the CLI. A handler is the business code itself
 * (`readLibrary`, `applyLibraryOperation`), so both entrances give the same answer. Adding a catalog entry without a
 * handler here is a type error (`OperationHandlers` is keyed by every catalog id).
 */
import {
  type CatalogOperation,
  type ExternalRequestClient,
  OPERATION_CATALOG,
  type OperationDef,
  type OperationId,
} from "@argelanderspace/contracts";
import type { ReaderOpDeps } from "./copilot-reader-tool.js";
import { exploreSeed, searchAds } from "./discovery-actions.js";
import { runDeleteDocOperation } from "./doc-delete-operation.js";
import type { ExternalAsk, ExternalCardFields } from "./external-requests.js";
import { applyLibraryOperation, type LibraryOpDeps, readLibrary } from "./library-actions.js";
import { runNavigationOperation } from "./navigation-operation.js";
import {
  CATALOG_PDF_SCOPE,
  runPdfWrite,
  runReaderRead,
  runReaderWrite,
  runReadImage,
  runReadPageImage,
  runReadSvgImage,
  runTextReadSource,
  type TextSourceReader,
} from "./reader-operations.js";
import type { NavigationPort } from "./workbench-windows.js";

/**
 * Where an operation with `confirm: "card"` puts its card for the real user (release-0.2 ticket 04). Only the running
 * workbench has one (the external requests queue); the in-process runtime of a CLI command has none, so such an
 * operation refuses there instead of running unconfirmed.
 */
export interface OperationConfirmPort {
  /** `null`: too many cards already wait. */
  ask(input: {
    card: ExternalCardFields;
    client?: ExternalRequestClient | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<ExternalAsk> | null;
}

/** What handlers may use. Domains add their deps here as the catalog grows. */
export interface OperationRuntime {
  library: LibraryOpDeps;
  /** Present in the running workbench only. */
  confirm?: OperationConfirmPort;
  /** Present in the running workbench only: opens somewhere in its most recently active window (ticket 05). */
  navigate?: NavigationPort;
  /**
   * The Reader's data seam (release-0.2 ticket 07): the annotations access path, the PDF access path and the reads of
   * a Doc. The workbench passes the one its Copilot `reader` tool uses; a CLI command in its own process builds the
   * same seam over its own locks (`createReaderOps`).
   */
  reader?: ReaderOpDeps;
  /** The text Doc service's source read (release-0.2 ticket 07). */
  text?: TextSourceReader;
  /** Cancels a read that is waiting on ADS (the Copilot's Stop); a CLI request's abort comes as `OperationCall.signal`. */
  signal?: AbortSignal | undefined;
}

/** Who asked and whether they are still there; given by the operation route, absent for a Copilot tool call. */
export interface OperationCall {
  client?: ExternalRequestClient | undefined;
  /** Aborts when the asker leaves (the CLI's Ctrl-C, a lost connection, the workbench closing). */
  signal?: AbortSignal | undefined;
}

type ParamsOf<Id extends OperationId> = Extract<CatalogOperation, { id: Id }>["params"]["_output"];

export type OperationHandlers = {
  [Id in OperationId]: (
    runtime: OperationRuntime,
    params: ParamsOf<Id>,
    call: OperationCall
  ) => Promise<unknown>;
};

export const OPERATION_HANDLERS: OperationHandlers = {
  "library.read": (runtime, params) => readLibrary(runtime.library, { action: "read", ...params }),
  "library.set_main_doc": (runtime, params) =>
    applyLibraryOperation(runtime.library, { action: "set_main_doc", ...params }),
  "library.delete_doc": (runtime, params, call) => runDeleteDocOperation(runtime, params, call),
  "workspace.open_doc": (runtime, params, call) =>
    runNavigationOperation(runtime, { op: "workspace.open_doc", params }, call),
  "library.open_work": (runtime, params, call) =>
    runNavigationOperation(runtime, { op: "library.open_work", params }, call),
  "argument.open": (runtime, params, call) =>
    runNavigationOperation(runtime, { op: "argument.open", params }, call),
  "discovery.search_ads": (runtime, params, call) =>
    searchAds(runtime.library, params, call?.signal ?? runtime.signal),
  "discovery.explore": (runtime, params, call) =>
    exploreSeed(runtime.library, params, call?.signal ?? runtime.signal),
  "reader.read": (runtime, params) => runReaderRead(readerOf(runtime), params),
  "reader.read_image": (runtime, params) => runReadImage(readerOf(runtime), params),
  "reader.read_svg_image": (runtime, params) => runReadSvgImage(readerOf(runtime), params),
  "reader.read_page_image": (runtime, params) => runReadPageImage(readerOf(runtime), params),
  "text.read_source": async (runtime, params) => {
    if (!runtime.text) throw new Error("this runtime has no text Doc service");
    return runTextReadSource(runtime.text, params);
  },
  "reader.create_annotation": async (runtime, params) =>
    (await runReaderWrite(readerOf(runtime), { action: "create_annotation", ...params })).payload,
  "reader.update_annotation": async (runtime, params) =>
    (await runReaderWrite(readerOf(runtime), { action: "update_annotation", ...params })).payload,
  "reader.delete_annotation": async (runtime, params) =>
    (await runReaderWrite(readerOf(runtime), { action: "delete_annotation", ...params })).payload,
  "reader.create_pdf_annotation": async (runtime, params) =>
    (
      await runPdfWrite(
        readerOf(runtime),
        { action: "create_pdf_annotation", ...params },
        CATALOG_PDF_SCOPE
      )
    ).payload,
  "reader.update_pdf_annotation": async (runtime, params) =>
    (
      await runPdfWrite(
        readerOf(runtime),
        { action: "update_pdf_annotation", ...params },
        CATALOG_PDF_SCOPE
      )
    ).payload,
  "reader.delete_pdf_annotation": async (runtime, params) =>
    (
      await runPdfWrite(
        readerOf(runtime),
        { action: "delete_pdf_annotation", ...params },
        CATALOG_PDF_SCOPE
      )
    ).payload,
};

/** The Reader seam of a runtime; a runtime made without one cannot run the reading and annotation operations. */
function readerOf(runtime: OperationRuntime): ReaderOpDeps {
  if (!runtime.reader) throw new Error("this runtime has no Reader data");
  return runtime.reader;
}

/** Run a cataloged operation with params already parsed by its catalog entry. */
export function runCatalogOperation(
  runtime: OperationRuntime,
  id: OperationId,
  params: Record<string, unknown>,
  call: OperationCall = {}
): Promise<unknown> {
  const handler = OPERATION_HANDLERS[id] as (
    runtime: OperationRuntime,
    params: Record<string, unknown>,
    call: OperationCall
  ) => Promise<unknown>;
  return handler(runtime, params, call);
}

/** The catalog entry of `id`, or undefined for an id that is not cataloged. */
export function findCatalogOperation(id: string): OperationDef | undefined {
  return (OPERATION_CATALOG as readonly OperationDef[]).find((op) => op.id === id);
}

/**
 * Validate parameters against the entry: the parsed object, or the one-line detail every entrance reports the same way
 * (the CLI before it runs or routes anything, the workbench's operation route again on arrival).
 */
export function parseOperationParams(
  op: OperationDef,
  raw: unknown
): { ok: true; params: Record<string, unknown> } | { ok: false; detail: string } {
  const parsed = op.params.safeParse(raw);
  if (parsed.success) return { ok: true, params: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    detail: parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(parameters)"}: ${issue.message}`)
      .join("; "),
  };
}
