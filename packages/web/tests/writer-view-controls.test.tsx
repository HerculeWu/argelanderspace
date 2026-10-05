/**
 * The Writer view controls a Copilot view action presses (copilot ticket 23): the cell click and pencil, the panel
 * folds, the right tabs, the template warning's close button, Export and the list's Retry, on the real
 * WriterView/WriterEditor with only the REST client and the WS bus replaced. Plus the safe table display of the
 * preview. Not layout evidence (happy-dom).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WriterManuscript, WriterPage, WriterTemplate } from "@argelanderspace/contracts";
import type { ComponentProps } from "react";
import type { LatexSourceField } from "../src/writer/latexSource";
import { safeTableHtml } from "../src/lib/safe-table-html";
import { WriterView, type WriterViewController } from "../src/writer/WriterView";

const ID = "m_0a1b2c3d";

const h = vi.hoisted(() => {
  const state = { warnings: ["bad template file"] as string[], listFails: true, exportOk: true, exported: 0 };
  const sample = (): WriterManuscript =>
    ({
      version: 1, id: "m_0a1b2c3d", rev: 0, template: "report", title: "Stellar Streams", authors: [], affiliations: [], userPreamble: "", infoValues: {},
      cells: [
        { id: "c_0ab50001", type: "latex", data: { source: "First paragraph." } },
        { id: "c_0ab50002", type: "latex", data: { source: "Second paragraph." } },
      ],
      comments: [], created_at: "2026-09-15T09:00:00.000Z", updated_at: "2026-09-15T09:00:00.000Z",
    }) as WriterManuscript;
  const templates: WriterTemplate[] = [
    { id: "report", version: 1, label: "Generic Report", chip: "Generic report", preamble: "", types: ["latex", "figure"], infoFields: [], frontMatter: "", deps: [] } as WriterTemplate,
  ];
  const store = new Map<string, WriterManuscript>();
  return {
    state, sample, store,
    reset() { state.warnings = ["bad template file"]; state.listFails = false; state.exportOk = true; state.exported = 0; store.clear(); store.set("m_0a1b2c3d", sample()); },
    api: {
      fetchTemplates: async () => (state.listFails ? null : { templates, warnings: state.warnings }),
      fetchManuscripts: async () => (state.listFails ? null : { manuscripts: [...store.values()].map((m) => ({ id: m.id, title: m.title, template: m.template, rev: m.rev, created_at: m.created_at, updated_at: m.updated_at })), warnings: [] }),
      fetchManuscript: async (id: string) => store.get(id) ?? null,
      probeManuscript: async (id: string) => (store.has(id) ? "found" : "missing"),
      createManuscript: async () => { throw new Error("unused"); },
      putManuscript: async (doc: WriterManuscript) => { const saved = { ...doc, rev: doc.rev + 1 }; store.set(doc.id, saved); return { ok: true as const, doc: saved }; },
      deleteManuscript: async () => true,
      uploadAsset: async (_id: string, file: File) => file.name,
      assetUrl: (id: string, name: string) => `/a/${id}/${name}`,
      fetchNumbering: async () => null,
      refreshNumbering: async () => ({ status: "never" as const, facts: null, lastError: null }),
      exportUrl: (id: string) => `/export/${id}`,
    },
  };
});

vi.mock("../src/writer/latexSource", () => ({ LatexSourceField: (p: ComponentProps<typeof LatexSourceField>) => (
  <textarea id={p.id} data-field="source" aria-label={p.label} value={p.value} onChange={(e) => p.onChange(e.target.value)} onFocus={(e) => p.onCaret?.(e.currentTarget)} />
) }));
vi.mock("../src/api/writer", () => h.api);
vi.mock("../src/api/ws", () => ({ onWriterChanged: () => () => {} }));

beforeEach(() => {
  h.reset();
  (globalThis as { fetch: unknown }).fetch = vi.fn(async (input: unknown) => {
    // The References tab reads the library through fetch too; only the export counts here.
    if (!String(input).startsWith("/export/")) return new Response(JSON.stringify({ refs: [] }), { status: 200 });
    h.state.exported++;
    return h.state.exportOk
      ? new Response(new Blob(["zip"]), { status: 200, headers: { "X-Writer-Bib-Missing": "%5B%5D", "X-Writer-Warnings": "%5B%5D" } })
      : new Response("no", { status: 500 });
  });
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:x";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});
afterEach(cleanup);

function mount() {
  const state: { page: WriterPage | null; controller: WriterViewController | null } = { page: null, controller: null };
  const view = render(
    <WriterView paneId={1} onContext={(_p, page) => { state.page = page; }} onController={(_p, controller) => { state.controller = controller; }} />,
  );
  return { view, state };
}
async function open(): Promise<ReturnType<typeof mount>> {
  const mounted = mount();
  await waitFor(() => expect(mounted.state.controller).not.toBeNull());
  expect(await mounted.state.controller?.apply({ action: "open_manuscript", manuscriptId: ID })).toEqual({ ok: true });
  return mounted;
}

describe("editor controls", () => {
  it("select_cell is a click on the cell (active, as the page reports it); an unknown cell is not_found", async () => {
    const { state } = await open();
    expect(await state.controller?.apply({ action: "select_cell", manuscriptId: ID, cellId: "c_0ab50002" })).toEqual({ ok: true });
    await waitFor(() => expect(state.page?.editor?.activeCellId).toBe("c_0ab50002"));
    expect(await state.controller?.apply({ action: "select_cell", manuscriptId: ID, cellId: "c_0000ffff" })).toEqual({ ok: false, detail: "not_found" });
  });

  it("edit_cell is the pencil: the cell opens in its editing form", async () => {
    const { view, state } = await open();
    expect(await state.controller?.apply({ action: "edit_cell", manuscriptId: ID, cellId: "c_0ab50001" })).toEqual({ ok: true });
    await waitFor(() => expect(state.page?.editor?.editingCellId).toBe("c_0ab50001"));
    expect(view.container.querySelector('[data-cell="c_0ab50001"] textarea[data-field="source"]')).not.toBeNull();
  });

  it("set_writer_panel folds and opens the outline and References panels like their buttons, and the page reports it", async () => {
    const { view, state } = await open();
    const outline = () => view.container.querySelector('[data-ui="writer-outline-panel"]') as HTMLElement;
    const refs = () => view.container.querySelector('[data-ui="writer-reference-panel"]') as HTMLElement;
    await state.controller?.apply({ action: "set_writer_panel", panel: "outline", collapsed: true });
    await waitFor(() => expect(outline().className).toContain("collapsed"));
    await state.controller?.apply({ action: "set_writer_panel", panel: "references", collapsed: true });
    await waitFor(() => expect(refs().className).toContain("collapsed"));
    await waitFor(() => expect(state.page?.editor?.panels).toMatchObject({ outlineCollapsed: true, referencesCollapsed: true }));
    await state.controller?.apply({ action: "set_writer_panel", panel: "outline", collapsed: false });
    await waitFor(() => expect(outline().className).not.toContain("collapsed"));
  });

  it("set_writer_tab switches the right panel's tab", async () => {
    const { view, state } = await open();
    await state.controller?.apply({ action: "set_writer_tab", tab: "comments" });
    await waitFor(() => expect(view.container.querySelector('[data-ui="writer-comments"]')).not.toBeNull());
    await waitFor(() => expect(state.page?.editor?.panels?.rightTab).toBe("comments"));
  });

  it("dismiss_template_warning closes the warning once; with none showing it is disabled", async () => {
    const { view, state } = await open();
    expect(view.container.querySelector('[data-ui="writer-template-warning"]')).not.toBeNull();
    await waitFor(() => expect(state.page?.editor?.panels?.templateWarnings).toBe(1));
    expect(await state.controller?.apply({ action: "dismiss_template_warning" })).toEqual({ ok: true });
    await waitFor(() => expect(view.container.querySelector('[data-ui="writer-template-warning"]')).toBeNull());
    expect(await state.controller?.apply({ action: "dismiss_template_warning" })).toEqual({ ok: false, detail: "disabled" });
  });

  it("a control of another manuscript, or with no editor open, is unavailable and does nothing", async () => {
    const { state } = await open();
    expect(await state.controller?.apply({ action: "select_cell", manuscriptId: "m_0000ffff", cellId: "c_0ab50001" })).toEqual({ ok: false, detail: "unavailable" });
    await state.controller?.apply({ action: "close_manuscript" });
    expect(await state.controller?.apply({ action: "set_writer_tab", tab: "comments" })).toEqual({ ok: false, detail: "unavailable" });
  });

  it("export_manuscript is the Export button: pending save first, then the download; a failed export is reported as failed", async () => {
    const { view, state } = await open();
    // the user has typed something unsaved: the export saves it first, exactly as the button does
    fireEvent.click(view.container.querySelector('[data-cell="c_0ab50001"] [data-action="edit"]') as HTMLElement);
    fireEvent.change(view.container.querySelector('[data-cell="c_0ab50001"] textarea[data-field="source"]') as HTMLElement, { target: { value: "Typed" } });
    expect(await state.controller?.apply({ action: "export_manuscript", manuscriptId: ID })).toEqual({ ok: true });
    expect(JSON.stringify(h.store.get(ID))).toContain("Typed");
    expect(h.state.exported).toBe(1);
    h.state.exportOk = false;
    expect(await state.controller?.apply({ action: "export_manuscript", manuscriptId: ID })).toEqual({ ok: false, detail: "failed" });
  });
});

describe("list controls", () => {
  it("retry_manuscript_list is the Retry button of a failed first load; with the list showing it is disabled", async () => {
    h.state.listFails = true;
    const { view, state } = mount();
    await waitFor(() => expect(state.controller).not.toBeNull());
    await waitFor(() => expect(view.container.querySelector('[data-ui="retry-manuscript-list"]')).not.toBeNull());
    expect(await state.controller?.apply({ action: "retry_manuscript_list" })).toEqual({ ok: false, detail: "failed" });
    h.state.listFails = false;
    expect(await state.controller?.apply({ action: "retry_manuscript_list" })).toEqual({ ok: true });
    await waitFor(() => expect(view.container.querySelector('[data-ui="retry-manuscript-list"]')).toBeNull());
    expect(await state.controller?.apply({ action: "retry_manuscript_list" })).toEqual({ ok: false, detail: "disabled" });
  });
});

describe("spec 14.3: the preview's table body", () => {
  it("keeps table structure and spans, drops scripts, events, links, images and styles", () => {
    const dirty =
      '<table onclick="x()"><tr><th colspan="2" style="color:red">H<script>alert(1)</script></th></tr><tr><td rowspan="2">a<img src=x onerror=alert(1)></td><td><a href="javascript:alert(1)">link</a><sup>2</sup></td></tr></table>';
    const clean = safeTableHtml(dirty);
    expect(clean).toContain('<th colspan="2">H</th>');
    expect(clean).toContain('<td rowspan="2">a</td>');
    expect(clean).toContain("link<sup>2</sup>");
    for (const bad of ["script", "onclick", "onerror", "<img", "<a ", "javascript", "style"]) expect(clean).not.toContain(bad);
  });
  it("a non-numeric span is dropped", () => {
    expect(safeTableHtml('<table><tr><td colspan="2;x">c</td></tr></table>')).not.toContain("colspan");
  });
});
