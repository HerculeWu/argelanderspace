/**
 * Stage 10 M2b — WriterView against a mocked REST api (vi.mock of
 * ../src/api/writer): the mock behaves like the real server (in-memory map,
 * rev bump on accepted PUT, 409 conflict carrying the current doc on a stale
 * rev). Scenarios: list/new/delete, edit roundtrip via debounced autosave,
 * add menu, comments, references/crossrefs inserts, equation crossrefs,
 * empty-state first cell, 409 conflict adoption, writer.changed external
 * refetch (incl. defer while a PUT is in flight), image upload → assetUrl.
 * (happy-dom: no layout assertions; scrollIntoView is feature-checked in src.)
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeCell, writerDraftKey, writerTemplateKey, type WriterManuscript, type WriterNumberingResponse, type WriterTemplate, type WriterPreview } from "@argelanderspace/contracts";
import type { ComponentProps } from "react";
import type { LatexSourceField } from "../src/writer/latexSource";
import type { LibraryData } from "../src/library/types";
import { WriterView } from "../src/writer/WriterView";

// ---------------------------------------------------------------- mock ----

const NOW = "2026-09-15T09:00:00.000Z";

const h = vi.hoisted(() => {
  const templates: WriterTemplate[] = [
    {
      id: "aa",
      version: 1,
      label: "A&A",
      chip: "A&A manuscript",
      preamble: "\\documentclass{aa}\n\\usepackage{graphicx}",
      types: ["latex", "abstract-aa", "figure", "table", "code", "ack", "appendix"],
      infoFields: [
        { key: "runningTitle", label: "Running title", input: "text" },
        { key: "keywords", label: "Keywords", input: "text" },
      ],
      frontMatter: "\\title{ {{title}} }\n\\author{ {{authors}} }\n\\maketitle",
      deps: [],
    },
    {
      id: "report",
      version: 1,
      label: "Generic Report",
      chip: "Generic report",
      preamble: "\\documentclass[11pt]{report}",
      types: ["latex", "figure", "table", "code"],
      infoFields: [],
      frontMatter: "\\title{ {{title}} }\n\\maketitle",
      deps: [],
    },
  ];

  function sample(): WriterManuscript {
    return {
      version: 1,
      id: "m_0a1b2c3d",
      rev: 0,
      template: "aa",
      title: "Stellar Streams in the Galactic Halo",
      authors: [{ name: "Wenjie Wu", aff: "1", email: "wenjie@example.org" }],
      affiliations: ["Argelander-Institut für Astronomie, Universität Bonn"],
      userPreamble: "",
      infoValues: {},
      cells: [
        {
          id: "c_0ab50001",
          type: "abstract-aa",
          data: { Context: "Streams preserve information.", Aims: "", Methods: "", Results: "", Conclusions: "" },
        },
        {
          id: "c_0ab50002",
          type: "latex",
          data: {
            source:
              "\\section{Introduction}\n\nStellar streams are sensitive tracers. We compare our inference with \\citep{Belokurov2006}.",
          },
        },
        {
          id: "c_0ab50003",
          type: "latex",
          data: { source: "\\section{Method}\n\nWe model the stream. The full selection function is included explicitly." },
        },
        {
          id: "c_0ab50004",
          type: "figure",
          data: { caption: "Rotation curve.", label: "fig:rotation-curve", placement: "center", width: 82, image: null },
        },
        { id: "c_0ab50005", type: "appendix", data: {} },
      ],
      comments: [
        { id: "cm_0ab50001", cell: "c_0ab50002", who: "AI collaborator", body: "Add one sentence on completeness.", created_at: NOW },
        { id: "cm_0ab50002", cell: "c_0ab50004", who: "Alice", body: "Note the 1-sigma band.", created_at: NOW },
      ],
      created_at: NOW,
      updated_at: NOW,
    } as WriterManuscript;
  }

  const store = new Map<string, WriterManuscript>();
  /** captured onWriterChanged listeners (the mocked ws module) */
  const wsCbs: ((msg: unknown) => void)[] = [];
  /** when set, the next putManuscript awaits this promise first */
  let putGate: Promise<void> | null = null;
  let idSeq = 0;

  const summary = (m: WriterManuscript) => ({
    id: m.id,
    title: m.title,
    template: m.template,
    rev: m.rev,
    created_at: m.created_at,
    updated_at: m.updated_at,
  });

  return {
    templates,
    sample,
    store,
    wsCbs,
    /** I031: explicit-render instrumentation (refresh POST count) */
    refreshCalls: 0,
    reset() {
      store.clear();
      store.set("m_0a1b2c3d", sample());
      wsCbs.length = 0;
      putGate = null;
      idSeq = 0;
      h.numbering = null;
      h.refreshCalls = 0;
    },
    /** simulate an external (agent) write: mutate + bump rev */
    externalWrite(id: string, fn: (m: WriterManuscript) => void) {
      const cur = store.get(id);
      if (!cur) return;
      const next = structuredClone(cur);
      fn(next);
      next.rev += 1;
      next.updated_at = new Date().toISOString();
      store.set(id, next);
    },
    fireWs(msg: unknown) {
      for (const cb of [...wsCbs]) cb(msg);
    },
    /** current numbering facts the api mock serves (tests may set it) */
    numbering: null as WriterNumberingResponse | null,
    setNumbering(n: WriterNumberingResponse | null) {
      if (!n) { h.numbering = null; return; }
      const preview = n.preview ?? previewFor(h.store.get("m_0a1b2c3d")!);
      if (!n.preview) for (const [i, section] of (n.facts?.sections ?? []).entries()) {
        const cell = section.cell ? preview.cells[section.cell] : undefined;
        if (cell) {
          const id = `sec-${i}`;
          cell.items.push({ kind: "heading", id, heading: section.title, number: section.number, level: 1 });
          if (section.label) preview.targetLabels[id] = section.label;
        }
      }
      h.numbering = { ...n, preview };
    },
    gateNextPut() {
      let release!: () => void;
      putGate = new Promise<void>((r) => (release = r));
      return release;
    },
    async _gatedPut(doc: WriterManuscript) {
      if (putGate) {
        const g = putGate;
        putGate = null;
        await g;
      }
      const cur = store.get(doc.id);
      if (!cur) return { ok: false as const, conflict: null };
      if (doc.rev !== cur.rev) return { ok: false as const, conflict: cur };
      const saved = { ...doc, rev: doc.rev + 1, updated_at: new Date().toISOString() };
      store.set(doc.id, saved);
      return { ok: true as const, doc: saved };
    },
    api: {
      fetchTemplates: async () => ({ templates, warnings: [] }),
      fetchManuscripts: async () => ({
        manuscripts: [...store.values()].map(summary).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
        warnings: [],
      }),
      fetchManuscript: async (id: string) => store.get(id) ?? null,
      createManuscript: async (input: { template: string; title?: string }) => {
        const now = new Date().toISOString();
        const m = {
          version: 1,
          id: `m_9000000${idSeq++}`,
          rev: 0,
          template: input.template,
          title: input.title || "Untitled manuscript",
          authors: [],
          affiliations: [],
          userPreamble: "",
          infoValues: {},
          cells: [],
          comments: [],
          created_at: now,
          updated_at: now,
        } as WriterManuscript;
        store.set(m.id, m);
        return m;
      },
      putManuscript: (doc: WriterManuscript) => h._gatedPut(doc),
      deleteManuscript: async (id: string) => store.delete(id),
      uploadAsset: async (_id: string, file: File) => file.name,
      assetUrl: (id: string, name: string) => `/api/writer/manuscripts/${id}/assets/${name}`,
      fetchNumbering: async (_id: string) => h.numbering,
      refreshNumbering: async (_id: string) => {
        h.refreshCalls++;
        return h.numbering ?? { status: "never" as const, facts: null, lastError: null };
      },
    },
  };
});

// State-machine tests use a native input seam. The actual CodeMirror component
// has its own tests and real-browser smoke; these are not layout/IME evidence.
vi.mock("../src/writer/latexSource", () => ({ LatexSourceField: (p: ComponentProps<typeof LatexSourceField>) => (
  <textarea id={p.id} data-field="source" aria-label={p.label} value={p.value}
    onChange={(e) => p.onChange(e.target.value)} onFocus={(e) => p.onCaret?.(e.currentTarget)}
    onKeyDown={(e) => { if (e.key === "Enter" && e.shiftKey && !e.nativeEvent.isComposing) p.onCommit?.(); }} />
) }));

function previewFor(doc: WriterManuscript): WriterPreview {
  return { draftKey: writerDraftKey(doc), templateKey: writerTemplateKey(h.templates.find((t) => t.id === doc.template)!),
    cells: Object.fromEntries(doc.cells.map((c) => [c.id, { source: serializeCell(c), items: [] }])),
    targetCells: {}, labelCells: { "sec:intro": "c_0ab50002" }, targetLabels: {}, references: [], warnings: [] };
}

vi.mock("../src/api/writer", () => h.api);
vi.mock("../src/api/ws", () => ({
  onWriterChanged: (cb: (msg: unknown) => void) => {
    h.wsCbs.push(cb);
    return () => {
      const i = h.wsCbs.indexOf(cb);
      if (i >= 0) h.wsCbs.splice(i, 1);
    };
  },
}));

const LIBRARY: LibraryData = {
  project: { name: "Demo", field: "Astro" },
  refs: [
    {
      id: "w1",
      title: "The Field of Streams",
      authors: "Belokurov et al.",
      year: 2006,
      venue: "ApJ",
      type: "article",
      cite: "Belokurov2006",
      tags: [],
      pdf: true,
      read: false,
      star: false,
    },
  ],
  tags: [],
  graph: { nodes: [], links: [] },
};

vi.mock("../src/api/library", () => ({
  fetchLibrary: async () => ({ data: LIBRARY, live: true }),
}));

beforeEach(() => h.reset());
afterEach(cleanup);

// ------------------------------------------------------------- helpers ----

async function openSample(view: ReturnType<typeof render>) {
  await waitFor(() => view.getByText("Stellar Streams in the Galactic Halo"));
  fireEvent.click(view.getByText("Stellar Streams in the Galactic Halo"));
  await waitFor(() => view.container.querySelector('[data-cell="c_0ab50002"]'));
  return view;
}

/** wait until the debounced autosave PUT has persisted the predicate */
async function waitStore(id: string, pred: (m: WriterManuscript) => boolean, timeout = 2500) {
  await waitFor(() => {
    const m = h.store.get(id);
    expect(m && pred(m)).toBe(true);
  }, { timeout });
}

// --------------------------------------------------------------- tests ----

describe("manuscript list", () => {
  it("renders the fixture manuscript with template and updated column", async () => {
    const { getByText, container } = render(<WriterView />);
    await waitFor(() => getByText("Stellar Streams in the Galactic Halo"));
    getByText("A&A");
    expect(container.querySelector('[data-ui="manuscript-item"]')?.getAttribute("data-ui-key")).toBe("m_0a1b2c3d");
  });

  it("new-manuscript modal requires a template before Create enables", async () => {
    const { getAllByText, getByRole, container } = render(<WriterView />);
    await waitFor(() => container.querySelector('[data-ui="create-manuscript"]'));
    fireEvent.click(container.querySelector('[data-ui="create-manuscript"]')!);
    const create = getByRole("button", { name: /创建/ });
    expect(create.hasAttribute("disabled")).toBe(true);
    const select = container.querySelector(".w-modal select")!;
    fireEvent.change(select, { target: { value: "report" } });
    expect(create.hasAttribute("disabled")).toBe(false);
    fireEvent.click(create);
    // created with the default title and opened straight into the editor
    await waitFor(() => expect(getAllByText("Untitled manuscript").length).toBeGreaterThan(0));
    expect(container.querySelector(".w-template-select")).not.toBeNull();
  });

  it("delete asks for confirmation and removes the row", async () => {
    const { getByText, queryByText, container } = render(<WriterView />);
    await waitFor(() => container.querySelector('[data-ms="m_0a1b2c3d"]'));
    const row = container.querySelector('[data-ms="m_0a1b2c3d"]')!;
    fireEvent.click(row.querySelector('[data-ui="delete-manuscript"]')!);
    getByText("删除稿件"); // confirm dialog
    fireEvent.click(getByText("删除", { selector: ".w-modal-foot button" }));
    await waitFor(() => expect(queryByText("Stellar Streams in the Galactic Halo")).toBeNull());
    expect(h.store.has("m_0a1b2c3d")).toBe(false);
  });
});

describe("editor", () => {
  it("uses shared icon-only actions with localized accessible names while retaining text for ambiguous actions", async () => {
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    const edit = container.querySelector<HTMLButtonElement>('[data-ui="edit-cell"]')!;
    expect(edit.getAttribute("aria-label")).toBe("编辑单元格");
    expect(edit.textContent).toBe("");
    expect(edit.querySelector("svg")).not.toBeNull();
    const tooltipId = edit.getAttribute("aria-describedby");
    expect(tooltipId && container.querySelector(`[id="${tooltipId}"][role="tooltip"]`)?.textContent).toBe("编辑单元格");
    const renderButton = container.querySelector<HTMLButtonElement>('[data-ui="render-manuscript"]')!;
    expect(renderButton.getAttribute("aria-label")).toBe("渲染");
    expect(renderButton.textContent).toBe("");
    expect(renderButton.querySelector("svg")).toBeTruthy();
    const exportButton = container.querySelector<HTMLButtonElement>('[data-ui="export-manuscript"]')!;
    expect(exportButton.getAttribute("aria-label")).toBe("导出");
    expect(exportButton.textContent).toBe("");
    expect(exportButton.querySelector("svg")).toBeTruthy();
    const figure = container.querySelector<HTMLElement>('[data-cell="c_0ab50004"]')!;
    fireEvent.click(figure.querySelector('[data-ui="edit-cell"]')!);
    const placement = figure.querySelector<HTMLButtonElement>('[data-ui="cell-placement"][data-ui-key="left"]')!;
    expect(placement.getAttribute("aria-label")).toBe("左对齐");
    expect(placement.textContent).toBe("左对齐");
    expect(placement.querySelector("svg")).toBeNull();
  });

  it("opens the sample and round-trips a latex cell edit via Shift+Enter", async () => {
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    const cellEl = container.querySelector('[data-cell="c_0ab50002"]')!;
    // No locally guessed heading/citation rendering while compilation is pending.
    expect(cellEl.querySelector(".w-source-preview")?.textContent).toContain("\\section{Introduction}");
    fireEvent.click(cellEl.querySelector('[data-action="edit"]')!);
    const textarea = cellEl.querySelector('textarea[data-field="source"]')!;
    fireEvent.change(textarea, { target: { value: "\\section{Methods X}\n\nBody text." } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    await waitFor(() => {
      expect(cellEl.querySelector(".w-source-preview")?.textContent).toContain("\\section{Methods X}");
    });
    // persisted through the api (debounced autosave → PUT)
    await waitStore("m_0a1b2c3d", (m) => {
      const c = m.cells.find((x) => x.id === "c_0ab50002")!;
      return (c.data as Record<string, unknown>).source === "\\section{Methods X}\n\nBody text.";
    });
  });

  it("add-cell menu offers only the current template's types", async () => {
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    fireEvent.click(container.querySelector(".w-add-cell")!);
    const menu = container.querySelector(".w-menu")!;
    const offered = [...menu.querySelectorAll(".w-menu-item")].map((b) => b.textContent);
    // aa template: latex/abstract-aa/figure/table/code/ack/appendix — no recipient
    expect(offered).toContain("致谢");
    expect(offered).toContain("附录");
    expect(offered).not.toContain("收件人");
    // picking one inserts a new cell in edit mode
    fireEvent.click([...menu.querySelectorAll(".w-menu-item")].find((b) => b.textContent === "致谢")!);
    await waitStore("m_0a1b2c3d", (m) => m.cells.some((c) => c.type === "ack" && c.id.startsWith("c_")));
  });

  it("comments: compose adds a note and bumps the badge", async () => {
    const view = render(<WriterView />);
    const { container, getByText } = await openSample(view);
    expect(container.querySelector(".w-badge")?.textContent).toBe("2");
    const tabs = container.querySelectorAll(".w-right-tab");
    fireEvent.click(tabs[2]!); // comments
    const compose = container.querySelector<HTMLTextAreaElement>(".w-comment-compose textarea")!;
    fireEvent.change(compose, { target: { value: "Check the completeness discussion." } });
    fireEvent.click(container.querySelector(".w-comment-compose .btn.primary")!);
    await waitFor(() => getByText("Check the completeness discussion."));
    expect(container.querySelector(".w-badge")?.textContent).toBe("3");
  });

  it("references tab inserts a bare key into the editing cell", async () => {
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    // references tab is the default; wait for the (mocked) library
    await waitFor(() => view.getByText("The Field of Streams"));
    // without an editing cell the insert falls back to a toast
    fireEvent.click(container.querySelector('[data-ref-key="Belokurov2006"]')!);
    await waitFor(() => view.getByText(/先进入一个 cell/));
    // now edit the intro cell and insert at the end of its source
    const cellEl = container.querySelector('[data-cell="c_0ab50002"]')!;
    fireEvent.click(cellEl.querySelector('[data-action="edit"]')!);
    fireEvent.click(container.querySelector('[data-ref-key="Belokurov2006"]')!);
    await waitFor(() => {
      const textarea = cellEl.querySelector<HTMLTextAreaElement>('textarea[data-field="source"]')!;
      expect(textarea.value.endsWith(".Belokurov2006")).toBe(true);
    });
  });

  it("outline shows compiled numbers (ok) and the stale marker (stale)", async () => {
    h.setNumbering({
      status: "ok",
      at: "2026-09-15T12:00:00.000Z",
      facts: {
        sections: [{ number: "1.1", title: "Introduction", cell: "c_0ab50002", label: "sec:intro" }],
        equations: [],
        labels: { "sec:intro": "1.1" },
      },
      lastError: null,
    });
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    // outline first section row shows the compiled number/label
    await waitFor(() => {
      expect(container.querySelector(".w-outline-row .w-num")?.textContent).toBe("1.1");
    });
    expect(container.querySelector(".w-stale")).toBeNull();

    // stale → marker appears (numbers stay as-is)
    h.setNumbering({
      status: "stale",
      at: "2026-09-15T12:00:00.000Z",
      facts: {
        sections: [{ number: "1.1", title: "Introduction", cell: "c_0ab50002", label: "sec:intro" }],
        equations: [],
        labels: {},
      },
      lastError: "compile failed",
    });
    h.fireWs({ type: "writer.changed", cause: "numbering", id: "m_0a1b2c3d" });
    await waitFor(() => expect(container.querySelector(".w-stale")).not.toBeNull());
  });

  it("crossrefs insert auto-completes a missing \\label on the target cell", async () => {
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    // edit the Method section cell (has no \label)
    const methodCell = container.querySelector('[data-cell="c_0ab50003"]')!;
    fireEvent.click(methodCell.querySelector('[data-action="edit"]')!);
    // switch to crossrefs and insert the Method section target
    const tabs = container.querySelectorAll(".w-right-tab");
    fireEvent.click(tabs[1]!);
    await waitFor(() => container.querySelector('[data-target-cell="c_0ab50003"]'));
    fireEvent.click(container.querySelector('[data-target-cell="c_0ab50003"]')!);
    await waitFor(() => {
      const textarea = methodCell.querySelector<HTMLTextAreaElement>('textarea[data-field="source"]')!;
      // \label appended to the target cell's source, and the label text
      // itself inserted at the editing caret (just before the appended label)
      expect(textarea.value).toContain("\\label{sec:method}");
      expect(textarea.value).toContain("\\section{Method}\\label{sec:method}");
      expect(textarea.value.endsWith("explicitly.sec:method")).toBe(true);
    });
  });

  it("equation targets appear in crossrefs and insert \\label inside the env", async () => {
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    // give the Method cell an unlabeled equation and keep it in edit mode
    const methodCell = container.querySelector('[data-cell="c_0ab50003"]')!;
    fireEvent.click(methodCell.querySelector('[data-action="edit"]')!);
    const textarea = methodCell.querySelector('textarea[data-field="source"]')!;
    fireEvent.change(textarea, {
      target: { value: "\\section{Method}\n\nWe fit:\n\n\\begin{equation}\n  v_c^2 = GM/r\n\\end{equation}" },
    });
    // crossrefs panel now lists the equation (generated label eq:1)
    const tabs = container.querySelectorAll(".w-right-tab");
    fireEvent.click(tabs[1]!);
    await waitFor(() => container.querySelector('[data-target-cell="c_0ab50003"][data-xref-insert="eq:1"]'));
    fireEvent.click(container.querySelector('[data-xref-insert="eq:1"]')!);
    await waitFor(() => {
      const ta = methodCell.querySelector<HTMLTextAreaElement>('textarea[data-field="source"]')!;
      expect(ta.value).toContain("\\begin{equation}\n  \\label{eq:1}\n");
      expect(ta.value).toContain("eq:1"); // label text inserted at the caret too
    });
  });

  it("new manuscript: empty state offers the first-cell add button", async () => {
    const view = render(<WriterView />);
    await waitFor(() => view.container.querySelector('[data-ui="create-manuscript"]'));
    fireEvent.click(view.container.querySelector('[data-ui="create-manuscript"]')!);
    const select = view.container.querySelector(".w-modal select")!;
    fireEvent.change(select, { target: { value: "report" } });
    fireEvent.click(view.getByRole("button", { name: /创建/ }));
    // editor opens on the empty manuscript: empty-state hint + visible ＋
    await waitFor(() => view.getByText("还没有内容块。点击 ＋ 添加第一个。"));
    const addBtn = view.container.querySelector(".w-cells-empty .w-add-cell")!;
    fireEvent.click(addBtn);
    const menu = view.container.querySelector(".w-menu")!;
    // report template offers latex/figure/table/code
    const latexItem = [...menu.querySelectorAll(".w-menu-item")].find((b) => b.textContent === "LaTeX")!;
    fireEvent.click(latexItem);
    await waitFor(() => {
      expect(view.container.querySelector('[data-cell] textarea[data-field="source"]')).not.toBeNull();
    });
    const created = [...h.store.values()].find((m) => m.title === "Untitled manuscript")!;
    await waitStore(created.id, (m) => m.cells.length === 1);
  });

  it("I031: opening never auto-compiles; Render button and global Shift+Enter render explicitly", async () => {
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    // no cached compile for this fixture: the placeholder invites an explicit render
    await waitFor(() => view.getAllByText(/尚未渲染/));
    expect(h.refreshCalls).toBe(0);
    fireEvent.click(container.querySelector("[data-render-button]")!);
    await waitFor(() => expect(h.refreshCalls).toBe(1));
    // Shift+Enter outside an editing cell renders the manuscript
    fireEvent.keyDown(container.querySelector(".writer-root")!, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(h.refreshCalls).toBe(2));
  });

  it("I031: external writer.changed marks stale without compiling", async () => {
    const view = render(<WriterView />);
    await openSample(view);
    expect(h.refreshCalls).toBe(0);
    h.externalWrite("m_0a1b2c3d", (m) => {
      m.title = "Externally Retitled";
    });
    h.fireWs({ type: "writer.changed", cause: "external", id: "m_0a1b2c3d" });
    await waitFor(() => view.getAllByText("Externally Retitled"));
    expect(h.refreshCalls).toBe(0);
  });

  it("renders compiled IR math after saving before the explicit refresh", async () => {
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    const cellEl = container.querySelector('[data-cell="c_0ab50003"]')!;
    fireEvent.click(cellEl.querySelector('[data-action="edit"]')!);
    const textarea = cellEl.querySelector('textarea[data-field="source"]')!;
    fireEvent.change(textarea, {
      target: { value: "We fit \\(v_c\\) in \\begin{equation} v_c^2 = GM/r \\end{equation} exactly." },
    });
    const compiledDoc = structuredClone(h.store.get("m_0a1b2c3d")!);
    compiledDoc.cells[2]!.data.source = "We fit \\(v_c\\) in \\begin{equation} v_c^2 = GM/r \\end{equation} exactly.";
    const preview = previewFor(compiledDoc);
    preview.cells.c_0ab50003!.items = [
      { kind: "block", block: { id: "p-1", type: "paragraph", segments: [{ type: "text", text: "We fit " }, { type: "math", latex: "v_c" }] } },
      { kind: "block", block: { id: "eq-1", type: "equation", latex: "v_c^2 = GM/r", number: "1.2" }, rows: [{ latex: "v_c^2 = GM/r", number: "1.2" }] },
    ];
    h.setNumbering({ status: "ok", facts: { sections: [], equations: [], labels: {} }, lastError: null, preview });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    await waitFor(() => {
      expect(cellEl.querySelector(".w-math .katex-display")).not.toBeNull();
      expect(cellEl.querySelector("p .katex")).not.toBeNull();
    });
  });

  it("a 409 conflict adopts the server's current doc and toasts", async () => {
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    // external writer bumps the doc while we hold rev 0
    h.externalWrite("m_0a1b2c3d", (m) => {
      m.title = "Externally Retitled";
    });
    // local edit against the stale rev → PUT 409
    const cellEl = container.querySelector('[data-cell="c_0ab50003"]')!;
    fireEvent.click(cellEl.querySelector('[data-action="edit"]')!);
    const textarea = cellEl.querySelector('textarea[data-field="source"]')!;
    fireEvent.change(textarea, { target: { value: "\\section{Method}\n\nLocal edit." } });
    await waitFor(() => view.getByText(/已在别处更新/), { timeout: 2500 });
    // the editor adopted the conflict doc (external title visible)
    await waitFor(() => view.getAllByText("Externally Retitled"));
    // and the editor's rev now matches the store (further edits save cleanly)
    await waitStore("m_0a1b2c3d", (m) => m.rev === 1);
  });

  it("writer.changed for the open doc refetches (external title appears)", async () => {
    const view = render(<WriterView />);
    await openSample(view);
    h.externalWrite("m_0a1b2c3d", (m) => {
      m.title = "Synced From Outside";
    });
    h.fireWs({ type: "writer.changed", cause: "external", id: "m_0a1b2c3d", at: new Date().toISOString() });
    await waitFor(() => view.getAllByText("Synced From Outside"));
  });

  it("writer.changed during an in-flight PUT is deferred until the write settles", async () => {
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    // start a local edit; gate the next PUT so we control when it lands
    const cellEl = container.querySelector('[data-cell="c_0ab50003"]')!;
    fireEvent.click(cellEl.querySelector('[data-action="edit"]')!);
    const textarea = cellEl.querySelector('textarea[data-field="source"]')!;
    const release = h.gateNextPut();
    fireEvent.change(textarea, { target: { value: "\\section{Method}\n\nLocal while gated." } });
    // wait for the debounce to fire the (blocked) PUT
    await waitFor(() => expect(h.store.size).toBeGreaterThan(0), { timeout: 1500 });
    // external change + WS while the PUT is in flight → deferred
    h.externalWrite("m_0a1b2c3d", (m) => {
      m.title = "Deferred External Title";
    });
    h.fireWs({ type: "writer.changed", cause: "external", id: "m_0a1b2c3d", at: new Date().toISOString() });
    // not refetched yet (the local optimistic doc has the old title)
    expect(view.queryByText("Deferred External Title")).toBeNull();
    release();
    await waitFor(() => view.getAllByText("Deferred External Title"), { timeout: 2500 });
  });

  it("writer.changed delete for the open doc returns to the list with a note", async () => {
    const view = render(<WriterView />);
    await openSample(view);
    h.store.delete("m_0a1b2c3d");
    h.fireWs({ type: "writer.changed", cause: "delete", id: "m_0a1b2c3d", at: new Date().toISOString() });
    await waitFor(() => view.getByText("该稿件已在别处被删除。"));
  });

  it("figure image upload stores the returned name and renders via assetUrl", async () => {
    const view = render(<WriterView />);
    const { container } = await openSample(view);
    const figCell = container.querySelector('[data-cell="c_0ab50004"]')!;
    fireEvent.click(figCell.querySelector('[data-action="edit"]')!);
    const input = figCell.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["png-bytes"], "plot.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    // upload resolves → data.image = stored name → render shows assetUrl
    fireEvent.keyDown(figCell.querySelector('textarea[data-field="caption"]')!, {
      key: "Enter",
      shiftKey: true,
    });
    await waitFor(() => {
      const img = figCell.querySelector("img");
      expect(img?.getAttribute("src")).toBe("/api/writer/manuscripts/m_0a1b2c3d/assets/plot.png");
    });
    await waitStore("m_0a1b2c3d", (m) => {
      const c = m.cells.find((x) => x.id === "c_0ab50004")!;
      return (c.data as Record<string, unknown>).image === "plot.png";
    });
  });
});
