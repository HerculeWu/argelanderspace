/**
 * `.argelander.jsonl` event stream parser (Stage 5 Q10/Q11).
 *
 * The instrumentation package (`argelander.sty`, packages/infra/src/tex)
 * writes one JSON object per line for every citation / label / section /
 * printed display-math number it observes at compile time:
 *
 *   {"type":"citation","id":"cite-000001","keys":["a","b"],"file":"main.tex","line":12,"page":"1"}
 *   {"type":"label","id":"label-000001","key":"sec:x","file":"main.tex","line":13,"page":"1"}
 *   {"type":"section","id":"section-000001","name":"section","number":"1","title":"Intro",...}
 *   {"type":"mathnum","id":"math-000001","env":"equation","number":"1","file":"main.tex",...}
 *
 * The parser is tolerant by contract and NEVER throws:
 *  - malformed lines, unknown types and missing fields are skipped, and a
 *    single counted warning summarizes the skips;
 *  - mathnum events whose captured number contains a control sequence
 *    (backslash) are dropped with a separate counted warning — those are
 *    bogus events from \eqref-in-display or macro-laden \tag values that
 *    passed the .sty's environment whitelist (see the .sty's KNOWN LIMITS);
 *  - event ids may show GAPS after such filtering: ids are assigned at
 *    TeX-event time, including to events the parser later drops and to
 *    whatsits inside throwaway typesetting boxes that never ship —
 *    consumers must not assume per-family id contiguity.
 *
 * `file` is the .sty's \CurrentFile value: reliable for the master file
 * and \input/\include children; stale (the master file's name) for events
 * fired while generated files (.toc/.lof/...) are typeset — e.g. the
 * duplicate citation event a \cite in a \caption produces when
 * \listoffigures re-typesets it.
 */

interface TexEventBase {
  /** Stable per-family id (`cite-000001`, zero-padded to 6 digits). */
  id: string;
  /**
   * Source file the event was read from (`\CurrentFile`; absent in
   * pre-file-field streams). See the module docstring for the
   * generated-file staleness caveat.
   */
  file?: string;
  /** `\inputlineno` at event time (amsmath multi-row envs report their end line). */
  line: number;
  /** `\thepage` resolved at shipout. */
  page: string;
}

export interface TexCitationEvent extends TexEventBase {
  type: "citation";
  keys: string[];
}

export interface TexLabelEvent extends TexEventBase {
  type: "label";
  key: string;
}

export interface TexSectionEvent extends TexEventBase {
  type: "section";
  /** sectioning unit: section / subsection. */
  name: string;
  /** Printed number, e.g. "2.3" ("" when unnumbered slips through). */
  number: string;
  title: string;
}

export interface TexMathnumEvent extends TexEventBase {
  type: "mathnum";
  /** Environment whose number was printed (equation/align/gather/...). */
  env: string;
  /**
   * True printed value: `\theequation` at print time, or the literal
   * `\tag{...}` text (tags do not advance the counter). Events whose
   * captured number contains a control sequence (unresolved macros) are
   * dropped by the parser.
   */
  number: string;
}

export type TexEvent = TexCitationEvent | TexLabelEvent | TexSectionEvent | TexMathnumEvent;

export interface TexEventStream {
  events: TexEvent[];
  warnings: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseBase(v: Record<string, unknown>): TexEventBase | null {
  const { id, line, page, file } = v;
  if (typeof id !== "string" || id === "") return null;
  if (typeof line !== "number" || !Number.isFinite(line)) return null;
  if (typeof page !== "string") return null;
  // A non-string `file` is dropped, not fatal to the event.
  const base: TexEventBase = { id, line, page };
  if (typeof file === "string" && file !== "") base.file = file;
  return base;
}

function parseLine(value: unknown): TexEvent | null {
  if (!isRecord(value)) return null;
  const base = parseBase(value);
  if (base === null) return null;
  switch (value.type) {
    case "citation": {
      if (!isStringList(value.keys)) return null;
      return { ...base, type: "citation", keys: value.keys };
    }
    case "label": {
      if (typeof value.key !== "string") return null;
      return { ...base, type: "label", key: value.key };
    }
    case "section": {
      const { name, number, title } = value;
      if (typeof name !== "string" || typeof number !== "string" || typeof title !== "string") {
        return null;
      }
      return { ...base, type: "section", name, number, title };
    }
    case "mathnum": {
      const { env, number } = value;
      if (typeof env !== "string" || typeof number !== "string") return null;
      return { ...base, type: "mathnum", env, number };
    }
    default:
      return null;
  }
}

/**
 * A printed math number is digits/letters/punctuation; a number containing
 * a backslash is an unexpanded macro (\eqref-in-display or a macro-laden
 * \tag) — a bogus capture, not a printed value.
 */
function isMacroNumber(number: string): boolean {
  return number.includes("\\");
}

export function parseTexEvents(content: string): TexEventStream {
  const events: TexEvent[] = [];
  let skipped = 0;
  let droppedMacroMath = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }
    const event = parseLine(parsed);
    if (event === null) {
      skipped++;
      continue;
    }
    if (event.type === "mathnum" && isMacroNumber(event.number)) {
      droppedMacroMath++;
      continue;
    }
    events.push(event);
  }
  const warnings: string[] = [];
  if (skipped > 0) {
    warnings.push(`skipped ${skipped} malformed event line(s) in the .argelander.jsonl stream`);
  }
  if (droppedMacroMath > 0) {
    warnings.push(
      `dropped ${droppedMacroMath} mathnum event(s) whose captured number is an unexpanded ` +
        "macro (\\eqref in a display or a macro-laden \\tag); ids in the parsed stream " +
        "may be non-contiguous"
    );
  }
  return { events, warnings };
}
