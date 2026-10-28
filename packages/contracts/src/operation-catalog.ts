/**
 * The operation catalog (ADR 0015): every business operation once, with its domain, name, parameters, result,
 * confirmation and navigation. The Copilot tools and the CLI subcommands are derived from this list; see
 * `operation-def.ts` for the entry shape and the derivation helpers. Release-0.2 ticket 01 holds the Library read and
 * `set_main_doc`; later tickets add domains here by listing their entries.
 */
import {
  DISCOVERY_EXPLORE_OPERATION,
  DISCOVERY_SEARCH_ADS_OPERATION,
} from "./discovery-catalog.js";
import { LIBRARY_READ_OPERATION, LIBRARY_SET_MAIN_DOC_OPERATION } from "./library-catalog.js";
import { type OperationDef, parseOperationCall } from "./operation-def.js";

export const OPERATION_CATALOG = [
  LIBRARY_READ_OPERATION,
  LIBRARY_SET_MAIN_DOC_OPERATION,
  DISCOVERY_SEARCH_ADS_OPERATION,
  DISCOVERY_EXPLORE_OPERATION,
] as const;
export type CatalogOperation = (typeof OPERATION_CATALOG)[number];
export type OperationId = CatalogOperation["id"];

export function operationsOfDomain(domain: string): OperationDef[] {
  return OPERATION_CATALOG.filter((op) => op.domain === domain);
}

/** The domains in catalog order. */
export function operationDomains(): string[] {
  return [...new Set(OPERATION_CATALOG.map((op) => op.domain))];
}

/** Parse a Copilot tool call `{ action, ...params }` of `domain`; `{ match: false }` if the action is not cataloged. */
export function parseCatalogCall(domain: string, raw: Record<string, unknown>) {
  return parseOperationCall(OPERATION_CATALOG, domain, raw);
}
