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
    return () => {
      ws.listener = null;
    };
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
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function job(kind: "upload" | "ingest", status: Job["status"], over: Partial<Job> = {}): Job {
  return {
    id: `${kind}-job`,
    kind,
    status,
    createdAt: "2026-09-21T00:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-09-21T00:00:01.000Z",
    finishedAt: status === "queued" || status === "running" ? null : "2026-09-21T00:00:02.000Z",
    progress: [],
    result: null,
    error: null,
    payload: { workId: REF.id },
    ...over,
  };
}

function renderDetail(r: LibraryRef = REF) {
  const onOpenDoc = vi.fn();
  const onReload = vi.fn();
  const view = render(
    <RefDetail
      r={r}
      node={null}
      onClose={() => {}}
      onOpenDoc={onOpenDoc}
      onReload={onReload}
    />
  );
  fireEvent.click(screen.getByRole("tab", { name: "全文" }));
  return { ...view, onOpenDoc, onReload };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RefDetail document provenance and actions", () => {
  it("shows each Doc's trusted source, identifier, and independently selected main position", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("upload-long-primary-document-identifier-7ad91e/ir")) {
          return Promise.resolve(json({ source: { acquired_via: "user_latex_zip" } }));
        }
        if (url.endsWith("arxiv-2609.17036/ir")) {
          return Promise.resolve(json({ source: { acquired_via: "arxiv_eprint" } }));
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const { onOpenDoc } = renderDetail();

    expect(await screen.findByText("用户上传")).toBeTruthy();
    expect(screen.getByText("arXiv")).toBeTruthy();
    expect(screen.getByText("upload-long-primary-document-identifier-7ad91e")).toBeTruthy();
    expect(screen.getByText("arxiv-2609.17036")).toBeTruthy();
    expect(screen.getAllByText("主文档")).toHaveLength(1);

    fireEvent.click(screen.getAllByRole("button", { name: "打开此文档" })[1]!);
    expect(onOpenDoc).toHaveBeenCalledWith("arxiv-2609.17036");

    fireEvent.click(screen.getAllByText("文档操作")[1]!);
    expect(screen.getByRole("button", { name: "设为主文档" })).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("states that a Work has no Doc without inventing a document or source", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderDetail({
      ...REF,
      doc_id: undefined,
      doc_ids: undefined,
      arxiv_id: undefined,
      needs_upload: true,
    });

    expect(screen.getByText("这篇文献还没有正文文档")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "正文文档" })).toBeNull();
    expect(screen.queryByText("主文档")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps missing or failed provenance unknown without guessing from planner labels or Doc ids", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ source: { origin: "/private/source/path" } }))
      .mockResolvedValueOnce(json({ detail: "broken IR" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    renderDetail({
      ...REF,
      sourceLabel: "planner says arXiv",
      doc_id: "arxiv-name-is-not-proof",
      doc_ids: ["arxiv-name-is-not-proof", "upload-name-is-not-proof"],
    });

    expect(await screen.findAllByText("来源未知")).toHaveLength(2);
    expect(screen.queryByText("planner says arXiv")).toBeNull();
    expect(screen.queryByText("/private/source/path")).toBeNull();
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/ir"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("annotations"))).toBe(false);
  });

  it("discards late provenance after switching Work and refreshes the same Doc after a new Work payload", async () => {
    const oldWork = deferred<Response>();
    const newWork = deferred<Response>();
    const refreshed = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => oldWork.promise)
      .mockImplementationOnce(() => newWork.promise)
      .mockImplementationOnce(() => refreshed.promise);
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <RefDetail r={{ ...REF, doc_id: "shared-doc", doc_ids: ["shared-doc"] }} node={null} onClose={() => {}} onOpenDoc={() => {}} />
    );
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    view.rerender(
      <RefDetail
        r={{ ...REF, id: "doi:10.0000/new", title: "New Work", doc_id: "shared-doc", doc_ids: ["shared-doc"] }}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
      />
    );

    await Promise.resolve(newWork.resolve(json({ source: { acquired_via: "user_latex_zip" } })));
    expect(await screen.findByText("用户上传")).toBeTruthy();
    await Promise.resolve(oldWork.resolve(json({ source: { acquired_via: "arxiv_eprint" } })));
    expect(screen.queryByText("arXiv")).toBeNull();

    view.rerender(
      <RefDetail
        r={{ ...REF, id: "doi:10.0000/new", title: "New Work refreshed", doc_id: "shared-doc", doc_ids: ["shared-doc"] }}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
      />
    );
    await Promise.resolve(refreshed.resolve(json({ source: { acquired_via: "arxiv_eprint" } })));
    expect(await screen.findByText("arXiv")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("places an adopted running upload before a long Doc list while keeping the main Doc readable", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ source: {} })));
    const { onOpenDoc } = renderDetail();

    act(() => {
      ws.listener?.(
        job("upload", "running", {
          progress: [{ at: "2026-09-21T00:00:01.000Z", message: "Compiling main.tex" }],
        }),
        "hello"
      );
    });

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

    act(() => {
      ws.listener?.(
        job("ingest", "failed", {
          error: "latexmk exited 12",
          errorCode: "compile_failed",
        }),
        "hello"
      );
    });

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
