/**
 * Agent-facing subcommands (Stage 2 / MS1; design decisions 2, 5, 6 and 8 in
 * `.kimi-code/memory/2026-08-27-stage2-design.md`):
 *
 *   search                          every work as one JSON line (no filtering);
 *                                   an empty-note hint goes to stderr when any
 *   read <docId> [--section] [--manifest refs|bib]
 *                                   LLM-friendly markdown, or a JSONL manifest
 *   show <docId> <floatId>          one float as JSON (caption/latex/body/image)
 *   ref <docId> <refIdOrKey>        one bibliography entry as JSON (+ cited_in)
 *   note <workId> [text...]         set/print the work's note
 *   label <workId> [--label] [--read] [--star] [--tags]
 *                                   patch user state, print the result
 *   list                            library overview + one line per doc
 *
 * Output conventions:
 * - structured output is JSON/JSONL on stdout, kept machine-clean: when a
 *   command's stdout is a JSONL stream (`search`, `read --manifest`), the doc
 *   header + deep link goes to stderr instead of corrupting the stream;
 *   `search` likewise reports `hint: N/M works have empty notes` on stderr
 *   (only when N > 0 — works without notes are invisible to note-driven
 *   ranking, so the query skill treats the hint as its cue to offer backfill);
 * - every command that references a doc location also prints a deep link
 *   `http://localhost:<port>/doc/<docId>#<anchor>` (decision 8; the web route
 *   itself is MS2). The port follows serve's chain minus its `--port` flag:
 *   `ARGELANDERSPACE_PORT` > config `port` > 8000.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DocIr,
  type IrBlock,
  type IrSection,
  TexDocIrSchema,
} from "@argelanderspace/contracts";
import {
  citeShort,
  displayAuthors,
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  patchWork,
  renderIrMarkdown,
  renderIrSectionMarkdown,
  segmentsMarkdown,
  type Work,
} from "@argelanderspace/core";
import { type AppConfig, getConfig } from "@argelanderspace/infra";
import type { Command } from "commander";
import { fail, resolveDataDir, withDataDir } from "./common.js";

// --------------------------------------------------------------------------- //
// Shared helpers
// --------------------------------------------------------------------------- //

/** Deep-link port: env `ARGELANDERSPACE_PORT` > config `port` > 8000. */
export function resolveLinkPort(
  env: NodeJS.ProcessEnv = process.env,
  config: AppConfig = getConfig()
): number {
  const raw = env.ARGELANDERSPACE_PORT;
  if (raw !== undefined) {
    const p = Number.parseInt(raw, 10);
    if (!Number.isNaN(p)) return p;
  }
  return config.port ?? 8000;
}

/** `http://localhost:<port>/doc/<docId>[#<anchor>]` (decision 8). */
export function docLink(port: number, docId: string, anchor?: string): string {
  return `http://localhost:${port}/doc/${docId}${anchor !== undefined ? `#${anchor}` : ""}`;
}

/** Doc ids under `<dataDir>/output` (dirs holding a `<id>/<id>.json`). */
function listDocIds(outputDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(outputDir);
  } catch {
    return [];
  }
  return names.filter((n) => existsSync(join(outputDir, n, `${n}.json`))).sort();
}

/**
 * Actionable "unknown id" error: substring matches when there are any, else
 * the (truncated) full candidate list.
 */
function unknownMsg(kind: string, query: string, candidates: readonly string[]): string {
  const q = query.toLowerCase();
  const close = candidates.filter((c) => {
    const cl = c.toLowerCase();
    return cl.includes(q) || (q.length >= 4 && q.includes(cl));
  });
  if (close.length > 0) {
    return `unknown ${kind} "${query}" — closest matches: ${close.slice(0, 12).join(", ")}`;
  }
  const show = candidates.slice(0, 12);
  const more = candidates.length > show.length ? ` … (${candidates.length} total)` : "";
  return `unknown ${kind} "${query}" — available: ${show.join(", ")}${more}`;
}

/**
 * The stored file IS the render IR; a file without the `version` marker is a
 * pre-migration Document JSON (fallback deleted in MS4b) and errors out.
 */
function loadDocIr(paths: LibraryPaths, docId: string): DocIr {
  const file = join(paths.outputDir, docId, `${docId}.json`);
  if (!existsSync(file)) {
    throw new Error(unknownMsg("doc", docId, listDocIds(paths.outputDir)));
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (
    raw !== null &&
    typeof raw === "object" &&
    typeof (raw as Record<string, unknown>).version === "number"
  ) {
    return TexDocIrSchema.parse(raw);
  }
  throw new Error(`doc "${docId}" is a pre-migration document — re-ingest it (fallback removed)`);
}

function* iterIrSections(sections: IrSection[]): Generator<IrSection> {
  for (const s of sections) {
    yield s;
    yield* iterIrSections(s.children);
  }
}

type IrFloat = Extract<IrBlock, { type: "figure" | "table" | "equation" | "code" | "algorithm" }>;

function docFloats(ir: DocIr): IrFloat[] {
  const out: IrFloat[] = [];
  for (const s of iterIrSections(ir.sections)) {
    for (const b of s.blocks) {
      if (
        b.type === "figure" ||
        b.type === "table" ||
        b.type === "equation" ||
        b.type === "code" ||
        b.type === "algorithm"
      ) {
        out.push(b);
      }
    }
  }
  return out;
}

function loadWork(paths: LibraryPaths, workId: string): Work {
  const store = LibraryStore.load(paths);
  const w = store.get(workId);
  if (w === undefined) {
    throw new Error(
      unknownMsg(
        "work",
        workId,
        store.works.map((x) => x.id)
      )
    );
  }
  return w;
}

function parseBoolFlag(name: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true|false, got "${value}"`);
}

// --------------------------------------------------------------------------- //
// Command implementations
// --------------------------------------------------------------------------- //

function runSearch(dataDir: string): void {
  const store = LibraryStore.load(libraryPaths(dataDir));
  for (const w of store.works) {
    console.log(
      JSON.stringify({
        id: w.id,
        title: w.title,
        year: w.year,
        venue: w.venue,
        authors: displayAuthors(w.authors),
        arxiv_id: w.arxiv_id,
        doi: w.doi,
        cited_by_count: w.cited_by_count,
        note: w.note,
        tags: w.tags,
        label: w.label,
        read: w.read,
        star: w.star,
        doc_ids: w.doc_ids,
      })
    );
  }
  // Empty = undefined/null/empty/whitespace-only. stdout stays pure JSONL;
  // the hint follows the other JSONL streams' header-on-stderr precedent.
  const empty = store.works.filter((w) => (w.note ?? "").trim() === "").length;
  if (empty > 0) {
    console.error(`hint: ${empty}/${store.works.length} works have empty notes`);
  }
}

interface ReadOpts {
  dataDir?: string;
  section?: string;
  manifest?: string;
}

function runRead(docId: string, opts: ReadOpts, dataDir: string): void {
  const paths = libraryPaths(dataDir);
  const ir = loadDocIr(paths, docId);
  const port = resolveLinkPort();
  const title = ir.title ?? docId;
  if (opts.manifest !== undefined) {
    if (opts.manifest !== "refs" && opts.manifest !== "bib") {
      throw new Error(`--manifest must be refs|bib, got "${opts.manifest}"`);
    }
    // stdout stays pure JSONL; the doc header + deep link goes to stderr
    console.error(`doc: ${docId} | ${title} | ${docLink(port, docId)}`);
    const rows = opts.manifest === "refs" ? ir.refsManifest : ir.bib;
    for (const r of rows) console.log(JSON.stringify(r));
    return;
  }
  if (opts.section !== undefined) {
    console.log(
      `# ${title}\n\n> doc: ${docId} | section: ${opts.section} | ` +
        `link: ${docLink(port, docId, opts.section)}\n`
    );
    process.stdout.write(renderIrSectionMarkdown(ir, opts.section));
    return;
  }
  console.log(
    `# ${title}\n\n> doc: ${docId} | source: ${"source" in ir ? ((ir.source as { type?: string }).type ?? "?") : "?"} | ` +
      `link: ${docLink(port, docId)}\n`
  );
  process.stdout.write(renderIrMarkdown(ir));
}

function runShow(docId: string, floatId: string, dataDir: string): void {
  const paths = libraryPaths(dataDir);
  const ir = loadDocIr(paths, docId);
  const floats = docFloats(ir);
  const b = floats.find((f) => f.id === floatId);
  if (b === undefined) {
    throw new Error(
      unknownMsg(
        "float",
        floatId,
        floats.map((f) => f.id)
      )
    );
  }
  const out: Record<string, unknown> = { doc_id: docId, id: b.id, kind: b.type };
  if (b.number !== undefined) out.number = b.number;
  if (b.label !== undefined) out.label = b.label;
  if (b.type === "equation") {
    out.latex = b.latex;
  } else {
    if (
      (b.type === "figure" || b.type === "table" || b.type === "code" || b.type === "algorithm") &&
      b.captionSegments !== undefined
    ) {
      out.caption = segmentsMarkdown(b.captionSegments);
    }
    if (b.type === "figure" || b.type === "table") {
      if (b.footnote !== undefined) out.footnote = b.footnote;
      if (b.imgPath !== undefined) out.image = `/images/${docId}/${b.imgPath}`;
    }
    if (b.type === "table" && b.tableBody !== undefined) out.table_body = b.tableBody;
    if ((b.type === "code" || b.type === "algorithm") && b.body !== undefined) {
      if (b.type === "code" && b.lang !== undefined) out.lang = b.lang;
      out.body = b.body;
    }
  }
  out.link = docLink(resolveLinkPort(), docId, b.id);
  console.log(JSON.stringify(out, null, 2));
}

function runRef(docId: string, refIdOrKey: string, dataDir: string): void {
  const paths = libraryPaths(dataDir);
  const ir = loadDocIr(paths, docId);
  const refs = ir.references ?? [];
  const ref =
    refs.find((r) => r.id === refIdOrKey) ??
    refs.find((r) => r.label === refIdOrKey || r.keys?.includes(refIdOrKey) === true);
  if (ref === undefined) {
    throw new Error(
      unknownMsg(
        "reference",
        refIdOrKey,
        refs.map((r) => r.id)
      )
    );
  }
  const citedIn = Object.entries(ir.citationsByBlock)
    .filter(([, refIds]) => refIds.includes(ref.id))
    .map(([blockId]) => blockId);
  const out: Record<string, unknown> = {
    doc_id: docId,
    id: ref.id,
    short: citeShort(ref),
  };
  if (ref.label !== undefined) out.label = ref.label;
  if (ref.title !== undefined) out.title = ref.title;
  if (ref.authors !== undefined) out.authors = ref.authors;
  if (ref.year !== undefined) out.year = ref.year;
  if (ref.venue !== undefined) out.venue = ref.venue;
  if (ref.volume !== undefined) out.volume = ref.volume;
  if (ref.pages !== undefined) out.pages = ref.pages;
  if (ref.doi !== undefined) out.doi = ref.doi;
  if (ref.arxiv_id !== undefined) out.arxiv_id = ref.arxiv_id;
  if (ref.url !== undefined) out.url = ref.url;
  out.raw = ref.raw;
  out.cited_in = citedIn;
  out.link = docLink(resolveLinkPort(), docId, ref.id);
  console.log(JSON.stringify(out, null, 2));
}

function runNote(workId: string, text: string[], dataDir: string): void {
  const paths = libraryPaths(dataDir);
  loadWork(paths, workId); // actionable error on unknown id
  if (text.length > 0) {
    if (!patchWork(paths, workId, { note: text.join(" ") })) {
      throw new Error(`failed to patch work "${workId}"`);
    }
  }
  const w = loadWork(paths, workId);
  console.log(JSON.stringify({ id: w.id, note: w.note }));
}

interface LabelOpts {
  dataDir?: string;
  label?: string;
  read?: string;
  star?: string;
  tags?: string;
}

function runLabel(workId: string, opts: LabelOpts, dataDir: string): void {
  const paths = libraryPaths(dataDir);
  loadWork(paths, workId);
  const patch: Record<string, unknown> = {};
  if (opts.label !== undefined) patch.label = opts.label;
  if (opts.read !== undefined) patch.read = parseBoolFlag("read", opts.read);
  if (opts.star !== undefined) patch.star = parseBoolFlag("star", opts.star);
  if (opts.tags !== undefined) {
    patch.tags =
      opts.tags === ""
        ? []
        : opts.tags
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t !== "");
  }
  if (Object.keys(patch).length > 0 && !patchWork(paths, workId, patch)) {
    throw new Error(`failed to patch work "${workId}"`);
  }
  const w = loadWork(paths, workId);
  console.log(
    JSON.stringify({ id: w.id, label: w.label, read: w.read, star: w.star, tags: w.tags })
  );
}

function runList(dataDir: string): void {
  const paths = libraryPaths(dataDir);
  const store = LibraryStore.load(paths);
  const nRead = store.works.filter((w) => w.read).length;
  const nLabeled = store.works.filter((w) => w.label !== null).length;
  const docIds = listDocIds(paths.outputDir);
  console.log(
    `library: works=${store.works.length} docs=${docIds.length} read=${nRead} ` +
      `unread=${store.works.length - nRead} labeled=${nLabeled}`
  );
  const port = resolveLinkPort();
  for (const id of docIds) {
    try {
      const ir = loadDocIr(paths, id);
      const title = (ir.title ?? "").replaceAll("|", "/");
      const nSec = [...iterIrSections(ir.sections)].length;
      const nRefs = (ir.references ?? []).length;
      console.log(
        `doc: ${id} | ${"source" in ir ? ((ir.source as { type?: string })?.type ?? "?") : "?"} | ` +
          `sec=${nSec} | refs=${nRefs} | ${title} | ${docLink(port, id)}`
      );
    } catch {
      console.log(`doc: ${id} | (unreadable doc JSON) | ${docLink(port, id)}`);
    }
  }
}

// --------------------------------------------------------------------------- //
// Registration
// --------------------------------------------------------------------------- //

export function registerAgentCommands(program: Command): void {
  withDataDir(program.command("search"))
    .description(
      "Print every library work as one JSON object per line " +
        "(full index rows; the agent judges relevance — no server-side filtering)."
    )
    .action((_opts: { dataDir?: string }, cmd: Command) => {
      try {
        runSearch(resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });

  withDataDir(program.command("read"))
    .description(
      "Render an ingested doc as LLM-friendly markdown (whole doc or one " +
        "section), or print a JSONL manifest."
    )
    .argument("<docId>", "ingested doc id (see `list`)")
    .option("--section <secId>", "render only this section subtree")
    .option("--manifest <kind>", "print the refs|bib JSONL manifest instead of markdown")
    .action((docId: string, opts: ReadOpts, cmd: Command) => {
      try {
        runRead(docId, opts, resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });

  withDataDir(program.command("show"))
    .description("Show one float (figure/table/equation/code/algorithm) as JSON.")
    .argument("<docId>", "ingested doc id")
    .argument("<floatId>", "float id, e.g. fig-3 / tab-1 / eq-2 (see the refs manifest)")
    .action((docId: string, floatId: string, _opts: { dataDir?: string }, cmd: Command) => {
      try {
        runShow(docId, floatId, resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });

  withDataDir(program.command("ref"))
    .description("Show one bibliography entry of a doc as JSON (fields + raw + citing blocks).")
    .argument("<docId>", "ingested doc id")
    .argument("<refIdOrKey>", "reference id (ref-12), label, or one of its match keys")
    .action((docId: string, refIdOrKey: string, _opts: { dataDir?: string }, cmd: Command) => {
      try {
        runRef(docId, refIdOrKey, resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });

  withDataDir(program.command("note"))
    .description("Set/replace a work's note; without text, print the current note.")
    .argument("<workId>", "library work id (see `search`)")
    .argument("[text...]", "the note text (replaces the current note)")
    .action((workId: string, text: string[], _opts: { dataDir?: string }, cmd: Command) => {
      try {
        runNote(workId, text, resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });

  withDataDir(program.command("label"))
    .description("Patch a work's user state (color label / read / star / tags); prints the result.")
    .argument("<workId>", "library work id (see `search`)")
    .option("--label <color>", "color-label key (empty string clears)")
    .option("--read <bool>", "mark read/unread (true|false)")
    .option("--star <bool>", "star/unstar (true|false)")
    .option("--tags <list>", "comma-separated tags, replaces the set (empty string clears)")
    .action((workId: string, opts: LabelOpts, cmd: Command) => {
      try {
        runLabel(workId, opts, resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });

  withDataDir(program.command("list"))
    .description("Library overview: works/read/labeled counts + one line per ingested doc.")
    .action((_opts: { dataDir?: string }, cmd: Command) => {
      try {
        runList(resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });
}
