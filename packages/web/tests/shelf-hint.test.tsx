/**
 * The "already on the Shelf" hint (shelf ticket 06; spec Q5(b), Q11, Q22; review Q6): adding by DOI / arXiv id in the
 * identifier dialog, or an exploration candidate, asks the Shelf after the add is submitted — only by DOI, arXiv id
 * (and OpenAlex id), never by title — and with a hit offers "Take from Shelf…" or the usual add. The dialog alone and
 * the real LibraryView (with its exploration) run against stubbed HTTP; `createWorks` is the usual add.
 */
import type { DiscoveryGraph, DiscoveryPaper, ShelfTakeResult } from "@argelanderspace/contracts";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Workspace, WorkspaceProvider } from "../src/argelander/workspace";
import i18n from "../src/i18n";
import { ImportDialog } from "../src/library/ImportDialog";
import { LibraryView } from "../src/library/LibraryView";
import type { LibraryData, LibraryRef, ManualWorkResponse } from "../src/library/types";
import { identifierIds, projectHas, ShelfHint } from "../src/shelf/already-on-shelf";
import { projectWorkFor } from "../src/shelf/ShelfDialog";
import { ENTRY_A, ENTRY_B, json, must, OK_ROW, OTHER_ROW, type Route, stubFetch } from "./shelf-fixtures";

const h = vi.hoisted(() => ({ createWorks: vi.fn<(req: unknown) => Promise<ManualWorkResponse | null>>() }));
vi.mock("../src/api/library", async (orig) => ({ ...(await orig<typeof import("../src/api/library")>()), createWorks: h.createWorks }));
vi.mock("../src/api/ws", () => ({ onArgumentGraphChanged: () => () => {}, onLibraryChanged: () => () => {}, onJobEvent: () => () => {} }));
vi.mock("../src/api/ws-instance", async () => {
  const { createFakeBus } = await import("../src/api/ws-bus");
  return { bus: createFakeBus() };
});
vi.mock("../src/graph/GraphCanvas", () => ({ GraphCanvas: () => <div data-ui="graph-stub" /> }));

const GAIA_ROW = OK_ROW as Extract<typeof OK_ROW, { status: "ok" }>;
const entryBody = (row: typeof GAIA_ROW) => ({ ...row, bibliography: { title: row.title, authors: row.authors, year: row.year, venue: "A&A" } });
const lookupHit = (row: typeof GAIA_ROW, matchedOn: string[]) => ({ entryId: row.entryId, rev: row.rev, title: row.title, matchedOn });

/** The Shelf as the server answers it: `lookup` decides what the lookup returns for the query it got. */
function shelfRoutes(lookup: (q: URLSearchParams) => Response | undefined, extra?: Route): Route {
  return async (url, init) => {
    const own = await extra?.(url, init);
    if (own) return own;
    if (url.startsWith("/api/shelf/lookup?")) return lookup(new URLSearchParams(url.split("?")[1]));
    if (url === `/api/shelf/entries/${ENTRY_A}`) return json(entryBody(GAIA_ROW));
    if (url === `/api/shelf/entries/${ENTRY_B}`) return json(entryBody(OTHER_ROW as typeof GAIA_ROW));
    return undefined;
  };
}
/** Exact identity only (as the server does): the Gaia entry for its DOI or arXiv id, nothing for anything else. */
const gaiaLookup = (q: URLSearchParams) => {
  const doi = q.get("doi")?.toLowerCase();
  const arxiv = q.get("arxiv")?.toLowerCase().replace(/v\d+$/, "");
  const on = [...(doi === "10.1051/gaia.2018" ? ["doi"] : []), ...(arxiv === "1804.09378" ? ["arxiv"] : [])];
  return json({ entries: on.length ? [lookupHit(GAIA_ROW, on)] : [] });
};
/** The add's lookups (the seed Work's own detail asks for its add-to-Shelf tooltip, ticket 05: not counted). */
const lookups = (mock: ReturnType<typeof stubFetch>) =>
  mock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/shelf/lookup?") && !u.includes("seed"));

const CREATED: LibraryRef = { id: "doi:10.1051/gaia.2018", title: "Gaia DR2", authors: "Gaia Collaboration", year: 2018, venue: "A&A", type: "article", cite: "gaia2018", tags: [], pdf: false, read: false, star: false, doi: "10.1051/gaia.2018" };

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  h.createWorks.mockReset();
  h.createWorks.mockResolvedValue({ results: [{ status: "created", ref: CREATED, key: "gaia2018" }] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------------------------ identifier dialog ----

function openDialog(works: LibraryRef[] = []) {
  const onResolved = vi.fn();
  const onClose = vi.fn();
  const onTakeFromShelf = vi.fn();
  render(
    <ImportDialog mode="identifier" onClose={onClose} onResolved={onResolved} works={works} onTakeFromShelf={onTakeFromShelf} />
  );
  const submit = (value: string) => {
    fireEvent.change(must('[data-ui="import-input"]'), { target: { value } });
    fireEvent.click(must('[data-ui="submit-import"]'));
  };
  return { onResolved, onClose, onTakeFromShelf, submit };
}

describe("identifier dialog", () => {
  it("an exact DOI hit: after submit (not while typing) the hint says what the entry carries; nothing is created; Take opens its take step", async () => {
    const fetchMock = stubFetch(shelfRoutes(gaiaLookup));
    const { onTakeFromShelf, onClose, submit } = openDialog();
    fireEvent.change(must('[data-ui="import-input"]'), { target: { value: "https://doi.org/10.1051/GAIA.2018" } });
    expect(lookups(fetchMock)).toEqual([]); // typing asks nothing (review Q6)
    submit("https://doi.org/10.1051/GAIA.2018");
    const hint = await waitFor(() => must('[data-ui="already-on-shelf-hint"]'));
    expect(lookups(fetchMock)).toEqual(["/api/shelf/lookup?doi=10.1051%2Fgaia.2018"]);
    expect(hint.textContent).toContain("文献仓里已有这一篇");
    expect(hint.textContent).toContain("2 个 Doc、3 条标注、论证图（7 条论证）。直接取入，免重新摄入？");
    expect(hint.textContent).toContain("来自 /home/u/research/wd-cooling");
    expect(h.createWorks).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ui="submit-import"]')).toBeNull();
    expect(must('[data-ui="import-as-usual"]').textContent).toBe("照常创建条目");
    // every request was a read
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    fireEvent.click(must('[data-ui="take-from-shelf-instead"]'));
    expect(onTakeFromShelf).toHaveBeenCalledWith({ entryId: ENTRY_A, take: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an arXiv id (any version, prefix or URL) is looked up by its arXiv id; an arXiv DataCite DOI too", async () => {
    expect(identifierIds("arXiv:1804.09378v2")).toEqual({ arxiv: "1804.09378v2" });
    expect(identifierIds("https://arxiv.org/abs/1804.09378")).toEqual({ arxiv: "1804.09378" });
    expect(identifierIds("10.48550/arXiv.1804.09378")).toEqual({ arxiv: "1804.09378" });
    expect(identifierIds("doi:10.1051/Gaia.2018")).toEqual({ doi: "10.1051/gaia.2018" });
    // the server refuses a bare arXiv id and anything else; nothing is looked up for them
    expect(identifierIds("1804.09378")).toBeNull();
    expect(identifierIds("Gaia Data Release 2")).toBeNull();
    stubFetch(shelfRoutes(gaiaLookup));
    const { submit } = openDialog();
    submit("arXiv:1804.09378v2");
    await waitFor(() => must('[data-ui="already-on-shelf-hint"]'));
    expect(h.createWorks).not.toHaveBeenCalled();
  });

  it("only the same title is not the same paper: no hint, the add goes ahead as usual", async () => {
    // a Shelf entry with exactly this paper's title, but another DOI: the lookup (identity only) has nothing
    const fetchMock = stubFetch(shelfRoutes(gaiaLookup));
    const { onResolved, onClose, submit } = openDialog();
    submit("10.9999/other-gaia-paper");
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(CREATED));
    expect(onClose).toHaveBeenCalled();
    expect(lookups(fetchMock)).toEqual(["/api/shelf/lookup?doi=10.9999%2Fother-gaia-paper"]); // no title is ever sent
    expect(h.createWorks).toHaveBeenCalledWith({ mode: "identifier", value: "10.9999/other-gaia-paper" });
    expect(document.querySelector('[data-ui="already-on-shelf-hint"]')).toBeNull();
  });

  it("declining adds as usual (the same request, not asked again)", async () => {
    const fetchMock = stubFetch(shelfRoutes(gaiaLookup));
    const { onResolved, onTakeFromShelf, submit } = openDialog();
    submit("10.1051/gaia.2018");
    await waitFor(() => must('[data-ui="already-on-shelf-hint"]'));
    fireEvent.click(must('[data-ui="import-as-usual"]'));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(CREATED));
    expect(h.createWorks).toHaveBeenCalledTimes(1);
    expect(h.createWorks).toHaveBeenCalledWith({ mode: "identifier", value: "10.1051/gaia.2018" });
    expect(lookups(fetchMock)).toHaveLength(1);
    expect(onTakeFromShelf).not.toHaveBeenCalled();
  });

  it("editing the identifier takes the hint away; the next submit asks again", async () => {
    const fetchMock = stubFetch(shelfRoutes(gaiaLookup));
    const { submit } = openDialog();
    submit("10.1051/gaia.2018");
    await waitFor(() => must('[data-ui="already-on-shelf-hint"]'));
    fireEvent.change(must('[data-ui="import-input"]'), { target: { value: "10.1051/gaia.2018 " } });
    expect(document.querySelector('[data-ui="already-on-shelf-hint"]')).toBeNull();
    fireEvent.click(must('[data-ui="submit-import"]'));
    await waitFor(() => expect(lookups(fetchMock)).toHaveLength(2));
    await waitFor(() => must('[data-ui="already-on-shelf-hint"]'));
  });

  it("a lookup that fails (refused or no answer) does not hold the add up: it goes ahead as usual", async () => {
    for (const broken of [() => json({ detail: "x", code: "shelf_unreadable" }, 500), () => Promise.reject(new TypeError("network down"))]) {
      stubFetch((url) => (url.startsWith("/api/shelf/lookup?") ? broken() : undefined));
      h.createWorks.mockClear();
      const { onResolved, submit } = openDialog();
      submit("10.1051/gaia.2018");
      await waitFor(() => expect(onResolved).toHaveBeenCalledWith(CREATED));
      expect(h.createWorks).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-ui="already-on-shelf-hint"]')).toBeNull();
      cleanup();
    }
  });

  it("several entries are this paper (one by DOI, one by arXiv id): all are named, and Take opens the Shelf on the first to choose", async () => {
    const other = { ...GAIA_ROW, entryId: ENTRY_B, rev: 1, title: "Gaia DR2 (arXiv version)" };
    stubFetch(
      shelfRoutes(() => json({ entries: [lookupHit(GAIA_ROW, ["doi"]), lookupHit(other, ["arxiv"])] }), (url) => (url === `/api/shelf/entries/${ENTRY_B}` ? json(entryBody(other)) : undefined))
    );
    const { onTakeFromShelf, submit } = openDialog();
    submit("10.1051/gaia.2018");
    const hint = await waitFor(() => must('[data-ui="already-on-shelf-hint"]'));
    expect(hint.textContent).toContain("文献仓里有 2 个条目是这一篇");
    expect([...hint.querySelectorAll('[data-ui="already-on-shelf-entry"]')].map((e) => e.getAttribute("data-ui-key"))).toEqual([ENTRY_A, ENTRY_B]);
    expect(hint.textContent).toContain("Gaia DR2 (arXiv version)");
    fireEvent.click(must('[data-ui="take-from-shelf-instead"]'));
    expect(onTakeFromShelf).toHaveBeenCalledWith({ entryId: ENTRY_A, take: false });
  });

  it("an entry whose summary cannot be read is still offered, without counts", async () => {
    stubFetch(shelfRoutes(gaiaLookup, (url) => (url === `/api/shelf/entries/${ENTRY_A}` ? json({ detail: "x" }, 500) : undefined)));
    const { submit } = openDialog();
    submit("10.1051/gaia.2018");
    const hint = await waitFor(() => must('[data-ui="already-on-shelf-hint"]'));
    expect(hint.textContent).toContain("直接取入，免重新摄入？");
    expect(hint.textContent).not.toContain("个 Doc");
  });

  it("the project already has this paper: no hint (the add opens that Work)", async () => {
    const fetchMock = stubFetch(shelfRoutes(gaiaLookup));
    const { onResolved, submit } = openDialog([{ ...CREATED, doi: "10.1051/GAIA.2018" }]);
    submit("10.1051/gaia.2018");
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(lookups(fetchMock)).toEqual([]);
  });
});

// ------------------------------------------------------------------------- Library: dialog → Shelf dialog ----

const SEED_REF: LibraryRef = { id: "doi:10.1/seed", title: "Seed paper", authors: "Seed, A.", year: 2019, venue: "A&A", type: "article", cite: "seed2019", tags: [], pdf: false, read: false, star: false, doi: "10.1/seed", bibcode: "SEED" };
const PAYLOAD: LibraryData = {
  project: { name: "P" },
  refs: [SEED_REF],
  tags: [],
  graph: { version: 2, nodes: [{ id: SEED_REF.id, ref: SEED_REF.id, y: 2019, c: 1, a: "Seed", v: "A&A", t: SEED_REF.title }], links: [] },
} as LibraryData;
const paper = (bibcode: string, over: Partial<DiscoveryPaper> = {}): DiscoveryPaper => ({
  bibcode,
  title: `Title of ${bibcode}`,
  authors: ["Doe, J."],
  year: 2018,
  venue: "A&A",
  abstract: null,
  citationCount: null,
  doi: null,
  arxivId: null,
  roles: ["related"],
  relatedRank: 1,
  libraryId: null,
  ...over,
});
const GRAPH: DiscoveryGraph = {
  version: 1,
  provider: "ads",
  seed: "SEED",
  nodes: [
    paper("SEED", { roles: ["seed"], relatedRank: undefined, doi: "10.1/seed", libraryId: SEED_REF.id, title: "Seed paper" }),
    paper("GAIA", { doi: "10.1051/gaia.2018", title: "Gaia Data Release 2" }),
    // only the title is the Shelf entry's: not the same paper
    paper("TWIN", { title: GAIA_ROW.title, relatedRank: 2 }),
  ],
  edges: [],
  warnings: [],
};
const PLAN: ShelfTakeResult = {
  work: { id: "doi:10.1051/gaia.2018", title: "Gaia DR2", created: true, citeKey: "gaia2018", filled: [] },
  mainDoc: { before: null, after: "arxiv-1804.09378", changed: true },
  docs: { taken: [{ docId: "arxiv-1804.09378", kind: "latex", annotations: 2, stamped: false }], skipped: [] },
  argumentGraph: "written",
  note: "written",
};

/** Another paper's take (OTHER_ROW, entry B). */
const PLAN_B: ShelfTakeResult = { ...PLAN, work: { id: "arxiv:1906.03924", title: "A 5D view", created: true, citeKey: "lodieu2019", filled: [] } };

function libraryRoutes(extra?: Route) {
  return stubFetch(
    shelfRoutes(gaiaLookup, async (url, init) => {
      const own = await extra?.(url, init);
      if (own) return own;
      if (url === "/api/library") return json(PAYLOAD);
      if (url.startsWith("/api/library/discovery?bibcode=")) return json(GRAPH);
      if (url === "/api/shelf") return json({ entries: [GAIA_ROW, OTHER_ROW] });
      if (url === `/api/shelf/entries/${ENTRY_A}/annotations?rev=2`) return json({ entryId: ENTRY_A, rev: 2, docs: [] });
      if (url === `/api/shelf/entries/${ENTRY_A}/take/preview`) return json({ plan: PLAN, planDigest: "d".repeat(64) });
      if (url === `/api/shelf/entries/${ENTRY_A}/take`) return json(PLAN);
      if (url === `/api/shelf/entries/${ENTRY_B}/annotations?rev=1`) return json({ entryId: ENTRY_B, rev: 1, docs: [] });
      if (url === `/api/shelf/entries/${ENTRY_B}/take/preview`) return json({ plan: PLAN_B, planDigest: "e".repeat(64) });
      if (url === `/api/shelf/entries/${ENTRY_B}/take`) return json(PLAN_B);
      return undefined;
    })
  );
}
const workspace = { openDoc: () => {}, docDeleted: () => {}, currentDoc: null } as unknown as Workspace;
function renderLibrary() {
  return render(
    <WorkspaceProvider value={workspace}>
      <LibraryView />
    </WorkspaceProvider>
  );
}

describe("in the Library", () => {
  it("identifier dialog → Take from Shelf… opens the Shelf dialog on that entry's take step", async () => {
    libraryRoutes();
    renderLibrary();
    await waitFor(() => must(`[data-ui="work-item"][data-ui-key="${SEED_REF.id}"]`));
    fireEvent.click(must('[data-ui="open-import-menu"]'));
    fireEvent.click(must('[data-ui="import-option"][data-ui-key="identifier"]'));
    fireEvent.change(must('[data-ui="import-input"]'), { target: { value: "10.1051/gaia.2018" } });
    fireEvent.click(must('[data-ui="submit-import"]'));
    await waitFor(() => must('[data-ui="already-on-shelf-hint"]'));
    fireEvent.click(must('[data-ui="take-from-shelf-instead"]'));
    await waitFor(() => must(`[data-ui="take-from-shelf"][data-ui-key="${ENTRY_A}"]`));
    expect(document.querySelector('[data-ui="import-dialog"]')).toBeNull();
    expect(h.createWorks).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------------- exploration candidate ----

async function exploreSeed() {
  await waitFor(() => must(`[data-ui="work-item"][data-ui-key="${SEED_REF.id}"]`));
  fireEvent.click(must(`[data-ui="work-item"][data-ui-key="${SEED_REF.id}"]`));
  const go = await waitFor(() => {
    const b = must('[data-ui="explore-from-work"]') as HTMLButtonElement;
    if (b.disabled) throw new Error("explore not available yet");
    return b;
  });
  fireEvent.click(go);
  await waitFor(() => must('[data-ui="discovery-paper"][data-ui-key="GAIA"]'));
}
const candidate = (bibcode: string) => {
  fireEvent.click(must(`[data-ui="discovery-paper"][data-ui-key="${bibcode}"]`));
  return must(`[data-ui="discovery-detail"][data-ui-key="${bibcode}"]`);
};

describe("exploration candidate", () => {
  it("Add with an exact DOI hit shows the hint in the candidate's detail instead of adding; no mark on the list or graph", async () => {
    const fetchMock = libraryRoutes();
    renderLibrary();
    await exploreSeed();
    // nothing about the Shelf before an Add (spec Q22: no marks)
    expect(lookups(fetchMock)).toEqual([]);
    candidate("GAIA");
    fireEvent.click(must('[data-ui="save-discovery-paper"]'));
    const hint = await waitFor(() => must('[data-ui="discovery-detail"] [data-ui="already-on-shelf-hint"]'));
    expect(hint.textContent).toContain("2 个 Doc、3 条标注、论证图");
    expect(lookups(fetchMock)).toEqual(["/api/shelf/lookup?doi=10.1051%2Fgaia.2018"]);
    expect(h.createWorks).not.toHaveBeenCalled();
    expect(must('[data-ui="take-from-shelf-instead"]').textContent).toBe("从文献仓取入…");
    expect(must('[data-ui="save-discovery-paper-as-usual"]').textContent).toBe("照常加入");
    expect(document.querySelector('[data-ui="discovery-paper"][data-ui-key="GAIA"]')?.textContent).not.toContain("文献仓");
    // another candidate: the hint is not carried over
    candidate("TWIN");
    expect(document.querySelector('[data-ui="already-on-shelf-hint"]')).toBeNull();
  });

  it("only the title matches: no lookup (no DOI / arXiv id), the usual add", async () => {
    const fetchMock = libraryRoutes();
    renderLibrary();
    await exploreSeed();
    candidate("TWIN");
    fireEvent.click(must('[data-ui="save-discovery-paper"]'));
    await waitFor(() => expect(h.createWorks).toHaveBeenCalledWith({ mode: "bibcode", bibcode: "TWIN" }));
    expect(lookups(fetchMock)).toEqual([]);
    expect(document.querySelector('[data-ui="already-on-shelf-hint"]')).toBeNull();
  });

  it("declining adds the candidate as usual", async () => {
    libraryRoutes();
    renderLibrary();
    await exploreSeed();
    candidate("GAIA");
    fireEvent.click(must('[data-ui="save-discovery-paper"]'));
    await waitFor(() => must('[data-ui="save-discovery-paper-as-usual"]'));
    fireEvent.click(must('[data-ui="save-discovery-paper-as-usual"]'));
    await waitFor(() => expect(h.createWorks).toHaveBeenCalledWith({ mode: "bibcode", bibcode: "GAIA" }));
    await waitFor(() => must('[data-ui="view-saved-work"]'));
    expect(document.querySelector('[data-ui="already-on-shelf-hint"]')).toBeNull();
  });

  it("the list display's Add asks too and opens the candidate with the hint", async () => {
    libraryRoutes();
    renderLibrary();
    await exploreSeed();
    fireEvent.click(must('[data-ui="show-discovery-list"]'));
    fireEvent.click(must('[data-ui="save-discovery-paper"][data-ui-key="GAIA"]'));
    await waitFor(() => must('[data-ui="discovery-detail"][data-ui-key="GAIA"] [data-ui="already-on-shelf-hint"]'));
    expect(h.createWorks).not.toHaveBeenCalled();
  });

  it("Take from Shelf… takes it in the Shelf dialog and stays in the exploration, the candidate now in the Library", async () => {
    const fetchMock = libraryRoutes();
    renderLibrary();
    await exploreSeed();
    candidate("GAIA");
    fireEvent.click(must('[data-ui="save-discovery-paper"]'));
    await waitFor(() => must('[data-ui="take-from-shelf-instead"]'));
    fireEvent.click(must('[data-ui="take-from-shelf-instead"]'));
    const submit = await waitFor(() => {
      const b = must('[data-ui="submit-take-from-shelf"]') as HTMLButtonElement;
      if (b.disabled) throw new Error("no plan yet");
      return b;
    });
    fireEvent.click(submit);
    await waitFor(() => must('[data-ui="take-from-shelf-result"]'));
    expect(fetchMock.mock.calls.some(([u, init]) => String(u) === `/api/shelf/entries/${ENTRY_A}/take` && init?.method === "POST")).toBe(true);
    // still exploring; the candidate is in the Library now
    expect(must('[data-ui="discovery-detail"][data-ui-key="GAIA"]')).toBeTruthy();
    expect(document.querySelector('[data-ui="library-view"]')).toBeNull();
    fireEvent.click(must('[data-ui="shelf-dialog"] [data-ui="close-dialog"]'));
    await waitFor(() => expect(document.querySelector('[data-ui="take-from-shelf-result"]')).toBeNull());
    expect(must('[data-ui="discovery-detail"] [data-ui="view-saved-work"]')).toBeTruthy();
    expect(document.querySelector('[data-ui="already-on-shelf-hint"]')).toBeNull();
    expect(h.createWorks).not.toHaveBeenCalled();
  });

  it("a lookup that fails: the candidate is added as usual", async () => {
    libraryRoutes((url) => (url.startsWith("/api/shelf/lookup?") ? json({ detail: "x", code: "shelf_unreadable" }, 500) : undefined));
    renderLibrary();
    await exploreSeed();
    candidate("GAIA");
    fireEvent.click(must('[data-ui="save-discovery-paper"]'));
    await waitFor(() => expect(h.createWorks).toHaveBeenCalledWith({ mode: "bibcode", bibcode: "GAIA" }));
    expect(document.querySelector('[data-ui="already-on-shelf-hint"]')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------ review fixes ----

/** A response held back until the test releases it. */
function deferred() {
  let release!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (release = r));
  return { promise, release };
}
async function takeInDialog() {
  const submit = await waitFor(() => {
    const b = must('[data-ui="submit-take-from-shelf"]') as HTMLButtonElement;
    if (b.disabled) throw new Error("no plan yet");
    return b;
  });
  fireEvent.click(submit);
  await waitFor(() => must('[data-ui="take-from-shelf-result"]'));
  fireEvent.click(must('[data-ui="shelf-dialog"] [data-ui="close-dialog"]'));
  await waitFor(() => expect(document.querySelector('[data-ui="shelf-dialog"]')).toBeNull());
}
async function hintAndOpenShelf() {
  candidate("GAIA");
  fireEvent.click(must('[data-ui="save-discovery-paper"]'));
  await waitFor(() => must('[data-ui="take-from-shelf-instead"]'));
  fireEvent.click(must('[data-ui="take-from-shelf-instead"]'));
}
const gaiaSaved = () => Boolean(document.querySelector('[data-ui="discovery-detail"][data-ui-key="GAIA"] [data-ui="view-saved-work"]'));

describe("review: a take marks the candidate only when it took one of its hits", () => {
  it("back from the take step, another (non-hit) entry taken: the candidate is not marked", async () => {
    libraryRoutes();
    renderLibrary();
    await exploreSeed();
    await hintAndOpenShelf();
    await waitFor(() => must(`[data-ui="take-from-shelf"][data-ui-key="${ENTRY_A}"]`));
    fireEvent.click(must('[data-ui="back-to-shelf"]'));
    fireEvent.click(must(`[data-ui="shelf-entry"][data-ui-key="${ENTRY_B}"]`));
    fireEvent.click(await waitFor(() => must(`[data-ui="shelf-entry-summary"][data-ui-key="${ENTRY_B}"] [data-ui="take-shelf-entry"]`)));
    await takeInDialog();
    expect(gaiaSaved()).toBe(false);
    expect(must('[data-ui="discovery-detail"][data-ui-key="GAIA"]')).toBeTruthy();
  });

  it("several hits: taking the other hit marks it", async () => {
    const other = OTHER_ROW as typeof GAIA_ROW;
    libraryRoutes((url) => (url.startsWith("/api/shelf/lookup?") ? json({ entries: [lookupHit(GAIA_ROW, ["doi"]), lookupHit(other, ["arxiv"])] }) : undefined));
    renderLibrary();
    await exploreSeed();
    await hintAndOpenShelf();
    // several hits: the summary of the first, to choose
    await waitFor(() => must(`[data-ui="shelf-entry-summary"][data-ui-key="${ENTRY_A}"]`));
    fireEvent.click(must(`[data-ui="shelf-entry"][data-ui-key="${ENTRY_B}"]`));
    fireEvent.click(await waitFor(() => must(`[data-ui="shelf-entry-summary"][data-ui-key="${ENTRY_B}"] [data-ui="take-shelf-entry"]`)));
    await takeInDialog();
    expect(gaiaSaved()).toBe(true);
  });

  it("the hit entry is gone when the Shelf is read: another is selected, and taking it does not mark the candidate", async () => {
    libraryRoutes((url) => (url === "/api/shelf" ? json({ entries: [OTHER_ROW] }) : undefined));
    renderLibrary();
    await exploreSeed();
    await hintAndOpenShelf();
    fireEvent.click(await waitFor(() => must(`[data-ui="shelf-entry-summary"][data-ui-key="${ENTRY_B}"] [data-ui="take-shelf-entry"]`)));
    await takeInDialog();
    expect(gaiaSaved()).toBe(false);
  });
});

describe("review: late lookups", () => {
  it("identifier dialog: an answer for an input that was edited meanwhile is dropped (no hint, nothing created)", async () => {
    const held = deferred();
    stubFetch(shelfRoutes(gaiaLookup, (url) => (url.startsWith("/api/shelf/lookup?") ? held.promise : undefined)));
    const { submit } = openDialog();
    submit("10.1051/gaia.2018");
    fireEvent.change(must('[data-ui="import-input"]'), { target: { value: "10.9999/another" } });
    held.release(json({ entries: [lookupHit(GAIA_ROW, ["doi"])] }));
    await new Promise((r) => setTimeout(r, 50));
    await waitFor(() => expect(must('[data-ui="submit-import"]').textContent).toBe("创建条目"));
    expect(document.querySelector('[data-ui="already-on-shelf-hint"]')).toBeNull();
    expect(h.createWorks).not.toHaveBeenCalled();
    expect((must('[data-ui="import-input"]') as HTMLInputElement).value).toBe("10.9999/another");
  });

  it("exploration: a hit that comes back after another candidate was opened does not pull the selection back", async () => {
    const held = deferred();
    libraryRoutes((url) => (url.startsWith("/api/shelf/lookup?") && url.includes("gaia") ? held.promise : undefined));
    renderLibrary();
    await exploreSeed();
    candidate("GAIA");
    fireEvent.click(must('[data-ui="save-discovery-paper"]'));
    candidate("TWIN");
    // the other candidate's Add waits while a lookup is out (as in the list display)
    expect((must('[data-ui="discovery-detail"][data-ui-key="TWIN"] [data-ui="save-discovery-paper"]') as HTMLButtonElement).disabled).toBe(true);
    held.release(json({ entries: [lookupHit(GAIA_ROW, ["doi"])] }));
    await new Promise((r) => setTimeout(r, 50));
    await waitFor(() => expect((must('[data-ui="discovery-detail"][data-ui-key="TWIN"] [data-ui="save-discovery-paper"]') as HTMLButtonElement).disabled).toBe(false));
    expect(document.querySelector('[data-ui="already-on-shelf-hint"]')).toBeNull();
    expect(h.createWorks).not.toHaveBeenCalled();
    candidate("GAIA");
    expect(document.querySelector('[data-ui="already-on-shelf-hint"]')).toBeNull();
  });
});

describe("the hint's argument count (shelf follow-up 01)", () => {
  it("a graph the server could not count is named without a count; no graph is not named", () => {
    const hit = (summary: typeof GAIA_ROW) => ({ entryId: summary.entryId, rev: summary.rev, title: summary.title, summary });
    render(<ShelfHint hits={[hit({ ...GAIA_ROW, argumentCount: null })]} />);
    expect(must('[data-ui="already-on-shelf-hint"]').textContent).toContain("2 个 Doc、3 条标注、论证图。直接取入");
    cleanup();
    render(<ShelfHint hits={[hit({ ...GAIA_ROW, argumentGraph: false, argumentCount: null })]} />);
    expect(must('[data-ui="already-on-shelf-hint"]').textContent).toContain("2 个 Doc、3 条标注。直接取入");
  });
});

describe("review: the project already has the paper by arXiv id", () => {
  it("projectHas reads an arXiv DataCite DOI as the arXiv id, on either side", () => {
    const work = (over: Partial<LibraryRef>): LibraryRef => ({ ...CREATED, doi: undefined, ...over });
    expect(projectHas({ doi: "10.48550/arXiv.1804.09378" }, [work({ arxiv_id: "1804.09378v2" })])).toBe(true);
    expect(projectHas({ arxiv: "arXiv:1804.09378" }, [work({ doi: "https://doi.org/10.48550/ARXIV.1804.09378" })])).toBe(true);
    expect(projectHas({ arxiv: "1804.09378" }, [work({ arxiv_id: "1804.09379" })])).toBe(false);
  });

  it("the Shelf dialog's \"in this project\" uses the same rule as the take: DataCite DOI, OpenAlex, and never when two Works match", () => {
    const work = (over: Partial<LibraryRef>): LibraryRef => ({ ...CREATED, doi: undefined, ...over });
    const row = (identity: { doi: string | null; arxiv: string | null; openalex: string | null }) => ({ identity }) as never;
    const datacite = work({ id: "w1", doi: "10.48550/arXiv.2301.00001" });
    expect(projectWorkFor(row({ doi: null, arxiv: "2301.00001", openalex: null }), [datacite])?.id).toBe("w1");
    const byOpenAlex = work({ id: "w2", openalex_id: "W123" });
    expect(projectWorkFor(row({ doi: null, arxiv: null, openalex: "W123" }), [byOpenAlex])?.id).toBe("w2");
    const a = work({ id: "a", doi: "10.1/x" });
    const b = work({ id: "b", arxiv_id: "2301.00001" });
    expect(projectWorkFor(row({ doi: "10.1/x", arxiv: "2301.00001", openalex: null }), [a, b])).toBeUndefined();
  });

  it("exploration: a candidate whose arXiv id the project has is not looked up", async () => {
    const graph: DiscoveryGraph = { ...GRAPH, nodes: [...GRAPH.nodes, paper("ARX", { arxivId: "2101.00001", relatedRank: 3 })] };
    const payload = { ...PAYLOAD, refs: [...PAYLOAD.refs, { ...CREATED, id: "arxiv:2101.00001", doi: undefined, arxiv_id: "2101.00001" }] } as LibraryData;
    const fetchMock = libraryRoutes((url) => (url.startsWith("/api/library/discovery?") ? json(graph) : url === "/api/library" ? json(payload) : undefined));
    renderLibrary();
    await exploreSeed();
    candidate("ARX");
    fireEvent.click(must('[data-ui="save-discovery-paper"]'));
    await waitFor(() => expect(h.createWorks).toHaveBeenCalledWith({ mode: "bibcode", bibcode: "ARX" }));
    expect(lookups(fetchMock)).toEqual([]);
  });
});
