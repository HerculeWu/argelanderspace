/** Opt-in citation projection from natbib's compiled labels AND effective style.
 * The legacy reader formatter is deliberately untouched. No author-name guessing
 * or browser-side bibliography numbering occurs on this path.
 */

import type { TexFacts } from "../facts/index.js";
import { readTexGroups, texCommandPositions } from "../facts/scan.js";

export interface CitationCall {
  command: string;
  keys: string[];
  star: boolean;
  notes: string[];
  aliases: ReadonlyMap<string, string>;
}
export type CitationFormatter = (call: CitationCall) => string;

interface CompiledLabel {
  number: string;
  year: string;
  short: string;
  full: string;
}

export function compiledCitationFormatter(
  facts: TexFacts,
  styleText: string,
  plain: (tex: string) => string
): CitationFormatter {
  const at = [...texCommandPositions(styleText, "argelandercitestyle")][0];
  const fields = at === undefined ? null : readTexGroups(styleText, at, 11);
  if (!fields)
    throw new Error(
      "compiled citation style is unavailable; preview cannot claim template fidelity"
    );
  const value = (i: number) => plain(fields[i]?.content ?? "").trim();
  const mode = value(0);
  const numeric = mode === "numbers" || mode === "numeric";
  if (!numeric && mode !== "authoryear") throw new Error(`unsupported citation mode: ${mode}`);
  if (value(9) === "1" || value(10) === "1") {
    throw new Error(
      "citation preview does not yet support natbib longnamesfirst or superscript mode"
    );
  }
  const open = value(1),
    close = value(2),
    sep = value(3),
    aysep = value(4),
    yrsep = value(5),
    cmt = value(6);
  const sort = value(7) === "1",
    compress = value(8) === "1";
  const labels = new Map<string, CompiledLabel>();
  for (const [key, raw] of Object.entries(facts.bibcites)) {
    const parts = readTexGroups(raw, 0, 4);
    if (parts) {
      const text = (i: number) => plain(parts[i]?.content ?? "").trim();
      labels.set(key, { number: text(0), year: text(1), short: text(2), full: text(3) || text(2) });
    } else {
      labels.set(key, { number: plain(raw), year: "", short: "?", full: "?" });
    }
  }
  const wrapped = (s: string) => `${open}${s}${close}`;
  const noteSpace = /(?:\s|~|\\ )$/.test(fields[6]?.content ?? "") ? " " : "";
  const note = (s: string) => (s ? `${cmt}${noteSpace}${s}` : "");
  const joined = (values: string[]) => values.join(`${sep} `);
  const numbers = (rows: CompiledLabel[]): string => {
    if (!compress) return joined(rows.map((r) => r.number));
    const parts: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const first = rows[i]?.number ?? "?";
      let end = i;
      while (
        /^\d+$/.test(first) &&
        end + 1 < rows.length &&
        Number(rows[end + 1]?.number) === Number(rows[end]?.number) + 1
      )
        end++;
      if (end - i >= 2) parts.push(`${first}–${rows[end]?.number}`);
      else for (let j = i; j <= end; j++) parts.push(rows[j]?.number ?? "?");
      i = end;
    }
    return joined(parts);
  };
  return ({ command, keys, star, notes, aliases }) => {
    const pre = notes.length > 1 ? (notes[0] ?? "") : "";
    const post = notes.length > 1 ? (notes[1] ?? "") : (notes[0] ?? "");
    let rows = keys.map(
      (key) => labels.get(key) ?? { number: "?", year: "?", short: "?", full: "?" }
    );
    if (sort) rows = [...rows].sort((a, b) => Number(a.number) - Number(b.number));
    const author = (r: CompiledLabel) => (star ? r.full : r.short);
    if (command === "citepalias" || command === "citetalias") {
      const body = joined(keys.map((k) => aliases.get(k) ?? "?"));
      return command === "citepalias" ? wrapped(body) : body;
    }
    if (command === "citeauthor") return joined(rows.map(author));
    if (command === "citeyear" || command === "citeyearpar") {
      const years = joined(rows.map((r) => r.year));
      return command === "citeyearpar"
        ? wrapped(`${pre ? `${pre} ` : ""}${years}${note(post)}`)
        : years;
    }
    if (command === "citenum") return numbers(rows);
    const textual =
      command === "citet" ||
      command === "citealt" ||
      command === "citeonline" ||
      (command === "cite" && !numeric && notes.length === 0);
    const bare = command === "citealt" || command === "citealp" || command === "citeonline";
    if (numeric && !textual) {
      const body = `${pre ? `${pre} ` : ""}${numbers(rows)}${note(post)}`;
      return bare ? body : wrapped(body);
    }
    // natbib groups adjacent equal author lists, and contracts repeated year
    // suffixes (2020a,b). The strings come from bibcite, not parsed surnames.
    const groups: { author: string; values: string[] }[] = [];
    for (const row of rows) {
      const name = author(row);
      const year = numeric ? row.number : row.year;
      const prev = groups[groups.length - 1];
      if (prev?.author === name) prev.values.push(year);
      else groups.push({ author: name, values: [year] });
    }
    const groupTexts = groups.map((g, i) => {
      const years = g.values
        .map((year, n) => {
          if (n === 0) return year;
          const prev = g.values[n - 1];
          return !numeric &&
            prev &&
            /\d[a-z]$/.test(year) &&
            year.slice(0, -1) === prev.slice(0, -1)
            ? `${yrsep}${year.slice(-1)}`
            : `${yrsep} ${numeric && textual && pre ? `${pre} ` : ""}${year}`;
        })
        .join("");
      if (textual) {
        const body = `${pre ? `${pre} ` : ""}${years}${i === groups.length - 1 ? note(post) : ""}`;
        return `${g.author} ${bare ? body : wrapped(body)}`;
      }
      return `${g.author}${aysep} ${years}`;
    });
    const body = joined(groupTexts);
    return textual
      ? body
      : bare
        ? `${pre ? `${pre} ` : ""}${body}${note(post)}`
        : wrapped(`${pre ? `${pre} ` : ""}${body}${note(post)}`);
  };
}
