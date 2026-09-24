import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@argelanderspace/contracts";
import { RefDetail } from "../src/library/RefDetail";
import type { LibraryRef } from "../src/library/types";

const ws = vi.hoisted(() => ({
  listener: null as ((job: Job, event: string) => void) | null,
}));

vi.mock("../src/api/ws", () => ({
  onJobEvent: (listener: (job: Job, event: string) => void) => {
    ws.listener = listener;
    return () => { ws.listener = null; };
  },
}));

const REF: LibraryRef = {
  id: "doi:10.0000/docs",
  title: "Multiple document sources",
  authors: "A. Author & B. Author",
  year: 2026,
  venue: "ApJ",
  type: "article",
  cite: "Author2026Docs",
  tags: [],
  pdf: false,
  read: false,
  star: false,
  doc_id: "upload-long-primary-document-identifier-7ad91e",
  doc_ids: ["upload-long-primary-document-identifier-7ad91e", "arxiv-2609.17036"],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function job(kind: "upload" | "ingest", status: Job["status"], over: Partial<Job> = {}): Job {
  return {
    id: `${kind}-job`, kind, status, createdAt: "2026-09-21T00:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-09-21T00:00:01.000Z",
    finishedAt: status === "queued" || status === "running" ? null : "2026-09-21T00:00:02.000Z",
    progress: [], result: null, error: null, payload: { workId: REF.id }, ...over,
  };
}
function renderDetail(r: LibraryRef = REF) {
  const onOpenDoc = vi.fn();
  const onReload = vi.fn();
  const view = render(<RefDetail r={r} node={null} onClose={() => {}} onOpenDoc={onOpenDoc} onReload={onReload} />);
  fireEvent.click(screen.getByRole("tab", { name: "全文" }));
  return { ...view, onOpenDoc, onReload };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("RefDetail document provenance and actions", () => {
  it("shows each Doc's trusted source, identifier, and independently selected main position", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("upload-long-primary-document-identifier-7ad91e/description"))
        return Promise.resolve(json({ doc_id: "upload-long-primary-document-identifier-7ad91e", format: "latex", acquired_via: "user_latex_zip" }));
      if (url.endsWith("arxiv-2609.17036/description"))
        return Promise.resolve(json({ doc_id: "arxiv-2609.17036", format: "latex", acquired_via: "arxiv_eprint" }));
      throw new Error(`unexpected fetch ${url}`);
    }));
    const { onOpenDoc } = renderDetail();
    expect(await screen.findByText("用户上传 LaTeX")).toBeTruthy();
    expect(screen.getByText("arXiv LaTeX 源码")).toBeTruthy();
    expect(screen.getByText("upload-long-primary-document-identifier-7ad91e")).toBeTruthy();
    expect(screen.getByText("arxiv-2609.17036")).toBeTruthy();
    expect(screen.getAllByText("主文档")).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "打开此文档" })[1]!);
    expect(onOpenDoc).toHaveBeenCalledWith("arxiv-2609.17036");
    fireEvent.click(screen.getAllByText("文档操作")[1]!);
    expect(screen.getByRole("button", { name: "设为主文档" })).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("guards same-tick PDF submissions and leaves the large-file warning cancellable", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/library/upload-pdf")) return response.promise;
      return Promise.resolve(json({ detail: "not available" }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDetail({ ...REF, doc_id: undefined, doc_ids: undefined });
    const input = screen.getByLabelText("上传 PDF");
    const largeFile = new File([new Uint8Array(25 * 1024 * 1024)], "large.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [largeFile] } });
    expect(await screen.findByText(/超过 25 MiB 提示阈值/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("upload-pdf"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText(/超过 25 MiB 提示阈值/)).toBeNull();

    const smallFile = new File([new Uint8Array([1, 2, 3])], "small.pdf", { type: "application/pdf" });
    act(() => {
      fireEvent.change(input, { target: { files: [smallFile] } });
      fireEvent.change(input, { target: { files: [smallFile] } });
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("upload-pdf"))).toHaveLength(1);
    response.resolve(json({ job: job("upload", "queued", { payload: { workId: REF.id, format: "pdf" } }), resourceWarning: false }, 202));
    expect(await screen.findByText("正在排队")).toBeTruthy();
  });

  it("defaults to a new arXiv PDF acquisition, retries its own failed job, and ignores late events after switching Work", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/paper/") && url.endsWith("/description")) return Promise.resolve(json({ doc_id: "pdf-existing", format: "pdf", acquired_via: "arxiv_pdf", arxiv_id: "2601.01234", acquired_at: "2026-09-24T00:00:00.000Z", owner_work_id: REF.id, work_title: REF.title, display_name: "arxiv-2601.01234.pdf", byte_length: 10, sha256: "a".repeat(64), page_count: 1, pages: [{ width: 612, height: 792, rotation: 0 }] }));
      if (url.includes("/api/library/acquire-arxiv-pdf")) return Promise.resolve(json({ job: job("upload", "queued", { payload: { workId: REF.id, format: "arxiv-pdf", arxivId: "2601.01234", automatic: false } }) }, 202));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const work = { ...REF, arxiv_id: "2601.01234", doc_id: "pdf-existing", doc_ids: ["pdf-existing"] };
    const view = renderDetail(work);
    expect(await screen.findByText("arXiv PDF 获取")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    expect((screen.getByRole("radio", { name: /从 arXiv 获取 PDF/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "获取 PDF 并添加为新正文" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("acquire-arxiv-pdf"), expect.objectContaining({ method: "POST" })));
    act(() => ws.listener?.(job("upload", "failed", { error: "controlled source failure", payload: { workId: REF.id, format: "arxiv-pdf", arxivId: "2601.01234" } }), "job.failed"));
    expect(await screen.findByText("controlled source failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭 arXiv PDF 获取提醒" }));
    expect(screen.getByText(/arXiv PDF 获取失败；已有正文未更改/)).toBeTruthy();
    act(() => ws.listener?.(job("upload", "failed", { error: "controlled source failure", payload: { workId: REF.id, format: "arxiv-pdf", arxivId: "2601.01234" } }), "job.failed"));
    expect(screen.queryByText("controlled source failure")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新获取 PDF" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    view.rerender(<RefDetail r={{ ...work, id: "doi:10.0000/other", title: "Other Work", doc_id: undefined, doc_ids: undefined }} node={null} onClose={() => {}} onOpenDoc={() => {}} onReload={() => {}} />);
    act(() => ws.listener?.(job("upload", "failed", { error: "late old Work failure", payload: { workId: REF.id, format: "arxiv-pdf", arxivId: "2601.01234" } }), "job.failed"));
    expect(screen.queryByText("late old Work failure")).toBeNull();
  });

  it("labels an explicitly described PDF without inferring format from its Doc id", async () => {
    const docId = "pdf-12345678-1234-4234-8234-123456789abc";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ doc_id: docId, format: "pdf", acquired_via: "user_pdf_upload" })));
    renderDetail({ ...REF, doc_id: docId, doc_ids: [docId] });
    expect(await screen.findByText("用户上传 PDF")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/description"), expect.any(Object));
  });

  it("keeps an explicit arXiv LaTeX source option enabled for PDF-only Works", async () => {
    const existing = {
      ...REF,
      arxiv_id: "2601.01234",
      doc_id: "pdf-existing",
      doc_ids: ["pdf-existing"],
    };
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pdf-existing/description")) return Promise.resolve(json({ doc_id: "pdf-existing", format: "pdf", acquired_via: "arxiv_pdf", arxiv_id: "2601.01234", acquired_at: "2026-09-24T00:00:00.000Z", owner_work_id: existing.id, work_title: existing.title, display_name: "arxiv-2601.01234.pdf", byte_length: 10, sha256: "a".repeat(64), page_count: 1, pages: [{ width: 612, height: 792, rotation: 0 }] }));
      if (url.includes("/api/library/attach-arxiv")) return Promise.resolve(json({ job: job("ingest", "queued", { payload: { workId: existing.id, arxivId: "2601.01234" } }) }, 202));
      throw new Error(`unexpected fetch ${url}`);
    }));
    renderDetail(existing);
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    const latex = await screen.findByRole("radio", { name: /从 arXiv 获取 LaTeX 源码/ });
    expect((latex as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(latex);
    fireEvent.click(screen.getByRole("button", { name: "开始获取" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/library/attach-arxiv"), expect.objectContaining({ method: "POST" })));
  });

  it("states that a Work has no Doc without inventing a document or source", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderDetail({ ...REF, doc_id: undefined, doc_ids: undefined, arxiv_id: undefined, needs_upload: true });
    expect(screen.getByText("这篇文献还没有正文文档")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "正文文档" })).toBeNull();
    expect(screen.queryByText("主文档")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps missing or failed provenance unknown without guessing from planner labels or Doc ids", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ doc_id: "arxiv-name-is-not-proof", format: "unknown", source: { origin: "/private/source/path" } }))
      .mockResolvedValueOnce(json({ detail: "broken description" }, 500));
    vi.stubGlobal("fetch", fetchMock);
    renderDetail({ ...REF, sourceLabel: "planner says arXiv", doc_id: "arxiv-name-is-not-proof", doc_ids: ["arxiv-name-is-not-proof", "upload-name-is-not-proof"] });
    expect(await screen.findAllByText("来源未知")).toHaveLength(2);
    expect(screen.queryByText("planner says arXiv")).toBeNull();
    expect(screen.queryByText("/private/source/path")).toBeNull();
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/description"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("annotations"))).toBe(false);
  });

  it("discards late provenance after switching Work and refreshes the same Doc after a new Work payload", async () => {
    const oldWork = deferred<Response>();
    const newWork = deferred<Response>();
    const refreshed = deferred<Response>();
    const fetchMock = vi.fn().mockImplementationOnce(() => oldWork.promise).mockImplementationOnce(() => newWork.promise).mockImplementationOnce(() => refreshed.promise);
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<RefDetail r={{ ...REF, doc_id: "shared-doc", doc_ids: ["shared-doc"] }} node={null} onClose={() => {}} onOpenDoc={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    view.rerender(<RefDetail r={{ ...REF, id: "doi:10.0000/new", title: "New Work", doc_id: "shared-doc", doc_ids: ["shared-doc"] }} node={null} onClose={() => {}} onOpenDoc={() => {}} />);
    await Promise.resolve(newWork.resolve(json({ doc_id: "shared-doc", format: "latex", acquired_via: "user_latex_zip" })));
    expect(await screen.findByText("用户上传 LaTeX")).toBeTruthy();
    await Promise.resolve(oldWork.resolve(json({ doc_id: "shared-doc", format: "latex", acquired_via: "arxiv_eprint" })));
    expect(screen.queryByText("arXiv")).toBeNull();
    view.rerender(<RefDetail r={{ ...REF, id: "doi:10.0000/new", title: "New Work refreshed", doc_id: "shared-doc", doc_ids: ["shared-doc"] }} node={null} onClose={() => {}} onOpenDoc={() => {}} />);
    await Promise.resolve(refreshed.resolve(json({ doc_id: "shared-doc", format: "latex", acquired_via: "arxiv_eprint" })));
    expect(await screen.findByText("arXiv LaTeX 源码")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("places an adopted running upload before a long Doc list while keeping the main Doc readable", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ source: {} })));
    const { onOpenDoc } = renderDetail();
    act(() => { ws.listener?.(job("upload", "running", { progress: [{ at: "2026-09-21T00:00:01.000Z", message: "Compiling main.tex" }] }), "hello"); });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("正在处理上传的正文");
    expect(status.textContent).toContain("Compiling main.tex");
    const documentRegion = screen.getByRole("region", { name: "正文文档" });
    expect(status.compareDocumentPosition(documentRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "阅读全文" }));
    expect(onOpenDoc).toHaveBeenCalledWith(REF.doc_id);
  });

  it("shows an existing-Doc update failure without claiming the linked Doc is healthy", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ source: {} })));
    const { onOpenDoc } = renderDetail();
    act(() => { ws.listener?.(job("ingest", "failed", { error: "latexmk exited 12", errorCode: "compile_failed" }), "hello"); });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("全文更新失败");
    expect(alert.textContent).toContain("latexmk exited 12");
    expect(alert.textContent).toContain("已有正文关联仍保留；打开后以阅读器状态为准");
    expect(alert.textContent).not.toContain("仍可阅读");
    fireEvent.click(screen.getByRole("button", { name: "阅读全文" }));
    expect(onOpenDoc).toHaveBeenCalledWith(REF.doc_id);
    expect(screen.getByRole("region", { name: "正文文档" })).toBeTruthy();
  });
});
