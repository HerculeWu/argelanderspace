/**
 * Manual import writes narrowly (copilot ticket 14, B1/B2): the raw library file is re-read, only the affected
 * Works change, every unknown key survives, library.bib is the same text the typed save produces, a bridging
 * record is refused for the tool and an `exists` entry reports whether the file really changed.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  addManualBibcode,
  addManualBibText,
  addManualIdentifier,
} from "../src/library/add-manual.js";
import type { MetadataSources } from "../src/library/sources.js";
import { LibraryStore, libraryPaths, workToDict } from "../src/library/store.js";
import { addManualBibText as addManualBibTextHead } from "./helpers/add-manual-head.js";

const nullSources: MetadataSources = {
  ads: { status: "no-token", resolve: async () => null, exportBibtex: async () => null },
  crossref: { resolve: async () => null },
  oa: { resolve: async () => null },
};
const seedFile = () => ({
  version: 1,
  project: { name: "Synthetic", short: "S", field: "", x_project: "keep" },
  x_top: { nested: [1, 2] },
  works: [
    {
      id: "doi:10.1/a",
      title: "Alpha galaxies",
      authors: ["Ann"],
      year: 2001,
      doi: "10.1/a",
      cite_key: "ann2001",
      doc_ids: ["d1"],
      note: "mine",
      star: true,
      read: true,
      x_work: "keep-work",
    },
    {
      id: "arxiv:2001.00001",
      title: "Beta clusters",
      authors: ["Bob"],
      year: 2002,
      arxiv_id: "2001.00001",
      cite_key: "bob2002",
      x_other: 5,
    },
    {
      id: "doi:10.1/c",
      title: "Gamma",
      authors: ["Cy"],
      year: 2003,
      doi: "10.1/c",
      cite_key: "cy2003",
    },
  ],
});
function seed() {
  const dir = mkdtempSync(join(tmpdir(), "aspace-narrow-"));
  const paths = libraryPaths(dir);
  mkdirSync(paths.libraryDir, { recursive: true });
  writeFileSync(paths.libraryJson, JSON.stringify(seedFile(), null, 2), "utf8");
  return paths;
}
const disk = (paths: ReturnType<typeof libraryPaths>) =>
  JSON.parse(readFileSync(paths.libraryJson, "utf8"));
const bytes = (paths: ReturnType<typeof libraryPaths>) => readFileSync(paths.libraryJson, "utf8");
const BIB =
  "@article{freshA,\n author={Doe, J.},\n title={A fresh paper},\n year={2024},\n journal={MNRAS}\n}\n";

test("a bib import adds the entry and keeps the top level, project, other Works and their unknown keys", async () => {
  const paths = seed();
  const out = await addManualBibText(paths, BIB);
  expect(out.map((o) => `${o.status}:${o.changed}`)).toEqual(["created:true"]);
  const after = disk(paths);
  const before = seedFile();
  expect(after.x_top).toEqual(before.x_top);
  expect(after.project).toEqual(before.project);
  expect(after.works.slice(0, 3)).toEqual(before.works);
  expect(after.works[3]).toMatchObject({ title: "A fresh paper", cite_key: "freshA" });
});

test("an identifier import that resolves nothing saves the bare stub and keeps every unknown key", async () => {
  const paths = seed();
  const out = await addManualIdentifier(paths, nullSources, { kind: "arxiv", arxiv: "2603.99999" });
  expect(out.status).toBe("created");
  const after = disk(paths);
  expect(after.works.slice(0, 3)).toEqual(seedFile().works);
  expect(after.x_top).toEqual(seedFile().x_top);
  expect(after.works[3].id).toBe("arxiv:2603.99999");
});

test("an exists entry that fills a blank field is changed; repeating it leaves the file byte-identical", async () => {
  const paths = seed();
  const entry =
    "@article{ann2001,\n author={Ann},\n title={Alpha galaxies},\n year={2001},\n doi={10.1/a},\n journal={MNRAS}\n}\n";
  const first = await addManualBibText(paths, entry);
  expect(first[0]).toMatchObject({ status: "exists", changed: true });
  expect(disk(paths).works[0]).toMatchObject({
    venue: "MNRAS",
    note: "mine",
    star: true,
    x_work: "keep-work",
  });
  const filled = bytes(paths);
  const mtime = statSync(paths.libraryJson).mtimeMs;
  const again = await addManualBibText(paths, entry);
  expect(again[0]).toMatchObject({ status: "exists", changed: false });
  expect(bytes(paths)).toBe(filled);
  expect(statSync(paths.libraryJson).mtimeMs).toBe(mtime);
});

test("an identifier that already exists reports changed:false and writes nothing", async () => {
  const paths = seed();
  const before = bytes(paths);
  const out = await addManualIdentifier(paths, nullSources, { kind: "doi", doi: "10.1/a" });
  expect(out).toMatchObject({ status: "exists", changed: false });
  expect(bytes(paths)).toBe(before);
});

// one record carrying the DOI of work A and the title of work C bridges the two
const BRIDGE =
  "@article{bridge1,\n author={Ann},\n title={Gamma},\n year={2001},\n doi={10.1/a}\n}\n";

test("a bridging record is refused as a whole in reject mode, naming both Works, with nothing written", async () => {
  const paths = seed();
  const before = bytes(paths);
  const bibBefore = existsBib(paths);
  const out = await addManualBibText(paths, `${BIB}${BRIDGE}`, { bridge: "reject" });
  expect(out.every((o) => o.status === "error")).toBe(true);
  expect(out.find((o) => o.bridged)?.bridged).toEqual(["doi:10.1/a", "doi:10.1/c"]);
  expect(out.find((o) => o.bridged)?.error).toContain("doi:10.1/c");
  expect(bytes(paths)).toBe(before);
  expect(existsBib(paths)).toBe(bibBefore);
});

test("the page's merge mode is unchanged: the bridged Work is folded into the first and removed", async () => {
  const paths = seed();
  const out = await addManualBibText(paths, BRIDGE);
  expect(out[0]).toMatchObject({ status: "exists", changed: true });
  const works = disk(paths).works as { id: string; note?: string; x_work?: string }[];
  expect(works.map((w) => w.id)).toEqual(["doi:10.1/a", "arxiv:2001.00001"]);
  // the survivor keeps its own note and unknown key (the folded Work's own note/star/read are the known loss)
  expect(works[0]).toMatchObject({ note: "mine", x_work: "keep-work" });
});

test("a single-identifier bridge is refused in reject mode", async () => {
  const paths = seed();
  const sources: MetadataSources = {
    ...nullSources,
    ads: {
      status: "ok",
      resolve: async () => null,
      exportBibtex: async () =>
        "@ARTICLE{2020A&A...1..1X,\n author={{Ann}},\n title={Gamma},\n year={2001},\n doi={10.1/a}\n}",
    },
  };
  const before = bytes(paths);
  const out = await addManualBibcode(paths, sources, "2020A&A...1..1X", { bridge: "reject" });
  expect(out.status).toBe("error");
  expect(out.bridged).toEqual(["doi:10.1/a", "doi:10.1/c"]);
  expect(bytes(paths)).toBe(before);
});

function existsBib(paths: ReturnType<typeof libraryPaths>): string | null {
  try {
    return readFileSync(paths.libraryBib, "utf8");
  } catch {
    return null;
  }
}

// ---- byte comparison against the real HEAD (typed whole-file save) implementation ---------------------- //
const noStamp = (works: object[]) => works.map((w) => ({ ...w, added_at: undefined }));
async function sameAsHead(
  initial: (paths: ReturnType<typeof libraryPaths>) => void,
  entry: string
) {
  const narrow = libraryPaths(mkdtempSync(join(tmpdir(), "aspace-narrow-new-")));
  const head = libraryPaths(mkdtempSync(join(tmpdir(), "aspace-narrow-head-")));
  for (const paths of [narrow, head]) {
    mkdirSync(paths.libraryDir, { recursive: true });
    initial(paths);
  }
  const viaNarrow = await addManualBibText(narrow, entry);
  const viaHead = await addManualBibTextHead(head, entry);
  expect(viaNarrow.map((o) => `${o.status}:${o.ref?.id}:${o.key}`)).toEqual(
    viaHead.map((o) => `${o.status}:${o.ref?.id}:${o.key}`)
  );
  expect(readFileSync(narrow.libraryBib, "utf8")).toBe(readFileSync(head.libraryBib, "utf8"));
  // the typed projection of both files (what every typed reader sees) is the same
  const project = (paths: ReturnType<typeof libraryPaths>) =>
    noStamp(LibraryStore.load(paths).works.map(workToDict));
  expect(project(narrow)).toEqual(project(head));
}
const seedInto = (paths: ReturnType<typeof libraryPaths>) =>
  writeFileSync(paths.libraryJson, JSON.stringify(seedFile(), null, 2), "utf8");
const fixtureInto = (paths: ReturnType<typeof libraryPaths>) =>
  writeFileSync(
    paths.libraryJson,
    readFileSync(new URL("./fixtures/library.json", import.meta.url))
  );

test("a created entry: library.bib and the typed projection equal what HEAD's typed save wrote (seed and core fixture)", async () => {
  await sameAsHead(seedInto, BIB);
  await sameAsHead(fixtureInto, BIB);
});

test("an exists entry that fills fields: library.bib equals HEAD's", async () => {
  await sameAsHead(
    seedInto,
    "@article{ann2001,\n author={Ann},\n title={Alpha galaxies},\n year={2001},\n doi={10.1/a},\n journal={MNRAS}\n}\n"
  );
});

test("a bridging record in merge mode (a Work deleted): library.bib equals HEAD's", async () => {
  await sameAsHead(seedInto, BRIDGE);
});

// ---- id collisions: two different papers, one derived `work:` id ------------------------------------------- //
const SERIES = "Observations of the open cluster population of the Milky Way";
const t1 = `${SERIES} I. Survey`;
const t2 = `${SERIES} II. Ages`;
const entry = (key: string, title: string, year = 2020) =>
  `@article{${key},\n author={${key}},\n title={${title}},\n year={${year}}\n}\n`;
const seriesSeed = (titles: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "aspace-series-"));
  const paths = libraryPaths(dir);
  mkdirSync(paths.libraryDir, { recursive: true });
  const file = {
    version: 1,
    project: { name: "S", short: "S", field: "" },
    works: titles.map((title, i) => ({
      id: `work:${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 48)
        .replace(/-$/, "")}-2020`,
      title,
      authors: [`Ann${i}`],
      year: 2020,
      type: "article",
      cite_key: `ann${i}`,
      origin: "bib",
      note: `my note ${i}`,
      star: true,
      read: true,
      x_keep: i,
    })),
  };
  writeFileSync(paths.libraryJson, JSON.stringify(file, null, 2), "utf8");
  return paths;
};

test("series paper II against a stored paper I with the same derived id: refused with a reason, paper I untouched", async () => {
  const paths = seriesSeed([t1]);
  const before = bytes(paths);
  const out = await addManualBibText(paths, entry("bob2020", t2));
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ status: "error" });
  expect(out[0]?.error).toContain("already used by a different paper");
  expect(bytes(paths)).toBe(before);
  const kept = disk(paths).works;
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({
    title: t1,
    note: "my note 0",
    star: true,
    read: true,
    x_keep: 0,
    cite_key: "ann0",
  });
});

test("papers I and II in one batch: the first is created, the second is refused, and the results match the disk", async () => {
  const paths = seriesSeed([]);
  const out = await addManualBibText(paths, entry("ann2020", t1) + entry("bob2020", t2));
  expect(out.map((o) => o.status)).toEqual(["created", "error"]);
  const works = disk(paths).works;
  expect(works).toHaveLength(1);
  expect(works[0]).toMatchObject({ title: t1, cite_key: "ann2020" });
  expect(out[0]?.ref?.id).toBe(works[0].id);
  expect((readFileSync(paths.libraryBib, "utf8").match(/^@/gm) ?? []).length).toBe(1);
});

test("two untitled entries of one year share `work:work-YYYY`: the second is refused and the first is untouched", async () => {
  const paths = seriesSeed([]);
  const bare = (key: string) => `@misc{${key},\n author={${key}},\n year={2021}\n}\n`;
  const out = await addManualBibText(paths, bare("first") + bare("second"));
  expect(out.map((o) => o.status)).toEqual(["created", "error"]);
  expect(disk(paths).works.map((w: { cite_key: string }) => w.cite_key)).toEqual(["first"]);
  // across batches too
  const again = await addManualBibText(paths, bare("third"));
  expect(again[0]?.status).toBe("error");
  expect(disk(paths).works).toHaveLength(1);
});

test("a created Work is never merged into a stored one; a refused entry does not hide the other entries' results", async () => {
  const paths = seriesSeed([t1]);
  const out = await addManualBibText(
    paths,
    entry("bob2020", t2) + entry("carl2020", "A wholly different paper")
  );
  expect(out.map((o) => o.status)).toEqual(["error", "created"]);
  const works = disk(paths).works;
  expect(works.map((w: { title: string }) => w.title)).toEqual([t1, "A wholly different paper"]);
  expect(works[0]).toMatchObject({ note: "my note 0", x_keep: 0 });
  expect(works[1].note).toBeUndefined();
});

test("an identifier whose derived id is taken is refused through the shared tail too", async () => {
  const paths = seriesSeed([t1]);
  const sources: MetadataSources = {
    ...nullSources,
    ads: {
      status: "ok",
      resolve: async () => null,
      exportBibtex: async () =>
        `@ARTICLE{2020A&A...1..2Y,\n author={{Bob}},\n title={${t2}},\n year={2020}\n}`,
    },
  };
  const before = bytes(paths);
  const out = await addManualBibcode(paths, sources, "2020A&A...1..2Y");
  // a bibcode import gets id work:...; the series collision is refused with the same reason
  expect(out.status).toBe("error");
  expect(out.error).toContain("already used by a different paper");
  expect(bytes(paths)).toBe(before);
});

test("reject mode keeps each entry's own error, and words a bridge into a batch-created Work accurately", async () => {
  const paths = seed();
  const before = bytes(paths);
  // entry 1 clashes on its cite key (held by another work); entry 2 is new; entry 3 bridges entry 2 and work 3
  const clash = "@article{bob2002,\n author={Evil},\n title={Clash},\n year={1900}\n}\n";
  const fresh =
    "@article{fresh2,\n author={Doe},\n title={Gamma bridge target},\n year={2005},\n doi={10.9/zz}\n}\n";
  const bridge =
    "@article{bridge2,\n author={Doe},\n title={Gamma bridge target},\n year={2005},\n doi={10.9/zz},\n eprint={2001.00001}\n}\n";
  const out = await addManualBibText(paths, clash + fresh + bridge, { bridge: "reject" });
  expect(out[0]?.error).toContain("already used by another work");
  expect(out[1]?.status).toBe("error");
  expect(out[1]?.error).toContain("refused");
  expect(out[2]?.bridged?.length).toBe(2);
  expect(out[2]?.error).toContain("created earlier in this import");
  expect(out[2]?.error).not.toContain("existing works");
  expect(bytes(paths)).toBe(before);
});

test("a hand-edited numeric work id is matched like its string form, so the import still updates it", async () => {
  const paths = seed();
  const file = seedFile();
  (file.works[0] as Record<string, unknown>).id = 5;
  writeFileSync(paths.libraryJson, JSON.stringify(file, null, 2), "utf8");
  const entry =
    "@article{ann2001,\n author={Ann},\n title={Alpha galaxies},\n year={2001},\n doi={10.1/a},\n journal={MNRAS}\n}\n";
  const [result] = await addManualBibText(paths, entry);
  expect(result).toMatchObject({ status: "exists", changed: true });
  const works = disk(paths).works;
  expect(works).toHaveLength(3);
  expect(works[0]).toMatchObject({ venue: "MNRAS", note: "mine", x_work: "keep-work" });
  expect(works[1]).toMatchObject({ x_other: 5 });
});
