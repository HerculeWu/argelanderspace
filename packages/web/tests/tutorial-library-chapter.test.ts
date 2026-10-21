import type { Job, PageContext } from "@argelanderspace/contracts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeRungs } from "../src/tutorial/anchors";
import { CHAPTERS } from "../src/tutorial/chapters";
import {
  EVANS_OH_2022_ARXIV,
  EVANS_OH_2022_BIBTEX,
  EVANS_OH_2022_UPLOAD_DOC_ID,
  EVANS_OH_2022_WORK_ID,
  LIBRARY,
} from "../src/tutorial/chapters/library";
import { watchSources } from "../src/tutorial/l2";
import { SAMPLE_WORK_IDS } from "../src/tutorial/sample-ids";
import type { GateRun, StepDefinition, WorkbenchSnapshot } from "../src/tutorial/types";
import { fakeBus } from "./fake-ws";
import { fakePage, fakeSnapshot } from "./tutorial-fixtures";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
const fetchLibrary = vi.fn();
vi.mock("../src/api/library", () => ({ fetchLibrary: () => fetchLibrary() }));

// in-app-tutorial ticket 20: chapter 2 "library" (appendix A) against fake snapshots — gates, requirements, ladders —
// and its two L2 sources on the fake ws bus.

const step = (id: string): StepDefinition => {
  const s = LIBRARY.steps.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};
const runOf = (baseline: WorkbenchSnapshot): GateRun => ({ baseline, memo: {} });

const ROSER = SAMPLE_WORK_IDS.roser2019;
const JERABKOVA = SAMPLE_WORK_IDS.jerabkova2021;
const EVANS = { id: EVANS_OH_2022_WORK_ID, arxiv_id: EVANS_OH_2022_ARXIV, title: "Mass Segregation in the Hyades Cluster" };

/** A library page with `selected` open in the detail panel (null: nothing selected). */
function libraryPage(selected: { id: string; arxiv_id?: string } | null, tab = "meta"): PageContext {
  const page = fakePage("library") as unknown as Record<string, unknown>;
  return {
    ...page,
    library: {
      source: "live",
      query: "",
      total: 5,
      matched: 5,
      refs: [],
      links: [],
      selectedRefId: selected?.id ?? null,
      detail: selected ? { ref: { ...selected, title: "t", authors: "a", year: 2022, venue: "v", type: "article", cite: "k", tags: [], pdf: false, read: false, star: false }, bibtex: "", tab } : null,
      temporaryLabels: {},
      sidebarCollapsed: false,
      graph: { labelsOn: false },
    },
  } as unknown as PageContext;
}
const onLibrary = (selected: { id: string; arxiv_id?: string } | null, data: Record<string, unknown> = {}, tab = "meta") =>
  fakeSnapshot({ page: libraryPage(selected, tab), data });

const sampleRefs = Object.values(SAMPLE_WORK_IDS).map((id) => ({ id, ...(id === JERABKOVA ? { doc_ids: ["arxiv-2103.12080"] } : {}) }));

describe("chapter 2 is registered after chapter 1, with the appendix A steps", () => {
  it("chapter id, number and step order", () => {
    expect(CHAPTERS.map((c) => c.id).slice(0, 3)).toEqual(["prepare", "tour", "library"]);
    expect(LIBRARY.n).toBe(2);
    expect(LIBRARY.steps.map((s) => s.id)).toEqual([
      "library.list",
      "library.work-vs-doc",
      "library.add-bibtex",
      "library.acquisition",
      "library.upload-source",
      "library.cite-key",
      "library.agent",
    ]);
  });
  it("only 2.2, 2.3 and 2.5 are gated; only 2.5 needs TeX; 2.A is the agent card without an anchor", () => {
    expect(LIBRARY.steps.filter((s) => s.gate).map((s) => s.id)).toEqual(["library.work-vs-doc", "library.add-bibtex", "library.upload-source"]);
    expect(LIBRARY.steps.filter((s) => s.needsTex).map((s) => s.id)).toEqual(["library.upload-source"]);
    expect(step("library.agent").kind).toBe("agent");
    expect(step("library.agent").anchors).toEqual([]);
    expect(step("library.agent").requires).toBeUndefined();
  });
});

describe("2.1 and 2.2: the library and Work versus Doc", () => {
  it("2.1 looks at the work list on the library page; away from it, the take-me-there is switch_view library", () => {
    const s = step("library.list");
    expect(s.gate).toBeUndefined();
    expect(s.anchors.map((a) => a.ui)).toEqual(["library-view", "work-list"]);
    expect(s.requires!.test(fakeSnapshot({ view: "library" }))).toBe(true);
    expect(s.requires!.test(fakeSnapshot({ view: "settings" }))).toBe(false);
    expect(s.requires!.where).toBe("library");
    expect(s.requires!.takeMeThere).toEqual({ action: "switch_view", view: "library" });
  });
  it("2.2 passes when Röser 2019 is selected with its details on the Full text tab (L1; parent ruling: selection alone held at once)", () => {
    const gate = step("library.work-vs-doc").gate!;
    const roserFiles = onLibrary({ id: ROSER }, {}, "files");
    expect(gate(roserFiles, runOf(roserFiles))).toBe(true);
    const roserMeta = onLibrary({ id: ROSER });
    expect(gate(roserMeta, runOf(roserMeta))).toBe(false);
    const other = onLibrary({ id: JERABKOVA }, {}, "files");
    expect(gate(other, runOf(other))).toBe(false);
    const none = onLibrary(null);
    expect(gate(none, runOf(none))).toBe(false);
    const away = fakeSnapshot({ view: "settings" });
    expect(gate(away, runOf(away))).toBe(false);
  });
  it("2.2's ladder: Röser's list row, its detail panel, its Full text tab, the Full text panel", () => {
    expect(step("library.work-vs-doc").anchors).toEqual([
      { ui: "work-item", key: ROSER },
      { ui: "work-detail", key: ROSER },
      { ui: "tab", key: "files", within: { ui: "work-detail", key: ROSER } },
      { ui: "work-fulltext" },
    ]);
    expect(step("library.work-vs-doc").requires!.where).toBe("library");
  });
});

describe("2.3: a BibTeX entry adds Evans & Oh 2022 (L2: library.changed → GET /api/library)", () => {
  const gate = step("library.add-bibtex").gate!;
  it("passes once the read-back library holds a Work with arXiv 2202.06973", () => {
    const before = onLibrary(null, { library: { live: true, refs: sampleRefs } });
    expect(gate(before, runOf(before))).toBe(false);
    const after = onLibrary(null, { library: { live: true, refs: [...sampleRefs, EVANS] } });
    expect(gate(after, runOf(before))).toBe(true);
  });
  it("does not pass on the built-in example the client falls back to, nor before the first read", () => {
    const demo = onLibrary(null, { library: { live: false, refs: [EVANS] } });
    expect(gate(demo, runOf(demo))).toBe(false);
    const unread = onLibrary(null);
    expect(gate(unread, runOf(unread))).toBe(false);
  });
  it("its source is the library read back on library.changed; the prepared text is the BibTeX constant", () => {
    const s = step("library.add-bibtex");
    expect(s.sources?.map((x) => x.id)).toEqual(["library"]);
    expect(s.preparedText).toBe(EVANS_OH_2022_BIBTEX);
    expect(s.preparedCopy).toBeFalsy();
    expect(s.anchors).toEqual([
      { ui: "open-import-menu" },
      { ui: "import-option", key: "bib" },
      { ui: "import-dialog", key: "bib" },
      { ui: "submit-import" },
    ]);
    expect(s.requires!.test(fakeSnapshot({ view: "library" }))).toBe(true);
    expect(s.requires!.test(fakeSnapshot({ view: "plan" }))).toBe(false);
  });
  it("the BibTeX names the DOI and arXiv id the definitions use, and its cite key is not one of the sample's", () => {
    expect(EVANS_OH_2022_BIBTEX).toContain("doi           = {10.1093/mnras/stac707}");
    expect(EVANS_OH_2022_BIBTEX).toContain(`eprint        = {${EVANS_OH_2022_ARXIV}}`);
    // The Work id the product derives from a BibTeX entry with a DOI (core canonicalId: `doi:` + the lower-case DOI).
    expect(EVANS_OH_2022_WORK_ID).toBe("doi:10.1093/mnras/stac707");
    const library = JSON.parse(
      readFileSync(join(fileURLToPath(new NodeURL("../../../tutorial-sample/literatures/library/library.json", import.meta.url))), "utf8"),
    ) as { works: { id: string; cite_key?: string; arxiv_id?: string }[] };
    const key = /@article\{([^,]+),/.exec(EVANS_OH_2022_BIBTEX)?.[1];
    expect(key).toBe("evans2022hyades");
    expect(library.works.map((w) => w.cite_key)).not.toContain(key);
    expect(library.works.map((w) => w.id)).not.toContain(EVANS_OH_2022_WORK_ID);
    expect(library.works.map((w) => w.arxiv_id)).not.toContain(EVANS_OH_2022_ARXIV);
  });
});

describe("2.4: the four ways to a full text (requires Evans & Oh selected)", () => {
  const s = step("library.acquisition");
  it("requires Evans & Oh 2022 in the detail panel; the take-me-there selects it", () => {
    expect(s.requires!.test(onLibrary({ id: EVANS.id, arxiv_id: EVANS_OH_2022_ARXIV }))).toBe(true);
    expect(s.requires!.test(onLibrary({ id: EVANS.id }))).toBe(true);
    expect(s.requires!.test(onLibrary({ id: ROSER }))).toBe(false);
    expect(s.requires!.test(onLibrary(null))).toBe(false);
    expect(s.requires!.test(fakeSnapshot({ view: "settings" }))).toBe(false);
    expect(s.requires!.where).toBe("workDetail");
    expect(s.requires!.whereValues).toEqual({ work: "Evans & Oh 2022" });
    expect(s.requires!.takeMeThere).toEqual({ action: "select_work", refId: EVANS_OH_2022_WORK_ID });
  });
  it("a look step whose lowest rung is the detail's Full text tab, then the tab's Get full text button, then the dialog", () => {
    expect(s.gate).toBeUndefined();
    expect(s.anchors).toEqual([
      { ui: "tab", key: "files", within: { ui: "work-detail" } },
      { ui: "work-fulltext" },
      { ui: "gather-doc" },
      { ui: "fulltext-acquisition-methods" },
    ]);
  });
});

describe("2.5: upload the source archive (L2: job.done upload for that Work, and the Work read back has a Doc)", () => {
  const s = step("library.upload-source");
  const gate = s.gate!;
  const evansNoDoc = { ...EVANS };
  const evansDoc = { ...EVANS, doc_ids: ["upload-doi-10-1093-mnras-stac707-abcdef"] };
  const snap = (refs: object[], uploadedWorkIds: string[]) => onLibrary({ id: EVANS.id, arxiv_id: EVANS_OH_2022_ARXIV }, { upload: { live: true, refs: [...sampleRefs, ...refs], uploadedWorkIds } });
  const start = snap([evansNoDoc], []);

  it("passes when an upload job of Evans & Oh finished and the Work has a Doc", () => {
    expect(gate(snap([evansDoc], [EVANS.id]), runOf(start))).toBe(true);
  });
  it("an upload job of another Work does not count (jobTarget must be that Work)", () => {
    expect(gate(snap([evansDoc], [JERABKOVA]), runOf(start))).toBe(false);
  });
  it("no Doc does not pass, even with the job done; nor before the first read", () => {
    expect(gate(snap([evansNoDoc], [EVANS.id]), runOf(start))).toBe(false);
    expect(gate(snap([], [EVANS.id]), runOf(start))).toBe(false);
    const unread = onLibrary({ id: EVANS.id });
    expect(gate(unread, runOf(unread))).toBe(false);
  });
  it("a Work that already had its Doc when the step started passes at once (done before, resumed, came back)", () => {
    const already = snap([evansDoc], []);
    expect(gate(already, runOf(already))).toBe(true);
  });
  it("needs TeX; the take-me-there selects Evans & Oh; Jerabkova 2021 (the no-TeX alternative) is accepted too", () => {
    expect(s.needsTex).toBe(true);
    expect(s.sources?.map((x) => x.id)).toEqual(["upload"]);
    expect(s.requires!.test(onLibrary({ id: EVANS.id }))).toBe(true);
    expect(s.requires!.test(onLibrary({ id: JERABKOVA }))).toBe(true);
    expect(s.requires!.test(onLibrary({ id: ROSER }))).toBe(false);
    expect(s.requires!.test(onLibrary(null))).toBe(false);
    expect(s.requires!.takeMeThere).toEqual({ action: "select_work", refId: EVANS_OH_2022_WORK_ID });
    expect(s.requires!.where).toBe("workDetail");
  });
  it("its ladder: Full text tab, Get full text, the upload method, the job status, the Documents list, the uploaded Doc", () => {
    expect(activeRungs(s.anchors, start)).toEqual([
      { ui: "tab", key: "files", within: { ui: "work-detail" } },
      { ui: "gather-doc" },
      { ui: "upload-latex-source" },
      { ui: "acquisition-status" },
      { ui: "work-documents" },
      { ui: "doc-item", key: EVANS_OH_2022_UPLOAD_DOC_ID },
    ]);
  });
  it("the uploaded Doc's id is the one core derives from the Work id (upload-<slug>-<6 hex of SHA-1>)", async () => {
    const { createHash } = await import("node:crypto");
    const slug = EVANS_OH_2022_WORK_ID.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 44);
    const hash = createHash("sha1").update(EVANS_OH_2022_WORK_ID).digest("hex").slice(0, 6);
    expect(EVANS_OH_2022_UPLOAD_DOC_ID).toBe(`upload-${slug}-${hash}`);
  });
});

describe("2.6 and 2.A", () => {
  it("2.6 looks at the copy-citation-key button of any selected Work", () => {
    const s = step("library.cite-key");
    expect(s.gate).toBeUndefined();
    expect(s.anchors).toEqual([{ ui: "copy-cite-key" }]);
    expect(s.requires!.test(onLibrary({ id: ROSER }))).toBe(true);
    expect(s.requires!.test(onLibrary({ id: EVANS.id }))).toBe(true);
    expect(s.requires!.test(onLibrary(null))).toBe(false);
    expect(s.requires!.test(fakeSnapshot({ view: "plan" }))).toBe(false);
    expect(s.requires!.takeMeThere).toEqual({ action: "select_work", refId: EVANS_OH_2022_WORK_ID });
  });
});

describe("chapter 2's L2 sources on the fake ws bus", () => {
  beforeEach(() => {
    fetchLibrary.mockReset();
  });
  afterEach(() => vi.useRealTimers());
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const job = (over: Partial<Job> & { payload?: unknown }): Job =>
    ({ id: "j1", kind: "upload", status: "done", createdAt: "", startedAt: null, finishedAt: null, progress: [], result: null, error: null, ...over }) as Job;

  it("2.3 reads the library at the start and again after library.changed; stops when the step is left", async () => {
    fetchLibrary.mockResolvedValue({ live: true, data: { refs: sampleRefs } });
    const seen: unknown[] = [];
    const stop = watchSources(step("library.add-bibtex").sources!, (_id, v) => seen.push(v));
    await flush();
    expect(fetchLibrary).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual({ live: true, refs: sampleRefs });
    fetchLibrary.mockResolvedValue({ live: true, data: { refs: [...sampleRefs, EVANS] } });
    fakeBus.emit("library.changed", {} as never);
    await flush();
    expect(fetchLibrary).toHaveBeenCalledTimes(2);
    expect((seen[1] as { refs: unknown[] }).refs).toHaveLength(6);
    stop();
    fakeBus.emit("library.changed", {} as never);
    await flush();
    expect(fetchLibrary).toHaveBeenCalledTimes(2);
  });

  it("2.5 remembers the Works of the upload jobs that finished while it is shown, and reads the library again", async () => {
    fetchLibrary.mockResolvedValue({ live: true, data: { refs: sampleRefs } });
    const seen: { uploadedWorkIds: string[] }[] = [];
    const stop = watchSources(step("library.upload-source").sources!, (_id, v) => seen.push(v as never));
    await flush();
    expect(seen[seen.length - 1]?.uploadedWorkIds).toEqual([]);
    // still running, another kind, a failed one: not remembered, no read
    fakeBus.emit("job.progress", { job: job({ status: "running", payload: { workId: EVANS.id } }) } as never);
    fakeBus.emit("job.done", { job: job({ kind: "ingest", payload: { workId: EVANS.id } }) } as never);
    fakeBus.emit("job.failed", { job: job({ status: "failed", payload: { workId: EVANS.id } }) } as never);
    await flush();
    expect(fetchLibrary).toHaveBeenCalledTimes(1);
    fakeBus.emit("job.done", { job: job({ payload: { workId: EVANS.id } }) } as never);
    await flush();
    expect(fetchLibrary).toHaveBeenCalledTimes(2);
    expect(seen[seen.length - 1]?.uploadedWorkIds).toEqual([EVANS.id]);
    stop();
    // a new showing starts with nothing remembered
    const again: { uploadedWorkIds: string[] }[] = [];
    const stop2 = watchSources(step("library.upload-source").sources!, (_id, v) => again.push(v as never));
    await flush();
    expect(again[again.length - 1]?.uploadedWorkIds).toEqual([]);
    stop2();
  });
});
