/**
 * Execution of the operation catalog (contracts `operation-catalog.ts`; ADR 0015, release-0.2 ticket 01): one handler
 * per catalog entry, run by the Copilot tool and by the CLI. A handler is the business code itself
 * (`readLibrary`, `applyLibraryOperation`), so both entrances give the same answer. Adding a catalog entry without a
 * handler here is a type error (`OperationHandlers` is keyed by every catalog id).
 */
import type { CatalogOperation, OperationId } from "@argelanderspace/contracts";
import { applyLibraryOperation, type LibraryOpDeps, readLibrary } from "./library-actions.js";

/** What handlers may use. Domains add their deps here as the catalog grows. */
export interface OperationRuntime {
  library: LibraryOpDeps;
}

type ParamsOf<Id extends OperationId> = Extract<CatalogOperation, { id: Id }>["params"]["_output"];

export type OperationHandlers = {
  [Id in OperationId]: (runtime: OperationRuntime, params: ParamsOf<Id>) => Promise<unknown>;
};

export const OPERATION_HANDLERS: OperationHandlers = {
  "library.read": (runtime, params) => readLibrary(runtime.library, { action: "read", ...params }),
  "library.set_main_doc": (runtime, params) =>
    applyLibraryOperation(runtime.library, { action: "set_main_doc", ...params }),
};

/** Run a cataloged operation with params already parsed by its catalog entry. */
export function runCatalogOperation(
  runtime: OperationRuntime,
  id: OperationId,
  params: Record<string, unknown>
): Promise<unknown> {
  const handler = OPERATION_HANDLERS[id] as (
    runtime: OperationRuntime,
    params: Record<string, unknown>
  ) => Promise<unknown>;
  return handler(runtime, params);
}
