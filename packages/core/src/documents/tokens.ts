/**
 * Inline token helpers (bibgraph/schema.py).
 *
 * Body text carries in-text citation / cross-reference sites as placeholder tokens:
 * `"... as shown by [[cite:ref-1;ref-2]] in [[xref:fig-3]] ..."`.
 */

import { CITE_TOKEN_RE, XREF_TOKEN_RE } from "@argelanderspace/contracts";

/** `["ref-1","ref-2"]` -> `"[[cite:ref-1;ref-2]]"`. */
export function citeToken(refIds: string[]): string {
  return `[[cite:${refIds.join(";")}]]`;
}

/** `"fig-3"` -> `"[[xref:fig-3]]"`. */
export function xrefToken(targetId: string): string {
  return `[[xref:${targetId}]]`;
}

const CITE_TOKEN_G = new RegExp(CITE_TOKEN_RE, "gu");
const XREF_TOKEN_G = new RegExp(XREF_TOKEN_RE, "gu");

/** Return `text` with all `[[cite:..]]` / `[[xref:..]]` tokens removed. */
export function stripTokens(text: string): string {
  return text
    .replace(CITE_TOKEN_G, "")
    .replace(XREF_TOKEN_G, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
}
