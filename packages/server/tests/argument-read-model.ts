/**
 * A model that does ONLY what the tool's words tell it (argument graph ticket 09, review round B): it asks for the first
 * part, then for each further part exactly as the result's `note` says, and reads a cut text as `batch.clipped` and the
 * field note say. It never carries a position the note did not give. A tool whose notes lead such a model to reread a
 * list, to loop, or to stop early fails here; a tool that makes that model assemble the stored graph exactly, in every
 * room, passes.
 */
import { argumentReadLimit } from "@argelanderspace/contracts";
import { historyCost, RESULT_OVERHEAD_BYTES } from "../src/copilot-batching.js";

// biome-ignore lint/suspicious/noExplicitAny: the model reads untyped JSON
export type Loose = Record<string, any>;
export type Caller = (params: Loose) => Promise<string>;

export interface ModelReport {
  ok: boolean;
  problems: string[];
  calls: number;
  fieldCalls: number;
  /** Calls that were made while something remained but delivered nothing new. */
  emptyCalls: number;
  /** Positions or texts delivered twice. */
  repeats: number;
  gap?: { bytes: number; detail: string };
  maxCost: number;
  limit: number;
  got: { arguments: Loose[]; edges: Loose[]; notFound: string[] };
}

const TOP =
  /^Part of the graph is NOT read yet: call read again with (.+?)(?: \((?:the edges|the arguments) are complete: [^)]*\))?, until batch and edgesBatch both say complete before you rely on the whole\./;
const FIELD_MORE =
  /^Part of this text is NOT read yet: call read again with the same ids, the same field and offset = (\d+)\. /;

/** The model's whole walk over one graph, in one room (undefined: no room limit), whole graph or `ids`. */
export async function walk(
  call: Caller,
  workId: string,
  room: number | undefined,
  ids: string[] | undefined,
  maxCalls = 20_000
): Promise<ModelReport> {
  const limit = argumentReadLimit(room);
  const rep: ModelReport = {
    ok: true,
    problems: [],
    calls: 0,
    fieldCalls: 0,
    emptyCalls: 0,
    repeats: 0,
    maxCost: 0,
    limit,
    got: { arguments: [], edges: [], notFound: [] },
  };
  const bad = (message: string) => {
    rep.ok = false;
    if (rep.problems.length < 12) rep.problems.push(message);
  };
  const argsAt = new Map<number, Loose>();
  const edgesAt = new Map<number, Loose>();
  const cutDone = new Set<string>();
  const seenCalls = new Set<string>();

  const send = async (params: Loose, kind: "top" | "field"): Promise<Loose | null> => {
    const key = JSON.stringify(params);
    if (seenCalls.has(key)) {
      rep.repeats++;
      bad(`the same call twice: ${key.slice(0, 160)}`);
      return null;
    }
    seenCalls.add(key);
    rep.calls++;
    if (kind === "field") rep.fieldCalls++;
    const text = await call(params);
    const cost = historyCost(text) + RESULT_OVERHEAD_BYTES;
    rep.maxCost = Math.max(rep.maxCost, cost);
    if (room !== undefined && cost > room) bad(`result needs ${cost} bytes, room is ${room}`);
    const result = JSON.parse(text) as Loose;
    if (result.status === "rejected" && /^capacity/.test(String(result.detail))) {
      rep.gap = { bytes: result.gap?.bytes, detail: result.detail };
      return null;
    }
    if (result.status !== "ok") {
      bad(`status ${result.status} (${result.detail}) for ${key.slice(0, 160)}`);
      return null;
    }
    return result;
  };

  const readField = async (id: string, field: string, offset: number) => {
    let text = "";
    let target: unknown;
    let at = offset;
    for (;;) {
      if (rep.calls > maxCalls) {
        bad("too many calls");
        return null;
      }
      const result = await send({ action: "read", workId, ids: [id], field, offset: at }, "field");
      if (!result) return null;
      const f = result.field as Loose;
      if (f.from !== at) bad(`field.from ${f.from} is not the asked ${at}`);
      if (f.text.length !== f.to - f.from) bad("field text length differs from to - from");
      text += f.text;
      target = f.target;
      if (f.status === "complete") {
        if (!String(result.note).startsWith("This text is complete. ")) bad("odd complete note");
        return { text, target };
      }
      const next = FIELD_MORE.exec(String(result.note));
      if (!next) {
        bad(`partial field without the continuation note: ${String(result.note).slice(0, 160)}`);
        return null;
      }
      if (Number(next[1]) !== f.to || f.to <= at) {
        bad(`field continuation ${next[1]} (to ${f.to}, asked ${at})`);
        return null;
      }
      at = f.to;
    }
  };

  let params: Loose = { action: "read", workId, ...(ids ? { ids } : {}) };
  for (;;) {
    if (rep.calls > maxCalls) {
      bad(`no end after ${maxCalls} calls`);
      break;
    }
    const result = await send(params, "top");
    if (!result) break;
    const b = result.batch as Loose;
    const eb = result.edgesBatch as Loose;
    const note = String(result.note);
    let fresh = 0;
    const uniq = ids ? [...new Set(ids)] : undefined;
    if (result.arguments.length + (result.notFound?.length ?? 0) !== b.to - b.from)
      bad(
        `batch [${b.from},${b.to}) holds ${result.arguments.length} + ${result.notFound?.length ?? 0}`
      );
    if (result.edges.length !== eb.to - eb.from) bad("edgesBatch does not hold its range");
    for (let p = b.from; p < b.to; p++) {
      let item: Loose | undefined;
      if (uniq) {
        const id = uniq[p] as string;
        const found = (result.arguments as Loose[]).find((a) => a.id === id);
        if (found) item = { arg: found };
        else if ((result.notFound ?? []).includes(id)) item = { missing: id };
        else bad(`position ${p} is neither an argument nor notFound`);
      } else item = { arg: result.arguments[p - b.from] };
      if (!item) continue;
      if (argsAt.has(p)) rep.repeats++;
      else {
        argsAt.set(p, item);
        fresh++;
      }
    }
    for (let i = eb.from; i < eb.to; i++) {
      if (edgesAt.has(i)) rep.repeats++;
      else {
        edgesAt.set(i, result.edges[i - eb.from]);
        fresh++;
      }
    }
    // A cut argument comes alone; the model reads what batch.clipped says is missing.
    const clipped = (b.clipped ?? []) as Loose[];
    if (clipped.length) {
      const first = clipped[0] as Loose;
      const target = (result.arguments as Loose[]).find((a) => a.id === first.id) as Loose;
      if (!target || result.arguments.length !== 1) bad("the cut argument is not alone");
      if (!/batch\.clipped/.test(note)) bad("clipped without a note that points at batch.clipped");
      if (/The whole graph\.|, whole\./.test(note)) bad("a cut result claims to be whole");
      if (target && !cutDone.has(first.id)) {
        cutDone.add(first.id);
        for (const clip of clipped.filter((c) => c.field !== "sources")) {
          const src = /^sources\.(\d+)$/.exec(clip.field);
          const index = src ? Number(src[1]) : -1;
          const shownText = (src ? target.sources[index].text : target[clip.field]) as string;
          if (shownText.length !== clip.shown)
            bad(`clip shown ${clip.shown} but ${shownText.length} delivered`);
          // the page spells a source text `sources.N.text`: the tool takes it as well; the model uses it for odd N
          const name = src && index % 2 === 1 ? `sources.${index}.text` : clip.field;
          const rest = await readField(clip.id, name, clip.shown);
          if (!rest) return finish(rep, argsAt, edgesAt);
          fresh += rest.text.length;
          const full = shownText + rest.text;
          if (full.length !== clip.chars)
            bad(`${clip.field} reread to ${full.length}, clip says ${clip.chars}`);
          if (src) target.sources[index] = { ...target.sources[index], text: full };
          else target[clip.field] = full;
        }
        const left = clipped.find((c) => c.field === "sources");
        if (left) {
          if (target.sources.length !== left.shown) bad("sources delivered differ from clip.shown");
          for (let n = left.shown; n < left.chars; n++) {
            const got = await readField(left.id, `sources.${n}`, 0);
            if (!got) return finish(rep, argsAt, edgesAt);
            fresh += got.text.length + 1;
            target.sources.push({ text: got.text, ...(got.target ? { target: got.target } : {}) });
          }
        }
      }
    }
    const partial = b.status === "partial" || eb.status === "partial";
    if (fresh === 0 && partial) {
      rep.emptyCalls++;
      bad("a call with something left delivered nothing new");
    }
    const m = TOP.exec(note);
    if (!partial) {
      if (m) bad("a continuation note on a complete result");
      const first = (params.offset ?? 0) === 0 && (params.edgeOffset ?? 0) === 0;
      const hasCut = clipped.length > 0;
      if (
        !hasCut &&
        first &&
        !/^(The whole graph\.|These arguments, and every edge that touches them, whole\.)/.test(
          note
        )
      )
        bad(`first complete note: ${note.slice(0, 120)}`);
      if (!hasCut && !first && !note.startsWith("This was the last part: nothing remains unread."))
        bad(`last-part note: ${note.slice(0, 120)}`);
      if (!first && /The whole graph\./.test(note)) bad("a later part claims the whole graph");
      break;
    }
    if (!m) {
      bad(`partial without the continuation note: ${note.slice(0, 200)}`);
      break;
    }
    // Exactly what the note says: nothing carried, nothing left out.
    const next: Loose = { action: "read", workId };
    for (const part of (m[1] as string).split(", ")) {
      const offsetAt = /^offset = (\d+)$/.exec(part);
      const edgeAt = /^edgeOffset = (\d+)$/.exec(part);
      if (part === "the same ids") {
        if (!ids) bad("the note says 'the same ids' but none were passed");
        next.ids = ids;
      } else if (offsetAt) next.offset = Number(offsetAt[1]);
      else if (edgeAt) next.edgeOffset = Number(edgeAt[1]);
      else bad(`unparseable part of the note: ${part}`);
    }
    if (next.offset !== b.to) bad(`the note's offset ${next.offset} is not batch.to ${b.to}`);
    if (next.edgeOffset !== eb.to)
      bad(`the note's edgeOffset ${next.edgeOffset} is not edgesBatch.to ${eb.to}`);
    if (ids && !next.ids) bad("the ids form, but the note does not pass the ids again");
    params = next;
  }
  return finish(rep, argsAt, edgesAt);
}

function finish(
  rep: ModelReport,
  argsAt: Map<number, Loose>,
  edgesAt: Map<number, Loose>
): ModelReport {
  const top = argsAt.size ? Math.max(...argsAt.keys()) + 1 : 0;
  for (let p = 0; p < top; p++) {
    const item = argsAt.get(p);
    if (!item) {
      rep.ok = false;
      rep.problems.push(`gap in arguments at ${p}`);
      break;
    }
    if (item.arg) rep.got.arguments.push(item.arg);
    else rep.got.notFound.push(item.missing);
  }
  const n = edgesAt.size ? Math.max(...edgesAt.keys()) + 1 : 0;
  for (let i = 0; i < n; i++) {
    if (!edgesAt.has(i)) {
      rep.ok = false;
      rep.problems.push(`gap in edges at ${i}`);
      break;
    }
    rep.got.edges.push(edgesAt.get(i) as Loose);
  }
  return rep;
}
