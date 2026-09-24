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
  onJobEvent: (listener: (job: Job, event: string) => void) => {
    h.listener = listener;
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

const REF: LibraryRef = {
  id: "arxiv:2609.17036",
  title: "Safe acquisition",
  authors: "A. Author",
  year: 2026,
  venue: "ApJ",
  type: "article",
  cite: "Author2026Safe",
  tags: [],
  pdf: false,
  read: false,
  star: false,
  arxiv_id: "2609.17036",
};

function job(kind: "upload" | "ingest" = "ingest"): Job {
  return {
    id: `${kind}-job`,
    kind,
    status: "queued",
    createdAt: "2026-09-21T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    progress: [],
    result: null,
    error: null,
    payload: { workId: REF.id },
  };
}

function chooseArxivLatex(): void {
  fireEvent.click(screen.getByRole("radio", { name: /从 arXiv 获取 LaTeX 源码/ }));
}
function chooseLatexUpload(): void {
  fireEvent.click(screen.getByRole("radio", { name: /上传 LaTeX 源码包/ }));
}

function renderDetail(r: LibraryRef = REF) {
  const onReload = vi.fn();
  const view = render(
    <RefDetail
      r={r}
      node={null}
      onClose={() => {}}
      onOpenDoc={() => {}}
      onReload={onReload}
    />
  );
  return { ...view, onReload };
}

beforeEach(() => {
  h.attachArxiv.mockReset();
  h.uploadLatexZip.mockReset();
  h.patchRef.mockReset().mockResolvedValue(true);
  h.fetchAnnotations.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("RefDetail full-text acquisition", () => {
  it("submits a docless arXiv acquisition from the unified method dialog without querying annotations", async () => {
    h.attachArxiv.mockResolvedValue(job());
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "获取全文" }));
    fireEvent.click(screen.getByRole("button", { name: "获取全文…" }));
    chooseArxivLatex();

    const dialog = screen.getByRole("dialog", { name: "获取全文" });
    expect(dialog.textContent).toContain("从 arXiv 获取");
    expect(dialog.textContent).toContain("上传 LaTeX 源码包");
    expect(h.fetchAnnotations).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "开始获取" }));

    await waitFor(() => expect(h.attachArxiv).toHaveBeenCalledWith(REF.id));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.fetchAnnotations).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("正在排队");
  });

  it("requires a real zip selection before submitting a first upload and cancel sends no mutation", async () => {
    h.uploadLatexZip.mockResolvedValue(job("upload"));
    renderDetail({ ...REF, arxiv_id: undefined, id: "doi:10.1/upload" });

    fireEvent.click(screen.getByRole("button", { name: "获取全文" }));
    fireEvent.click(screen.getByRole("button", { name: "获取全文…" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(h.uploadLatexZip).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "获取全文…" }));
    const upload = screen.getByLabelText("上传 LaTeX 源码包") as HTMLInputElement;
    expect(upload.accept).toBe(".zip");

    fireEvent.click(screen.getByRole("button", { name: "上传并处理" }));
    expect(screen.getByRole("alert").textContent).toContain("请选择 .zip 源码包");
    expect(h.uploadLatexZip).not.toHaveBeenCalled();

    const pdf = new File(["%PDF"], "paper.pdf", { type: "application/pdf" });
    fireEvent.change(upload, { target: { files: [pdf] } });
    expect(screen.getByRole("alert").textContent).toContain("扩展名为 .zip");
    fireEvent.click(screen.getByRole("button", { name: "上传并处理" }));
    expect(h.uploadLatexZip).not.toHaveBeenCalled();

    const empty = new File([], "empty.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("上传 LaTeX 源码包"), {
      target: { files: [empty] },
    });
    expect(screen.getByRole("alert").textContent).toContain("文件为空");
    expect(h.uploadLatexZip).not.toHaveBeenCalled();

    const first = new File(["PK\u0003\u0004first"], "source.zip", {
      type: "application/zip",
    });
    const replacement = new File(["PK\u0003\u0004replacement"], "source.zip", {
      type: "application/zip",
    });
    const picker = screen.getByLabelText("上传 LaTeX 源码包") as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [first] } });
    expect(picker.value).toBe("");
    fireEvent.change(picker, { target: { files: [replacement] } });
    expect(screen.getByText("source.zip")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "上传并处理" }));

    await waitFor(() =>
      expect(h.uploadLatexZip).toHaveBeenCalledWith("doi:10.1/upload", replacement)
    );
    expect(h.fetchAnnotations).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.uploadLatexZip).toHaveBeenCalledTimes(1);
  });

  it("queries the exact arXiv replacement target and requires an explicit annotated-content confirmation", async () => {
    let resolveCount: (value: unknown) => void = () => {};
    h.fetchAnnotations.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCount = resolve;
        })
    );
    h.attachArxiv.mockResolvedValue(job());
    renderDetail({
      ...REF,
      doc_id: "arxiv-2609.17036",
      doc_ids: ["arxiv-2609.17036"],
    });

    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    chooseArxivLatex();
    expect(h.fetchAnnotations).toHaveBeenCalledWith("arxiv-2609.17036");
    expect(screen.getByText("正在检查这份正文的标注…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认更新" }) as HTMLButtonElement).disabled).toBe(true);

    resolveCount({
      ok: true,
      file: {
        version: 1,
        rev: 0,
        content_fingerprint: "a".repeat(64),
        annotations: [{ id: "a_00000001" }, { id: "a_00000002" }],
      },
    });

    expect(await screen.findByText(/这份正文有 2 条标注/)).toBeTruthy();
    expect(screen.getByText(/旧标注将整批归档/)).toBeTruthy();
    expect(screen.getByText(/不会自动迁移/)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "确认更新" });
    act(() => {
      confirm.click();
      confirm.click();
    });

    await waitFor(() => expect(h.attachArxiv).toHaveBeenCalledTimes(1));
  });

  it("binds a repeat upload to the server-derived Work target and gives zero annotations one-surface replacement notice", async () => {
    const exactTarget = "upload-doi-10-1-risk-3d7e36";
    h.fetchAnnotations.mockResolvedValue({
      ok: true,
      file: {
        version: 1,
        rev: 0,
        content_fingerprint: "b".repeat(64),
        annotations: [],
      },
    });
    h.uploadLatexZip.mockResolvedValue(job("upload"));
    renderDetail({
      ...REF,
      id: "doi:10.1/risk",
      arxiv_id: undefined,
      doc_id: "upload-decoy",
      doc_ids: ["upload-decoy", exactTarget],
    });

    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    chooseLatexUpload();

    await waitFor(() => expect(h.fetchAnnotations).toHaveBeenCalledWith(exactTarget));
    expect((await screen.findAllByText(exactTarget)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("当前未发现标注；更新会替换这份正文。")).toBeTruthy();
    const file = new File(["PK\u0003\u0004fixture"], "replacement.zip", {
      type: "application/zip",
    });
    fireEvent.change(screen.getByLabelText("上传 LaTeX 源码包"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));

    await waitFor(() =>
      expect(h.uploadLatexZip).toHaveBeenCalledWith("doi:10.1/risk", file)
    );
    expect(h.fetchAnnotations).toHaveBeenCalledTimes(1);
  });

  it("treats an unavailable annotation count as risk, but blocks a known busy target", async () => {
    h.fetchAnnotations.mockResolvedValueOnce({ ok: false, missing: false, status: 500 });
    h.attachArxiv.mockResolvedValue(job());
    const view = renderDetail({
      ...REF,
      doc_id: "arxiv-2609.17036",
      doc_ids: ["arxiv-2609.17036"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    chooseArxivLatex();

    expect(await screen.findByText(/无法确认这份正文的标注数量/)).toBeTruthy();
    expect(screen.getByText(/不会自动迁移/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    await waitFor(() => expect(h.attachArxiv).toHaveBeenCalledTimes(1));

    view.unmount();
    h.attachArxiv.mockClear();
    h.fetchAnnotations.mockResolvedValueOnce({ ok: false, missing: false, status: 409 });
    renderDetail({
      ...REF,
      doc_id: "arxiv-2609.17036",
      doc_ids: ["arxiv-2609.17036"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    chooseArxivLatex();

    expect(await screen.findByText("正文正在处理中")).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认更新" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    expect(h.attachArxiv).not.toHaveBeenCalled();
  });

  it("rechecks annotation risk on every retry instead of retaining a previous consent", async () => {
    h.fetchAnnotations.mockResolvedValue({
      ok: true,
      file: {
        version: 1,
        rev: 0,
        content_fingerprint: "c".repeat(64),
        annotations: [{ id: "a_00000001" }],
      },
    });
    h.attachArxiv
      .mockResolvedValueOnce(job())
      .mockResolvedValueOnce({ ...job(), id: "ingest-retry" });
    renderDetail({
      ...REF,
      doc_id: "arxiv-2609.17036",
      doc_ids: ["arxiv-2609.17036"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    chooseArxivLatex();
    expect(await screen.findByText(/这份正文有 1 条标注/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    await waitFor(() => expect(h.attachArxiv).toHaveBeenCalledTimes(1));

    act(() => {
      h.listener?.({ ...job(), status: "failed", error: "network failed" }, "job.failed");
    });
    expect(await screen.findByText(/network failed/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("arxiv-retry"));
    chooseArxivLatex();

    expect(await screen.findByText(/这份正文有 1 条标注/)).toBeTruthy();
    expect(h.fetchAnnotations).toHaveBeenCalledTimes(2);
    expect(h.attachArxiv).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    await waitFor(() => expect(h.attachArxiv).toHaveBeenCalledTimes(2));
  });

  it("ignores a late count after switching Work sessions", async () => {
    let resolveCount: ((value: unknown) => void) | null = null;
    h.fetchAnnotations.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCount = resolve;
        })
    );
    const view = renderDetail({
      ...REF,
      doc_id: "arxiv-2609.17036",
      doc_ids: ["arxiv-2609.17036"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    chooseArxivLatex();
    expect(screen.getByText("正在检查这份正文的标注…")).toBeTruthy();

    view.rerender(
      <RefDetail
        r={{ ...REF, id: "doi:10.9/next", title: "Next Work", arxiv_id: "2610.00001" }}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        onReload={view.onReload}
      />
    );
    expect(screen.queryByRole("dialog", { name: "获取全文" })).toBeNull();
    await act(async () => {
      resolveCount?.({
        ok: true,
        file: {
          version: 1,
          rev: 0,
          content_fingerprint: "e".repeat(64),
          annotations: [{ id: "late" }],
        },
      });
    });
    expect(screen.queryByText(/这份正文有 1 条标注/)).toBeNull();
  });

  it("blocks duplicate submission and every dismissal path while the request is pending", async () => {
    h.fetchAnnotations.mockResolvedValue({
      ok: true,
      file: {
        version: 1,
        rev: 0,
        content_fingerprint: "f".repeat(64),
        annotations: [{ id: "a_00000001" }],
      },
    });
    let resolveSubmit: ((value: Job | null) => void) | null = null;
    h.attachArxiv.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        })
    );
    renderDetail({
      ...REF,
      doc_id: "arxiv-2609.17036",
      doc_ids: ["arxiv-2609.17036"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    chooseArxivLatex();
    expect(await screen.findByText(/这份正文有 1 条标注/)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "确认更新" });
    fireEvent.click(confirm);
    expect(h.attachArxiv).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "正在提交…" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByTestId("dialog-backdrop"));
    expect(screen.getByRole("dialog", { name: "获取全文" })).toBeTruthy();
    expect(h.attachArxiv).toHaveBeenCalledTimes(1);

    await act(async () => resolveSubmit?.(null));
    expect(screen.getByText("获取 arXiv 正文失败，请重试")).toBeTruthy();
    await waitFor(() => expect(h.fetchAnnotations).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/这份正文有 1 条标注/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not let a late A submit settle mutate B's independently busy dialog", async () => {
    const resolvers: Array<(value: Job | null) => void> = [];
    h.fetchAnnotations.mockResolvedValue({
      ok: true,
      file: {
        version: 1,
        rev: 0,
        content_fingerprint: "1".repeat(64),
        annotations: [],
      },
    });
    h.attachArxiv.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );
    const view = renderDetail({
      ...REF,
      doc_id: "arxiv-2609.17036",
      doc_ids: ["arxiv-2609.17036"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    chooseArxivLatex();
    expect(await screen.findByText("当前未发现标注；更新会替换这份正文。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    expect(h.attachArxiv).toHaveBeenCalledTimes(1);

    const next: LibraryRef = {
      ...REF,
      id: "arxiv:2610.00001",
      title: "Next Work",
      arxiv_id: "2610.00001",
      doc_id: undefined,
      doc_ids: undefined,
    };
    view.rerender(
      <RefDetail
        r={next}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        onReload={view.onReload}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "获取全文…" }));
    chooseArxivLatex();
    fireEvent.click(screen.getByRole("button", { name: "开始获取" }));
    expect(h.attachArxiv).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Next Work" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "正在提交…" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => resolvers[0]?.(null));
    expect(screen.getByRole("heading", { name: "Next Work" })).toBeTruthy();
    expect(screen.queryByText("获取 arXiv 正文失败，请重试")).toBeNull();
    expect((screen.getByRole("button", { name: "正在提交…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolvers[1]?.(null));
  });

  it("invalidates a same-target payload snapshot and ignores its delayed old count", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    h.fetchAnnotations.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );
    const initial = {
      ...REF,
      doc_id: "arxiv-2609.17036",
      doc_ids: ["arxiv-2609.17036"],
    };
    const view = renderDetail(initial);
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    chooseArxivLatex();
    expect(h.fetchAnnotations).toHaveBeenCalledTimes(1);

    view.rerender(
      <RefDetail
        r={{ ...initial, sourceStatus: "refreshed" }}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        onReload={view.onReload}
      />
    );
    await waitFor(() => expect(h.fetchAnnotations).toHaveBeenCalledTimes(2));
    expect((screen.getByRole("button", { name: "确认更新" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () =>
      resolvers[1]?.({
        ok: true,
        file: {
          version: 1,
          rev: 0,
          content_fingerprint: "2".repeat(64),
          annotations: [],
        },
      })
    );
    expect(await screen.findByText("当前未发现标注；更新会替换这份正文。")).toBeTruthy();
    await act(async () =>
      resolvers[0]?.({
        ok: true,
        file: {
          version: 1,
          rev: 0,
          content_fingerprint: "3".repeat(64),
          annotations: [{ id: "late" }],
        },
      })
    );
    expect(screen.queryByText(/这份正文有 1 条标注/)).toBeNull();
    expect(screen.getByText("当前未发现标注；更新会替换这份正文。")).toBeTruthy();
  });

  it("invalidates a known-zero snapshot when a matching job becomes busy", async () => {
    h.fetchAnnotations.mockResolvedValue({
      ok: true,
      file: {
        version: 1,
        rev: 0,
        content_fingerprint: "4".repeat(64),
        annotations: [],
      },
    });
    renderDetail({
      ...REF,
      doc_id: "arxiv-2609.17036",
      doc_ids: ["arxiv-2609.17036"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    chooseArxivLatex();
    expect(await screen.findByText("当前未发现标注；更新会替换这份正文。")).toBeTruthy();

    act(() => {
      h.listener?.(job(), "job.created");
    });
    expect(await screen.findByText("正文正在处理中")).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认更新" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.attachArxiv).not.toHaveBeenCalled();
  });

  it("invalidates a count when the same Work payload removes the selected target", async () => {
    h.fetchAnnotations.mockResolvedValue({
      ok: true,
      file: {
        version: 1,
        rev: 0,
        content_fingerprint: "d".repeat(64),
        annotations: [{ id: "a_00000001" }],
      },
    });
    const view = renderDetail({
      ...REF,
      doc_id: "arxiv-2609.17036",
      doc_ids: ["arxiv-2609.17036"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));
    chooseArxivLatex();
    expect(await screen.findByText(/这份正文有 1 条标注/)).toBeTruthy();

    view.rerender(
      <RefDetail
        r={{ ...REF, doc_id: "upload-new", doc_ids: ["upload-new"] }}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
        onReload={view.onReload}
      />
    );

    expect(await screen.findByText("更新目标已变化")).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认更新" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.attachArxiv).not.toHaveBeenCalled();
  });

  it("keeps scene C blocked and never uses a displayed source or Doc prefix as arXiv eligibility", () => {
    renderDetail({
      ...REF,
      doc_id: "upload-only-document",
      doc_ids: ["upload-only-document"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "全文" }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 更新全文…" }));

    const arxiv = screen.getByRole("radio", { name: /从 arXiv 获取 LaTeX 源码/ }) as HTMLInputElement;
    expect(arxiv.disabled).toBe(true);
    expect(screen.getByText("现有正文不匹配 arXiv 获取条件")).toBeTruthy();
    expect(h.attachArxiv).not.toHaveBeenCalled();
    expect(h.fetchAnnotations).not.toHaveBeenCalled();
  });
});
