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
import {
  LIBRARY_DELETE_DOC_OPERATION,
  LIBRARY_READ_OPERATION,
  LIBRARY_SET_MAIN_DOC_OPERATION,
} from "./library-catalog.js";
import {
  ARGUMENT_OPEN_OPERATION,
  LIBRARY_OPEN_WORK_OPERATION,
  WORKSPACE_OPEN_DOC_OPERATION,
} from "./navigation-catalog.js";
import { type OperationDef, parseOperationCall } from "./operation-def.js";
import {
  READER_CREATE_ANNOTATION_OPERATION,
  READER_CREATE_PDF_ANNOTATION_OPERATION,
  READER_DELETE_ANNOTATION_OPERATION,
  READER_DELETE_PDF_ANNOTATION_OPERATION,
  READER_READ_IMAGE_OPERATION,
  READER_READ_OPERATION,
  READER_READ_PAGE_IMAGE_OPERATION,
  READER_READ_SVG_IMAGE_OPERATION,
  READER_UPDATE_ANNOTATION_OPERATION,
  READER_UPDATE_PDF_ANNOTATION_OPERATION,
} from "./reader-catalog.js";
import { TEXT_READ_SOURCE_OPERATION } from "./text-catalog.js";

export const OPERATION_CATALOG = [
  LIBRARY_READ_OPERATION,
  LIBRARY_SET_MAIN_DOC_OPERATION,
  LIBRARY_DELETE_DOC_OPERATION,
  WORKSPACE_OPEN_DOC_OPERATION,
  LIBRARY_OPEN_WORK_OPERATION,
  ARGUMENT_OPEN_OPERATION,
  DISCOVERY_SEARCH_ADS_OPERATION,
  DISCOVERY_EXPLORE_OPERATION,
  READER_READ_OPERATION,
  READER_READ_IMAGE_OPERATION,
  READER_READ_SVG_IMAGE_OPERATION,
  READER_READ_PAGE_IMAGE_OPERATION,
  TEXT_READ_SOURCE_OPERATION,
  READER_CREATE_ANNOTATION_OPERATION,
  READER_UPDATE_ANNOTATION_OPERATION,
  READER_DELETE_ANNOTATION_OPERATION,
  READER_CREATE_PDF_ANNOTATION_OPERATION,
  READER_UPDATE_PDF_ANNOTATION_OPERATION,
  READER_DELETE_PDF_ANNOTATION_OPERATION,
] as const;
export type CatalogOperation = (typeof OPERATION_CATALOG)[number];
export type OperationId = CatalogOperation["id"];

export function operationsOfDomain(domain: string): OperationDef[] {
  return OPERATION_CATALOG.filter((op) => op.domain === domain);
}

/** The CLI group of an entry: its `cli` override, else its domain. */
export function operationCliGroup(op: OperationDef): string {
  return op.cli?.group ?? op.domain;
}

/** The CLI groups in catalog order. */
export function operationCliGroups(): string[] {
  return [...new Set(OPERATION_CATALOG.map((op) => operationCliGroup(op)))];
}

/** The entries registered under one CLI group. */
export function operationsOfCliGroup(group: string): OperationDef[] {
  return OPERATION_CATALOG.filter((op) => operationCliGroup(op) === group);
}

/** The domains in catalog order. */
export function operationDomains(): string[] {
  return [...new Set(OPERATION_CATALOG.map((op) => op.domain))];
}

/** Parse a Copilot tool call `{ action, ...params }` of `domain`; `{ match: false }` if the action is not cataloged. */
export function parseCatalogCall(domain: string, raw: Record<string, unknown>) {
  return parseOperationCall(OPERATION_CATALOG, domain, raw);
}
