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
  uploadLatexZip: h.uploadLatexZip,
  patchRef: h.patchRef,
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
  fireEvent.click(screen.getByRole("button", { name: "附件" }));
}

beforeEach(() => {
  h.attachArxiv.mockReset().mockReturnValue(new Promise(() => {})); // pending by default
});

afterEach(() => {
  cleanup();
});

describe("docless work with an arXiv id", () => {
  it("shows the clickable arXiv pill; clicking queues the fetch and shows progress below", async () => {
    renderDetail(REF_ARXIV);
    openFilesTab();
    const pill = screen.getByTestId("arxiv-fetch");
    expect(pill.textContent).toBe("可获取 · arXiv 全文");
    const job = makeJob();
    h.attachArxiv.mockResolvedValueOnce(job);
    fireEvent.click(pill);
    expect(h.attachArxiv).toHaveBeenCalledWith(REF_ARXIV.id);
    await waitFor(() => screen.getByText("排队等待获取 arXiv 正文…"));
    // progress ticks land under the line
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
    fireEvent.click(screen.getByTestId("arxiv-fetch"));
    await waitFor(() => screen.getByText("排队等待获取 arXiv 正文…"));
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
    // retry re-triggers the fetch
    h.attachArxiv.mockResolvedValueOnce(makeJob({ id: "ingest-j2" }));
    fireEvent.click(screen.getByTestId("arxiv-retry"));
    expect(h.attachArxiv).toHaveBeenCalledTimes(2);
  });

  it("a plain failure shows no PDF-only hint", async () => {
    renderDetail(REF_ARXIV);
    openFilesTab();
    h.attachArxiv.mockResolvedValueOnce(makeJob());
    fireEvent.click(screen.getByTestId("arxiv-fetch"));
    await waitFor(() => screen.getByText("排队等待获取 arXiv 正文…"));
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

  it("a non-202 trigger surfaces the generic failure line", async () => {
    h.attachArxiv.mockResolvedValueOnce(null);
    renderDetail(REF_ARXIV);
    openFilesTab();
    fireEvent.click(screen.getByTestId("arxiv-fetch"));
    await waitFor(() => screen.getByText("获取 arXiv 正文失败，请重试"));
  });
});

describe("D17 cleanup of acquisition ads", () => {
  it("docless without arXiv: needsUpload pill stays, no clickable line", () => {
    renderDetail(REF_NEEDS_UPLOAD);
    openFilesTab();
    // the factual pill renders in BOTH the info panel and the files tab (D17)
    expect(screen.getAllByText("需上传源码包").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("arxiv-fetch")).toBeNull();
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
  it("an arXiv main doc offers the refetch entry; a click queues the refresh", () => {
    renderDetail(REF_WITH_ARXIV_DOC);
    // the acquisition line is hidden once a main doc exists
    openFilesTab();
    expect(screen.queryByTestId("arxiv-fetch")).toBeNull();
    const btn = screen.getByTestId("arxiv-refetch-main");
    expect(btn.textContent).toBe("重新获取");
    fireEvent.click(btn);
    expect(h.attachArxiv).toHaveBeenCalledWith(REF_WITH_ARXIV_DOC.id);
  });

  it("a user-upload doc offers no refetch entry", () => {
    renderDetail(REF_WITH_UPLOAD_DOC);
    openFilesTab();
    expect(screen.queryByTestId("arxiv-fetch")).toBeNull();
    expect(screen.queryByTestId("arxiv-refetch-main")).toBeNull();
  });
});
