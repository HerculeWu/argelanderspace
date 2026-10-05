import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocDescription, TextSourceDto } from "@argelanderspace/contracts";
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
  /** next generate answer override */
  generate?: () => Response;
  pdfOk: boolean;
  putGate?: Promise<void>;
}
let backend: Backend;
const dto = (): TextSourceDto => ({
  doc_id: DOC,
  rev: backend.rev,
  input_version: 1,
  markdown: backend.markdown,
  assets: [],
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
    if (url === `/api/paper/${DOC}/source` && method === "GET") return json(dto());
    if (url === `/api/paper/${DOC}/source` && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { expectedRev: number; markdown: string };
      backend.puts.push(body);
      if (backend.putGate) await backend.putGate;
      if (body.expectedRev !== backend.rev) return json({ detail: "rev mismatch", rev: backend.rev, source: dto() }, 409);
      backend.rev += 1;
      backend.markdown = body.markdown;
      return json(dto());
    }
    if (url === `/api/paper/${DOC}/source/validate`) return json({ sourceRev: backend.rev, valid: true, diagnostics: [], stats: { sections: 2, paragraphs: 3, lists: 1 } });
    if (url === `/api/paper/${DOC}/source/generate`) {
      if (backend.generate) return backend.generate();
      backend.generated = true;
      backend.publishedRev = backend.rev;
      return json({ publishedSourceRev: backend.rev, fingerprint: "a".repeat(64), diagnostics: [], stats: { sections: 1, paragraphs: 1, lists: 0 } });
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
function Harness({ withPdf = false }: { withPdf?: boolean }) {
  const workspace: Workspace = {
    papers: [DOC], currentDoc: DOC, setCurrentDoc: () => {}, openDoc: (id) => { if (id) opened.push(id); },
    pendingAnchor: null, clearPendingAnchor: () => {}, docDeleted: () => {},
    tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
  };
  return <WorkspaceProvider value={workspace}>
    <TextDocPane docId={DOC} description={description(withPdf ? { source_pdf: { doc_id: PDF, sha256: "b".repeat(64) } } : {})} reader={<div data-testid="reader-stub">reader</div>} />
  </WorkspaceProvider>;
}
const input = (c: HTMLElement) => c.querySelector<HTMLTextAreaElement>('[data-ui="text-source-input"]')!;
const ui = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-ui="${id}"]`);
const posts = (kind: "generate" | "validate") => backend.log.filter((l) => l.startsWith("POST") && l.endsWith(`/source/${kind}`));

beforeEach(() => {
  backend = { rev: 0, markdown: "", log: [], puts: [], generated: false, publishedRev: null, pdfOk: true };
  opened.length = 0;
  installBackend();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  events.published.clear();
  events.source.clear();
});

async function ready(withPdf = false) {
  const view = render(<Harness withPdf={withPdf} />);
  await waitFor(() => expect(input(view.container)).toBeTruthy());
  return view;
}

describe("text Doc pane: autosave and explicit generation", () => {
  it("a first draft opens on the source and shows the first-draft state in the reading tab", async () => {
    const { container, getByRole } = await ready();
    expect(ui(container, "text-source-panel")?.hidden).toBe(false);
    expect(ui(container, "text-reader-panel")?.hidden).toBe(true);
    fireEvent.click(getByRole("tab", { name: "阅读" }));
    expect(ui(container, "text-doc-first-draft")).toBeTruthy();
    expect(container.querySelector('[data-testid="reader-stub"]')).toBeNull();
  });

  it("saves typed text byte for byte after a pause, with expectedRev, and never validates or generates", async () => {
    const view = await ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const text = "# T\r\n\r\n```\nunclosed $x\t中文";
    fireEvent.change(input(view.container), { target: { value: text } });
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
    fireEvent.change(input(view.container), { target: { value: "# Title\n\nbody" } });
    fireEvent.click(ui(view.container, "text-source-generate")!);
    await waitFor(() => expect(ui(view.container, "text-source-generated")).toBeTruthy());
    const order = backend.log.filter((l) => l.startsWith("PUT") || l.endsWith("/generate"));
    expect(order).toEqual([`PUT /api/paper/${DOC}/source`, `POST /api/paper/${DOC}/source/generate`]);
    expect(backend.markdown).toBe("# Title\n\nbody");
  });

  it("a text with errors keeps the source and shows the located diagnostics; clicking one selects its line", async () => {
    backend.generate = () => json({ detail: "the text has errors", code: "diagnostics", diagnostics: [{ code: "unsupported_syntax", severity: "error", message: "block quotes are not supported", line: 3, column: 1 }], stats: { sections: 0, paragraphs: 0, lists: 0 } }, 422);
    const view = await ready();
    const text = "# T\n\n> quote\n\nend";
    fireEvent.change(input(view.container), { target: { value: text } });
    fireEvent.click(ui(view.container, "text-source-generate")!);
    await waitFor(() => expect(ui(view.container, "text-source-diagnostics")).toBeTruthy());
    expect(ui(view.container, "text-source-generation-error")?.textContent).toContain("文本存在错误，未生成");
    const row = ui(view.container, "text-source-diagnostic")!;
    expect(row.textContent).toContain("第 3 行，第 1 列");
    expect(row.textContent).toContain("block quotes are not supported");
    fireEvent.click(row.querySelector("button")!);
    expect(input(view.container).value.slice(input(view.container).selectionStart, input(view.container).selectionEnd)).toBe("> quote");
    expect(input(view.container).value).toBe(text);
    expect(backend.markdown).toBe(text);
  });

  it("a replacement blocked by annotations is reported as not published, text kept", async () => {
    backend.generate = () => json({ detail: "blocked", code: "replacement_blocked", annotations: 2 }, 409);
    const view = await ready();
    fireEvent.change(input(view.container), { target: { value: "# T\n\nbody" } });
    fireEvent.click(ui(view.container, "text-source-generate")!);
    await waitFor(() => expect(ui(view.container, "text-source-generation-error")).toBeTruthy());
    expect(ui(view.container, "text-source-generation-error")?.textContent).toContain("未发布");
    expect(input(view.container).value).toBe("# T\n\nbody");
  });

  it("validate saves first, has its own result, and does not generate", async () => {
    const view = await ready();
    fireEvent.change(input(view.container), { target: { value: "# T\n\nbody" } });
    fireEvent.click(ui(view.container, "text-source-validate")!);
    await waitFor(() => expect(ui(view.container, "text-source-valid")).toBeTruthy());
    expect(ui(view.container, "text-source-valid")?.textContent).toContain("2 节 · 3 段 · 1 个列表");
    expect(posts("generate")).toHaveLength(0);
    expect(posts("validate")).toHaveLength(1);
  });
});

describe("text Doc pane: conflict, leave protection, source PDF", () => {
  async function conflicted() {
    const view = await ready();
    backend.rev = 5; // another writer saved
    backend.markdown = "server text";
    fireEvent.change(input(view.container), { target: { value: "my local text" } });
    fireEvent.click(ui(view.container, "text-source-generate")!);
    await waitFor(() => expect(ui(view.container, "text-source-conflict")).toBeTruthy());
    return view;
  }

  it("keeps the local text on a rev conflict, shows the latest server text and generates nothing", async () => {
    const view = await conflicted();
    expect(input(view.container).value).toBe("my local text");
    expect(ui(view.container, "text-source-conflict-latest")?.textContent).toBe("server text");
    expect(backend.markdown).toBe("server text");
    expect(posts("generate")).toHaveLength(0);
    expect(input(view.container).readOnly).toBe(true);
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
    fireEvent.change(input(second.container), { target: { value: "mine" } });
    fireEvent.click(ui(second.container, "text-source-validate")!);
    await waitFor(() => expect(ui(second.container, "text-source-conflict")).toBeTruthy());
    const putsBefore = backend.puts.length;
    fireEvent.click(ui(second.container, "text-source-use-latest")!);
    expect(input(second.container).value).toBe("server again");
    expect(backend.puts.length).toBe(putsBefore);
  });

  it("leaving with unsaved or conflicted text asks first; a saved text leaves freely", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = await ready();
    expect(confirmWorkspaceLeave()).toBe(true);
    fireEvent.change(input(view.container), { target: { value: "unsaved" } });
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
    fireEvent.change(input(view.container), { target: { value: "precious" } });
    fireEvent.click(ui(view.container, "text-source-validate")!);
    await waitFor(() => expect(ui(view.container, "text-source-save-error")).toBeTruthy());
    expect(ui(view.container, "text-source-save-error")?.textContent).toContain("disk full");
    expect(input(view.container).value).toBe("precious");
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
    expect(input(gone.container).readOnly).toBe(false);
  });

  it("marks unpublished changes only once a reading version exists, and refreshes on the published event", async () => {
    backend.generated = true;
    backend.publishedRev = 0;
    backend.rev = 0;
    const view = await ready();
    expect(ui(view.container, "text-unpublished")).toBeNull();
    expect(view.container.querySelector('[data-testid="reader-stub"]')).toBeTruthy();
    fireEvent.change(input(view.container), { target: { value: "changed" } });
    expect(ui(view.container, "text-unpublished")).toBeTruthy();
    // the published event makes the pane read the description again
    backend.publishedRev = 3;
    const before = backend.log.length;
    await act(async () => { for (const cb of events.published) cb({ type: "text-doc.published", doc_id: DOC, published_source_rev: 3, at: "x" }); });
    await waitFor(() => expect(backend.log.slice(before).some((l) => l.endsWith("/description"))).toBe(true));
  });
});
