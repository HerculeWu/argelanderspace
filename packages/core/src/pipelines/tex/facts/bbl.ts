/**
 * .bbl parser: key → raw rendered entry.
 *
 * Each reference is the verbatim text between `\bibitem{key}` (optional
 * `[label]` argument supported) and the next `\bibitem` or
 * `\end{thebibliography}`. Beyond the raw text only identifier-shaped
 * patterns are recognized (DOI / arXiv ID / URL); the bare-DOI form is a
 * conservative heuristic (see `extractDoi`). Title/author boundaries
 * are deliberately NOT guessed from typeset text — unknown beats
 * guessed-wrong (Stage 5 roadmap; they stay absent, i.e. null downstream).
 *
 * biblatex-style .bbl files have no thebibliography environment; they yield
 * no references plus a warning. Parse errors degrade, they never throw.
 */
import { readTexGroup, skipTexWhitespace, texCommandPositions } from "./scan.js";

export interface TexReferenceFact {
  key: string;
  raw: string;
  /** The optional \bibitem[label] marker (e.g. "Knuth(1984)"), when present. */
  label?: string;
  doi?: string;
  arxiv?: string;
  url?: string;
}

export interface TexBblFacts {
  references: TexReferenceFact[];
  warnings: string[];
}

/** Trailing punctuation that commonly clings to identifiers in typeset text. */
function stripTrailing(s: string): string {
  return s.replace(/[.,;\]]+$/, "");
}

/**
 * DOI extraction. Explicitly marked forms (`\doi{...}`, `doi:...`,
 * `doi.org/...`) are trusted as-is. The BARE form (`10.NNNN/suffix` with
 * no marker) is a heuristic: to keep prose like "10.1234/567" (page-like
 * number pairs) from matching, the suffix must contain at least one ASCII
 * letter — real DOI suffixes almost always do. False negatives (bare,
 * purely numeric suffixes) are accepted as the conservative trade.
 */
function extractDoi(raw: string): string | undefined {
  const m =
    /(?:\\doi\{|doi[:\s]\s*|doi\.org\/)(10\.\d{4,9}\/[^\s}]+)/i.exec(raw) ??
    /\b(10\.\d{4,9}\/[^\s,}]*[a-zA-Z][^\s,}]*)/.exec(raw);
  return m?.[1] !== undefined ? stripTrailing(m[1]) : undefined;
}

function extractArxiv(raw: string): string | undefined {
  const m =
    /(?:arxiv\.org\/abs\/|arXiv:\s*)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i.exec(
      raw
    );
  return m?.[1] !== undefined ? stripTrailing(m[1]) : undefined;
}

function extractUrl(raw: string): string | undefined {
  for (const m of raw.matchAll(/https?:\/\/[^\s}]+/gi)) {
    const url = stripTrailing(m[0]);
    if (/doi\.org|arxiv\.org/i.test(url)) continue; // already captured as doi/arxiv
    return url;
  }
  return undefined;
}

export function parseBbl(content: string): TexBblFacts {
  const beginMark = "\\begin{thebibliography}";
  const begin = content.indexOf(beginMark);
  if (begin === -1) {
    // No thebibliography: either an empty .bbl (silent) or a biblatex-style
    // .bbl (\refsection/\entry structure), which we cannot read.
    const warnings =
      content.trim() === ""
        ? []
        : [".bbl has no thebibliography environment (biblatex-style?); no references extracted"];
    return { references: [], warnings };
  }
  const endMark = content.indexOf("\\end{thebibliography}", begin);
  const body = endMark === -1 ? content.slice(begin) : content.slice(begin, endMark);

  const items: { key: string; label?: string; cmdStart: number; rawStart: number }[] = [];
  for (const at of texCommandPositions(body, "bibitem")) {
    let i = skipTexWhitespace(body, at);
    let label: string | undefined;
    if (body[i] === "[") {
      const close = body.indexOf("]", i);
      if (close === -1) continue;
      const inner = body.slice(i + 1, close).trim();
      if (inner !== "") label = inner;
      i = skipTexWhitespace(body, close + 1);
    }
    const key = readTexGroup(body, i);
    if (!key) continue;
    const item: { key: string; label?: string; cmdStart: number; rawStart: number } = {
      key: key.content,
      cmdStart: at - "\\bibitem".length,
      rawStart: key.end,
    };
    if (label !== undefined) item.label = label;
    items.push(item);
  }

  const references = items.map((item, n) => {
    const next = items[n + 1];
    const rawEnd = next !== undefined ? next.cmdStart : body.length;
    const raw = body.slice(item.rawStart, rawEnd).trim();
    const ref: TexReferenceFact = { key: item.key, raw };
    if (item.label !== undefined) ref.label = item.label;
    const doi = extractDoi(raw);
    const arxiv = extractArxiv(raw);
    const url = extractUrl(raw);
    if (doi !== undefined) ref.doi = doi;
    if (arxiv !== undefined) ref.arxiv = arxiv;
    if (url !== undefined) ref.url = url;
    return ref;
  });
  return { references, warnings: [] };
}
