/**
 * The `argelanderspace` commander program (milestone M5): `ingest` /
 * `library build` / `acquire` / `serve`, a commander port of the Python entry
 * points `bibgraph/cli.py`, `bibgraph/library/__main__.py`, and
 * `bibgraph/acquire/__main__.py` on top of the M1–M4 packages — plus the
 * Stage 2 / MS1 agent subcommands (`search` / `read` / `show` / `ref` /
 * `note` / `label` / `list`, registered from `./agent.js`).
 *
 * `--data-dir` (decision 3) is global and may appear before or after the
 * subcommand; resolution is flag > `ARGELANDERSPACE_DATA_DIR` > config file
 * (decision 23) > `./literatures`. The ingest pipelines root at `<dataDir>/output`
 * (Python's `data/output`).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireReferences,
  addBibRecords,
  addDoiWork,
  enrichAndPlan,
  fetchReadyFulltext,
  fetchRemaining,
  LibraryStore,
  libraryPaths,
  parseBibtex,
  rebuild,
  type Work,
} from "@argelanderspace/core";
import { ingestTexSource } from "@argelanderspace/infra";
import { realPipelines, realSources, startServer } from "@argelanderspace/server";
import { Command } from "commander";
import { registerAgentCommands } from "./agent.js";
import { fail, resolveDataDir, withDataDir } from "./common.js";
import { detectSource } from "./detect.js";
import { formatPlanRow, formatTexIngestSummary, planSortKey } from "./summary.js";

// re-exported: the resolution chain now lives in ./common.js (shared with the
// agent subcommands), but the public import path stays stable
export { resolveDataDir };

interface IngestOpts {
  output?: string;
  outRoot?: string;
  figureDpi: string;
  assets: boolean;
  cache: boolean;
  verbose?: boolean;
}

async function runIngest(input: string, opts: IngestOpts, dataDir: string): Promise<void> {
  const outRoot = opts.outRoot ?? join(dataDir, "output");
  // latex-only on main. A DOI / DOI-carrying URL becomes a docless library
  // entry (Stage 7 MS4); DOI-less URLs and bare strings throw a friendly error.
  const detected = detectSource(input);
  if (detected.kind === "doi-stub") {
    await runAddDoiStub(detected.doi, detected.fromUrl, opts, dataDir);
    return;
  }
  // --no-assets skips figure materialization (block+caption kept, no image);
  // --figure-dpi is accepted for interface stability but ignored (figures
  // become SVG — no raster DPI anymore, MS4 docs sweep).
  const r = await ingestTexSource(detected.input, {
    outRoot,
    noCache: !opts.cache,
    assets: opts.assets,
    onProgress: (m) => {
      if (opts.verbose) console.error(m);
      else if (m.startsWith("warning: ")) console.error(m);
    },
  });
  if (opts.output) {
    writeFileSync(opts.output, JSON.stringify(r.ir, null, 2), "utf-8");
    console.log(`wrote ${opts.output}`);
  }
  console.log(
    `\n${formatTexIngestSummary(r.ir, { engine: r.engine, warnings: r.warnings.length })}`
  );
}

/**
 * Stage 7 MS4: a DOI input creates (or finds) the docless library work for it.
 * Crossref enriches immediately; offline / no-record degrades to a bare stub.
 * `fromUrl` marks a DOI extracted from a publisher URL: when Crossref has no
 * record for it the hint says so — the extraction may have caught a non-DOI.
 */
async function runAddDoiStub(
  doi: string,
  fromUrl: boolean,
  opts: IngestOpts,
  dataDir: string
): Promise<void> {
  // The latex-pipeline flags have no meaning for a docless entry; say so
  // instead of silently dropping them (warnings go to stderr, like runIngest).
  const ignored: string[] = [];
  if (opts.output) ignored.push("--output");
  if (opts.outRoot) ignored.push("--out-root");
  if (!opts.assets) ignored.push("--no-assets");
  if (!opts.cache) ignored.push("--no-cache");
  if (ignored.length > 0) {
    console.error(`note: ${ignored.join(" ")} ignored — a DOI entry has no ingest output`);
  }
  const paths = libraryPaths(dataDir);
  const r = await addDoiWork(paths, doi, realSources(paths, false).crossref);
  if (r === null) throw new Error(`invalid DOI: ${doi}`);
  if (!r.created) {
    console.log(`library entry already exists for this DOI: ${r.ref.id}`);
  } else if (r.enriched) {
    console.log(`created library entry ${r.ref.id} (no full text yet)`);
  } else if (fromUrl) {
    console.log(
      `created library entry ${r.ref.id} ` +
        "(bare stub — Crossref has no record for this DOI, or was unreachable; " +
        "it was extracted from the URL and may not be a real DOI)"
    );
  } else {
    console.log(
      `created library entry ${r.ref.id} ` +
        "(bare stub — Crossref had no record or was unreachable)"
    );
  }
  if (r.created && r.ref.title) console.log(`  title: ${r.ref.title}`);
  console.log(
    "  next: upload a LaTeX source zip on this work's detail page in the web UI " +
      "to attach the full text"
  );
}

/** The trailing ADS hint of `library/__main__.py` (status != "ok"). */
function printAdsWarning(status: string): void {
  console.log(`\n⚠ ADS enrichment was not applied (status: ${status}).`);
  console.log(
    "  Put a valid token in ~/.ads/dev_key or $ADS_DEV_KEY to enable astro citation counts;"
  );
  console.log("  Crossref + OpenAlex still supply counts/metadata meanwhile.");
}

async function runLibraryBuild(opts: { offline?: boolean; bib?: string }, dataDir: string) {
  const paths = libraryPaths(dataDir);
  const summary = await rebuild(paths, {
    sources: realSources(paths, opts.offline ?? false),
    bibPath: opts.bib ?? null,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.ads_status !== "ok") printAdsWarning(summary.ads_status);
}

interface AcquireOpts {
  offline?: boolean;
  dryRun?: boolean;
  fetch?: boolean;
  fetchRemaining?: boolean;
  skip: string;
  limit?: string;
  verbose?: boolean;
}

function printPlanTable(works: readonly Work[]): void {
  console.log(`\n=== acquisition plan (${works.length} works) ===`);
  const sorted = [...works].sort((a, b) => {
    const ka = planSortKey(a);
    const kb = planSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const w of sorted) console.log(formatPlanRow(w));
}

async function runAcquire(bib: string, opts: AcquireOpts, dataDir: string): Promise<void> {
  const paths = libraryPaths(dataDir);
  const offline = opts.offline ?? false;
  const limit = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : null;
  const sources = realSources(paths, offline);

  if (opts.dryRun) {
    // Plan only: an in-memory store, no library write (acquire/__main__.py).
    const store = new LibraryStore();
    addBibRecords(store, parseBibtex(bib));
    await enrichAndPlan(store, sources);
    printPlanTable(store.works);
    return;
  }

  let summary = await acquireReferences(paths, bib, { sources });
  const pipelines = realPipelines(paths);

  if (opts.fetch) {
    const store = LibraryStore.load(paths);
    const results = await fetchReadyFulltext(store, { pipelines, limit });
    const ok = results.filter((r) => r.ok).length;
    console.log(`\n=== fetched ${ok}/${results.length} ready works ===`);
    for (const r of results) {
      if (r.ok) {
        console.log(
          `  ✓ ${String(r.doc_id).padEnd(16)} ${String(r.tier).padEnd(12)} ` +
            `sec=${r.sections ?? "None"} fig=${r.figures ?? "None"} ref=${r.refs ?? "None"} ` +
            `blocks=${String(r.blocks)}  ${String(r.title ?? "")}`
        );
      } else {
        console.log(`  ✗ ${String(r.tier).padEnd(12)} ${String(r.loc)}  ERR: ${String(r.error)}`);
      }
    }
    // relink the new reader docs to their works + refresh plans/graph
    summary = await rebuild(paths, { sources });
  }

  if (opts.fetchRemaining) {
    const store = LibraryStore.load(paths);
    const skip = new Set(
      opts.skip
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
    );
    const results = await fetchRemaining(store, {
      pipelines,
      skip,
      limit,
    });
    const ok = results.filter((r) => r.ok).length;
    console.log(`\n=== fetch-remaining: recovered ${ok}/${results.length} ===`);
    for (const r of results) {
      if (r.ok) {
        console.log(
          `  ✓ ${String(r.doc_id).padEnd(22)} via ${String(r.via).padEnd(12)} ` +
            `blocks=${String(r.blocks)}  ${String(r.title ?? "")}`
        );
      } else {
        console.log(`  ✗ ${String(r.id)}  ${String(r.error)}`);
      }
    }
    summary = await rebuild(paths, { sources });
  }

  console.log(JSON.stringify(summary, null, 2));
  printPlanTable(LibraryStore.load(paths).works);
}

interface ServeOpts {
  port?: string;
  dataDir?: string;
  webDist?: string;
}

async function runServe(opts: ServeOpts, globalDataDir: string | undefined): Promise<void> {
  // Defer to the server's resolution chain (flag > env > default) by only
  // forwarding flags the user actually passed.
  const argv: string[] = [];
  const dataDir = opts.dataDir ?? globalDataDir;
  if (dataDir !== undefined) argv.push("--data-dir", dataDir);
  if (opts.port !== undefined) argv.push("--port", opts.port);
  if (opts.webDist !== undefined) argv.push("--web-dist", opts.webDist);
  const srv = await startServer(argv);
  const shutdown = () => {
    void srv.close().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("argelanderspace")
    .description(
      "ArgelanderSpace — ingest papers (arXiv / local LaTeX sources) into " +
        "structured JSON and manage the citation-graph library."
    )
    .version("0.1.0")
    .option(
      "--data-dir <dir>",
      "data directory (default ./literatures; env ARGELANDERSPACE_DATA_DIR)"
    );

  withDataDir(program.command("ingest"))
    .description(
      "Ingest a paper into structured JSON. <input> may be an arXiv id / URL, " +
        "a local LaTeX source (.tex file / source dir / tarball), or a DOI / " +
        "DOI-carrying publisher URL (creates a docless library entry to attach " +
        "a LaTeX zip to later in the web UI)."
    )
    .argument("<input>", "arXiv id/URL | .tex/dir/tarball | DOI")
    .option("-o, --output <path>", "also write the document JSON to this path")
    .option("--out-root <dir>", "output root (default <data-dir>/output)")
    .option("--figure-dpi <n>", "DPI for rasterising vector figures (default 200)", "200")
    .option("--no-assets", "do not download figure images locally")
    .option("--no-cache", "ignore the on-disk fetch cache (re-fetch)")
    .option("-v, --verbose", "verbose progress on stderr")
    .action(async (input: string, opts: IngestOpts, cmd: Command) => {
      try {
        await runIngest(input, opts, resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });

  const library = program.command("library").description("Manage the citation-graph library");
  withDataDir(library.command("build"))
    .description(
      "Rebuild the library from ingested papers (+ an optional .bib): seed → " +
        "enrich (ADS▸Crossref▸OpenAlex) → plan → graph."
    )
    .option("--offline", "skip live ADS/Crossref/OpenAlex calls (use cache only)")
    .option("--bib <path>", "also add every entry of this .bib to the library")
    .option("-v, --verbose", "verbose progress on stderr")
    .action(async (opts: { offline?: boolean; bib?: string }, cmd: Command) => {
      try {
        await runLibraryBuild(opts, resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });

  withDataDir(program.command("acquire"))
    .description(
      "Add a .bib's entries to the library and print the acquisition plan " +
        "(resolve + plan; no full text unless --fetch/--fetch-remaining)."
    )
    .argument("<bib>", "path to a .bib file")
    .option("--offline", "use cached metadata only")
    .option("--dry-run", "plan only; do not write the library")
    .option("--fetch", "after planning, fetch full text for ready works (arXiv LaTeX)")
    .option(
      "--fetch-remaining",
      "retry pending works via arXiv LaTeX (the only auto-fetchable tier on main)"
    )
    .option("--skip <ids>", "comma-separated work ids to skip when fetching", "")
    .option("--limit <n>", "cap how many works --fetch ingests")
    .option("-v, --verbose", "verbose progress on stderr")
    .action(async (bib: string, opts: AcquireOpts, cmd: Command) => {
      try {
        await runAcquire(bib, opts, resolveDataDir(cmd.optsWithGlobals()));
      } catch (e) {
        fail(e);
      }
    });

  program
    .command("serve")
    .description("Start the ArgelanderSpace server (API + web UI + WebSocket progress).")
    .option("--port <n>", "port (default 8000; env ARGELANDERSPACE_PORT)")
    .option(
      "--data-dir <dir>",
      "data directory (default ./literatures; env ARGELANDERSPACE_DATA_DIR)"
    )
    .option("--web-dist <dir>", "built SPA directory (default packages/web/dist)")
    .action(async (opts: ServeOpts, cmd: Command) => {
      try {
        await runServe(opts, cmd.optsWithGlobals().dataDir as string | undefined);
      } catch (e) {
        fail(e);
      }
    });

  // Stage 2 / MS1: agent-facing subcommands (search/read/show/ref/note/label/list)
  registerAgentCommands(program);

  return program;
}
