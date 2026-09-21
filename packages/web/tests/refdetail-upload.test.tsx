/**
 * RefDetail LaTeX-zip upload tracking (Stage 3.1 MS2): the WS subscriber must
 * not drop job frames that arrive before the upload POST's fetch response,
 * `hello` replays must restore tracking of a running upload, terminal states
 * must surface `job.error`, and — the Q7 failure probe — a *failed* job
 * replayed via `hello` (page refresh: the server replays the persisted job
 * table) must show `上传失败：…` in the detail panel. Also covers the notes
 * tab (full note text, read-only).
 *
 * The `../src/api/ws` / `../src/api/library` modules are mocked: the captured
 * job listener is driven by hand, `uploadLatexZip` is a controlled promise.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@argelanderspace/contracts";
import { RefDetail } from "../src/library/RefDetail";
import type { LibraryRef } from "../src/library/types";

const h = vi.hoisted(() => ({
  listener: null as ((job: Job, event: string) => void) | null,
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
  fetchDocProvenance: vi.fn().mockResolvedValue("unknown"),
  uploadLatexZip: h.uploadLatexZip,
  patchRef: h.patchRef,
}));

vi.mock("../src/api/annotations", () => ({
  deletePaperDoc: vi.fn(),
  fetchAnnotations: h.fetchAnnotations,
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

/** Open the acquisition dialog, select upload, and submit a real File. */
async function pickZip(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /获取全文…|添加 \/ 更新全文…/ }));
  fireEvent.click(screen.getByLabelText("上传 LaTeX 源码包"));
  const input = document.querySelector("#acquisition-file");
  if (!input) throw new Error("acquisition file input not found");
  fireEvent.change(input, {
    target: { files: [new File(["PK\x03\x04fake"], "src.zip", { type: "application/zip" })] },
  });
  const submit = screen.getByRole("button", { name: /上传并处理|确认更新/ });
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(submit);
}

function openFilesTab(): void {
  fireEvent.click(screen.getByRole("tab", { name: "全文" }));
}

describe("RefDetail upload tracking", () => {
  beforeEach(() => {
    h.listener = null;
    h.uploadLatexZip.mockReset();
    h.patchRef.mockReset();
    h.patchRef.mockResolvedValue(true);
    h.fetchAnnotations.mockReset().mockResolvedValue({
      ok: true,
      file: {
        version: 1,
        rev: 0,
        content_fingerprint: "a".repeat(64),
        annotations: [],
      },
    });
    // never resolves unless the test says so
    h.uploadLatexZip.mockImplementation(() => new Promise<Job | null>(() => {}));
  });

  afterEach(() => cleanup());

  it("offers a .zip file picker when the work has no doc", () => {
    renderDetail();
    openFilesTab();
    fireEvent.click(screen.getByRole("button", { name: "获取全文…" }));
    fireEvent.click(screen.getByLabelText("上传 LaTeX 源码包"));
    expect(document.querySelector("#acquisition-file")?.getAttribute("accept")).toBe(".zip");
  });

  it("re-upload: an exact upload target keeps a safe replacement action", async () => {
    renderDetail({
      ...REF,
      doc_id: "upload-doi-10-1-x-19b8c2",
      doc_ids: ["upload-doi-10-1-x-19b8c2"],
      needs_upload: false,
    });
    openFilesTab();
    // the Doc stays listed by its concrete identifier, and re-upload remains available.
    expect(screen.getByText("upload-doi-10-1-x-19b8c2")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "更新上传的正文" })).toBeTruthy();
    // Selecting upload resolves the exact target and uses overwrite semantics.
    await pickZip();
    expect(h.uploadLatexZip).toHaveBeenCalledWith(REF.id, expect.any(File));
  });

  it("arXiv-ingested doc: the upload button is offered too (Stage 7 MS3 new-version semantics)", () => {
    renderDetail({
      ...REF,
      doc_id: "arxiv-2603.03522",
      doc_ids: ["arxiv-2603.03522"],
      needs_upload: false,
    });
    openFilesTab();
    expect(screen.getByText("arxiv-2603.03522")).toBeTruthy();
    const btn = screen.getByRole("button", { name: "添加 / 更新全文…" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("version list: every doc is listed, the main one is marked, others offer 设为主", async () => {
    const { onReload } = renderDetail({
      ...REF,
      doc_id: "upload-doi-10-1-x-a1b2c3",
      doc_ids: ["upload-doi-10-1-x-a1b2c3", "arxiv-2603.03522"],
      needs_upload: false,
    });
    openFilesTab();
    // main doc marked, old version listed by doc id with a 设为主 action
    expect(screen.getByText("主文档")).toBeTruthy();
    expect(screen.getByText("arxiv-2603.03522")).toBeTruthy();
    fireEvent.click(screen.getAllByText("文档操作")[1]!);
    const setMain = screen.getByRole("button", { name: "设为主文档" }) as HTMLButtonElement;
    expect(setMain.disabled).toBe(false);
    fireEvent.click(setMain);
    expect(h.patchRef).toHaveBeenCalledWith(REF.id, { doc_id: "arxiv-2603.03522" });
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
  });

  it("a failed main-doc switch surfaces an error and does not reload", async () => {
    h.patchRef.mockResolvedValue(false);
    const { onReload } = renderDetail({
      ...REF,
      doc_id: "upload-doi-10-1-x-a1b2c3",
      doc_ids: ["upload-doi-10-1-x-a1b2c3", "arxiv-2603.03522"],
      needs_upload: false,
    });
    openFilesTab();
    fireEvent.click(screen.getAllByText("文档操作")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "设为主文档" }));
    expect(await screen.findByText("设为主文档失败，请重试")).toBeTruthy();
    expect(onReload).not.toHaveBeenCalled();
  });

  it("does not deliver a late main-doc PATCH result into a later A → B → A Work session", async () => {
    let resolvePatch: (ok: boolean) => void = () => {};
    h.patchRef.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePatch = resolve;
        })
    );
    const refWithDocs = {
      ...REF,
      doc_id: "upload-doi-10-1-x-a1b2c3",
      doc_ids: ["upload-doi-10-1-x-a1b2c3", "arxiv-2603.03522"],
      needs_upload: false,
    };
    const view = renderDetail(refWithDocs);
    openFilesTab();
    fireEvent.click(screen.getAllByText("文档操作")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "设为主文档" }));

    view.rerender(
      <RefDetail
        r={{ ...REF, id: "doi:10.1/next", title: "Next Work" }}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        onReload={view.onReload}
      />
    );
    view.rerender(
      <RefDetail
        r={refWithDocs}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        onReload={view.onReload}
      />
    );
    await act(async () => resolvePatch(false));

    expect(screen.queryByText("设为主文档失败，请重试")).toBeNull();
    expect(view.onReload).not.toHaveBeenCalled();
    expect(screen.getByText("主文档")).toBeTruthy();
  });

  it("invalidates an in-flight main-doc PATCH when the detail unmounts", async () => {
    let resolvePatch: (ok: boolean) => void = () => {};
    h.patchRef.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePatch = resolve;
        })
    );
    const view = renderDetail({
      ...REF,
      doc_id: "upload-doi-10-1-x-a1b2c3",
      doc_ids: ["upload-doi-10-1-x-a1b2c3", "arxiv-2603.03522"],
      needs_upload: false,
    });
    openFilesTab();
    fireEvent.click(screen.getAllByText("文档操作")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "设为主文档" }));
    view.unmount();
    await act(async () => resolvePatch(true));

    expect(view.onReload).not.toHaveBeenCalled();
  });

  it("tracks job frames that arrive before the fetch response (no rewind on 202)", async () => {
    let resolveFetch: (j: Job | null) => void = () => {};
    h.uploadLatexZip.mockImplementation(
      () =>
        new Promise<Job | null>((res) => {
          resolveFetch = res;
        })
    );
    renderDetail();
    openFilesTab();
    await pickZip();

    // job.created and a progress frame beat the pending POST response
    act(() => h.listener?.(makeJob(), "job.created"));
    const queuedBtn = screen.getByRole("button", { name: "获取全文…" });
    expect((queuedBtn as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "正在提交…" }) as HTMLButtonElement).disabled).toBe(true);
    act(() =>
      h.listener?.(
        makeJob({
          status: "running",
          startedAt: "2026-09-01T00:00:01.000Z",
          progress: [{ at: "2026-09-01T00:00:01.000Z", message: "Ingesting LaTeX source" }],
        }),
        "job.progress"
      )
    );
    expect(screen.getAllByText(/Ingesting LaTeX source/).length).toBeGreaterThanOrEqual(1);

    // the 202 body is the stale queued snapshot — it must not rewind the UI
    await act(async () => resolveFetch(makeJob()));
    expect(screen.getAllByText(/Ingesting LaTeX source/).length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces a fast failure that beats the fetch response (job.error shown)", async () => {
    let resolveFetch: (j: Job | null) => void = () => {};
    h.uploadLatexZip.mockImplementation(
      () =>
        new Promise<Job | null>((res) => {
          resolveFetch = res;
        })
    );
    renderDetail();
    openFilesTab();
    await pickZip();

    act(() => h.listener?.(makeJob(), "job.created"));
    act(() =>
      h.listener?.(
        makeJob({
          status: "failed",
          startedAt: "2026-09-01T00:00:01.000Z",
          finishedAt: "2026-09-01T00:00:02.000Z",
          error: "no .tex file found under …",
        }),
        "job.failed"
      )
    );
    // the error is visible even before the POST answers
    expect(screen.getByText(/上传失败：no \.tex file found/)).toBeTruthy();

    // the late stale 202 must not resurrect the queued state or hide the error
    await act(async () => resolveFetch(makeJob()));
    expect(screen.getByText(/上传失败：no \.tex file found/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /获取全文…|添加 \/ 更新全文…/ }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("does not resurrect a terminal upload when late WS queued/running frames arrive", () => {
    renderDetail();
    openFilesTab();
    act(() => {
      h.listener?.(makeJob({ status: "failed", error: "terminal upload failure" }), "job.failed");
    });
    screen.getByText(/上传失败：terminal upload failure/);

    act(() => {
      h.listener?.(makeJob({ status: "queued", error: null }), "job.created");
      h.listener?.(makeJob({ status: "running", error: null }), "job.progress");
    });

    expect(screen.getByText(/上传失败：terminal upload failure/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hello replay of a running upload restores tracking without a local upload", () => {
    renderDetail();
    act(() =>
      h.listener?.(
        makeJob({
          status: "running",
          startedAt: "2026-09-01T00:00:01.000Z",
          progress: [{ at: "2026-09-01T00:00:01.000Z", message: "Rebuilding library" }],
        }),
        "hello"
      )
    );
    openFilesTab();
    expect(screen.getByText("Rebuilding library")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "获取全文…" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("failure probe: a failed upload replayed via hello shows 上传失败：… (survives F5)", () => {
    renderDetail();
    // the server replays the persisted job table on (re)connect — including
    // the failed upload recorded in <dataDir>/jobs/<id>.json
    act(() =>
      h.listener?.(
        makeJob({
          status: "failed",
          finishedAt: "2026-09-01T00:01:00.000Z",
          error: "TeX compilation failed: main.tex",
        }),
        "hello"
      )
    );
    openFilesTab();
    expect(screen.getByText(/上传失败：TeX compilation failed: main\.tex/)).toBeTruthy();
    // the upload button stays usable (the failure is not a live job)
    expect(
      (screen.getByRole("button", { name: /获取全文…|添加 \/ 更新全文…/ }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("hello replay surfaces an interrupted upload and leaves replacement available", () => {
    renderDetail();
    act(() =>
      h.listener?.(
        makeJob({
          status: "interrupted",
          finishedAt: "2026-09-01T00:01:00.000Z",
          error: "server restarted",
        }),
        "hello"
      )
    );
    openFilesTab();

    expect(screen.getByText(/上传失败：server restarted/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /获取全文…|添加 \/ 更新全文…/ }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("job.done reloads the library and re-enables the button", async () => {
    h.uploadLatexZip.mockResolvedValue(makeJob());
    const { onReload } = renderDetail();
    openFilesTab();
    await pickZip();
    await screen.findByText("正在排队");

    act(() =>
      h.listener?.(makeJob({ status: "done", finishedAt: "2026-09-01T00:02:00.000Z" }), "job.done")
    );
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: /获取全文…|添加 \/ 更新全文…/ }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("a null from uploadLatexZip (POST rejected) shows the generic failure", async () => {
    h.uploadLatexZip.mockResolvedValue(null);
    renderDetail();
    openFilesTab();
    await pickZip();
    expect(await screen.findByText("上传失败，请重试")).toBeTruthy();
  });

  it("does not attach a late upload POST response to a later A → B → A Work session", async () => {
    let resolveFetch: (job: Job | null) => void = () => {};
    h.uploadLatexZip.mockImplementation(
      () =>
        new Promise<Job | null>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const view = renderDetail();
    openFilesTab();
    await pickZip();

    view.rerender(
      <RefDetail
        r={{ ...REF, id: "doi:10.1/next", title: "Next Work" }}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        onReload={view.onReload}
      />
    );
    view.rerender(
      <RefDetail
        r={{ ...REF }}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        onReload={view.onReload}
      />
    );
    await act(async () => resolveFetch(makeJob()));

    expect(screen.getByRole("heading", { name: REF.title })).toBeTruthy();
    expect(screen.queryByText("正在排队")).toBeNull();
    expect(
      (screen.getByRole("button", { name: /获取全文…|添加 \/ 更新全文…/ }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("can adopt a persisted failure for the newly selected Work after showing the previous Work's failure", () => {
    const view = renderDetail();
    openFilesTab();
    act(() => {
      h.listener?.(makeJob({ status: "failed", error: "old work failed" }), "hello");
    });
    screen.getByText(/上传失败：old work failed/);

    const next = { ...REF, id: "doi:10.1/next", title: "Next Work" };
    view.rerender(
      <RefDetail
        r={next}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        onReload={view.onReload}
      />
    );
    act(() => {
      h.listener?.(
        makeJob({
          id: "upload-j2",
          status: "failed",
          error: "new work failed",
          payload: { workId: next.id },
        }),
        "hello"
      );
    });

    screen.getByText(/上传失败：new work failed/);
    expect(screen.queryByText(/old work failed/)).toBeNull();
  });

  it("ignores upload jobs targeting other works", () => {
    renderDetail();
    act(() =>
      h.listener?.(makeJob({ id: "upload-other", payload: { workId: "doi:10.1/other" } }), "job.created")
    );
    act(() =>
      h.listener?.(
        makeJob({
          id: "upload-other-failed",
          status: "failed",
          error: "someone else's failure",
          payload: { workId: "doi:10.1/other" },
        }),
        "hello"
      )
    );
    openFilesTab();
    expect(
      (screen.getByRole("button", { name: /获取全文…|添加 \/ 更新全文…/ }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(screen.queryByText(/someone else's failure/)).toBeNull();
  });
});

describe("RefDetail notes tab", () => {
  beforeEach(() => {
    h.listener = null;
    h.uploadLatexZip.mockReset();
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
    expect(screen.getByText("还没有笔记")).toBeTruthy();
    expect(screen.getByText("此处暂不支持编辑笔记。")).toBeTruthy();
  });
});
