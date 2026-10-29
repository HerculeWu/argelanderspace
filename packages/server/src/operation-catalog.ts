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
import { runArgumentEdit, runArgumentRead, runArgumentReplace } from "./argument-operations.js";
import type { ArgumentOpDeps } from "./copilot-argument-tool.js";
import { exploreSeed, searchAds } from "./discovery-actions.js";
import { runDeleteDocOperation } from "./doc-delete-operation.js";
import type { ExternalAsk, ExternalCardFields } from "./external-requests.js";
import { applyLibraryOperation, type LibraryOpDeps, readLibrary } from "./library-actions.js";
import { runNavigationOperation } from "./navigation-operation.js";
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
  /** The argument graph store (release-0.2 ticket 08): its own lock, Work lookup, change notice and undo memory. */
  argument?: ArgumentOpDeps;
  /** Present in the running workbench only. */
  confirm?: OperationConfirmPort;
  /** Present in the running workbench only: opens somewhere in its most recently active window (ticket 05). */
  navigate?: NavigationPort;
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
  "argument.read": async (runtime, params) =>
    runArgumentRead(runtime, { action: "read", ...params }),
  "argument.create": (runtime, params) => runArgumentEdit(runtime, { action: "create", ...params }),
  "argument.update": (runtime, params) => runArgumentEdit(runtime, { action: "update", ...params }),
  "argument.delete": (runtime, params) => runArgumentEdit(runtime, { action: "delete", ...params }),
  "argument.undo_delete": (runtime, params) =>
    runArgumentEdit(runtime, { action: "undo_delete", ...params }),
  "argument.add_edge": (runtime, params) =>
    runArgumentEdit(runtime, { action: "add_edge", ...params }),
  "argument.remove_edge": (runtime, params) =>
    runArgumentEdit(runtime, { action: "remove_edge", ...params }),
  "argument.replace": (runtime, params, call) =>
    runArgumentReplace(runtime, { action: "replace", ...params }, call),
  "argument.clear": (runtime, params, call) =>
    runArgumentReplace(runtime, { action: "clear", ...params }, call),
};

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
