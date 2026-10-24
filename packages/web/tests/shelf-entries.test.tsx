/**
 * Where the Shelf is entered (shelf ticket 05): the Library's import menu item and the Work detail's add button, the
 * same in every Project — the tutorial Project and an unreadable tutorial state included (tutorial-shelf ticket 01);
 * the one-time ingest reminder (review Q2/Q3).
 */
import type { Job, TutorialState } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Workspace, WorkspaceProvider } from "../src/argelander/workspace";
import i18n from "../src/i18n";
import { LibraryView } from "../src/library/LibraryView";
import type { LibraryData, LibraryRef } from "../src/library/types";
import { useWorkShelf } from "../src/shelf/AddToShelf";
import { dismissIngestPrompt, ingestPromptJob, resetIngestPromptsForTests, setIngestPromptProject, useIngestPrompt, useIngestPromptProject } from "../src/shelf/ingest-prompt";
import { json, must, stubFetch } from "./shelf-fixtures";

vi.mock("../src/api/ws", () => ({ onArgumentGraphChanged: () => () => {}, onLibraryChanged: () => () => {}, onJobEvent: () => () => {} }));
vi.mock("../src/api/ws-instance", async () => {
  const { createFakeBus } = await import("../src/api/ws-bus");
  return { bus: createFakeBus() };
});
const tutorialState = vi.hoisted(() => ({ value: null as TutorialState | null, reads: 0 }));
vi.mock("../src/api/tutorial", () => ({
  fetchTutorial: async () => {
    tutorialState.reads += 1;
    return tutorialState.value;
  },
  putTutorial: async () => ({}),
}));

const BOUND = "/home/u/ArgelanderSpace-Tutorial";
const bound = (state: "ready" | "missing" = "ready"): TutorialState => ({
  progress: { version: 1, project: { path: BOUND }, steps: {}, at: null } as unknown as TutorialState["progress"],
  project: { path: BOUND, display: "~/ArgelanderSpace-Tutorial", state } as TutorialState["project"],
  sample: { bundled: 1, project: 1 },
});

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
function renderLibrary() {
  return render(
    <WorkspaceProvider value={workspace}>
      <LibraryView />
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

describe("the Shelf entries are the same in every Project", () => {
  // The Project is the tutorial Project, the tutorial state is not readable, or there is no tutorial: no difference.
  for (const [label, state] of [["the tutorial Project", bound()], ["an unreadable tutorial state", null], ["a user's Project", { ...bound(), progress: null, project: null }]] as const) {
    it(`${label}: import menu item and Work detail button shown`, async () => {
      tutorialState.value = state as TutorialState | null;
      libraryRoutes();
      renderLibrary();
      await waitFor(() => must('[data-ui="open-import-menu"]'));
      fireEvent.click(must('[data-ui="open-import-menu"]'));
      await waitFor(() => must('[data-ui="import-option"][data-ui-key="bib"]'));
      expect(document.querySelector('[data-ui="import-option"][data-ui-key="shelf"]')).not.toBeNull();
      await waitFor(() => must('[data-ui="work-detail-actions"]'));
      expect(document.querySelector('[data-ui="add-work-to-shelf"]')).not.toBeNull();
    });
  }

  it("the Shell's one piece of Shelf state is the open folder for the reminders: it never reads the tutorial state, and the folder is the key whatever it is", async () => {
    function Probe({ root }: { root: string }) {
      useIngestPromptProject(root);
      return null;
    }
    tutorialState.value = bound();
    tutorialState.reads = 0;
    render(<Probe root={BOUND} />);
    await act(async () => {});
    act(() => ingestPromptJob(doneJob(REF.id), "job.done"));
    const stored = JSON.parse(localStorage.getItem("argelander.shelfIngestPrompts") ?? "{}") as Record<string, { pending: string[] }>;
    expect(stored[BOUND]?.pending).toEqual([REF.id]);
    expect(tutorialState.reads).toBe(0);
  });

  it("the import menu's fourth item opens the Shelf dialog", async () => {
    const fetchMock = libraryRoutes();
    renderLibrary();
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
      <Harness work={REF} />
    );
    expect(document.querySelector('[data-ui="ingest-add-to-shelf-prompt"]')).toBeNull();
    act(() => ingestPromptJob(doneJob(REF.id), "job.done"));
    expect(must('[data-ui="ingest-add-to-shelf-prompt"]').textContent).toContain("要把这篇加入文献仓");
    rerender(
      <Harness work={other} />
    );
    expect(document.querySelector('[data-ui="ingest-add-to-shelf-prompt"]')).toBeNull();
    rerender(
      <Harness work={REF} />
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

  it("is kept per project folder across a reload", () => {
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
    // the folder here may as well be the tutorial Project: the reminder is the same
    render(<Harness work={{ ...REF, id: "doi:10.1/z" }} />);
    expect(must('[data-ui="ingest-add-to-shelf-prompt"]')).toBeTruthy();
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
      <ShelfParts work={REF} />
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
        <ShelfParts work={REF} />
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
      <ShelfParts work={{ ...REF, doi: undefined, openalex_id: "W42" }} />
    );
    const button = must('[data-ui="add-work-to-shelf"]');
    expect(button.querySelector("svg")).not.toBeNull();
    await waitFor(() => expect(must('[data-ui="add-work-to-shelf"]').getAttribute("aria-label")).toBe("加入文献仓（已有，将替换）"));
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain("/api/shelf/lookup?openalex=W42");
    expect(fetchMock.mock.calls.some(([, i]) => (i?.method ?? "GET") !== "GET")).toBe(false);
  });
});
