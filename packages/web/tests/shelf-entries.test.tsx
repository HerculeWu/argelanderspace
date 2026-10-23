/**
 * Where the Shelf is entered (shelf ticket 05): the Library's import menu item and the Work detail's add button,
 * both absent in the tutorial Project (spec Q21) and until that is known; the one-time ingest reminder (review Q2/Q3).
 */
import type { Job, TutorialState } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Preferences } from "../src/argelander/preferences";
import { PreferencesProvider } from "../src/argelander/preferences";
import { type Workspace, WorkspaceProvider } from "../src/argelander/workspace";
import i18n from "../src/i18n";
import { LibraryView } from "../src/library/LibraryView";
import type { LibraryData, LibraryRef } from "../src/library/types";
import { useWorkShelf } from "../src/shelf/AddToShelf";
import { ShelfAvailabilityProvider, ShelfAvailabilityValue, shelfAvailable, useShelfAvailable } from "../src/shelf/availability";
import { dismissIngestPrompt, ingestPromptJob, resetIngestPromptsForTests, setIngestPromptProject, useIngestPrompt } from "../src/shelf/ingest-prompt";
import { json, must, stubFetch } from "./shelf-fixtures";

vi.mock("../src/api/ws", () => ({ onArgumentGraphChanged: () => () => {}, onLibraryChanged: () => () => {}, onJobEvent: () => () => {} }));
vi.mock("../src/api/ws-instance", async () => {
  const { createFakeBus } = await import("../src/api/ws-bus");
  return { bus: createFakeBus() };
});
const tutorialState = vi.hoisted(() => ({ value: null as TutorialState | null }));
vi.mock("../src/api/tutorial", () => ({ fetchTutorial: async () => tutorialState.value, putTutorial: async () => ({}) }));

const BOUND = "/home/u/ArgelanderSpace-Tutorial";
const bound = (state: "ready" | "missing" = "ready"): TutorialState => ({
  progress: { version: 1, project: { path: BOUND }, steps: {}, at: null } as unknown as TutorialState["progress"],
  project: { path: BOUND, display: "~/ArgelanderSpace-Tutorial", state } as TutorialState["project"],
  sample: { bundled: 1, project: 1 },
});
const prefsAt = (root: string | null) => ({ settings: { running: { project_root: root ? { path: root, display: root } : null } } }) as unknown as Preferences;

const REF: LibraryRef = { id: "doi:10.1/x", title: "Paper X", authors: "Able", year: 2020, venue: "ApJ", type: "article", cite: "able2020", tags: [], pdf: true, read: false, star: false, doi: "10.1/x", doc_id: "arxiv-1", doc_ids: ["arxiv-1"] };
const PAYLOAD: LibraryData = { project: { name: "T" }, refs: [REF], tags: [], graph: { nodes: [{ id: "doi:10.1/x", ref: REF.id, y: 2020, c: 1, a: "Able", v: "ApJ", t: "Paper X" }], links: [] } };

function libraryRoutes() {
  return stubFetch(async (url) => {
    if (url === "/api/library") return json(PAYLOAD);
    if (url === "/api/shelf/entries/preview") return json({ impact: null, carried: { docs: [], argumentGraph: false, note: false }, notCarried: [] });
    if (url.startsWith("/api/paper/")) return json({ detail: "x" }, 404);
    if (url.includes("/upload-target") || url.includes("acquisition")) return json({ detail: "x" }, 404);
    return undefined;
  });
}

const workspace = { openDoc: () => {}, docDeleted: () => {}, currentDoc: null } as unknown as Workspace;
function renderLibrary(available: boolean | undefined) {
  return render(
    <WorkspaceProvider value={workspace}>
      <ShelfAvailabilityValue value={available}>
        <LibraryView />
      </ShelfAvailabilityValue>
    </WorkspaceProvider>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  resetIngestPromptsForTests();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("tutorial Project: no Shelf entry", () => {
  it("the rule: hidden while unknown, hidden in the bound tutorial folder, shown elsewhere", () => {
    expect(shelfAvailable(undefined, "/p")).toBeUndefined();
    expect(shelfAvailable(bound(), undefined)).toBeUndefined();
    expect(shelfAvailable(bound(), BOUND)).toBe(false);
    expect(shelfAvailable(bound(), `${BOUND}/`)).toBe(false);
    expect(shelfAvailable(bound(), "/home/u/research")).toBe(true);
    expect(shelfAvailable(bound("missing"), BOUND)).toBe(true);
    // the tutorial state could not be read: not known, hidden
    expect(shelfAvailable(null, "/p")).toBeUndefined();
    expect(shelfAvailable({ ...bound(), progress: null, project: null }, "/p")).toBe(true);
  });

  it("the Shell's provider reads the tutorial state and the open folder", async () => {
    function Probe() {
      return <span data-testid="probe">{String(useShelfAvailable())}</span>;
    }
    tutorialState.value = bound();
    render(
      <PreferencesProvider value={prefsAt(BOUND)}>
        <ShelfAvailabilityProvider>
          <Probe />
        </ShelfAvailabilityProvider>
      </PreferencesProvider>
    );
    await act(async () => {});
    expect(screen.getByTestId("probe").textContent).toBe("false");
    cleanup();
    render(
      <PreferencesProvider value={prefsAt("/home/u/research")}>
        <ShelfAvailabilityProvider>
          <Probe />
        </ShelfAvailabilityProvider>
      </PreferencesProvider>
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("true"));
  });

  for (const [label, available, shown] of [["tutorial Project", false, false], ["not known yet", undefined, false], ["a user's Project", true, true]] as const) {
    it(`${label}: import menu item and Work detail button ${shown ? "shown" : "absent"}`, async () => {
      libraryRoutes();
      renderLibrary(available);
      await waitFor(() => must('[data-ui="open-import-menu"]'));
      fireEvent.click(must('[data-ui="open-import-menu"]'));
      await waitFor(() => must('[data-ui="import-option"][data-ui-key="bib"]'));
      expect(document.querySelector('[data-ui="import-option"][data-ui-key="shelf"]') !== null).toBe(shown);
      await waitFor(() => must('[data-ui="work-detail-actions"]'));
      expect(document.querySelector('[data-ui="add-work-to-shelf"]') !== null).toBe(shown);
    });
  }

  it("the import menu's fourth item opens the Shelf dialog", async () => {
    const fetchMock = libraryRoutes();
    renderLibrary(true);
    await waitFor(() => must('[data-ui="open-import-menu"]'));
    fireEvent.click(must('[data-ui="open-import-menu"]'));
    const items = await waitFor(() => {
      const list = document.querySelectorAll('[data-ui="import-option"]');
      if (list.length < 4) throw new Error("menu");
      return list;
    });
    expect(items[3].getAttribute("data-ui-key")).toBe("shelf");
    expect(items[3].textContent).toContain("从文献仓");
    fireEvent.click(items[3]);
    await waitFor(() => must('[data-ui="shelf-dialog"]'));
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/shelf")).toBe(true);
  });
});

const doneJob = (workId: string, id = "j1"): Job => ({ id, kind: "upload", status: "done", createdAt: "x", startedAt: "x", finishedAt: "x", progress: [], result: null, error: null, payload: { workId, docId: "pdf-1", format: "pdf" } });

describe("the ingest reminder", () => {
  function Harness({ work }: { work: LibraryRef }) {
    const shelf = useWorkShelf(work);
    return (
      <div>
        {shelf.ingestPrompt}
        {shelf.dialog}
      </div>
    );
  }

  it("appears after a live ingest success (never for a hello replay), survives a Work switch, goes only when closed", async () => {
    setIngestPromptProject("/home/u/research");
    ingestPromptJob(doneJob(REF.id), "hello");
    const other: LibraryRef = { ...REF, id: "doi:10.1/y", title: "Y" };
    stubFetch(async (url) => (url === "/api/shelf/entries/preview" ? json({ impact: null, carried: { docs: [], argumentGraph: false, note: false }, notCarried: [] }) : undefined));
    const { rerender } = render(
      <ShelfAvailabilityValue value={true}>
        <Harness work={REF} />
      </ShelfAvailabilityValue>
    );
    expect(document.querySelector('[data-ui="ingest-add-to-shelf-prompt"]')).toBeNull();
    act(() => ingestPromptJob(doneJob(REF.id), "job.done"));
    expect(must('[data-ui="ingest-add-to-shelf-prompt"]').textContent).toContain("要把这篇加入文献仓");
    rerender(
      <ShelfAvailabilityValue value={true}>
        <Harness work={other} />
      </ShelfAvailabilityValue>
    );
    expect(document.querySelector('[data-ui="ingest-add-to-shelf-prompt"]')).toBeNull();
    rerender(
      <ShelfAvailabilityValue value={true}>
        <Harness work={REF} />
      </ShelfAvailabilityValue>
    );
    expect(must('[data-ui="ingest-add-to-shelf-prompt"]')).toBeTruthy();
    // its button opens the ordinary add dialog (no direct add)
    fireEvent.click(must('[data-ui="ingest-open-add-to-shelf"]'));
    await waitFor(() => must('[data-ui="add-to-shelf-dialog"]'));
    fireEvent.click(must('[data-ui="dismiss-ingest-shelf-prompt"]'));
    expect(document.querySelector('[data-ui="ingest-add-to-shelf-prompt"]')).toBeNull();
    // once per Work: another success does not bring it back
    act(() => ingestPromptJob(doneJob(REF.id, "j2"), "job.done"));
    expect(document.querySelector('[data-ui="ingest-add-to-shelf-prompt"]')).toBeNull();
  });

  it("is kept per project folder across a reload, and is never shown in the tutorial Project", () => {
    setIngestPromptProject("/home/u/a");
    ingestPromptJob(doneJob(REF.id), "job.done");
    resetIngestPromptsForTests(false); // a reload: memory gone, storage kept
    function Probe({ id }: { id: string }) {
      return <span data-testid="p">{String(useIngestPrompt(id))}</span>;
    }
    render(<Probe id={REF.id} />);
    expect(screen.getByTestId("p").textContent).toBe("false");
    act(() => setIngestPromptProject("/home/u/b"));
    expect(screen.getByTestId("p").textContent).toBe("false");
    act(() => setIngestPromptProject("/home/u/a"));
    expect(screen.getByTestId("p").textContent).toBe("true");
    act(() => dismissIngestPrompt(REF.id));
    expect(screen.getByTestId("p").textContent).toBe("false");
    cleanup();
    act(() => ingestPromptJob(doneJob("doi:10.1/z"), "job.done"));
    render(
      <ShelfAvailabilityValue value={false}>
        <Harness work={{ ...REF, id: "doi:10.1/z" }} />
      </ShelfAvailabilityValue>
    );
    expect(document.querySelector('[data-ui="ingest-add-to-shelf-prompt"]')).toBeNull();
  });

  function ShelfParts({ work }: { work: LibraryRef }) {
    const shelf = useWorkShelf(work);
    return (
      <div>
        {shelf.button}
        {shelf.feedback}
        {shelf.ingestPrompt}
        {shelf.dialog}
      </div>
    );
  }

  it("an add made through the reminder closes it and the result line says what went in", async () => {
    setIngestPromptProject("/home/u/research");
    stubFetch(async (url, init) => {
      if (url === "/api/shelf/entries/preview") return json({ impact: null, carried: { docs: [], argumentGraph: false, note: false }, notCarried: [] });
      if (url.startsWith("/api/shelf/add-candidates/")) return json({ workId: REF.id, docs: [{ docId: "arxiv-1", kind: "latex", bytes: 10, annotations: { state: "current", list: [] } }] });
      if (url === "/api/shelf/entries" && init?.method === "POST")
        return json({ entry: { entryId: "e".repeat(32), rev: 1 }, replaced: [], carried: { docs: [{ docId: "arxiv-1", kind: "latex", annotations: 0 }], argumentGraph: false, note: false }, notCarried: [], archived: [] });
      return undefined;
    });
    render(
      <ShelfAvailabilityValue value={true}>
        <ShelfParts work={REF} />
      </ShelfAvailabilityValue>
    );
    act(() => ingestPromptJob(doneJob(REF.id), "job.done"));
    fireEvent.click(must('[data-ui="ingest-open-add-to-shelf"]'));
    const submit = await waitFor(() => must('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement);
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(must('[data-ui="add-to-shelf-feedback"]').textContent).toBe("已加入文献仓：1 个 Doc、0 条标注。"));
    expect(document.querySelector('[data-ui="ingest-add-to-shelf-prompt"]')).toBeNull();
  });

  it("the result line in English: one Doc, one annotation; several are plural (ticket shelf-followups 09)", async () => {
    await i18n.changeLanguage("en");
    const answers = [
      { docs: [{ docId: "arxiv-1", kind: "latex", annotations: 1 }], replaced: [] as unknown[], text: "Added to the Shelf: 1 Doc, 1 annotation." },
      { docs: [{ docId: "arxiv-1", kind: "latex", annotations: 2 }, { docId: "pdf-1", kind: "pdf", annotations: 0 }], replaced: [{ entryId: "f".repeat(32), rev: 1 }], text: "Shelf entry replaced: 2 Docs, 2 annotations." },
    ];
    for (const answer of answers) {
      cleanup();
      stubFetch(async (url, init) => {
        if (url === "/api/shelf/entries/preview") return json({ impact: null, carried: { docs: [], argumentGraph: false, note: false }, notCarried: [] });
        if (url.startsWith("/api/shelf/add-candidates/")) return json({ workId: REF.id, docs: [{ docId: "arxiv-1", kind: "latex", bytes: 10, annotations: { state: "current", list: [] } }] });
        if (url === "/api/shelf/entries" && init?.method === "POST")
          return json({ entry: { entryId: "e".repeat(32), rev: 1 }, replaced: answer.replaced, carried: { docs: answer.docs, argumentGraph: false, note: false }, notCarried: [], archived: [] });
        return undefined;
      });
      render(
        <ShelfAvailabilityValue value={true}>
          <ShelfParts work={REF} />
        </ShelfAvailabilityValue>
      );
      fireEvent.click(must('[data-ui="add-work-to-shelf"]'));
      const submit = await waitFor(() => must('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement);
      await waitFor(() => expect(submit.disabled).toBe(false));
      fireEvent.click(submit);
      await waitFor(() => expect(must('[data-ui="add-to-shelf-feedback"]').textContent).toBe(answer.text));
    }
  });

  it("the add button: the chosen icon from icons.json; says 'replaces' when the Shelf has the paper (by DOI, arXiv or OpenAlex)", async () => {
    const fetchMock = stubFetch(async (url) => (url.startsWith("/api/shelf/lookup") ? json({ entries: [{ entryId: "e".repeat(32), rev: 1, title: "X", matchedOn: ["openalex"] }] }) : undefined));
    render(
      <ShelfAvailabilityValue value={true}>
        <ShelfParts work={{ ...REF, doi: undefined, openalex_id: "W42" }} />
      </ShelfAvailabilityValue>
    );
    const button = must('[data-ui="add-work-to-shelf"]');
    expect(button.querySelector("svg")).not.toBeNull();
    await waitFor(() => expect(must('[data-ui="add-work-to-shelf"]').getAttribute("aria-label")).toBe("加入文献仓（已有，将替换）"));
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain("/api/shelf/lookup?openalex=W42");
    expect(fetchMock.mock.calls.some(([, i]) => (i?.method ?? "GET") !== "GET")).toBe(false);
  });
});
