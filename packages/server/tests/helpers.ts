/**
 * Shared fixtures for the server tests: a hermetic `<tmp>/data` tree built
 * from the repo's golden reader docs + the core library fixture, plus stub
 * `MetadataSources` / `IngestPipelines` (no MinerU, no network).
 */

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Document, WsServerMessage } from "@argelanderspace/contracts";
import type { IngestPipelines, MetadataSources } from "@argelanderspace/core";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GOLDEN = join(REPO_ROOT, "tests", "golden");
const CORE_FIXTURES = join(REPO_ROOT, "packages", "core", "tests", "fixtures");

/** A work that exists in the library fixture (for upload/patch tests). */
export const KNOWN_WORK_ID = "arxiv:2603.03522";

/**
 * Fresh data dir:
 *   output/arxiv-2501.17225/…  (a real golden reader doc)
 *   output/demo/{demo.json, mineru/images/pic.jpg, assets/logo.png}
 *   library/library.json       (core fixture; contains KNOWN_WORK_ID)
 *   library/cache/graph.json   (one suggested node `oa:W999`)
 */
export function makeDataDir(): string {
  const dataDir = join(mkdtempSync(join(tmpdir(), "aspace-server-")), "data");

  const goldenDir = join(dataDir, "output", "arxiv-2501.17225");
  mkdirSync(goldenDir, { recursive: true });
  copyFileSync(join(GOLDEN, "arxiv-2501.17225.json"), join(goldenDir, "arxiv-2501.17225.json"));

  const demoDir = join(dataDir, "output", "demo");
  mkdirSync(join(demoDir, "mineru", "images"), { recursive: true });
  mkdirSync(join(demoDir, "assets"), { recursive: true });
  writeFileSync(
    join(demoDir, "demo.json"),
    JSON.stringify({
      doc_id: "demo",
      meta: { title: "Demo paper" },
      source: {},
      blocks: [],
      references: [],
    })
  );
  writeFileSync(
    join(demoDir, "mineru", "images", "pic.jpg"),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  );
  writeFileSync(join(demoDir, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const libDir = join(dataDir, "library");
  mkdirSync(join(libDir, "cache"), { recursive: true });
  copyFileSync(join(CORE_FIXTURES, "library.json"), join(libDir, "library.json"));
  writeFileSync(
    join(libDir, "cache", "graph.json"),
    JSON.stringify({
      nodes: [
        {
          id: "oa:W999",
          doi: "10.1234/test",
          t: "A suggested paper",
          a: "Doe",
          y: 2020,
          v: "ApJ",
          c: 7,
        },
      ],
      links: [],
    })
  );
  return dataDir;
}

/** Offline sources: every lookup misses; ADS reports no token. */
export function stubSources(): MetadataSources {
  return {
    ads: { status: "no-token", resolve: async () => null },
    crossref: { resolve: async () => null },
    oa: { resolve: async () => null, fetchMany: async () => new Map() },
  };
}

/**
 * Pipelines whose `ingestPdf` mimics MinerU minimally: write a tiny Document
 * to `<outDir>/<stem>.json` (what the real pipeline + `stampSource` expect).
 */
export function stubPipelines(): IngestPipelines {
  return {
    ingestPdf: async (pdfPath: string, opts: { outDir: string }) => {
      const stem =
        pdfPath
          .split("/")
          .pop()
          ?.replace(/\.pdf$/i, "") ?? "doc";
      const doc = {
        doc_id: stem,
        meta: { title: `Stub OCR of ${stem}` },
        source: {},
        blocks: [],
        references: [],
      };
      writeFileSync(join(opts.outDir, `${stem}.json`), JSON.stringify(doc));
      return doc as unknown as Document;
    },
    ingestHtml: async () => {
      throw new Error("not used in server tests");
    },
    ingestLatex: async () => {
      throw new Error("not used in server tests");
    },
  };
}

/** A minimal built SPA: index.html + one asset. */
export function makeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "aspace-webdist-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>ArgelanderSpace</title>\n");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('spa');\n");
  return dir;
}

/** Broadcast collector: records the WS message stream for assertions. */
export function collectBroadcasts(): {
  messages: WsServerMessage[];
  broadcast: (msg: WsServerMessage) => void;
} {
  const messages: WsServerMessage[] = [];
  return { messages, broadcast: (msg) => messages.push(msg) };
}
