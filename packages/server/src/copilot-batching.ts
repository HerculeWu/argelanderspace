/**
 * Context batching for the Copilot (ticket 24, spec §7.2): a Reader reading or a PDF's material that does not fit the
 * room left in the model's window is delivered in parts, every part carrying its range, the total and the source
 * version; nothing is cut silently, a version already delivered whole is not repeated, and what could not be
 * delivered is said so in the message itself (never "the whole document" by omission).
 *
 * Pure functions over the message envelope and the reading; the host (`copilot.ts`) owns the window arithmetic and the
 * history, the `reader` tool owns the `read` call. One unit is one Reader entry or one PDF page: a part always holds
 * whole units, so an entry or a page is never split.
 */
import {
  type ContextCoverage,
  type CopilotPrompt,
  PDF_NO_IMAGE_NOTICE,
  type PdfMaterialEnvelope,
  type PdfReading,
  type ReaderReading,
  type ReadingLedger,
  readingVersion,
} from "@argelanderspace/contracts";

/** What `text` costs once it is held in the history as one JSON string (its quotes and escapes count). */
export const historyCost = (text: string): number => Buffer.byteLength(JSON.stringify(text));

/** Slack for the record that travels with a tool result (its operation details) and the host's own entries. */
export const RESULT_OVERHEAD_BYTES = 1536;

/**
 * The largest `k` in `[min, total]` whose cost fits `room`; `cost` is non-decreasing in `k`. -1 when even `min` does not.
 */
export function largestFit(
  min: number,
  total: number,
  cost: (k: number) => number,
  room: number
): number {
  if (min > total || cost(min) > room) return -1;
  let low = min;
  let high = total;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (cost(mid) <= room) low = mid;
    else high = mid - 1;
  }
  return low;
}

interface Source {
  kind: "reader" | "pdf";
  docId: string;
  version: string;
  unit: "entries" | "pages";
  total: number;
}
export const readerVersion = (reading: ReaderReading): string =>
  readingVersion(reading.epoch.fingerprint, reading.epoch.annotationsRev);
export const pdfVersion = (reading: PdfReading): string =>
  readingVersion(reading.sha256, reading.annotationsRev);
const readerSource = (reading: ReaderReading): Source => ({
  kind: "reader",
  docId: reading.docId,
  version: readingVersion(reading.epoch.fingerprint, reading.epoch.annotationsRev),
  unit: "entries",
  total: reading.entries.length,
});
const pdfSource = (reading: PdfReading): Source => ({
  kind: "pdf",
  docId: reading.docId,
  version: readingVersion(reading.sha256, reading.annotationsRev),
  unit: "pages",
  total: reading.pages.length,
});

const unitWord = (source: Source) => (source.unit === "entries" ? "entries" : "pages");
const coverageOf = (
  source: Source,
  from: number,
  to: number,
  head: boolean,
  status: ContextCoverage["status"],
  note: string,
  heldIn?: string
): ContextCoverage => ({
  kind: source.kind,
  docId: source.docId,
  version: source.version,
  unit: source.unit,
  total: source.total,
  from,
  to,
  head,
  status,
  ...(heldIn ? { heldIn } : {}),
  note,
});

const partialNote = (source: Source, to: number) =>
  `PART OF THE DOCUMENT ONLY: ${unitWord(source)} [0, ${to}) of ${source.total} are in this message (zero-based, ${source.unit === "pages" ? "pageIndex" : "reading order"}); ${source.total - to} ${unitWord(source)} are NOT read. Read the rest with reader read {docId, from: ${to}, version: "${source.version}"} (repeat with the next from and the same version until the result says complete; a version_changed conflict means the document changed: start again at from 0); until then you have not read the whole document and must not say so`;

type Context = CopilotPrompt["context"];
/** The message with its reading replaced by `reading` (null: left out, with the totals and a note). */
function withReader(
  prompt: CopilotPrompt,
  reading: ReaderReading,
  entries: number | "omitted",
  coverage: ContextCoverage
): CopilotPrompt {
  const reader = prompt.context.reader;
  if (!reader) return prompt;
  const { reading: _whole, readingOmitted: _omitted, readingRef: _ref, ...rest } = reader;
  const next =
    entries === "omitted"
      ? {
          ...rest,
          reading: null,
          readingOmitted: {
            fingerprint: reading.epoch.fingerprint,
            annotationsRev: reading.epoch.annotationsRev,
            coverage: reading.coverage,
            note: coverage.note,
          },
        }
      : { ...rest, reading: { ...reading, entries: reading.entries.slice(0, entries) } };
  return {
    ...prompt,
    context: { ...prompt.context, reader: next } as unknown as Context,
    coverage,
  };
}
function withPdf(
  prompt: CopilotPrompt,
  reading: PdfReading,
  pages: number | "omitted" | "held",
  coverage: ContextCoverage
): CopilotPrompt {
  const material: PdfMaterialEnvelope =
    pages === "omitted" || pages === "held"
      ? {
          status: pages,
          detail:
            !reading.images.modelAcceptsImages && reading.imageOnlyPages.length > 0
              ? `${coverage.note}. ${PDF_NO_IMAGE_NOTICE}`
              : coverage.note,
          modelAcceptsImages: reading.images.modelAcceptsImages,
          coverage: {
            pages: reading.coverage.pages,
            pagesWithText: reading.coverage.pagesWithText,
            pagesWithoutText: reading.coverage.pagesWithoutText,
            characters: reading.coverage.characters,
          },
        }
      : { status: "ok", reading: { ...reading, pages: reading.pages.slice(0, pages) } };
  return { ...prompt, pdf: material, coverage };
}

export interface FittedEnvelope {
  prompt: CopilotPrompt;
  /** Why a reading was not delivered whole: `room` (the window), `present` (parts of it are already in the conversation). */
  reason?: "room" | "present";
  /** Absent when the page carries neither a Reader reading nor a PDF material. */
  coverage?: ContextCoverage;
}

/**
 * The envelope for `prompt` within `room` bytes (as the history will hold it). In order: this exact version was
 * already delivered whole (`held`: not repeated); everything fits (`complete`); the largest prefix of whole units
 * that fits (`partial`); nothing of the reading fits, so it is left out with its totals (`omitted`). Returns null
 * only when even the smallest form does not fit, which is a real capacity failure.
 */
export function fitEnvelope(
  prompt: CopilotPrompt,
  room: number,
  ledger: ReadingLedger,
  hardRoom: number = room,
  forceOmit?: string,
  ceiling?: number
): FittedEnvelope | null {
  const whole = fitReading(prompt, room, ledger, hardRoom, forceOmit, ceiling);
  const text = (prompt.context as { textSource?: { markdown: string | null } | null }).textSource;
  if (!text || text.markdown === null) return whole;
  // A text Doc's page carries the editor's source beside the reading. It never decides the fate of the message: when
  // the reading (or the page alone) does not fit with it, the source goes first, with a note that names where to read it.
  const delivered = whole?.coverage?.status;
  if (whole && (delivered === "complete" || delivered === "held") && !whole.reason) return whole;
  if (whole && !prompt.context.reader?.reading && !whole.coverage) return whole;
  const thin: CopilotPrompt = {
    ...prompt,
    context: {
      ...prompt.context,
      textSource: {
        ...text,
        markdown: null,
        omitted: `the source (${(text as { characters?: number }).characters ?? "?"} characters) is NOT in this message: it did not fit the room left in the model's window; read it with text read_source (from 0, then the next from while it says partial) and never answer as if you had read it`,
      },
    } as unknown as CopilotPrompt["context"],
  };
  const lean = fitReading(thin, room, ledger, hardRoom, forceOmit, ceiling);
  if (!lean) return whole;
  if (!whole) return lean;
  // both fit in some form: the one that delivers more of the reading
  return (lean.coverage?.to ?? 0) > (whole.coverage?.to ?? 0) ||
    lean.coverage?.status === "complete"
    ? lean
    : whole;
}

function fitReading(
  prompt: CopilotPrompt,
  room: number,
  ledger: ReadingLedger,
  /** The most the history can hold at all: the held and the left-out forms, which are small, may use it up to here. */
  hardRoom: number = room,
  forceOmit?: string,
  /** The most bytes of reading one delivery may add (learned from a provider rejection); absent: no cap. */
  ceiling?: number
): FittedEnvelope | null {
  const reader = prompt.context.reader?.reading ?? undefined;
  const pdf = prompt.pdf?.status === "ok" ? prompt.pdf.reading : undefined;
  if (!reader && !pdf) {
    const text = JSON.stringify(prompt);
    return historyCost(text) <= hardRoom ? { prompt } : null;
  }
  const raw = reader ? readerSource(reader) : pdfSource(pdf as PdfReading);
  // A prompt that is itself a part keeps the document's own total, never the length of its slice.
  const source: Source = { ...raw, total: prompt.coverage?.total ?? raw.total };
  const cost = (candidate: CopilotPrompt) => historyCost(JSON.stringify(candidate));
  const build = (units: number | "omitted" | "held", coverage: ContextCoverage): CopilotPrompt =>
    reader
      ? withReader(prompt, reader, units === "held" ? "omitted" : units, coverage)
      : withPdf(prompt, pdf as PdfReading, units, coverage);
  const omittedNote = (reason: string) =>
    `NOT IN THIS MESSAGE: ${reason}. The ${source.kind === "pdf" ? "PDF's pages" : "reading"} (${source.total} ${unitWord(source)}) is NOT in the conversation now; fetch it with reader read {docId} (from: 0, then the next from while it says remaining), and never answer as if you had read it`;
  const omit = (reason: string, why: "room" | "present" = "room"): FittedEnvelope | null => {
    const coverage = coverageOf(source, 0, 0, false, "omitted", omittedNote(reason));
    const candidate = build("omitted", coverage);
    return cost(candidate) <= hardRoom ? { prompt: candidate, coverage, reason: why } : null;
  };
  if (forceOmit) return omit(forceOmit);
  if (ledger.complete(source.kind, source.docId, source.version)) {
    const heldIn = ledger.heldIn(source.kind, source.docId, source.version);
    const note = `NOT REPEATED: this exact ${source.kind === "pdf" ? "PDF material" : "reading"} (same content and annotations revision) was already delivered whole earlier in this conversation${heldIn ? ` (message ${heldIn})` : ""} and is in it now; read it there. reader read returns the current one`;
    const coverage = coverageOf(source, 0, source.total, true, "held", note, heldIn);
    const candidate = build("held", coverage);
    if (cost(candidate) <= hardRoom) return { prompt: candidate, coverage };
    return omit(
      "the page's material cannot be repeated and does not fit the room left in the model's window"
    );
  }
  const present = ledger.ranges(source.kind, source.docId, source.version);
  if (present.length > 0) {
    const missing: [number, number][] = [];
    let at = 0;
    for (const [a, b] of present) {
      if (a > at) missing.push([at, a]);
      at = Math.max(at, b);
    }
    if (at < source.total) missing.push([at, source.total]);
    const list = (ranges: [number, number][]) => ranges.map(([a, b]) => `[${a}, ${b})`).join(", ");
    const coverage = coverageOf(
      source,
      0,
      0,
      false,
      "omitted",
      `NOT IN THIS MESSAGE: ${unitWord(source)} ${list(present)} of ${source.total} of this very version are already in the conversation, so they are not delivered again; ${unitWord(source)} ${list(missing)} are NOT in the conversation: read them with reader read {docId, from, version: "${source.version}"}, and never answer as if you had read the whole document`
    );
    const candidate = build("omitted", coverage);
    return cost(candidate) <= hardRoom ? { prompt: candidate, coverage, reason: "present" } : null;
  }
  // The most one delivery may add (a provider rejection taught the ceiling), on top of the form without the reading.
  const base = omit("it does not fit the room left in the model's window");
  const limit = ceiling === undefined || !base ? room : Math.min(room, cost(base.prompt) + ceiling);
  const completeNote = "the whole document is in this message";
  const whole = coverageOf(source, 0, source.total, true, "complete", completeNote);
  const wholeCandidate = build(source.total, whole);
  if (cost(wholeCandidate) <= limit) return { prompt: wholeCandidate, coverage: whole };
  const partialCost = (k: number) =>
    cost(build(k, coverageOf(source, 0, k, true, "partial", partialNote(source, k))));
  const k = largestFit(1, source.total, partialCost, limit);
  if (k >= 1) {
    const coverage = coverageOf(source, 0, k, true, "partial", partialNote(source, k));
    return { prompt: build(k, coverage), coverage, reason: "room" };
  }
  return omit("it does not fit the room left in the model's window");
}

/**
 * A `held` message whose earlier delivery has since left the conversation: the same message, restated so that it no
 * longer says the reading is in the conversation (it is not).
 */
export function restateGone(prompt: CopilotPrompt, reason: string): CopilotPrompt {
  const held = prompt.coverage;
  if (held?.status !== "held") return prompt;
  const note = `NOT REPEATED HERE, AND NOT TO BE RELIED ON: ${reason}. The ${held.kind === "pdf" ? "PDF's pages" : "reading"} (${held.total} ${held.unit}) is in the conversation only if a later message carries it; otherwise it is NOT, and you fetch it with reader read {docId} (from: 0): never answer as if you had read it`;
  const coverage: ContextCoverage = {
    ...held,
    status: "omitted",
    from: 0,
    to: 0,
    head: false,
    note,
  };
  const reader = prompt.context.reader;
  const next: CopilotPrompt = {
    ...prompt,
    coverage,
    ...(reader?.readingOmitted
      ? {
          context: {
            ...prompt.context,
            reader: { ...reader, readingOmitted: { ...reader.readingOmitted, note } },
          },
        }
      : {}),
  };
  if (prompt.pdf?.status === "held")
    return { ...next, pdf: { ...prompt.pdf, status: "omitted", detail: note } };
  return next;
}

// ---- The `reader read` tool ------------------------------------------------------------------------- //

export type BatchOutcome =
  | { kind: "ok"; payload: object; coverage: ContextCoverage }
  | { kind: "gap"; coverage: ContextCoverage; detail: string };

const unitId = (unit: unknown, index: number): string => {
  const id = (unit as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : `#${index}`;
};

function batch<T>(args: {
  source: Source;
  from: number;
  room: number;
  units: readonly T[];
  payload: (from: number, k: number, coverage: ContextCoverage) => object;
  describe: (index: number) => string;
}): BatchOutcome {
  const { source, from, room, units } = args;
  const note = (to: number) =>
    to - from === 0
      ? "nothing"
      : to >= source.total && from === 0
        ? "the whole document is in this result"
        : to >= source.total
          ? `the rest of the document: ${unitWord(source)} [${from}, ${to}) of ${source.total} are in this result and nothing remains`
          : `PART OF THE DOCUMENT ONLY: ${unitWord(source)} [${from}, ${to}) of ${source.total} are in this result; ${source.total - to} are NOT read. Call reader read {docId, from: ${to}, version: "${source.version}"} for the next part, until the result says complete; until then you have not read the whole document and must not say so`;
  const coverageFor = (k: number) => {
    const to = from + k;
    const head = from === 0;
    // `complete` here means nothing remains after this part (a continuation that reaches the end says so too).
    const status: ContextCoverage["status"] = to >= source.total ? "complete" : "partial";
    return coverageOf(source, from, to, head, status, note(to));
  };
  const cost = (k: number) =>
    historyCost(JSON.stringify(args.payload(from, k, coverageFor(k)))) + RESULT_OVERHEAD_BYTES;
  const min = source.total === 0 ? 0 : 1;
  const k = largestFit(min, units.length - from, cost, room);
  if (k >= 0) {
    const coverage = coverageFor(k);
    return { kind: "ok", payload: args.payload(from, k, coverage), coverage };
  }
  const first = cost(min);
  const gapId = args.describe(from);
  const headOnly = from === 0 && source.total > 0 ? cost(0) : 0;
  const detail =
    headOnly > room
      ? `capacity: the part of this ${source.kind === "pdf" ? "PDF" : "reading"} that is not a list of ${unitWord(source)} (${source.kind === "pdf" ? "outline and workbench annotations" : "metadata, bibliography and annotations"}) alone needs ${headOnly} bytes, more than the ${Math.max(0, room)} bytes left in this model's window; the smallest part that can be read does not fit, so nothing was returned and none of it was read`
      : `capacity: the next unit, ${args.source.unit === "entries" ? "entry " : ""}${args.describe(from)}, needs ${first} bytes (${source.kind === "pdf" ? "its text and the result's record" : "with the result's record"}), more than the ${Math.max(0, room)} bytes left in this model's window; it is the smallest part that can be read, so nothing was returned and ${unitWord(source)} [${from}, ${source.total}) are NOT read`;
  return {
    kind: "gap",
    coverage: {
      ...coverageOf(source, from, from, false, "omitted", detail),
      gap: { id: gapId, bytes: headOnly > room ? headOnly : first },
    },
    detail,
  };
}

export function readerBatch(
  reading: ReaderReading,
  from: number,
  room: number,
  observed: string
): BatchOutcome {
  const source = readerSource(reading);
  return batch({
    source,
    from,
    room,
    units: reading.entries,
    describe: (index) => unitId(reading.entries[index], index),
    payload: (start, k, coverage) =>
      start === 0
        ? {
            ok: true,
            status: "ok",
            observed,
            reading: { ...reading, entries: reading.entries.slice(0, k) },
            batch: coverage,
          }
        : {
            ok: true,
            status: "ok",
            observed,
            docId: reading.docId,
            epoch: reading.epoch,
            entries: reading.entries.slice(start, start + k),
            batch: coverage,
          },
  });
}

export function pdfBatch(
  reading: PdfReading,
  from: number,
  room: number,
  observed: string
): BatchOutcome {
  const source = pdfSource(reading);
  return batch({
    source,
    from,
    room,
    units: reading.pages,
    describe: (index) => `page ${reading.pages[index]?.pageIndex ?? index}`,
    payload: (start, k, coverage) =>
      start === 0
        ? {
            ok: true,
            status: "ok",
            observed,
            reading: { ...reading, pages: reading.pages.slice(0, k) },
            batch: coverage,
          }
        : {
            ok: true,
            status: "ok",
            observed,
            docId: reading.docId,
            sha256: reading.sha256,
            pages: reading.pages.slice(start, start + k),
            batch: coverage,
          },
  });
}
