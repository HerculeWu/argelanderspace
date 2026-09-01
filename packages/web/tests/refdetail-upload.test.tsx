/**
 * RefDetail upload-job tracking (Stage 3 / MS3): the WS subscriber must not
 * drop job frames that arrive before the upload POST's fetch response, `hello`
 * replays must restore tracking of a running upload, and terminal states must
 * surface `job.error`. Also covers the notes tab (full note text, read-only).
 *
 * The `../src/api/ws` / `../src/api/library` modules are mocked: the captured
 * job listener is driven by hand, `uploadPdf` is a controlled promise.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@argelanderspace/contracts";
import { RefDetail } from "../src/library/RefDetail";
import type { LibraryRef } from "../src/library/types";

const h = vi.hoisted(() => ({
  listener: null as ((job: Job, event: string) => void) | null,
  uploadPdf: vi.fn<(workId: string, file: File | Blob) => Promise<Job | null>>(),
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
  uploadPdf: h.uploadPdf,
}));

/** A work with no reader doc → the files tab offers the upload button. */
const REF: LibraryRef = {
  id: "doi:10.1/x",
  title: "Some Paper",
  authors: "Doe",
  year: 2020,
  venue: "ApJ",
  type: "article",
  cite: "doe2020",
  tags: [],
  pdf: false,
  read: false,
  star: false,
  needs_upload: true,
};

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: "upload-j1",
    kind: "upload",
    status: "queued",
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    progress: [],
    result: null,
    error: null,
    payload: { workId: REF.id, doi: null, arxiv: null },
    ...over,
  };
}

function renderDetail(r: LibraryRef = REF) {
  const onReload = vi.fn();
  const utils = render(
    <RefDetail r={r} node={null} onClose={() => {}} onOpenDoc={() => {}} onReload={onReload} />
  );
  return { ...utils, onReload };
}

/** Pick a PDF in the hidden file input (uploadPdf stays pending by default). */
function pickPdf(container: HTMLElement): void {
  const input = container.querySelector("input[type=file]");
  if (!input) throw new Error("file input not found");
  fireEvent.change(input, {
    target: { files: [new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" })] },
  });
}

function openFilesTab(): void {
  fireEvent.click(screen.getByRole("button", { name: "附件" }));
}

describe("RefDetail upload tracking", () => {
  beforeEach(() => {
    h.listener = null;
    h.uploadPdf.mockReset();
    // never resolves unless the test says so
    h.uploadPdf.mockImplementation(() => new Promise<Job | null>(() => {}));
  });

  afterEach(() => cleanup());

  it("tracks job frames that arrive before the fetch response (no rewind on 202)", async () => {
    let resolveFetch: (j: Job | null) => void = () => {};
    h.uploadPdf.mockImplementation(
      () =>
        new Promise<Job | null>((res) => {
          resolveFetch = res;
        })
    );
    const { container } = renderDetail();
    openFilesTab();
    pickPdf(container);

    // job.created and a progress frame beat the pending POST response
    act(() => h.listener?.(makeJob(), "job.created"));
    const queuedBtn = screen.getByRole("button", { name: /排队等待 OCR/ });
    expect((queuedBtn as HTMLButtonElement).disabled).toBe(true);
    act(() =>
      h.listener?.(
        makeJob({
          status: "running",
          startedAt: "2026-09-01T00:00:01.000Z",
          progress: [{ at: "2026-09-01T00:00:01.000Z", message: "MinerU task state: running (elapsed 5s)" }],
        }),
        "job.progress"
      )
    );
    expect(screen.getByText(/MinerU task state: running/)).toBeTruthy();

    // the 202 body is the stale queued snapshot — it must not rewind the UI
    await act(async () => resolveFetch(makeJob()));
    expect(screen.getByText(/MinerU task state: running/)).toBeTruthy();
  });

  it("surfaces a fast failure that beats the fetch response (job.error shown)", async () => {
    let resolveFetch: (j: Job | null) => void = () => {};
    h.uploadPdf.mockImplementation(
      () =>
        new Promise<Job | null>((res) => {
          resolveFetch = res;
        })
    );
    const { container } = renderDetail();
    openFilesTab();
    pickPdf(container);

    act(() => h.listener?.(makeJob(), "job.created"));
    act(() =>
      h.listener?.(
        makeJob({
          status: "failed",
          startedAt: "2026-09-01T00:00:01.000Z",
          finishedAt: "2026-09-01T00:00:02.000Z",
          error: "MinerU exploded",
        }),
        "job.failed"
      )
    );
    // the error is visible even before the POST answers
    expect(screen.getByText(/MinerU exploded/)).toBeTruthy();

    // the late stale 202 must not resurrect the queued state or hide the error
    await act(async () => resolveFetch(makeJob()));
    expect(screen.getByText(/MinerU exploded/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /上传 PDF/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hello replay of a running upload restores tracking without a local upload", () => {
    renderDetail();
    act(() =>
      h.listener?.(
        makeJob({
          status: "running",
          startedAt: "2026-09-01T00:00:01.000Z",
          progress: [{ at: "2026-09-01T00:00:01.000Z", message: "MinerU extraction" }],
        }),
        "hello"
      )
    );
    openFilesTab();
    expect((screen.getByRole("button", { name: /MinerU extraction/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hello replay of a terminal job does not flash an error", () => {
    renderDetail();
    act(() =>
      h.listener?.(
        makeJob({
          status: "failed",
          finishedAt: "2026-09-01T00:01:00.000Z",
          error: "an old failure",
        }),
        "hello"
      )
    );
    openFilesTab();
    expect(screen.queryByText(/an old failure/)).toBeNull();
    expect((screen.getByRole("button", { name: /上传 PDF/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("job.done reloads the library and re-enables the button", async () => {
    h.uploadPdf.mockResolvedValue(makeJob());
    const { container, onReload } = renderDetail();
    openFilesTab();
    pickPdf(container);
    await screen.findByRole("button", { name: /排队等待 OCR/ });

    act(() =>
      h.listener?.(
        makeJob({ status: "done", finishedAt: "2026-09-01T00:02:00.000Z" }),
        "job.done"
      )
    );
    expect(onReload).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: /上传 PDF/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores upload jobs targeting other works", () => {
    renderDetail();
    act(() =>
      h.listener?.(
        makeJob({ id: "upload-other", payload: { workId: "doi:10.1/other" } }),
        "job.created"
      )
    );
    openFilesTab();
    expect((screen.getByRole("button", { name: /上传 PDF/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("RefDetail notes tab", () => {
  beforeEach(() => {
    h.listener = null;
    h.uploadPdf.mockReset();
  });

  afterEach(() => cleanup());

  it("renders the full note text read-only (pre-wrap), no count placeholder", () => {
    const { container } = renderDetail({ ...REF, note: "line one\nline two" });
    fireEvent.click(screen.getByText("笔记"));
    const note = container.querySelector(".ref-note p");
    expect(note?.textContent).toBe("line one\nline two");
    expect(screen.queryByText(/已有 \d+ 条笔记/)).toBeNull();
  });

  it("shows the empty state when the ref carries no note", () => {
    renderDetail();
    fireEvent.click(screen.getByText("笔记"));
    expect(screen.getByText("暂无笔记")).toBeTruthy();
  });
});
