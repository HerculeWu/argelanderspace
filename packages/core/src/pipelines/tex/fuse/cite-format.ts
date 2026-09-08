/**
 * Visible-text reconstruction for cite segments (ported from the retired
 * walker's `emitCite`/`formatCitation`/`citePieces`): the reader's cite chip
 * shows the printed citation form ("(Knuth 1984)", "Knuth (1984)"),
 * reconstructed from the command semantics + reference authors/year.
 */
import type { Reference } from "@argelanderspace/contracts";

/** natbib/kernel command → citation mode (pandoc's citationMode twins). */
export type CiteMode = "AuthorInText" | "NormalCitation" | "SuppressAuthor" | "AuthorOnly";

export function citeModeOf(command: string): CiteMode {
  switch (command) {
    case "citet":
    case "citealt":
    case "citeonline":
      return "AuthorInText";
    case "citeyear":
    case "citeyearpar":
      return "SuppressAuthor";
    case "citeauthor":
      return "AuthorOnly";
    default:
      return "NormalCitation"; // cite, citep, citealp, citenum-ish
  }
}

/** `(authorLabel, year)` for one reference (key fallback when unresolved). */
export function citePieces(
  ref: Reference | undefined,
  key: string
): [author: string, year: number | null] {
  if (ref === undefined) return [key, null];
  const a = ref.authors ?? [];
  let au: string;
  if (a.length === 0) au = key;
  else if (a.length === 1) au = a[0] ?? key;
  else if (a.length === 2) au = `${a[0]} & ${a[1]}`;
  else au = `${a[0]} et al.`;
  return [au, ref.year ?? null];
}

/** Reconstruct the printed citation string (old `formatCitation`). */
export function formatCitation(
  modes: readonly CiteMode[],
  authorYear: ReadonlyArray<readonly [string, number | null]>,
  prefix: string,
  suffix: string
): string {
  const ay = (au: string, yr: number | null): string => (yr !== null ? `${au} ${yr}` : au);

  const allIntext = modes.length > 0 && modes.every((m) => m === "AuthorInText");
  const allSuppress = modes.length > 0 && modes.every((m) => m === "SuppressAuthor");
  const allAuthor = modes.length > 0 && modes.every((m) => m === "AuthorOnly");
  if (allAuthor) return authorYear.map(([au]) => au).join("; ");
  if (allSuppress) {
    const body = authorYear
      .filter(([, yr]) => yr !== null)
      .map(([, yr]) => String(yr))
      .join("; ");
    return body !== "" ? `(${body})` : "";
  }
  if (allIntext) {
    return authorYear.map(([au, yr]) => (yr !== null ? `${au} (${yr})` : au)).join("; ");
  }
  const body = authorYear.map(([au, yr]) => ay(au, yr)).join("; ");
  const inner = (prefix !== "" ? `${prefix} ` : "") + body + (suffix !== "" ? `, ${suffix}` : "");
  return `(${inner})`;
}
