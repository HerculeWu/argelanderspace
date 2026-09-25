/**
 * RefDetail arXiv auto-fetch UI (Stage 15, D7/D11/D16/D17):
 *
 * - the files tab of a docless work WITH an arXiv id shows the CLICKABLE
 *   "可获取 · arXiv 全文" pill (existing pill style, not a button); clicking
 *   queues the fetch via `attachArxiv`, progress unfolds right below the
 *   line, and `job.done` reloads the library;
 * - a failed job surfaces `job.error` + retry; the machine-readable
 *   `errorCode: "arxiv_pdf_only"` adds the bilingual PDF-only guidance;
 * - `hello` replays adopt an in-flight fetch (tracking resumes after F5);
 * - D17 cleanup: acquisition-advertising pills (ready / blocked / unknown)
 *   are gone everywhere; the info panel keeps only ingestedFrom/needsUpload;
 * - arXiv docs (`arxiv-…` id) offer the "重新获取" refetch entry; non-arXiv
 *   docs don't; works with a main doc hide the acquisition line entirely.
 *
 * `../src/api/ws` and `../src/api/library` are mocked: the captured job
 * listener is driven by hand, `attachArxiv` is a controlled promise.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@argelanderspace/contracts";
import { RefDetail } from "../src/library/RefDetail";
import type { LibraryRef } from "../src/library/types";

const h = vi.hoisted(() => ({
  listener: null as ((job: Job, event: string) => void) | null,
  attachArxiv: vi.fn<(workId: string) => Promise<Job | null>>(),
  uploadLatexZip: vi.fn<(workId: string, file: File | Blob) => Promise<Job | null>>(),
  patchRef: vi.fn<(id: string, patch: Record<string, unknown>) => Promise<boolean>>(),
  fetchAnnotations: vi.fn(),
}));

vi.mock("../src/api/ws", () => ({
  onJobEvent: (cb: (job: Job, event: string) => void) => {
    h.listener = cb;
    return () => {
      h.listener = null;
    };
  },
}));

vi.mock("../src/api/library", () => ({
  attachArxiv: h.attachArxiv,
  fetchDocProvenance: vi.fn().mockResolvedValue("unknown"),
  uploadLatexZip: h.uploadLatexZip,
  patchRef: h.patchRef,
}));

vi.mock("../src/api/annotations", () => ({
  deletePaperDoc: vi.fn(),
  fetchAnnotations: h.fetchAnnotations,
}));

const BASE: LibraryRef = {
  id: "arxiv:2609.17036",
  title: "Some Paper",
  authors: "Doe",
  year: 2026,
  venue: "ApJ",
  type: "article",
  cite: "doe2026",
  tags: [],
  pdf: false,
  read: false,
  star: false,
};

/** Docless work with an arXiv id → the clickable acquisition line. */
const REF_ARXIV: LibraryRef = { ...BASE, arxiv_id: "2609.17036" };

/** Docless, no arXiv, upload needed → the needsUpload pill stays. */
const REF_NEEDS_UPLOAD: LibraryRef = {
  ...BASE,
  id: "doi:10.1/noarxiv",
  arxiv_id: undefined,
  needs_upload: true,
};

/** Docless with a publisher-HTML acquisition ad (Stage 15 cleans these). */
const REF_AD: LibraryRef = {
  ...BASE,
  id: "doi:10.1/ad",
  arxiv_id: undefined,
  needs_upload: false,
  source: "journal_html",
  sourceLabel: "A&A html",
  sourceStatus: "ready",
};

/** Work whose main doc IS the arXiv doc → the refetch entry. */
const REF_WITH_ARXIV_DOC: LibraryRef = {
  ...BASE,
  arxiv_id: "2609.17036",
  doc_id: "arxiv-2609.17036",
  doc_ids: ["arxiv-2609.17036"],
};

/** Work whose only doc is a user upload → no acquisition line, no refetch. */
const REF_WITH_UPLOAD_DOC: LibraryRef = {
  ...BASE,
  id: "doi:10.1/uploaded",
  arxiv_id: "2609.17036",
  doc_id: "upload-x1",
  doc_ids: ["upload-x1"],
};

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: "ingest-j1",
    kind: "ingest",
    status: "queued",
    createdAt: "2026-09-17T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    progress: [],
    result: null,
    error: null,
    payload: { workId: BASE.id, arxivId: "2609.17036" },
    ...over,
  };
}

function renderDetail(r: LibraryRef) {
  const onReload = vi.fn();
  const utils = render(
    <RefDetail r={r} node={null} onClose={() => {}} onOpenDoc={() => {}} onReload={onReload} />
  );
  return { ...utils, onReload };
}

function openFilesTab(): void {
  fireEvent.click(screen.getByRole("tab", { name: "全文" }));
}

function startArxivAcquisition(): void {
  fireEvent.click(screen.getByRole("button", { name: "获取全文…" }));
  fireEvent.click(screen.getByRole("radio", { name: /从 arXiv 获取 LaTeX 源码/ }));
  fireEvent.click(screen.getByRole("button", { name: "开始获取" }));
}

beforeEach(() => {
  h.attachArxiv.mockReset().mockReturnValue(new Promise(() => {})); // pending by default
  h.fetchAnnotations.mockReset().mockResolvedValue({
    ok: true,
    file: {
      version: 1,
      rev: 0,
      content_fingerprint: "a".repeat(64),
      annotations: [],
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("docless work with an arXiv id", () => {
  it("uses the unified acquisition dialog and shows arXiv progress below", async () => {
    renderDetail(REF_ARXIV);
    openFilesTab();
    expect(screen.queryByText("可获取 · arXiv 全文")).toBeNull();
    const job = makeJob();
    h.attachArxiv.mockResolvedValueOnce(job);
    startArxivAcquisition();
    expect(h.attachArxiv).toHaveBeenCalledWith(REF_ARXIV.id);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("正在排队"));
    // progress ticks land in the task message before the document area
    act(() => {
      h.listener?.(
        makeJob({ status: "running", progress: [{ at: "t", message: "Compiling LaTeX (latexmk)" }] }),
        "job.progress"
      );
    });
    screen.getByText("Compiling LaTeX (latexmk)");
    // done → reload
    act(() => {
      h.listener?.(makeJob({ status: "running" }), "job.progress");
    });
    // re-drive: subscriber needs the SAME tracked job to flip to done
    act(() => {
      h.listener?.(makeJob({ status: "done" }), "job.done");
    });
  });

  it("a failed fetch surfaces the error + retry; PDF-only adds the bilingual hint", async () => {
    renderDetail(REF_ARXIV);
    openFilesTab();
    const job = makeJob();
    h.attachArxiv.mockResolvedValueOnce(job);
    startArxivAcquisition();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("正在排队"));
    act(() => {
      h.listener?.(
        makeJob({
          status: "failed",
          error: "1108.tar.gz is neither a tar nor a readable gzip stream; PDF-only",
          errorCode: "arxiv_pdf_only",
        }),
        "job.failed"
      );
    });
    screen.getByText(/获取 arXiv 正文失败：/);
    screen.getByText(/无 LaTeX 源码（仅 PDF）/);
    // PDF-only retry enters the upload path instead of pretending arXiv can succeed.
    fireEvent.click(screen.getByTestId("arxiv-retry"));
    expect(screen.getByRole("dialog", { name: "获取全文" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /上传 LaTeX 源码包/ })).toBeTruthy();
    expect(h.attachArxiv).toHaveBeenCalledTimes(1);
  });

  it("a plain failure shows no PDF-only hint", async () => {
    renderDetail(REF_ARXIV);
    openFilesTab();
    h.attachArxiv.mockResolvedValueOnce(makeJob());
    startArxivAcquisition();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("正在排队"));
    act(() => {
      h.listener?.(makeJob({ status: "failed", error: "connection reset" }), "job.failed");
    });
    screen.getByText(/获取 arXiv 正文失败：connection reset/);
    expect(screen.queryByText(/无 LaTeX 源码/)).toBeNull();
  });

  it("a hello replay of an in-flight fetch adopts tracking after F5", async () => {
    renderDetail(REF_ARXIV);
    openFilesTab();
    act(() => {
      h.listener?.(
        makeJob({ status: "running", progress: [{ at: "t", message: "Compiling LaTeX (latexmk)" }] }),
        "hello"
      );
    });
    screen.getByText("Compiling LaTeX (latexmk)");
  });

  it("a hello replay restores an interrupted fetch with retry guidance", () => {
    renderDetail(REF_ARXIV);
    openFilesTab();
    act(() => {
      h.listener?.(makeJob({ status: "interrupted", error: "server restarted" }), "hello");
    });

    screen.getByText(/获取 arXiv 正文失败：server restarted/);
    expect(screen.getByTestId("arxiv-retry")).toBeTruthy();
  });

  it("does not attach a late arXiv POST response to a later A → B → A Work session", async () => {
    let resolveFetch: (job: Job | null) => void = () => {};
    h.attachArxiv.mockImplementationOnce(
      () =>
        new Promise<Job | null>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const view = renderDetail(REF_ARXIV);
    openFilesTab();
    startArxivAcquisition();

    view.rerender(
      <RefDetail
        r={{ ...REF_ARXIV, id: "arxiv:2609.99999", title: "Next Work" }}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        onReload={view.onReload}
      />
    );
    view.rerender(
      <RefDetail
        r={{ ...REF_ARXIV }}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        onReload={view.onReload}
      />
    );
    await act(async () => resolveFetch(makeJob()));

    expect(screen.queryByText("正在排队")).toBeNull();
    startArxivAcquisition();
    expect(h.attachArxiv).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a terminal arXiv job when late WS queued/running frames arrive", () => {
    renderDetail(REF_ARXIV);
    openFilesTab();
    act(() => {
      h.listener?.(makeJob({ status: "failed", error: "terminal arXiv failure" }), "job.failed");
    });
    screen.getByText(/获取 arXiv 正文失败：terminal arXiv failure/);

    act(() => {
      h.listener?.(makeJob({ status: "queued", error: null }), "job.created");
      h.listener?.(makeJob({ status: "running", error: null }), "job.progress");
    });

    expect(screen.getByText(/获取 arXiv 正文失败：terminal arXiv failure/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a non-202 trigger surfaces the generic failure line", async () => {
    h.attachArxiv.mockResolvedValueOnce(null);
    renderDetail(REF_ARXIV);
    openFilesTab();
    startArxivAcquisition();
    await waitFor(() => screen.getByText("获取 arXiv 正文失败，请重试"));
  });
});

describe("D17 cleanup of acquisition ads", () => {
  it("docless without arXiv: uses the same acquisition entry and disables arXiv", () => {
    renderDetail(REF_NEEDS_UPLOAD);
    openFilesTab();
    fireEvent.click(screen.getByRole("button", { name: "获取全文…" }));
    expect((screen.getByRole("radio", { name: /从 arXiv 获取 LaTeX 源码/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("radio", { name: /上传 LaTeX 源码包/ })).toBeTruthy();
  });

  it("the '可获取 · A&A html' style acquisition ads are gone everywhere", () => {
    renderDetail(REF_AD);
    // info panel (under the title)
    expect(screen.queryByText(/可获取/)).toBeNull();
    openFilesTab();
    expect(screen.queryByText(/可获取/)).toBeNull();
    expect(screen.queryByText(/反爬墙/)).toBeNull();
  });
});

describe("works with docs", () => {
  it("an arXiv main doc offers the safe update entry; confirmation queues the refresh", async () => {
    h.attachArxiv.mockResolvedValueOnce(makeJob());
    renderDetail(REF_WITH_ARXIV_DOC);
    // the acquisition line is hidden once a main doc exists
    openFilesTab();
    expect(screen.queryByTestId("arxiv-fetch")).toBeNull();
    const btn = screen.getByTestId("arxiv-refetch-main");
    expect(btn.textContent).toBe("重新获取 arXiv 最新版（覆盖该文档）");
    fireEvent.click(btn);
    expect(h.attachArxiv).not.toHaveBeenCalled();
    expect(await screen.findByText("当前未发现标注；更新会替换这份正文。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    await waitFor(() => expect(h.attachArxiv).toHaveBeenCalledWith(REF_WITH_ARXIV_DOC.id));
  });

  it("a user-upload doc offers no refetch entry", () => {
    renderDetail(REF_WITH_UPLOAD_DOC);
    openFilesTab();
    expect(screen.queryByTestId("arxiv-fetch")).toBeNull();
    expect(screen.queryByTestId("arxiv-refetch-main")).toBeNull();
  });
});
