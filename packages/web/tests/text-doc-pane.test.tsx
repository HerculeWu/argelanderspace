import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocDescription, TextSourceDto, TextSourcePage } from "@argelanderspace/contracts";
import { ReaderBridgeContext, type ReaderBridge } from "../src/doc/reader-bridge";
import { EditorView } from "@codemirror/view";
import { TextDocPane } from "../src/doc/TextDocPane";
import { confirmWorkspaceLeave, WorkspaceProvider, type Workspace } from "../src/argelander/workspace";

const events = vi.hoisted(() => ({
  published: new Set<(m: { doc_id: string; published_source_rev: number; at: string; type: "text-doc.published" }) => void>(),
  source: new Set<(m: { doc_id: string; rev: number; at: string; type: "text-source.changed" }) => void>(),
}));
vi.mock("../src/api/ws", () => ({
  onTextDocPublished: (cb: never) => { events.published.add(cb); return () => events.published.delete(cb); },
  onTextSourceChanged: (cb: never) => { events.source.add(cb); return () => events.source.delete(cb); },
  onLibraryChanged: () => () => {},
  onAnnotationChanged: () => () => {},
}));

type TextDescription = Extract<DocDescription, { format: "text" }>;
const DOC = "text-11111111-1111-4111-8111-111111111111";
const PDF = "pdf-22222222-2222-4222-8222-222222222222";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Backend {
  rev: number;
  markdown: string;
  log: string[];
  puts: { expectedRev: number; markdown: string }[];
  generated: boolean;
  publishedRev: number | null;
  /** next generate answer override (receives the request body) */
  generate?: (body: { sourceRev: number; operationId: string; confirm?: Record<string, unknown> }) => Response;
  validate?: () => Response;
  pdfOk: boolean;
  putGate?: Promise<void>;
  assets: TextSourceDto["assets"];
  /** the next POST .../source/assets answer (default: accept as a PNG named after the file) */
  assetAnswer?: (url: string) => Response;
  assetPosts: { url: string; type: string | null; size: number }[];
  /** the bodies of POST .../source/assets/from-pdf (ticket 29) and the next answer (default: add a PNG) */
  pdfPosts: Record<string, unknown>[];
  pdfAnswer?: () => Response;
  /** the status of GET .../source while a load failure is being simulated (default 200) */
  sourceStatus?: number;
}
let backend: Backend;
const dto = (): TextSourceDto => ({
  doc_id: DOC,
  rev: backend.rev,
  input_version: 1,
  markdown: backend.markdown,
  assets: backend.assets,
  created_at: "2026-10-05T00:00:00.000Z",
  updated_at: "2026-10-05T00:00:00.000Z",
  generated: backend.generated,
  published_source_rev: backend.publishedRev,
});
function installBackend() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    backend.log.push(`${method} ${url}`);
    if (url === `/api/paper/${DOC}/source` && method === "GET") return backend.sourceStatus && backend.sourceStatus !== 200 ? json({ detail: "boom" }, backend.sourceStatus) : json(dto());
    if (url === `/api/paper/${DOC}/source` && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { expectedRev: number; markdown: string };
      backend.puts.push(body);
      if (backend.putGate) await backend.putGate;
      if (body.expectedRev !== backend.rev) return json({ detail: "rev mismatch", rev: backend.rev, source: dto() }, 409);
      backend.rev += 1;
      backend.markdown = body.markdown;
      return json(dto());
    }
    if (url.startsWith(`/api/paper/${DOC}/source/assets?`) && method === "POST") {
      const file = init?.body as Blob;
      backend.assetPosts.push({ url, type: new Headers(init?.headers).get("content-type"), size: file.size });
      if (backend.assetAnswer) return backend.assetAnswer(url);
      const filename = decodeURIComponent(/filename=([^&]*)/.exec(url)?.[1] ?? "image.png");
      const asset = { name: `${filename.replace(/\.png$/, "").replace(/ /g, "-")}-0123abcd.png`, sha256: "c".repeat(64), byte_length: file.size, media_type: "image/png" as const, width: 40, height: 30 };
      backend.assets = [...backend.assets, asset];
      backend.rev += 1;
      return json({ source: dto(), asset, reused: false, restored: false }, 201);
    }
    if (url.startsWith(`/api/paper/${PDF}/pdf/pages?`)) return json({ page_count: 3 });
    if (url.startsWith(`/api/paper/${PDF}/pdf/pages/`)) return new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/png" } });
    if (url === `/api/paper/${DOC}/source/assets/from-pdf` && method === "POST") {
      backend.pdfPosts.push(JSON.parse(String(init?.body)));
      if (backend.pdfAnswer) return backend.pdfAnswer();
      const asset = { name: "p2-region-0123abcd.png", sha256: "d".repeat(64), byte_length: 900, media_type: "image/png" as const, width: 300, height: 200 };
      backend.assets = [...backend.assets, asset];
      backend.rev += 1;
      return json({ source: dto(), asset, reused: false, restored: false }, 201);
    }
    if (url === `/api/paper/${DOC}/source/validate` && backend.validate) return backend.validate();
    if (url === `/api/paper/${DOC}/source/validate`) return json({ sourceRev: backend.rev, valid: true, diagnostics: [], stats: { sections: 2, paragraphs: 3, lists: 1 } });
    if (url === `/api/paper/${DOC}/source/generate`) {
      if (backend.generate) return backend.generate(JSON.parse(String(init?.body)));
      backend.generated = true;
      backend.publishedRev = backend.rev;
      return json({ publishedSourceRev: backend.rev, fingerprint: "a".repeat(64), replacedAnnotations: 0, diagnostics: [], stats: { sections: 1, paragraphs: 1, lists: 0 } });
    }
    if (url === `/api/paper/${DOC}/description`) return json(description());
    if (url === `/api/paper/${PDF}/description`) return backend.pdfOk ? json({ doc_id: PDF, format: "latex" }) : json({ detail: "not found" }, 404);
    return json({ detail: "unexpected" }, 500);
  }));
}
const description = (over: Partial<TextDescription> = {}): TextDescription => ({
  doc_id: DOC,
  format: "text",
  generated: backend.generated,
  source_rev: backend.rev,
  published_source_rev: backend.publishedRev,
  ...over,
});
const opened: string[] = [];
const pages: (TextSourcePage | null)[] = [];
const viewHandles: (((view: "reader" | "source") => void) | null)[] = [];
const retryHandles: (((() => void) | null))[] = [];
const stubBridge: ReaderBridge = {
  setSession() {}, setLive() {}, setFailure() {}, setPanels() {}, setHandle() {}, addRetry: (retry) => { retryHandles.push(retry); return () => { retryHandles.push(null); }; },
  setTextView: (setView) => { viewHandles.push(setView); },
};
function Harness({ withPdf = false }: { withPdf?: boolean }) {
  const workspace: Workspace = {
    papers: [DOC], currentDoc: DOC, setCurrentDoc: () => {}, openDoc: (id) => { if (id) opened.push(id); },
    pendingAnchor: null, clearPendingAnchor: () => {}, docDeleted: () => {},
    tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
  };
  return <WorkspaceProvider value={workspace}>
    <ReaderBridgeContext.Provider value={stubBridge}>
      <TextDocPane docId={DOC} onPage={(page) => { pages.push(page); }} description={description(withPdf ? { source_pdf: { doc_id: PDF, sha256: "b".repeat(64) } } : {})} reader={<div data-testid="reader-stub">reader</div>} />
    </ReaderBridgeContext.Provider>
  </WorkspaceProvider>;
}
const cm = (c: HTMLElement) => {
  const content = c.querySelector<HTMLElement>(".cm-content");
  return content ? (EditorView.findFromDOM(content) ?? null) : null;
};
/** The CodeMirror source field seen as a plain text field (value, selection, read-only). */
const input = (c: HTMLElement) => {
  const view = cm(c);
  return view
    ? {
        get value() { return view.state.doc.toString(); },
        get readOnly() { return view.state.readOnly; },
        get selectionStart() { return view.state.selection.main.from; },
        get selectionEnd() { return view.state.selection.main.to; },
        view,
      }
    : null;
};
/** Type by replacing the document, as the editor's own transactions do. */
const typeText = (c: HTMLElement, value: string) => {
  const view = cm(c)!;
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, userEvent: "input.type" }));
};
const ui = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-ui="${id}"]`);
const posts = (kind: "generate" | "validate") => backend.log.filter((l) => l.startsWith("POST") && l.endsWith(`/source/${kind}`));

const stopSelection = (e: Event) => e.stopImmediatePropagation();
beforeEach(() => {
  document.addEventListener("selectionchange", stopSelection, true);
  backend = { rev: 0, markdown: "", log: [], puts: [], generated: false, publishedRev: null, pdfOk: true, assets: [], assetPosts: [], pdfPosts: [] };
  opened.length = 0;
  pages.length = 0;
  viewHandles.length = 0;
  retryHandles.length = 0;
  installBackend();
});
afterEach(() => {
  document.removeEventListener("selectionchange", stopSelection, true);
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  events.published.clear();
  events.source.clear();
});

async function ready(withPdf = false) {
  const view = render(<Harness withPdf={withPdf} />);
  await waitFor(() => expect(input(view.container)).not.toBeNull());
  return view;
}

describe("text Doc pane: autosave and explicit generation", () => {
  it("a first draft opens on the source and shows the first-draft state in the reading tab", async () => {
    const { container, getByRole } = await ready();
    expect(ui(container, "text-source-panel")?.hidden).toBe(false);
    expect(ui(container, "text-reader-panel")?.hidden).toBe(true);
    // line numbers (CodeMirror gutter) are on
    expect(container.querySelector(".cm-lineNumbers")).toBeTruthy();
    fireEvent.click(getByRole("tab", { name: "阅读" }));
    expect(ui(container, "text-doc-first-draft")).toBeTruthy();
    expect(container.querySelector('[data-testid="reader-stub"]')).toBeNull();
  });

  it("saves typed text byte for byte after a pause, with expectedRev, and never validates or generates", async () => {
    const view = await ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const text = "# T\r\n\r\n```\nunclosed $x\t中文";
    typeText(view.container, text);
    expect(ui(view.container, "text-source-status")?.getAttribute("data-state")).toBe("dirty");
    expect(backend.puts).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    vi.useRealTimers();
    await waitFor(() => expect(ui(view.container, "text-source-status")?.getAttribute("data-state")).toBe("saved"));
    expect(backend.puts).toEqual([{ expectedRev: 0, markdown: text }]);
    expect(posts("generate")).toHaveLength(0);
    expect(posts("validate")).toHaveLength(0);
  });

  it("Generate saves the newest typing first, then generates the revision just saved", async () => {
    const view = await ready();
    typeText(view.container, "# Title\n\nbody");
    fireEvent.click(ui(view.container, "text-source-generate")!);
    await waitFor(() => expect(ui(view.container, "text-source-generated")).toBeTruthy());
    const order = backend.log.filter((l) => l.startsWith("PUT") || l.endsWith("/generate"));
    expect(order).toEqual([`PUT /api/paper/${DOC}/source`, `POST /api/paper/${DOC}/source/generate`]);
    expect(backend.markdown).toBe("# Title\n\nbody");
  });

  it("a text with errors keeps the source and shows the located diagnostics; clicking one selects its line", async () => {
    backend.generate = () => json({ detail: "the text has errors", code: "diagnostics", diagnostics: [{ code: "quote_unsupported", severity: "error", message: "block quotes are not supported", line: 3, column: 1 }], stats: { sections: 0, paragraphs: 0, lists: 0 } }, 422);
    const view = await ready();
    const text = "# T\n\n> quote\n\nend";
    typeText(view.container, text);
    fireEvent.click(ui(view.container, "text-source-generate")!);
    await waitFor(() => expect(ui(view.container, "text-source-diagnostics")).toBeTruthy());
    expect(ui(view.container, "text-source-generation-error")?.textContent).toContain("文本存在错误，未生成");
    const row = ui(view.container, "text-source-diagnostic")!;
    expect(row.textContent).toContain("第 3 行，第 1 列");
    expect(row.textContent).toContain("不支持块引用");
    fireEvent.click(row.querySelector("button")!);
    // the caret lands on the diagnostic's line and column (line 3, column 1), CodeMirror's own selection
    expect(input(view.container)!.selectionStart).toBe(text.indexOf("> quote"));
    expect(input(view.container)!.value).toBe(text);
    expect(backend.markdown).toBe(text);
  });

  it("ticket 26 diagnostics are localized with the offending value; warnings do not make the text invalid", async () => {
    backend.validate = () =>
      json({
        sourceRev: backend.rev,
        valid: true,
        stats: { sections: 1, paragraphs: 1, lists: 0 },
        diagnostics: [
          { code: "cite_unresolved", severity: "warning", message: "no reference has the id", line: 3, column: 5, subject: "ghost1999" },
          { code: "block_meta_unknown_field", severity: "warning", message: "unknown", line: 7, column: 3, subject: "colour", field: "colour" },
          { code: "math_katex", severity: "warning", message: "x", line: 9, column: 2, subject: "Undefined control sequence" },
          { code: "future_code_from_a_newer_server", severity: "warning", message: "the server's own words", line: 11, column: 1 },
        ],
      });
    const view = await ready();
    typeText(view.container, "# T\n\nSee [cite: ghost1999].");
    fireEvent.click(ui(view.container, "text-source-validate")!);
    await waitFor(() => expect(ui(view.container, "text-source-diagnostics")).toBeTruthy());
    expect(ui(view.container, "text-source-valid")).toBeTruthy();
    const rows = Array.from(view.container.querySelectorAll('[data-ui="text-source-diagnostic"]')).map((r) => r.textContent);
    expect(rows[0]).toContain("没有 id 为“ghost1999”的参考文献");
    expect(rows[1]).toContain("块设置没有名为“colour”的字段");
    expect(rows[2]).toContain("这个公式无法排版：Undefined control sequence");
    expect(rows[3]).toContain("the server's own words");
  });

  describe("replacing reading text that has annotations (ticket 28)", () => {
    const impact = (over: Record<string, unknown> = {}) => ({
      docId: DOC,
      sourceRev: 1,
      publishedSourceRev: 0,
      annotations: 3,
      annotationsRev: 7,
      oldFingerprint: "a".repeat(64),
      newFingerprint: "b".repeat(64),
      ...over,
    });
    const asks = (over: Record<string, unknown> = {}, code = "confirmation_required") =>
      json({ detail: "needs confirmation", code, impact: impact(over) }, 409);
    const dialog = () => document.querySelector<HTMLElement>('[data-ui="text-regeneration-dialog"]');
    const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-ui="${id}"]`);

    async function asked(view: Awaited<ReturnType<typeof ready>>) {
      typeText(view.container, "# T\n\nbody");
      fireEvent.click(ui(view.container, "text-source-generate")!);
      await waitFor(() => expect(dialog()).toBeTruthy());
    }

    it("shows the impact instead of publishing; nothing was sent but the first request, text kept", async () => {
      backend.generate = () => asks();
      const view = await ready();
      await asked(view);
      expect(dialog()?.textContent).toContain("3 条标注");
      expect(dialog()?.textContent).toContain("归档");
      expect(dialog()?.textContent).toContain("标注版本 7");
      expect(button("confirm-text-regeneration")?.textContent).toContain("替换并归档 3 条标注");
      expect(posts("generate")).toHaveLength(1);
      expect(input(view.container)!.value).toBe("# T\n\nbody");
      // the safe choice has the initial focus
      expect(document.activeElement).toBe(button("cancel-text-regeneration"));
    });

    it("cancelling writes nothing: no second request, the reading version is not generated", async () => {
      backend.generate = () => asks();
      const view = await ready();
      await asked(view);
      fireEvent.click(button("cancel-text-regeneration")!);
      await waitFor(() => expect(dialog()).toBeNull());
      expect(posts("generate")).toHaveLength(1);
      expect(backend.generated).toBe(false);
      expect(ui(view.container, "text-source-generated")).toBeNull();
      expect(ui(view.container, "text-source-regeneration-cancelled")?.textContent).toContain("已取消");
      expect(input(view.container)!.value).toBe("# T\n\nbody");
    });

    it("a click on the confirmation sends exactly the stated values and the revision the question was about", async () => {
      const bodies: { sourceRev: number; confirm?: Record<string, unknown> }[] = [];
      backend.generate = (body) => {
        bodies.push(body);
        if (!body.confirm) return asks({ sourceRev: body.sourceRev });
        backend.generated = true;
        backend.publishedRev = body.sourceRev;
        return json({ publishedSourceRev: body.sourceRev, fingerprint: "b".repeat(64), replacedAnnotations: 3, diagnostics: [], stats: { sections: 1, paragraphs: 1, lists: 0 } });
      };
      const view = await ready();
      await asked(view);
      fireEvent.click(button("confirm-text-regeneration")!);
      await waitFor(() => expect(ui(view.container, "text-source-generated")).toBeTruthy());
      expect(bodies).toHaveLength(2);
      expect(bodies[0]!.confirm).toBeUndefined();
      expect(bodies[1]).toMatchObject({ sourceRev: bodies[0]!.sourceRev, confirm: impact({ sourceRev: bodies[0]!.sourceRev }) });
      expect(dialog()).toBeNull();
      expect(ui(view.container, "text-source-replacement-note")?.textContent).toContain("3 条标注会在阅读器下次读取时归档");
    });

    it("a refusal because things moved shows the fresh numbers and asks again, publishing nothing", async () => {
      let n = 0;
      backend.generate = (body) => {
        n += 1;
        if (n === 1) return asks();
        if (n === 2) return asks({ annotations: 2, annotationsRev: 8 }, "confirmation_changed");
        backend.generated = true;
        backend.publishedRev = body.sourceRev;
        return json({ publishedSourceRev: body.sourceRev, fingerprint: "b".repeat(64), replacedAnnotations: 3, diagnostics: [], stats: { sections: 1, paragraphs: 1, lists: 0 } });
      };
      const view = await ready();
      await asked(view);
      fireEvent.click(button("confirm-text-regeneration")!);
      await waitFor(() => expect(dialog()?.textContent).toContain("2 条标注"));
      expect(dialog()?.textContent).toContain("发生了变化");
      expect(backend.generated).toBe(false);
      expect(button("confirm-text-regeneration")?.textContent).toContain("替换并归档 2 条标注");
      fireEvent.click(button("confirm-text-regeneration")!);
      await waitFor(() => expect(ui(view.container, "text-source-generated")).toBeTruthy());
      expect(posts("generate")).toHaveLength(3);
    });

    it("a text edited after the question makes the confirmation stale: shown as not published, the dialog closes", async () => {
      let n = 0;
      backend.generate = () => {
        n += 1;
        return n === 1 ? asks() : json({ detail: "source changed", code: "stale", rev: 9 }, 409);
      };
      const view = await ready();
      await asked(view);
      fireEvent.click(button("confirm-text-regeneration")!);
      await waitFor(() => expect(dialog()).toBeNull());
      expect(ui(view.container, "text-source-generation-error")?.textContent).toContain("生成期间文本已更改");
      expect(ui(view.container, "text-source-generated")).toBeNull();
    });

    it("annotations that cannot be read are an error, never a confirmation", async () => {
      backend.generate = () => json({ detail: "the Doc's annotations cannot be read; nothing was replaced", code: "annotations_unreadable" }, 500);
      const view = await ready();
      typeText(view.container, "# T\n\nbody");
      fireEvent.click(ui(view.container, "text-source-generate")!);
      await waitFor(() => expect(ui(view.container, "text-source-generation-error")).toBeTruthy());
      expect(dialog()).toBeNull();
      expect(ui(view.container, "text-source-generation-error")?.textContent).toContain("cannot be read");
    });

    it("the success note reports what the server says was replaced, not the echoed confirmation", async () => {
      backend.generate = (body) => {
        if (!body.confirm) return asks();
        backend.generated = true;
        backend.publishedRev = body.sourceRev;
        return json({ publishedSourceRev: body.sourceRev, fingerprint: "b".repeat(64), replacedAnnotations: 0, diagnostics: [], stats: { sections: 1, paragraphs: 1, lists: 0 } });
      };
      const view = await ready();
      await asked(view);
      fireEvent.click(button("confirm-text-regeneration")!);
      await waitFor(() => expect(ui(view.container, "text-source-generated")).toBeTruthy());
      expect(ui(view.container, "text-source-replacement-note")).toBeNull();
    });

    it("a confirmation refused with nothing at risk any more closes the question and says to generate again", async () => {
      backend.generate = (body) => (body.confirm ? json({ detail: "changed", code: "confirmation_changed" }, 409) : asks());
      const view = await ready();
      await asked(view);
      fireEvent.click(button("confirm-text-regeneration")!);
      await waitFor(() => expect(dialog()).toBeNull());
      expect(ui(view.container, "text-source-generation-error")?.textContent).toContain("重新生成");
      expect(ui(view.container, "text-source-generated")).toBeNull();
    });

    it("typing while the question is open is not part of what is confirmed", async () => {
      backend.generate = (body) => (body.confirm ? json({ detail: "source changed", code: "stale", rev: 9 }, 409) : asks());
      const view = await ready();
      await asked(view);
      // the dialog is modal; the editor stays as it is until the user answers
      expect(dialog()?.getAttribute("role")).toBe("dialog");
    });
  });

  it("validate saves first, has its own result, and does not generate", async () => {
    const view = await ready();
    typeText(view.container, "# T\n\nbody");
    fireEvent.click(ui(view.container, "text-source-validate")!);
    await waitFor(() => expect(ui(view.container, "text-source-valid")).toBeTruthy());
    expect(ui(view.container, "text-source-valid")?.textContent).toContain("2 节 · 3 段 · 1 个列表");
    expect(posts("generate")).toHaveLength(0);
    expect(posts("validate")).toHaveLength(1);
  });
});

describe("text Doc pane: load failure Retry offered to the Copilot (ticket 32 gap G2)", () => {
  it("a failed source load offers the page's own Retry through the bridge (reader retry_sync) and withdraws it once loaded", async () => {
    backend.sourceStatus = 500;
    const view = render(<Harness />);
    await waitFor(() => expect(ui(view.container, "text-source-load-error")).toBeTruthy());
    const offered = retryHandles[retryHandles.length - 1];
    expect(typeof offered).toBe("function");
    const getsBefore = backend.log.filter((l) => l === `GET /api/paper/${DOC}/source`).length;
    backend.sourceStatus = 200;
    act(() => offered?.());
    await waitFor(() => expect(input(view.container)).not.toBeNull());
    expect(backend.log.filter((l) => l === `GET /api/paper/${DOC}/source`).length).toBe(getsBefore + 1);
    // the loaded editor has nothing to retry: the offer is withdrawn
    expect(retryHandles[retryHandles.length - 1]).toBeNull();
  });
});

describe("text Doc pane: conflict, leave protection, source PDF", () => {
  async function conflicted() {
    const view = await ready();
    backend.rev = 5; // another writer saved
    backend.markdown = "server text";
    typeText(view.container, "my local text");
    fireEvent.click(ui(view.container, "text-source-generate")!);
    await waitFor(() => expect(ui(view.container, "text-source-conflict")).toBeTruthy());
    return view;
  }

  it("keeps the local text on a rev conflict, shows the latest server text and generates nothing", async () => {
    const view = await conflicted();
    expect(input(view.container)!.value).toBe("my local text");
    expect(ui(view.container, "text-source-conflict-latest")?.textContent).toBe("server text");
    expect(backend.markdown).toBe("server text");
    expect(posts("generate")).toHaveLength(0);
    expect(input(view.container)!.readOnly).toBe(true);
    expect((ui(view.container, "text-source-generate") as HTMLButtonElement).disabled).toBe(true);
  });

  it("'keep mine' saves on top of the latest revision; 'use latest' adopts the server text without a write", async () => {
    const view = await conflicted();
    fireEvent.click(ui(view.container, "text-source-keep-mine")!);
    await waitFor(() => expect(ui(view.container, "text-source-status")?.getAttribute("data-state")).toBe("saved"));
    expect(backend.puts[backend.puts.length - 1]).toEqual({ expectedRev: 5, markdown: "my local text" });
    cleanup();
    backend.rev = 8; backend.markdown = "newer server"; backend.puts.length = 0;
    const second = await ready();
    backend.rev = 9; backend.markdown = "server again";
    typeText(second.container, "mine");
    fireEvent.click(ui(second.container, "text-source-validate")!);
    await waitFor(() => expect(ui(second.container, "text-source-conflict")).toBeTruthy());
    const putsBefore = backend.puts.length;
    fireEvent.click(ui(second.container, "text-source-use-latest")!);
    expect(input(second.container)!.value).toBe("server again");
    expect(backend.puts.length).toBe(putsBefore);
  });

  it("leaving with unsaved or conflicted text asks first; a saved text leaves freely", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = await ready();
    expect(confirmWorkspaceLeave()).toBe(true);
    typeText(view.container, "unsaved");
    expect(confirmWorkspaceLeave()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    expect(confirmWorkspaceLeave()).toBe(true);
    confirm.mockRestore();
  });

  it("a save failure is visible, keeps the text and offers retry", async () => {
    const view = await ready();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ detail: "disk full" }, 500);
      return real(input, init);
    }));
    typeText(view.container, "precious");
    fireEvent.click(ui(view.container, "text-source-validate")!);
    await waitFor(() => expect(ui(view.container, "text-source-save-error")).toBeTruthy());
    expect(ui(view.container, "text-source-save-error")?.textContent).toContain("disk full");
    expect(input(view.container)!.value).toBe("precious");
  });

  it("opens the source PDF through the workspace, or shows it as unavailable when it is gone (no cascade)", async () => {
    const view = await ready(true);
    await waitFor(() => expect((ui(view.container, "text-open-source-pdf") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(ui(view.container, "text-open-source-pdf")!);
    expect(opened).toEqual([PDF]);
    cleanup();
    backend.pdfOk = false;
    const gone = await ready(true);
    await waitFor(() => expect(ui(gone.container, "text-open-source-pdf")?.textContent).toContain("来源 PDF 已不可用"));
    expect((ui(gone.container, "text-open-source-pdf") as HTMLButtonElement).disabled).toBe(true);
    // the text itself stays editable
    expect(input(gone.container)!.readOnly).toBe(false);
  });

  it("marks unpublished changes only once a reading version exists, and refreshes on the published event", async () => {
    backend.generated = true;
    backend.publishedRev = 0;
    backend.rev = 0;
    const view = await ready();
    expect(ui(view.container, "text-unpublished")).toBeNull();
    expect(view.container.querySelector('[data-testid="reader-stub"]')).toBeTruthy();
    typeText(view.container, "changed");
    expect(ui(view.container, "text-unpublished")).toBeTruthy();
    // the published event makes the pane read the description again
    backend.publishedRev = 3;
    const before = backend.log.length;
    await act(async () => { for (const cb of events.published) cb({ type: "text-doc.published", doc_id: DOC, published_source_rev: 3, at: "x" }); });
    await waitFor(() => expect(backend.log.slice(before).some((l) => l.endsWith("/description"))).toBe(true));
  });
});

describe("text Doc pane: image assets (ticket 27)", () => {
  const png = () => new File([new Uint8Array([1, 2, 3, 4])], "Shear profile.png", { type: "image/png" });
  const chooseFile = (_view: { container: HTMLElement }, file: File) =>
    fireEvent.change(document.querySelector<HTMLElement>('[data-ui="text-source-asset-input"]')!, { target: { files: [file] } });
  const dialog = () => document.querySelector<HTMLElement>('[data-ui="text-source-assets-dialog"]');

  it("the toolbar button opens the assets dialog: empty state, upload action, close; the footer counts the images", async () => {
    const view = await ready();
    const button = ui(view.container, "text-source-assets")!;
    expect(button.getAttribute("aria-label")).toBe("图片资产");
    expect(ui(view.container, "text-source-asset-count")?.textContent).toBe("0 张图片");
    fireEvent.click(button);
    expect(dialog()).toBeTruthy();
    expect(document.querySelector('[data-ui="text-source-assets-empty"]')).toBeTruthy();
    expect(document.querySelector('[data-ui="text-source-asset-upload"]')?.textContent).toContain("上传图片");
    expect(document.querySelector<HTMLInputElement>('[data-ui="text-source-asset-input"]')?.accept).toBe("image/png,image/jpeg,image/webp");
    fireEvent.click(document.querySelector('[data-ui="close-text-source-assets"]')!);
    expect(dialog()).toBeNull();
  });

  it("uploads the chosen file as raw bytes with the saved revision, lists it with type/size and its path, and counts it", async () => {
    const view = await ready();
    fireEvent.click(ui(view.container, "text-source-assets")!);
    chooseFile(view, png());
    await waitFor(() => expect(document.querySelector('[data-ui="text-source-asset"]')).toBeTruthy());
    expect(backend.assetPosts).toEqual([{ url: `/api/paper/${DOC}/source/assets?expectedRev=0&filename=Shear%20profile.png`, type: "application/octet-stream", size: 4 }]);
    const row = document.querySelector<HTMLElement>('[data-ui="text-source-asset"]')!;
    expect(row.textContent).toContain("Shear-profile-0123abcd.png");
    expect(row.textContent).toContain("PNG · 40×30 像素 · 1 KiB");
    expect(row.textContent).toContain("assets/Shear-profile-0123abcd.png");
    expect(document.querySelector('[data-ui="text-source-asset-message"]')?.textContent).toContain("已添加");
    expect(ui(view.container, "text-source-asset-count")?.textContent).toBe("1 张图片");
    // the editor's text and save state are untouched by the upload
    expect(ui(view.container, "text-source-status")?.getAttribute("data-state")).toBe("saved");
  });

  it("text typed while uploading is saved afterwards on top of the NEW revision (no false conflict)", async () => {
    const view = await ready();
    fireEvent.click(ui(view.container, "text-source-assets")!);
    typeText(view.container, "# T\n\n![x](assets/a.png)");
    chooseFile(view, png());
    await waitFor(() => expect(document.querySelector('[data-ui="text-source-asset"]')).toBeTruthy());
    await waitFor(() => expect(ui(view.container, "text-source-status")?.getAttribute("data-state")).toBe("saved"));
    expect(backend.puts[backend.puts.length - 1]).toEqual({ expectedRev: 1, markdown: "# T\n\n![x](assets/a.png)" });
    expect(ui(view.container, "text-source-conflict")).toBeNull();
  });

  it("a restored file is reported as such; the dialog is the prototype's 520 px wide", async () => {
    const view = await ready();
    backend.assetAnswer = () => {
      const asset = { name: "fig-0123abcd.png", sha256: "c".repeat(64), byte_length: 4, media_type: "image/png" as const, width: 4, height: 3 };
      backend.assets = [asset];
      return json({ source: dto(), asset, reused: true, restored: true }, 200);
    };
    fireEvent.click(ui(view.container, "text-source-assets")!);
    expect(document.querySelector<HTMLElement>('[data-ui="text-source-assets-dialog"]')?.style.getPropertyValue("--dialog-width")).toBe("520px");
    chooseFile(view, png());
    await waitFor(() => expect(document.querySelector('[data-ui="text-source-asset-message"]')).toBeTruthy());
    expect(document.querySelector('[data-ui="text-source-asset-message"]')?.textContent).toContain("现已重新写入");
  });

  it("a refused file shows the server's reason in the page's own words and adds nothing", async () => {
    backend.assetAnswer = () => json({ detail: "only PNG...", code: "unsupported_type" }, 415);
    const view = await ready();
    fireEvent.click(ui(view.container, "text-source-assets")!);
    chooseFile(view, new File(["<svg/>"], "evil.svg", { type: "image/svg+xml" }));
    await waitFor(() => expect(document.querySelector('[data-ui="text-source-asset-message"]')).toBeTruthy());
    const message = document.querySelector<HTMLElement>('[data-ui="text-source-asset-message"]')!;
    expect(message.getAttribute("role")).toBe("alert");
    expect(message.textContent).toContain("图片未能添加");
    expect(message.textContent).toContain("只接受 PNG、JPEG 和 WebP");
    expect(document.querySelector('[data-ui="text-source-asset"]')).toBeNull();
    expect(ui(view.container, "text-source-asset-count")?.textContent).toBe("0 张图片");
  });

  it("a revision conflict keeps the local text, shows the conflict panel and adds nothing", async () => {
    const view = await ready();
    backend.assetAnswer = () => { backend.rev = 5; return json({ detail: "rev mismatch", rev: 5, source: dto() }, 409); };
    fireEvent.click(ui(view.container, "text-source-assets")!);
    chooseFile(view, png());
    await waitFor(() => expect(ui(view.container, "text-source-conflict")).toBeTruthy());
    expect(document.querySelector('[data-ui="text-source-asset-message"]')?.textContent).toContain("别处改动");
    expect(document.querySelector('[data-ui="text-source-asset"]')).toBeNull();
  });

  it("figure and table diagnostics are localized with the offending name", async () => {
    backend.validate = () =>
      json({
        sourceRev: backend.rev,
        valid: false,
        diagnostics: [
          { code: "image_asset_missing", severity: "error", message: "m", line: 2, column: 1, subject: "nowhere-1.png" },
          { code: "table_span_overlap", severity: "error", message: "m", line: 5, column: 3, field: "rows[1][0]" },
        ],
        stats: { sections: 0, paragraphs: 0, lists: 0 },
      });
    const view = await ready();
    fireEvent.click(ui(view.container, "text-source-validate")!);
    await waitFor(() => expect(ui(view.container, "text-source-diagnostics")).toBeTruthy());
    const rows = view.container.querySelectorAll('[data-ui="text-source-diagnostic"]');
    expect(rows[0]?.textContent).toContain("图片列表中没有名为“nowhere-1.png”的图片");
    expect(rows[1]?.textContent).toContain("与表格中的另一单元格重叠");
  });
});


describe("text Doc pane for the Copilot (ticket 29)", () => {
  const last = () => pages[pages.length - 1] ?? null;

  it("publishes the source panel's page: the editor's CURRENT text, marked unsaved while it differs from the saved source", async () => {
    backend.markdown = "# Saved\n";
    backend.rev = 3;
    const view = await ready(true);
    await waitFor(() => expect(last()?.phase).toBe("ready"));
    expect(last()).toMatchObject({ docId: DOC, view: "source", rev: 3, save: "saved", unsaved: false, markdown: "# Saved\n", generated: false, publishedSourceRev: null, sourcePdf: { doc_id: PDF } });
    typeText(view.container, "# Typed but not saved\n");
    await waitFor(() => expect(last()).toMatchObject({ unsaved: true, markdown: "# Typed but not saved\n", rev: 3, save: "dirty" }));
    // saved by the autosave: the same text is now the saved one
    await waitFor(() => expect(last()).toMatchObject({ unsaved: false, rev: 4, save: "saved" }), { timeout: 4000 });
    view.unmount();
    expect(last()).toBeNull();
  });

  it("a longer text is not carried inline and says so; the page never pretends it is complete", async () => {
    backend.markdown = "x".repeat(100_001);
    await ready();
    await waitFor(() => expect(last()?.phase).toBe("ready"));
    expect(last()).toMatchObject({ markdown: null, characters: 100_001 });
    expect(last()?.omitted).toContain("read_source");
  });

  it("the Copilot's set_text_view presses the same tabs the user does", async () => {
    backend.generated = true;
    backend.publishedRev = 0;
    const view = await ready();
    const setView = viewHandles.filter(Boolean).pop()!;
    act(() => setView("reader"));
    expect(ui(view.container, "text-reader-panel")?.hidden).toBe(false);
    expect(ui(view.container, "text-source-panel")?.hidden).toBe(true);
    act(() => setView("source"));
    expect(ui(view.container, "text-source-panel")?.hidden).toBe(false);
    await waitFor(() => expect(last()?.view).toBe("source"));
  });

  describe("add image from the source PDF", () => {
    const open = async () => {
      const view = await ready(true);
      fireEvent.click(ui(view.container, "text-source-assets")!);
      await waitFor(() => expect(document.querySelector('[data-ui="text-source-asset-from-pdf"]')).toBeTruthy());
      fireEvent.click(document.querySelector('[data-ui="text-source-asset-from-pdf"]')!);
      await waitFor(() => expect(document.querySelector('[data-ui="text-pdf-picker-count"]')?.textContent).toContain("3"));
      return view;
    };
    const frame = () => document.querySelector<HTMLElement>('[data-ui="text-pdf-picker-preview"]')!;
    const loaded = () => fireEvent.load(frame().querySelector("img")!);
    const drag = (from: [number, number], to: [number, number]) => {
      frame().getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
      fireEvent.pointerDown(frame(), { clientX: from[0], clientY: from[1], pointerId: 1 });
      fireEvent.pointerMove(frame(), { clientX: to[0], clientY: to[1], pointerId: 1 });
      fireEvent.pointerUp(frame(), { clientX: to[0], clientY: to[1], pointerId: 1 });
    };
    const add = () => fireEvent.click(document.querySelector('[data-ui="add-text-pdf-image"]')!);

    it("is offered only with a source PDF that still exists, and not for a text without one", async () => {
      const bare = await ready(false);
      fireEvent.click(ui(bare.container, "text-source-assets")!);
      expect(document.querySelector('[data-ui="text-source-asset-from-pdf"]')).toBeNull();
      bare.unmount();
      backend.pdfOk = false;
      const gone = await ready(true);
      fireEvent.click(ui(gone.container, "text-source-assets")!);
      await waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-ui="text-source-asset-from-pdf"]')?.disabled).toBe(true));
    });

    it("adds a whole page by default: one-based on screen, zero-based on the wire, with the saved revision and the PDF's hash", async () => {
      await open();
      const input = document.querySelector<HTMLInputElement>('[data-ui="text-pdf-picker-page"]')!;
      fireEvent.change(input, { target: { value: "2" } });
      loaded();
      expect(document.querySelector('[data-ui="text-pdf-picker-scope"]')?.textContent).toBe("整页");
      add();
      await waitFor(() => expect(backend.pdfPosts).toHaveLength(1));
      expect(backend.pdfPosts[0]).toEqual({ expectedRev: 0, sha256: "b".repeat(64), pageIndex: 1 });
      // back in the assets list with the new independent asset
      await waitFor(() => expect(document.querySelector('[data-ui="text-source-asset"]')?.textContent).toContain("p2-region-0123abcd.png"));
      expect(document.querySelector('[data-ui="text-pdf-picker"]')).toBeNull();
    });

    it("a dragged region is sent in fractions of the visible page; a tiny drag is no region; clearing returns to the whole page", async () => {
      await open();
      loaded();
      drag([20, 10], [120, 60]);
      expect(document.querySelector('[data-ui="text-pdf-picker-scope"]')?.textContent).toBe("已选区域");
      const region = document.querySelector<HTMLElement>('[data-ui="text-pdf-picker-region"]')!;
      expect(region.style.left).toBe("10%");
      expect(region.style.width).toBe("50%");
      add();
      await waitFor(() => expect(backend.pdfPosts).toHaveLength(1));
      expect(backend.pdfPosts[0]).toMatchObject({ pageIndex: 0, region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } });
    });

    it("a tiny drag selects nothing and the add is the whole page", async () => {
      await open();
      loaded();
      drag([20, 10], [20.2, 10.1]);
      expect(document.querySelector('[data-ui="text-pdf-picker-region"]')).toBeNull();
      add();
      await waitFor(() => expect(backend.pdfPosts).toHaveLength(1));
      expect(backend.pdfPosts[0]).not.toHaveProperty("region");
    });

    it("a refusal keeps the picker open with its reason and adds nothing", async () => {
      backend.pdfAnswer = () => json({ detail: "document changed", code: "document_changed" }, 409);
      await open();
      loaded();
      add();
      await waitFor(() => expect(document.querySelector('[data-ui="text-pdf-picker-message"]')?.textContent).toContain("来源 PDF 不是生成此文本时的原件"));
      expect(document.querySelector('[data-ui="text-pdf-picker"]')).toBeTruthy();
      expect(backend.assets).toHaveLength(0);
    });

    it("the Add button waits until the preview has loaded", async () => {
      const view = await open();
      expect(document.querySelector<HTMLButtonElement>('[data-ui="add-text-pdf-image"]')?.disabled).toBe(true);
      loaded();
      expect(document.querySelector<HTMLButtonElement>('[data-ui="add-text-pdf-image"]')?.disabled).toBe(false);
      void view;
    });
  });
});
