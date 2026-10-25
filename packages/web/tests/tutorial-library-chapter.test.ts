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
import { SAMPLE_JERABKOVA_ARXIV, SAMPLE_WORK_IDS } from "../src/tutorial/sample-ids";
import type { GateRun, StepDefinition, WorkbenchSnapshot } from "../src/tutorial/types";
import { fakeBus } from "./fake-ws";
import { shelfAddPassed, type ShelfReadback } from "../src/tutorial/chapters/library";
import { fakeDom, fakePage, fakeSnapshot } from "./tutorial-fixtures";
import { alignPosition, chapterStatus, chapterSummary, nextStepId, recordOf } from "../src/tutorial/machine";
import { WHERE_KEYS } from "../src/tutorial/types";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
const fetchLibrary = vi.fn();
vi.mock("../src/api/library", () => ({ fetchLibrary: () => fetchLibrary() }));
const fetchShelf = vi.fn();
vi.mock("../src/api/shelf", () => ({
  fetchShelf: (signal?: AbortSignal) => fetchShelf(signal),
  onShelfChanged: (cb: (msg: unknown) => void) => fakeBus.on("shelf.changed", cb as never),
}));

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
      "library.shelf-add",
      "library.shelf-browse",
      "library.shelf-take",
      "library.agent",
    ]);
  });
  it("only 2.2, 2.3, 2.5, 2.7 and 2.8 are gated; only 2.5 needs TeX; 2.A is the agent card without an anchor", () => {
    expect(LIBRARY.steps.filter((s) => s.gate).map((s) => s.id)).toEqual(["library.work-vs-doc", "library.add-bibtex", "library.upload-source", "library.shelf-add", "library.shelf-browse"]);
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

// tutorial-shelf ticket 02: 2.7 adds Jerabkova 2021 to the person's own Shelf (L2: shelf.changed → GET /api/shelf).
describe("2.7: add Jerabkova 2021 to the Shelf (L2: shelf.changed add / replace, then GET /api/shelf)", () => {
  const s = step("library.shelf-add");
  const PROJECT = "/tmp/tutorial-project";
  /** A Shelf row as the gate reads it: id, rev, identity and where it was added from. */
  const row = (entryId: string, rev: number, over: { arxiv?: string | null; project?: string } = {}) => ({
    entryId,
    rev,
    arxiv: over.arxiv === undefined ? SAMPLE_JERABKOVA_ARXIV : over.arxiv,
    project: over.project ?? PROJECT,
  });
  const shelf = (...entries: ReturnType<typeof row>[]): ShelfReadback => ({ entries });
  const snap = (data: ShelfReadback | null, projectRoot: string | null = PROJECT) =>
    ({ ...onLibrary({ id: JERABKOVA }, data ? { shelf: data } : {}), projectRoot }) as WorkbenchSnapshot;

  describe("the predicate on fake snapshots", () => {
    it("an entry the user already had (any source) does not pass the step at its start", () => {
      const start = shelf(row("e1", 1), row("e2", 3, { project: "/home/me/other" }));
      expect(shelfAddPassed(start, start, PROJECT)).toBe(false);
      const gate = s.gate!;
      expect(gate(snap(start), runOf(snap(start)))).toBe(false);
    });
    it("an add in this project after the baseline passes", () => {
      const start = shelf(row("e9", 1, { arxiv: "2401.00001" }));
      const now = shelf(row("e9", 1, { arxiv: "2401.00001" }), row("e1", 1));
      expect(shelfAddPassed(now, start, PROJECT)).toBe(true);
      expect(s.gate!(snap(now), runOf(snap(start)))).toBe(true);
    });
    it("a replace in this project after the baseline passes (same entry id, higher rev)", () => {
      const start = shelf(row("e1", 1));
      const now = shelf(row("e1", 2));
      expect(shelfAddPassed(now, start, PROJECT)).toBe(true);
    });
    it("a replace whose result came from another project does not pass; nor an add from another project", () => {
      const start = shelf(row("e1", 1));
      expect(shelfAddPassed(shelf(row("e1", 2, { project: "/home/me/other" })), start, PROJECT)).toBe(false);
      expect(shelfAddPassed(shelf(row("e1", 1), row("e2", 1, { project: "/home/me/other" })), start, PROJECT)).toBe(false);
    });
    it("another paper added here does not pass", () => {
      const start = shelf();
      expect(shelfAddPassed(shelf(row("e3", 1, { arxiv: "2202.06973" })), start, PROJECT)).toBe(false);
      expect(shelfAddPassed(shelf(row("e3", 1, { arxiv: null })), start, PROJECT)).toBe(false);
    });
    it("a trailing separator on the project path is the same project; an unknown project or an unread Shelf never passes", () => {
      const start = shelf();
      expect(shelfAddPassed(shelf(row("e1", 1)), start, `${PROJECT}/`)).toBe(true);
      expect(shelfAddPassed(shelf(row("e1", 1)), start, null)).toBe(false);
      const unread = onLibrary({ id: JERABKOVA });
      expect(s.gate!(unread, runOf(unread))).toBe(false);
      expect(s.gate!(snap(shelf(row("e1", 1))), runOf(snap(null)))).toBe(false);
    });
    it("a deleted entry never passes", () => {
      const start = shelf(row("e1", 1));
      expect(shelfAddPassed(shelf(), start, PROJECT)).toBe(false);
    });
  });
  it("requires Jerabkova 2021 selected; the take-me-there selects it; the ladder is the button, the dialog, its submit", () => {
    expect(s.requires!.test(onLibrary({ id: JERABKOVA }))).toBe(true);
    expect(s.requires!.test(onLibrary({ id: ROSER }))).toBe(false);
    expect(s.requires!.test(onLibrary(null))).toBe(false);
    expect(s.requires!.where).toBe("workDetail");
    expect(s.requires!.whereValues).toEqual({ work: "Jerabkova 2021" });
    expect(s.requires!.takeMeThere).toEqual({ action: "select_work", refId: JERABKOVA });
    expect(s.kind).toBe("do");
    expect(s.needsTex).toBeFalsy();
    expect(s.anchors).toEqual([{ ui: "add-work-to-shelf" }, { ui: "add-to-shelf-dialog" }, { ui: "submit-add-to-shelf" }]);
    expect(s.sources?.map((x) => x.id)).toEqual(["shelf"]);
  });

  describe("its L2 source on the fake ws bus", () => {
    beforeEach(() => fetchShelf.mockReset());
    afterEach(() => vi.useRealTimers());
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const answer = (...rows: { entryId: string; rev: number; project: string; arxiv: string | null }[]) => ({
      ok: true as const,
      value: {
        entries: rows.map((r) => ({
          status: "ok",
          entryId: r.entryId,
          rev: r.rev,
          source: { project: r.project, workId: "w" },
          identity: { doi: null, arxiv: r.arxiv, openalex: null },
        })),
      },
    });
    const changed = (cause: "add" | "replace" | "delete") =>
      fakeBus.emit("shelf.changed", { type: "shelf.changed", cause, entry_id: "e1", rev: 1, removed: [], at: "2026-10-24T00:00:00.000Z" } as never);

    it("reads once at the start and again after an add or a replace; a delete does not read; leaving the step unsubscribes", async () => {
      fetchShelf.mockResolvedValue(answer());
      const seen: ShelfReadback[] = [];
      const stop = watchSources(s.sources!, (_id, v) => seen.push(v as ShelfReadback));
      await flush();
      expect(fetchShelf).toHaveBeenCalledTimes(1);
      expect(seen[0]).toEqual({ entries: [] });
      changed("delete");
      await flush();
      expect(fetchShelf).toHaveBeenCalledTimes(1);
      fetchShelf.mockResolvedValue(answer({ entryId: "e1", rev: 1, project: PROJECT, arxiv: SAMPLE_JERABKOVA_ARXIV }));
      changed("add");
      await flush();
      expect(fetchShelf).toHaveBeenCalledTimes(2);
      expect(seen[1]).toEqual({ entries: [{ entryId: "e1", rev: 1, arxiv: SAMPLE_JERABKOVA_ARXIV, project: PROJECT }] });
      changed("replace");
      await flush();
      expect(fetchShelf).toHaveBeenCalledTimes(3);
      stop();
      changed("add");
      changed("replace");
      await flush();
      expect(fetchShelf).toHaveBeenCalledTimes(3);
    });
    it("there is no subscription before the step is shown (no read, no listener)", async () => {
      fetchShelf.mockResolvedValue(answer());
      changed("add");
      await flush();
      expect(fetchShelf).not.toHaveBeenCalled();
    });
    it("rows that cannot be read as entries (damaged, incompatible) are not entries of that paper; a failed read gives no data", async () => {
      fetchShelf.mockResolvedValue({
        ok: true,
        value: { entries: [{ status: "damaged", entryId: "e5", rev: 1, bytes: 1, problem: "x" }, answer({ entryId: "e1", rev: 1, project: PROJECT, arxiv: SAMPLE_JERABKOVA_ARXIV }).value.entries[0]] },
      });
      const seen: ShelfReadback[] = [];
      const stop = watchSources(s.sources!, (_id, v) => seen.push(v as ShelfReadback));
      await flush();
      expect(seen[0]!.entries.map((e) => e.entryId)).toEqual(["e1"]);
      stop();
      fetchShelf.mockResolvedValue({ ok: false, status: 500, code: "shelf_unreadable", detail: "", body: {} });
      const failed: unknown[] = [];
      const stop2 = watchSources(s.sources!, (_id, v) => failed.push(v));
      await flush();
      expect(failed).toEqual([]);
      stop2();
    });
  });
});

// tutorial-shelf ticket 03: 2.8 opens the Shelf dialog (L3), 2.9 looks at taking and deleting in it (requires it open).
describe("2.8: open the Shelf from the import menu (L3: the Shelf dialog appears)", () => {
  const s = step("library.shelf-browse");
  const withDialog = (open: boolean) => ({ ...onLibrary({ id: JERABKOVA }), dom: fakeDom(open ? { "shelf-dialog": {} } : {}) }) as WorkbenchSnapshot;
  it("is a do step gated on the Shelf dialog being on the page, with no L2 source", () => {
    expect(s.kind).toBe("do");
    expect(s.needsTex).toBeFalsy();
    expect(s.sources).toBeUndefined();
    const closed = withDialog(false);
    expect(s.gate!(closed, runOf(closed))).toBe(false);
    const open = withDialog(true);
    expect(s.gate!(open, runOf(closed))).toBe(true);
  });
  it("another dialog or the import menu alone does not pass it", () => {
    const other = { ...onLibrary({ id: JERABKOVA }), dom: fakeDom({ "dialog-overlay": {}, "import-dialog[bib]": {}, "import-menu": {} }) } as WorkbenchSnapshot;
    expect(s.gate!(other, runOf(other))).toBe(false);
  });
  it("requires the library view (take-me-there: switch_view library); the ladder is the import menu button, the Shelf option, the dialog", () => {
    expect(s.requires!.test(fakeSnapshot({ view: "library" }))).toBe(true);
    expect(s.requires!.test(fakeSnapshot({ view: "plan" }))).toBe(false);
    expect(s.requires!.where).toBe("library");
    expect(s.requires!.takeMeThere).toEqual({ action: "switch_view", view: "library" });
    expect(s.anchors).toEqual([{ ui: "open-import-menu" }, { ui: "import-option", key: "shelf" }, { ui: "shelf-dialog" }]);
  });
});

describe("2.9: taking and deleting (a look step that requires the Shelf dialog open)", () => {
  const s = step("library.shelf-take");
  it("is a look step with no gate and no source; the ladder ends at the dialog's Delete button", () => {
    expect(s.kind).toBe("look");
    expect(s.gate).toBeUndefined();
    expect(s.sources).toBeUndefined();
    expect(s.anchors).toEqual([{ ui: "shelf-dialog" }, { ui: "delete-shelf-entry", within: { ui: "shelf-dialog" } }]);
  });
  it("floats over the Shelf dialog (tutorial-shelf ticket 04); no other step of any chapter declares a floating dialog, 2.8 included", () => {
    expect(s.floatsOver).toBe("shelf-dialog");
    expect(CHAPTERS.flatMap((c) => c.steps).filter((x) => x.floatsOver).map((x) => x.id)).toEqual(["library.shelf-take"]);
    expect(step("library.shelf-browse").floatsOver).toBeUndefined();
  });
  it("requires the Shelf dialog open; when it is not, the card says to go back to it and offers no take-me-there (nothing registered opens it)", () => {
    const open = { ...onLibrary({ id: JERABKOVA }), dom: fakeDom({ "shelf-dialog": {} }) } as WorkbenchSnapshot;
    const closed = onLibrary({ id: JERABKOVA });
    expect(s.requires!.test(open)).toBe(true);
    expect(s.requires!.test(closed)).toBe(false);
    expect(s.requires!.where).toBe("shelfDialog");
    expect(s.requires!.takeMeThere).toBeUndefined();
    expect(WHERE_KEYS).toContain("shelfDialog");
  });
});

describe("progress saved before 2.8 and 2.9 existed lines up by step id", () => {
  const records = {
    "library.cite-key": { state: "done", at: "2026-10-23T00:00:00.000Z" },
    "library.shelf-add": { state: "done", at: "2026-10-24T00:00:00.000Z" },
  } as const;
  it("the new steps have no record (not done); the position on 2.A or on 2.7 still resolves", () => {
    expect(recordOf(records, "library.shelf-browse")).toBeNull();
    expect(recordOf(records, "library.shelf-take")).toBeNull();
    expect(alignPosition(CHAPTERS, "library.agent")).toBe("library.agent");
    expect(alignPosition(CHAPTERS, "library.shelf-add")).toBe("library.shelf-add");
    expect(nextStepId(CHAPTERS, "library.shelf-add")).toBe("library.shelf-browse");
    expect(nextStepId(CHAPTERS, "library.shelf-browse")).toBe("library.shelf-take");
    expect(nextStepId(CHAPTERS, "library.shelf-take")).toBe("library.agent");
    const summary = chapterSummary(LIBRARY, records);
    expect(summary.done).toBe(2);
    expect(summary.total).toBe(LIBRARY.steps.length);
  });
  it("a chapter whose every old step was done is in progress again, not done, until the new steps are done", () => {
    const old = Object.fromEntries(
      LIBRARY.steps.filter((x) => x.kind !== "agent" && !x.id.startsWith("library.shelf-b") && x.id !== "library.shelf-take").map((x) => [x.id, { state: "done", at: "2026-10-24T00:00:00.000Z" }]),
    );
    expect(chapterStatus(LIBRARY, { ...old, "library.agent": { state: "done", at: "2026-10-24T00:00:00.000Z" } }, null)).toBe("inProgress");
  });
});
