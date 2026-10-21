// "The tutorial sample is loadable" (in-app-tutorial ticket 16, spec Testing Decisions): the frozen sample committed
// at the repository root (tutorial-sample/) still loads with the product's own readers. Run on a temp copy, never on
// the sample itself. ① the Doc's IR, ⑥ the bundled discovery cache answers the Röser discovery offline, ⑦ the library
// graph heals to exactly the citations among the five Works the spec lists (Röser↔Meingast, Jerabkova→Röser/Meingast,
// Kroupa→Röser/Meingast/Jerabkova, Pflamm-Altenburg→Jerabkova/Kroupa: nine directed edges; the spec's count "7" does
// not match its own list, see ticket 16's comments). ②–⑤ (annotations, argument graph, plan,
// manuscript, Copilot session) come with ticket 17. A red test here means the sample has to be regenerated with
// packages/app/scripts/tutorial-sample.mjs (or the product changed a format the sample relies on).
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverLiterature,
  healGraph,
  LibraryStore,
  libraryPaths,
  loadStoredDocIr,
} from "@argelanderspace/core";
import { AdsDiscoveryClient } from "@argelanderspace/infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SAMPLE = fileURLToPath(new URL("../../../tutorial-sample", import.meta.url));
const DOC = "arxiv-2103.12080";
const ROSER = "2019A&A...621L...2R";
const MEINGAST = "2019A&A...621L...3M";
const JERABKOVA = "2021A&A...647A.137J";
const W = {
  roser: "doi:10.1051/0004-6361/201834608",
  meingast: "doi:10.1051/0004-6361/201834622",
  jerabkova: "doi:10.1051/0004-6361/202039949",
  pflamm: "doi:10.1051/0004-6361/202244243",
  kroupa: "doi:10.1093/mnras/stac2563",
};

let root: string;
let dataDir: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tutorial-sample-"));
  cpSync(SAMPLE, join(root, "sample"), { recursive: true });
  dataDir = join(root, "sample", "literatures");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the tutorial sample's layout", () => {
  it("has the marker with exactly version and sample, the notice and the upload zip", () => {
    const marker = JSON.parse(readFileSync(join(SAMPLE, "argelanderspace-tutorial.json"), "utf8"));
    expect(Object.keys(marker).sort()).toEqual(["sample", "version"]);
    expect(marker.version).toBe(1);
    expect(Number.isInteger(marker.sample)).toBe(true);
    expect(existsSync(join(SAMPLE, "NOTICE.md"))).toBe(true);
    expect(existsSync(join(SAMPLE, "tutorial-assets", "evans-oh-2022-source.zip"))).toBe(true);
    expect(existsSync(join(SAMPLE, "status", "plans.json"))).toBe(true);
  });

  it("carries none of the derived or runtime parts of a project", () => {
    const lit = join(SAMPLE, "literatures");
    for (const absent of [
      "library/graph.json",
      "library/cache/graph.json",
      "library/library.bib",
      "jobs",
      "logs",
      "input",
      `output/${DOC}/src`,
      `output/${DOC}/build`,
    ])
      expect(existsSync(join(lit, absent)), absent).toBe(false);
    expect(readdirSync(join(lit, "output"))).toEqual([DOC]);
    expect(readdirSync(join(lit, `output/${DOC}`)).sort()).toEqual([
      "arxiv-2103.12080.json",
      "assets",
    ]);
    // the discovery cache is the only cache the sample carries
    const cache = join(lit, "library", "cache");
    if (existsSync(cache)) expect(readdirSync(cache)).toEqual(["ads-discovery"]);
  });
});

describe("the tutorial sample loads", () => {
  it("① the Jerabkova IR reads through loadStoredDocIr", () => {
    const ir = loadStoredDocIr(dataDir, DOC);
    expect(ir.docId).toBe(DOC);
    expect(ir.sections.length).toBeGreaterThan(0);
    const store = LibraryStore.load(libraryPaths(dataDir));
    expect(store.works.find((w) => w.doc_ids.includes(DOC))?.id).toBe(W.jerabkova);
  });

  it("⑥ the bundled discovery cache answers the Röser discovery with no token and no network", async () => {
    const cacheDir = join(dataDir, "library", "cache", "ads-discovery");
    expect(
      existsSync(cacheDir),
      "tutorial-sample has no ADS discovery cache: run `node packages/app/scripts/tutorial-sample.mjs cache`"
    ).toBe(true);
    const before = readdirSync(cacheDir).sort();
    let fetched = 0;
    const ads = new AdsDiscoveryClient({
      cacheDir,
      token: null,
      fetchImpl: () => {
        fetched += 1;
        throw new Error("the tutorial must not reach the network");
      },
    });
    const store = LibraryStore.load(libraryPaths(dataDir));
    const graph = await discoverLiterature(ROSER, { ads, store });
    expect(graph).not.toBeNull();
    if (graph === null) return;
    expect(graph.warnings).toEqual([]);
    const related = graph.nodes.filter((n) => n.roles.includes("related"));
    const useful = graph.nodes.filter((n) => n.roles.includes("useful"));
    expect(related.length).toBeGreaterThan(0);
    expect(useful.length).toBeGreaterThan(0);
    for (const bibcode of [MEINGAST, JERABKOVA]) {
      const node = graph.nodes.find((n) => n.bibcode === bibcode);
      expect(node, bibcode).toBeDefined();
      expect(node?.libraryId, bibcode).not.toBeNull();
    }
    expect(fetched).toBe(0);
    expect(readdirSync(cacheDir).sort()).toEqual(before);
    for (const name of before) {
      const entry = JSON.parse(readFileSync(join(cacheDir, name), "utf8"));
      expect(entry.pinned, name).toBe(true);
      for (const doc of entry.data) expect(Object.hasOwn(doc, "abstract"), name).toBe(false);
    }
  });

  it("⑦ the healed library graph has exactly the listed citations among the five Works", () => {
    const graph = healGraph(libraryPaths(dataDir));
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(Object.values(W).sort());
    expect(graph.links.map(([a, b]) => `${a} -> ${b}`).sort()).toEqual(
      [
        [W.roser, W.meingast],
        [W.meingast, W.roser],
        [W.jerabkova, W.roser],
        [W.jerabkova, W.meingast],
        [W.kroupa, W.roser],
        [W.kroupa, W.meingast],
        [W.kroupa, W.jerabkova],
        [W.pflamm, W.jerabkova],
        [W.pflamm, W.kroupa],
      ]
        .map(([a, b]) => `${a} -> ${b}`)
        .sort()
    );
  });
});
