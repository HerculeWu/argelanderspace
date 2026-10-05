/**
 * Writer page context and view controls for the Copilot (ticket 22), on the real WriterView/WriterEditor with only the
 * REST client and the WS bus replaced by an in-memory server that behaves like the real one (rev bump on an accepted
 * PUT, a 409 carrying the current document on a stale rev). Not layout evidence (happy-dom).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WriterManuscript, WriterPage, WriterTemplate } from "@argelanderspace/contracts";
import type { ComponentProps } from "react";
import type { LatexSourceField } from "../src/writer/latexSource";
import { WriterView, type WriterViewController } from "../src/writer/WriterView";
import { writerPageStatus } from "../src/writer/writer-context";

const ID = "m_0a1b2c3d";

const h = vi.hoisted(() => {
  const templates: WriterTemplate[] = [
    { id: "report", version: 1, label: "Generic Report", chip: "Generic report", preamble: "\\documentclass{report}", types: ["latex", "figure"], infoFields: [], frontMatter: "", deps: [] } as WriterTemplate,
  ];
  const store = new Map<string, WriterManuscript>();
  const wsCbs: ((msg: unknown) => void)[] = [];
  const sample = (): WriterManuscript =>
    ({
      version: 1, id: "m_0a1b2c3d", rev: 0, template: "report", title: "Stellar Streams", authors: [], affiliations: [], userPreamble: "", infoValues: {},
      cells: [
        { id: "c_0ab50001", type: "latex", data: { source: "First paragraph." } },
        { id: "c_0ab50002", type: "latex", data: { source: "Second paragraph LAST-MARK." } },
      ],
      comments: [], created_at: "2026-09-15T09:00:00.000Z", updated_at: "2026-09-15T09:00:00.000Z",
    }) as WriterManuscript;
  const summary = (m: WriterManuscript) => ({ id: m.id, title: m.title, template: m.template, rev: m.rev, created_at: m.created_at, updated_at: m.updated_at });
  return {
    templates, store, wsCbs, sample,
    reset() { store.clear(); store.set("m_0a1b2c3d", sample()); wsCbs.length = 0; },
    externalWrite(id: string, fn: (m: WriterManuscript) => void) {
      const next = structuredClone(store.get(id) as WriterManuscript);
      fn(next); next.rev += 1; store.set(id, next);
    },
    api: {
      fetchTemplates: async () => ({ templates, warnings: [] }),
      fetchManuscripts: async () => ({ manuscripts: [...store.values()].map(summary), warnings: [] }),
      fetchManuscript: async (id: string) => store.get(id) ?? null,
      createManuscript: async () => { throw new Error("unused"); },
      putManuscript: async (doc: WriterManuscript) => {
        const cur = store.get(doc.id);
        if (!cur) return { ok: false as const, conflict: null };
        if (doc.rev !== cur.rev) return { ok: false as const, conflict: cur };
        const saved = { ...doc, rev: doc.rev + 1, updated_at: new Date().toISOString() };
        store.set(doc.id, saved);
        return { ok: true as const, doc: saved };
      },
      deleteManuscript: async (id: string) => store.delete(id),
      uploadAsset: async (_id: string, file: File) => file.name,
      assetUrl: (id: string, name: string) => `/a/${id}/${name}`,
      fetchNumbering: async () => null,
      refreshNumbering: async () => ({ status: "never" as const, facts: null, lastError: null }),
    },
  };
});

vi.mock("../src/writer/latexSource", () => ({ LatexSourceField: (p: ComponentProps<typeof LatexSourceField>) => (
  <textarea id={p.id} data-field="source" aria-label={p.label} value={p.value}
    onChange={(e) => p.onChange(e.target.value)} onFocus={(e) => p.onCaret?.(e.currentTarget)}
    onKeyDown={(e) => { if (e.key === "Enter" && e.shiftKey && !e.nativeEvent.isComposing) p.onCommit?.(); }} />
) }));
vi.mock("../src/api/writer", () => h.api);
vi.mock("../src/api/ws", () => ({
  onWriterChanged: (cb: (msg: unknown) => void) => { h.wsCbs.push(cb); return () => { const i = h.wsCbs.indexOf(cb); if (i >= 0) h.wsCbs.splice(i, 1); }; },
}));

beforeEach(() => h.reset());
afterEach(cleanup);

/** Renders the pane like the Shell does: it keeps the latest page and the controller the pane registered. */
function mount() {
  const state: { page: WriterPage | null; controller: WriterViewController | null; pages: WriterPage[] } = { page: null, controller: null, pages: [] };
  const onContext = (_paneId: number, page: WriterPage | null) => { state.page = page; if (page) state.pages.push(page); };
  const onController = (_paneId: number, controller: WriterViewController | null) => { state.controller = controller; };
  const view = render(<WriterView paneId={1} onContext={onContext} onController={onController} />);
  return { view, state };
}
const editCell = (container: HTMLElement, cellId: string, value: string) => {
  const cell = container.querySelector(`[data-cell="${cellId}"]`) as HTMLElement;
  fireEvent.click(cell.querySelector('[data-action="edit"]') as HTMLElement);
  fireEvent.change(cell.querySelector('textarea[data-field="source"]') as HTMLElement, { target: { value } });
};

describe("the Writer page the Copilot receives", () => {
  it("the list page is complete only once the list loaded, and names every manuscript and template", async () => {
    const { state } = mount();
    await waitFor(() => expect(state.page?.list?.phase).toBe("ready"));
    expect(state.page?.list?.manuscripts.map((m) => m.id)).toEqual([ID]);
    expect(state.page?.list?.templates).toEqual([{ id: "report", label: "Generic Report", types: ["latex", "figure"] }]);
    expect(writerPageStatus(state.page)).toBe("complete");
    expect(state.pages[0]?.list?.phase).not.toBe("ready"); // loading came first and is never complete
    expect(writerPageStatus(state.pages[0])).toBe("unavailable");
  });

  it("an open manuscript carries its whole saved content, every cell, with no draft", async () => {
    const { view, state } = mount();
    await waitFor(() => view.getByText("Stellar Streams"));
    fireEvent.click(view.getByText("Stellar Streams"));
    await waitFor(() => expect(state.page?.editor?.phase).toBe("ready"));
    const editor = state.page?.editor;
    expect(editor?.saved?.cells.map((c) => c.id)).toEqual(["c_0ab50001", "c_0ab50002"]);
    expect(JSON.stringify(editor?.saved)).toContain("LAST-MARK");
    expect(editor?.draft).toBeNull();
    expect(editor?.template).toMatchObject({ id: "report", found: true });
    expect(writerPageStatus(state.page)).toBe("complete");
  });

  it("typing is a draft marked unsaved, kept apart from the saved manuscript, and gone once autosave persisted it", async () => {
    const { view, state } = mount();
    await waitFor(() => view.getByText("Stellar Streams"));
    fireEvent.click(view.getByText("Stellar Streams"));
    await waitFor(() => expect(state.page?.editor?.phase).toBe("ready"));
    editCell(view.container, "c_0ab50002", "Typed but not saved yet");
    await waitFor(() => expect(state.page?.editor?.draft?.unsaved).toBe(true));
    const editor = state.page?.editor;
    // The saved side still shows the disk's text; only the draft carries what was typed.
    expect(JSON.stringify(editor?.saved)).toContain("LAST-MARK");
    expect(JSON.stringify(editor?.saved)).not.toContain("Typed but not saved yet");
    expect(editor?.draft?.cells.changed.map((c) => c.id)).toEqual(["c_0ab50002"]);
    expect(JSON.stringify(editor?.draft)).toContain("Typed but not saved yet");
    expect(editor?.editingCellId).toBe("c_0ab50002");
    await waitFor(() => expect(h.store.get(ID)?.rev).toBe(1), { timeout: 2500 });
    await waitFor(() => expect(state.page?.editor?.draft).toBeNull());
    expect(JSON.stringify(state.page?.editor?.saved)).toContain("Typed but not saved yet");
    expect(state.page?.editor?.saved?.rev).toBe(1);
  });
});

describe("a newer save while the user has unsaved edits (an agent wrote first)", () => {
  it("keeps the user's draft on top of the newer document and saves both, instead of dropping the draft", async () => {
    const { view, state } = mount();
    await waitFor(() => view.getByText("Stellar Streams"));
    fireEvent.click(view.getByText("Stellar Streams"));
    await waitFor(() => expect(state.page?.editor?.phase).toBe("ready"));
    // The agent saves a new title and a change to the first cell while the page still holds rev 0.
    h.externalWrite(ID, (m) => { m.title = "Agent title"; (m.cells[0] as { data: { source: string } }).data.source = "Agent edit of the first cell"; });
    editCell(view.container, "c_0ab50002", "User draft of the second cell");
    await waitFor(() => view.getByText(/已在别处更新/), { timeout: 3000 });
    // Disk: the agent's work AND the user's draft, one revision on top of the agent's.
    await waitFor(() => expect(h.store.get(ID)?.rev).toBe(2), { timeout: 3000 });
    const saved = h.store.get(ID) as WriterManuscript;
    expect(saved.title).toBe("Agent title");
    expect((saved.cells[0] as { data: { source: string } }).data.source).toBe("Agent edit of the first cell");
    expect((saved.cells[1] as { data: { source: string } }).data.source).toBe("User draft of the second cell");
    // The editor still shows what the user typed.
    const textarea = view.container.querySelector('[data-cell="c_0ab50002"] textarea[data-field="source"]') as HTMLTextAreaElement | null;
    if (textarea) expect(textarea.value).toBe("User draft of the second cell");
    await waitFor(() => expect(state.page?.editor?.draft).toBeNull());
  });
});

describe("the controls an agent may press", () => {
  it("open_manuscript shows the editor (after the row exists) and close_manuscript saves, then returns to the list", async () => {
    const { view, state } = mount();
    await waitFor(() => expect(state.controller).not.toBeNull());
    expect(await state.controller?.apply({ action: "open_manuscript", manuscriptId: "m_0000ffff" })).toEqual({ ok: false, detail: "not_found" });
    expect(await state.controller?.apply({ action: "open_manuscript", manuscriptId: ID })).toEqual({ ok: true });
    expect(state.page?.editor?.manuscriptId).toBe(ID);
    expect(state.page?.editor?.phase).toBe("ready");
    editCell(view.container, "c_0ab50002", "Typed before close");
    expect(await state.controller?.apply({ action: "close_manuscript" })).toEqual({ ok: true });
    // The back button's own order: the unsaved text is saved before the editor goes away.
    expect(JSON.stringify(h.store.get(ID))).toContain("Typed before close");
    expect(state.page?.mode).toBe("list");
    expect(await state.controller?.apply({ action: "close_manuscript" })).toEqual({ ok: true });
  });

  it("another manuscript is not opened over an editor whose save cannot complete (leave_blocked)", async () => {
    h.store.set("m_0000000b", { ...h.sample(), id: "m_0000000b", title: "Second" });
    const { view, state } = mount();
    await waitFor(() => expect(state.controller).not.toBeNull());
    await state.controller?.apply({ action: "open_manuscript", manuscriptId: ID });
    // The server no longer has it: the autosave cannot succeed, so leaving would lose the draft.
    editCell(view.container, "c_0ab50002", "Cannot be saved");
    h.store.delete(ID);
    const result = await state.controller?.apply({ action: "open_manuscript", manuscriptId: "m_0000000b" });
    expect(result).toEqual({ ok: false, detail: "leave_blocked" });
    expect(state.page?.editor?.manuscriptId).toBe(ID);
  });
});
