/**
 * Shared fixtures for the server tests: a hermetic `<tmp>/data` tree built
 * from the repo's golden reader docs + the core library fixture, plus stub
 * `MetadataSources` (no network).
 */

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TexDocIr, WsServerMessage } from "@argelanderspace/contracts";
import type { IngestPipelines, MetadataSources } from "@argelanderspace/core";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GOLDEN = join(REPO_ROOT, "tests", "golden", "tex");
const CORE_FIXTURES = join(REPO_ROOT, "packages", "core", "tests", "fixtures");

/** A work that exists in the library fixture (for patch tests). */
export const KNOWN_WORK_ID = "arxiv:2603.03522";

/**
 * Fresh data dir:
 *   output/arxiv-2501.17225/…  (a real golden reader doc)
 *   output/demo/{demo.json, mineru/images/pic.jpg, assets/logo.png,
 *                assets/nested/deep.png}
 *   library/library.json       (core fixture; contains KNOWN_WORK_ID)
 *   library/cache/graph.json   (one suggested node `oa:W999`)
 *
 * The `mineru/images/pic.jpg` file pins the MS1 removal: the MinerU image
 * branch of /images is gone with the PDF pipeline, so it must 404 now.
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
  mkdirSync(join(demoDir, "assets", "nested"), { recursive: true });
  writeFileSync(
    join(demoDir, "assets", "nested", "deep.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x48])
  );

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
 * Pipelines whose `ingestLatexZip` mimics the real one minimally: write a tiny
 * stored-IR doc to `<outRoot>/<docId>/<docId>.json` (what `attachLatexZip`'s
 * `stampSource` + the seed merge expect). No latexmk involved.
 */
export function stubPipelines(): IngestPipelines {
  return {
    ingestLatex: async () => {
      throw new Error("not used in server tests");
    },
    ingestLatexZip: async (_zipPath: string, opts: { outRoot: string; docId: string }) => {
      const dir = join(opts.outRoot, opts.docId);
      mkdirSync(dir, { recursive: true });
      const ir: TexDocIr = {
        version: 1,
        docId: opts.docId,
        sections: [],
        refsManifest: [],
        bib: [],
        citationsByBlock: {},
        source: { type: "latex", origin: dir, main_tex: "main.tex" },
        meta: { title: `Stub LaTeX of ${opts.docId}` },
      };
      writeFileSync(join(dir, `${opts.docId}.json`), JSON.stringify(ir));
      return ir;
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

/**
 * Build a minimal real zip (stored entries). CRC fields are zeroed —
 * `extractZip` never verifies them. This keeps the upload tests free of any
 * archiving dependency. (Same construction as upload.test.ts's local copy.)
 */
export function makeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 10); // method
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const count = Object.keys(entries).length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(count, 8); // entries on this disk
  eocd.writeUInt16LE(count, 10); // entries total
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  return Buffer.concat([...locals, cd, eocd]);
}

/** A minimal legal LaTeX project (the upload success path's payload). */
export const UPLOAD_ZIP = makeZip({
  "main.tex": [
    "\\documentclass{article}",
    "\\title{Uploaded Paper}",
    "\\begin{document}",
    "\\maketitle",
    "Hello world.",
    "\\end{document}",
    "",
  ].join("\n"),
});
