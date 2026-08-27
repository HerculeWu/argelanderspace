/**
 * The `argelanderspace` commander program (milestone M5): `ingest` /
 * `library build` / `acquire` / `serve`, a commander port of the Python entry
 * points `bibgraph/cli.py`, `bibgraph/library/__main__.py`, and
 * `bibgraph/acquire/__main__.py` on top of the M1–M4 packages.
 *
 * `--data-dir` (decision 3) is global and may appear before or after the
 * subcommand; resolution is flag > `ARGELANDERSPACE_DATA_DIR` > config file
 * (decision 23) > `./data`. The ingest pipelines root at `<dataDir>/output`
 * (Python's `data/output`).
 */

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Document } from "@argelanderspace/contracts";
import {
  acquireReferences,
  addBibRecords,
  documentToJson,
  enrichAndPlan,
  fetchReadyFulltext,
  fetchRemaining,
  htmlAdapterInfos,
  LibraryStore,
  libraryPaths,
  parseBibtex,
  rebuild,
  type Work,
} from "@argelanderspace/core";
import {
  type AppConfig,
  FetchPdfDownloader,
  getConfig,
  ingestHtml,
  ingestLatex,
  ingestPdf,
} from "@argelanderspace/infra";
import { realPipelines, realSources, startServer } from "@argelanderspace/server";
import { Command } from "commander";
import { detectSource } from "./detect.js";
import { formatIngestSummary, formatPlanRow, planSortKey } from "./summary.js";

/** flag > env > config file (decision 23) > ./data (same chain as the server's). */
export function resolveDataDir(
  opts: { dataDir?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
  config: AppConfig = getConfig()
): string {
  return resolve(opts.dataDir ?? env.ARGELANDERSPACE_DATA_DIR ?? config.data_dir ?? "./data");
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Print `error: <msg>` like the Python CLI and fail the process (no stack). */
function fail(e: unknown): void {
  console.error(`error: ${errorMessage(e)}`);
  process.exitCode = 1;
}

interface IngestOpts {
  output?: string;
  outRoot?: string;
  figureDpi: string;
  inlineMath: string;
  assets: boolean;
  subpages: boolean;
  cache: boolean;
  outDir?: string;
  model: string;
  lang: string;
  pages?: string;
  formula: boolean;
  table: boolean;
  links: boolean;
  ocr?: boolean;
  reuse?: boolean;
  fresh?: boolean;
  verbose?: boolean;
}

async function runIngest(input: string, opts: IngestOpts, dataDir: string): Promise<void> {
  const outRoot = opts.outRoot ?? join(dataDir, "output");
  let doc: Document;
  switch (detectSource(input)) {
    case "latex":
      doc = await ingestLatex(input, {
        outRoot,
        config: {
          downloadAssets: opts.assets,
          useCache: opts.cache,
          figureDpi: Number.parseInt(opts.figureDpi, 10),
        },
        writeJson: true,
      });
      break;
    case "html":
      doc = await ingestHtml(input, {
        outRoot,
        config: {
          inlineMath: opts.inlineMath,
          downloadAssets: opts.assets,
          fetchSubpages: opts.subpages,
          useCache: opts.cache,
        },
        writeJson: true,
        log: opts.verbose ? (m) => console.error(m) : undefined,
      });
      break;
    case "pdf":
      doc = await ingestPdf(input, {
        outDir: opts.outDir,
        config: {
          mineru: {
            modelVersion: opts.model,
            language: opts.lang,
            enableFormula: opts.formula,
            enableTable: opts.table,
            pageRanges: opts.pages,
            // --ocr / --no-ocr / (neither) → true / false / null (auto-detect)
            isOcr: opts.ocr ?? null,
          },
          usePdfLinks: opts.links,
        },
        // Python `use_mineru_cache=not args.fresh` (--reuse is a no-op there:
        // reuse is already the default; the flag is accepted for parity).
        useMineruCache: !opts.fresh,
        writeJson: true,
      });
      break;
  }
  // Python `_summarize` reads `doc.to_dict(config.compact_json)`: serialize
  // once (stats are computed here) and reuse for `-o` and the summary.
  const docJson = documentToJson(doc, true);
  if (opts.output) {
    writeFileSync(opts.output, JSON.stringify(docJson, null, 2), "utf-8");
    console.log(`wrote ${opts.output}`);
  }
  console.log(`\n${formatIngestSummary(docJson)}`);
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
    htmlAdapters: htmlAdapterInfos(),
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
    await enrichAndPlan(store, sources, htmlAdapterInfos());
    printPlanTable(store.works);
    return;
  }

  let summary = await acquireReferences(paths, bib, {
    sources,
    htmlAdapters: htmlAdapterInfos(),
  });
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
    summary = await rebuild(paths, { sources, htmlAdapters: htmlAdapterInfos() });
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
      paths,
      downloader: new FetchPdfDownloader(),
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
    summary = await rebuild(paths, { sources, htmlAdapters: htmlAdapterInfos() });
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

/** Allow `--data-dir` after the subcommand as well as before it. */
function withDataDir(cmd: Command): Command {
  return cmd.option(
    "--data-dir <dir>",
    "data directory (default ./data; env ARGELANDERSPACE_DATA_DIR)"
  );
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("argelanderspace")
    .description(
      "ArgelanderSpace — ingest papers (PDF / publisher HTML / arXiv LaTeX) into " +
        "structured JSON and manage the citation-graph library."
    )
    .version("0.1.0")
    .option("--data-dir <dir>", "data directory (default ./data; env ARGELANDERSPACE_DATA_DIR)");

  withDataDir(program.command("ingest"))
    .description(
      "Ingest a paper into structured JSON. <input> may be a PDF path, a DOI / " +
        "publisher URL (HTML), or an arXiv id / URL / local .tex source (LaTeX)."
    )
    .argument("<input>", "PDF path | DOI | publisher URL | arXiv id/URL | .tex/dir/tarball")
    .option("-o, --output <path>", "also write the document JSON to this path")
    .option("--out-root <dir>", "HTML/LaTeX: output root (default <data-dir>/output)")
    .option("--figure-dpi <n>", "LaTeX: DPI for rasterising vector figures (default 200)", "200")
    .option(
      "--inline-math <mode>",
      "HTML: inline-math rendering (conservative|plain)",
      "conservative"
    )
    .option("--no-assets", "HTML/LaTeX: do not download figure images locally")
    .option("--no-subpages", "HTML: do not fetch table sub-pages (caption-only tables)")
    .option("--no-cache", "HTML/LaTeX: ignore the on-disk fetch cache (re-fetch)")
    .option("--out-dir <dir>", "PDF: working/cache dir (default <pdf_dir>/<stem>)")
    .option("--model <version>", "PDF: MinerU model_version (default vlm)", "vlm")
    .option("--lang <lang>", "PDF: document language (default en)", "en")
    .option("--pages <ranges>", "PDF: page ranges, e.g. '1-10'")
    .option("--no-formula", "PDF: disable formula OCR")
    .option("--no-table", "PDF: disable table OCR")
    .option("--no-links", "PDF: disable hyperlink resolution (regex only)")
    .option("--ocr", "PDF: force OCR on")
    .option("--no-ocr", "PDF: force OCR off")
    .option("--reuse", "PDF: reuse cached MinerU artifacts (already the default; no-op)")
    .option("--fresh", "PDF: ignore the MinerU cache and re-call the API")
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
    .option("--fetch", "after planning, fetch full text for ready works (A&A HTML + arXiv LaTeX)")
    .option(
      "--fetch-remaining",
      "fallback chain for stragglers: arXiv LaTeX → arXiv PDF → ADS scan (MinerU OCR)"
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
    .option("--data-dir <dir>", "data directory (default ./data; env ARGELANDERSPACE_DATA_DIR)")
    .option("--web-dist <dir>", "built SPA directory (default packages/web/dist)")
    .action(async (opts: ServeOpts, cmd: Command) => {
      try {
        await runServe(opts, cmd.optsWithGlobals().dataDir as string | undefined);
      } catch (e) {
        fail(e);
      }
    });

  return program;
}
