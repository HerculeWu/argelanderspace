/**
 * Ticket 48: the Work job tracking behind RefDetail's full-text tab.
 *
 * - `reduceWorkJob`: the per-kind event/submit transitions (hello adoption, no resurrection, fast failure, terminal
 *   states, dismiss policy) for the four kinds — LaTeX zip, PDF upload, arXiv source, arXiv PDF;
 * - `useWorkJobs` over a fake WS event source: one subscription, shared `seen` snapshots, PDF submissions cleared by a
 *   terminal frame of any Work, the Work-switch reset, and the `StartResult` 409 → busy wording;
 * - the three start API functions answering `StartResult`;
 * - `reduceAcquisitionRisk` and `loadDeleteCount` (an unreadable count is unknown, never 0).
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@argelanderspace/contracts";
import type { StartResult } from "../src/api/library";
import {
  type AcquisitionFlow,
  initialWorkJobState,
  isJobSnapshotRegression,
  loadDeleteCount,
  reduceAcquisitionRisk,
  reduceWorkJob,
  useWorkJobs,
  WORK_JOB_KINDS,
  type WorkJobState,
} from "../src/library/work-jobs";

const h = vi.hoisted(() => ({
  listeners: new Set<(job: Job, event: string) => void>(),
  uploadLatexZip: vi.fn<(workId: string, file: File | Blob) => Promise<StartResult>>(),
  uploadPdf: vi.fn<(workId: string, file: File) => Promise<StartResult>>(),
  attachArxiv: vi.fn<(workId: string) => Promise<StartResult>>(),
  acquireArxivPdf: vi.fn<(workId: string) => Promise<StartResult>>(),
  fetchAnnotations: vi.fn(),
  fetchPdfAnnotationCount: vi.fn(),
  fetchTextDeleteImpact: vi.fn(),
}));

vi.mock("../src/api/ws", () => ({
  onJobEvent: (cb: (job: Job, event: string) => void) => {
    h.listeners.add(cb);
    return () => {
      h.listeners.delete(cb);
    };
  },
}));

vi.mock("../src/api/library", () => ({
  uploadLatexZip: h.uploadLatexZip,
  uploadPdf: h.uploadPdf,
  attachArxiv: h.attachArxiv,
  acquireArxivPdf: h.acquireArxivPdf,
}));

vi.mock("../src/api/annotations", () => ({ fetchAnnotations: h.fetchAnnotations }));
vi.mock("../src/api/pdf-annotations", () => ({ fetchPdfAnnotationCount: h.fetchPdfAnnotationCount }));
vi.mock("../src/api/text-docs", () => ({ fetchTextDeleteImpact: h.fetchTextDeleteImpact }));

const A = "doi:10.1/a";
const B = "doi:10.1/b";

function job(over: Partial<Job> & { format?: string; workId?: string } = {}): Job {
  const { format, workId, ...rest } = over;
  return {
    id: "j1",
    kind: "upload",
    status: "queued",
    createdAt: "2026-10-11T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    progress: [],
    result: null,
    error: null,
    payload: { workId: workId ?? A, ...(format ? { format } : {}) },
    ...rest,
  };
}
const zipJob = (over: Partial<Job> & { workId?: string } = {}) => job(over);
const pdfJob = (over: Partial<Job> & { workId?: string } = {}) => job({ format: "pdf", ...over });
const arxivJob = (over: Partial<Job> & { workId?: string } = {}) => job({ kind: "ingest", ...over });
const arxivPdfJob = (over: Partial<Job> & { workId?: string } = {}) => job({ format: "arxiv-pdf", ...over });

function emit(j: Job, event = "job.progress"): void {
  act(() => {
    for (const cb of [...h.listeners]) cb(j, event);
  });
}

function step<E>(kind: Parameters<typeof reduceWorkJob<E>>[0], state: WorkJobState<E>, ...actions: Parameters<typeof reduceWorkJob<E>>[2][]) {
  return actions.reduce((s, a) => reduceWorkJob(kind, s, a), state);
}

beforeEach(() => {
  h.listeners.clear();
  for (const fn of [h.uploadLatexZip, h.uploadPdf, h.attachArxiv, h.acquireArxivPdf]) {
    fn.mockReset().mockReturnValue(new Promise(() => {}));
  }
  h.fetchAnnotations.mockReset();
  h.fetchPdfAnnotationCount.mockReset();
  h.fetchTextDeleteImpact.mockReset();
});
afterEach(() => cleanup());

describe("job snapshot helpers", () => {
  it("orders snapshots by phase", () => {
    expect(isJobSnapshotRegression(undefined, zipJob())).toBe(false);
    expect(isJobSnapshotRegression(zipJob({ status: "running" }), zipJob())).toBe(true);
    expect(isJobSnapshotRegression(zipJob({ status: "failed" }), zipJob({ status: "running" }))).toBe(true);
    expect(isJobSnapshotRegression(zipJob({ status: "failed" }), zipJob({ status: "failed" }))).toBe(false);
  });

  it("routes each job to exactly one kind by kind + payload.format", () => {
    const route = (j: Job) => Object.entries(WORK_JOB_KINDS).filter(([, k]) => k.match(j)).map(([name]) => name);
    expect(route(zipJob())).toEqual(["zip"]);
    expect(route(pdfJob())).toEqual(["pdf"]);
    expect(route(arxivJob())).toEqual(["arxiv"]);
    expect(route(arxivPdfJob())).toEqual(["arxivPdf"]);
  });
});

describe("reduceWorkJob", () => {
  it("adopts a replayed queued/running job when nothing is tracked, and follows only that job", () => {
    const zip = WORK_JOB_KINDS.zip;
    let s = step(zip, initialWorkJobState(), { type: "event", job: zipJob({ status: "running" }) });
    expect(s.job?.status).toBe("running");
    s = step(zip, s, { type: "event", job: zipJob({ id: "other", status: "running" }) });
    expect(s.job?.id).toBe("j1");
    // an untracked done frame is ignored
    expect(step(zip, initialWorkJobState(), { type: "event", job: zipJob({ status: "done" }) })).toEqual(initialWorkJobState());
  });

  it("zip / PDF / arXiv source adopt one replayed failure per Work ('once')", () => {
    for (const [kind, make, text] of [
      [WORK_JOB_KINDS.zip, zipJob, "上传失败：first"],
      [WORK_JOB_KINDS.pdf, pdfJob, "first"],
      [WORK_JOB_KINDS.arxiv, arxivJob, "获取 arXiv 正文失败：first"],
    ] as const) {
      const s = step<unknown>(
        kind,
        initialWorkJobState(),
        { type: "event", job: make({ id: "f1", status: "failed", error: "first" }) },
        { type: "event", job: make({ id: "f2", status: "interrupted", error: "second" }) }
      );
      expect(s.adopted).toBe(true);
      expect(s.error?.message).toBe(text);
      expect(s.job).toBeNull();
    }
  });

  it("arXiv PDF adopts every replayed failure, the last one wins, and a per-job dismissal is remembered", () => {
    const kind = WORK_JOB_KINDS.arxivPdf;
    let s = step(
      kind,
      initialWorkJobState(),
      { type: "event", job: arxivPdfJob({ id: "p1", status: "failed", error: "one" }) },
      { type: "event", job: arxivPdfJob({ id: "p2", status: "failed", error: "two" }) }
    );
    expect(s.error).toMatchObject({ message: "two", jobId: "p2" });
    expect(s.dismissed).toBe(false);
    s = step(kind, s, { type: "dismiss" });
    expect(s.dismissed).toBe(true);
    // p1 again: not dismissed; p2 again: still dismissed
    s = step(kind, s, { type: "event", job: arxivPdfJob({ id: "p1", status: "failed", error: "one" }) });
    expect(s).toMatchObject({ dismissed: false, error: { message: "one" } });
    s = step(kind, s, { type: "event", job: arxivPdfJob({ id: "p2", status: "failed", error: "two" }) });
    expect(s).toMatchObject({ dismissed: true, error: { message: "two" } });
    // the remembered dismissals survive a Work switch
    s = step(kind, s, { type: "reset", submitting: false });
    s = step(kind, s, { type: "event", job: arxivPdfJob({ id: "p2", status: "failed", error: "two" }) });
    expect(s.dismissed).toBe(true);
  });

  it("a tracked job's failure is settled in a later step: then the job clears and the kind's message and extra are written", () => {
    let s = step(WORK_JOB_KINDS.arxiv, initialWorkJobState(), { type: "event", job: arxivJob({ status: "running" }) });
    s = step(WORK_JOB_KINDS.arxiv, s, {
      type: "event",
      job: arxivJob({ status: "failed", error: "no source", errorCode: "arxiv_pdf_only" }),
    });
    expect(s.job?.status).toBe("failed");
    expect(s.error).toBeNull();
    s = step(WORK_JOB_KINDS.arxiv, s, { type: "settle" });
    expect(s.job).toBeNull();
    expect(s.error).toMatchObject({ message: "获取 arXiv 正文失败：no source", extra: "arxiv_pdf_only" });
    // a failure without job.error uses the generic line
    const z = step(WORK_JOB_KINDS.zip, initialWorkJobState(), { type: "event", job: zipJob() }, { type: "event", job: zipJob({ status: "failed" }) }, { type: "settle" });
    expect(z.error?.message).toBe("上传失败，请重试");
    const p = step(WORK_JOB_KINDS.pdf, initialWorkJobState(), { type: "event", job: pdfJob() }, { type: "event", job: pdfJob({ status: "failed" }) }, { type: "settle" });
    expect(p.error?.message).toBe("PDF 上传请求失败，请重试。");
  });

  it("a settled-but-unhandled job still occupies the slot, so a frame of the same batch is not adopted over it", () => {
    const zip = WORK_JOB_KINDS.zip;
    let s = step(
      zip,
      initialWorkJobState(),
      { type: "event", job: zipJob({ id: "new", status: "running" }) },
      { type: "event", job: zipJob({ id: "new", status: "failed", error: "tracked" }) },
      { type: "event", job: zipJob({ id: "older", status: "failed", error: "older" }) }
    );
    s = step(zip, s, { type: "settle" });
    expect(s.error?.message).toBe("上传失败：tracked");
    // settling a queued/running job, or nothing, changes nothing
    const running = step(zip, initialWorkJobState(), { type: "event", job: zipJob({ status: "running" }) });
    expect(step(zip, running, { type: "settle" })).toBe(running);
  });

  it("done clears the job; only the PDF kinds also clear a standing error", () => {
    for (const [kind, make, clears] of [
      [WORK_JOB_KINDS.zip, zipJob, false],
      [WORK_JOB_KINDS.arxiv, arxivJob, false],
      [WORK_JOB_KINDS.pdf, pdfJob, true],
      [WORK_JOB_KINDS.arxivPdf, arxivPdfJob, true],
    ] as const) {
      const s = step<unknown>(
        kind,
        initialWorkJobState(),
        { type: "event", job: make({ id: "old", status: "failed", error: "old" }) },
        { type: "event", job: make({ id: "new", status: "running" }) },
        { type: "event", job: make({ id: "new", status: "done" }) },
        { type: "settle" }
      );
      expect(s.job).toBeNull();
      expect(s.error === null).toBe(clears);
    }
  });

  it("a 202 answer prefers the newer seen snapshot, surfaces a fast failure, and leaves a seen done untracked", () => {
    const zip = WORK_JOB_KINDS.zip;
    const running = zipJob({ status: "running", progress: [{ at: "t", message: "Compiling" }] });
    let s = step(zip, initialWorkJobState(), { type: "submit" }, { type: "accepted", job: zipJob(), seen: running });
    expect(s.job).toBe(running);
    s = step(zip, initialWorkJobState(), { type: "submit" }, { type: "accepted", job: zipJob(), seen: zipJob({ status: "failed", error: "boom" }) });
    expect(s.job).toBeNull();
    expect(s.error?.message).toBe("上传失败：boom");
    s = step(zip, initialWorkJobState(), { type: "submit" }, { type: "accepted", job: zipJob(), seen: zipJob({ status: "done" }) });
    expect(s).toMatchObject({ job: null, error: null, submitting: false });
  });

  it("a rejected submission writes the kind's own message: 409 is busy, other statuses keep the old wording", () => {
    const rejected = (kind: Parameters<typeof reduceWorkJob>[0], status: number, detail = "server detail") =>
      step(kind, initialWorkJobState(), { type: "submit" }, { type: "rejected", status, detail }).error?.message;
    const busy = "document busy";
    expect(rejected(WORK_JOB_KINDS.zip, 409, busy)).toBe("该文档正在处理或删除，请稍后重试");
    expect(rejected(WORK_JOB_KINDS.zip, 409)).toBe("上传失败，请重试");
    expect(rejected(WORK_JOB_KINDS.zip, 500)).toBe("上传失败，请重试");
    expect(rejected(WORK_JOB_KINDS.arxiv, 409, busy)).toBe("arXiv 正文文档正在处理或删除，请稍后重试");
    // attach-arxiv's other 409s (Scenario C, Work changed) are not busy
    expect(rejected(WORK_JOB_KINDS.arxiv, 409, "work 'arxiv:1' already has a non-arXiv doc; delete it first if you want the arXiv version")).toBe("获取 arXiv 正文失败，请重试");
    expect(rejected(WORK_JOB_KINDS.arxiv, 409, "could not queue the arXiv fetch (work state changed)")).toBe("获取 arXiv 正文失败，请重试");
    expect(rejected(WORK_JOB_KINDS.arxiv, 0)).toBe("获取 arXiv 正文失败，请重试");
    expect(rejected(WORK_JOB_KINDS.arxivPdf, 409, busy)).toBe("arXiv PDF 文档正在处理或删除，请稍后重试。");
    expect(rejected(WORK_JOB_KINDS.arxivPdf, 409, "could not queue arXiv PDF acquisition")).toBe("未能提交 arXiv PDF 获取任务，请重试。");
    expect(rejected(WORK_JOB_KINDS.arxivPdf, 500)).toBe("未能提交 arXiv PDF 获取任务，请重试。");
    // PDF upload keeps its existing (pre-ticket) 409 rule
    expect(rejected(WORK_JOB_KINDS.pdf, 409)).toBe("该 PDF 正在处理或删除，请稍后重试。");
    expect(rejected(WORK_JOB_KINDS.pdf, 400)).toBe("server detail");
  });

  it("dismiss: none for zip/arXiv source, a flag for PDF upload that a new failure resets", () => {
    const failed = { type: "event", job: zipJob({ status: "failed", error: "x" }) } as const;
    expect(step(WORK_JOB_KINDS.zip, initialWorkJobState(), failed, { type: "dismiss" }).dismissed).toBe(false);
    expect(step(WORK_JOB_KINDS.arxiv, initialWorkJobState(), { type: "event", job: arxivJob({ status: "failed" }) }, { type: "dismiss" }).dismissed).toBe(false);
    let s = step(WORK_JOB_KINDS.pdf, initialWorkJobState(), { type: "event", job: pdfJob({ status: "failed", error: "x" }) }, { type: "dismiss" });
    expect(s.dismissed).toBe(true);
    s = step(WORK_JOB_KINDS.pdf, s, { type: "event", job: pdfJob({ id: "j2" }) }, { type: "event", job: pdfJob({ id: "j2", status: "failed", error: "y" }) }, { type: "settle" });
    expect(s).toMatchObject({ dismissed: false, error: { message: "y" } });
  });
});

describe("useWorkJobs", () => {
  function renderJobs(workId = A) {
    const onReload = vi.fn();
    const view = renderHook(({ id }) => useWorkJobs(id, { onReload }), { initialProps: { id: workId } });
    return { ...view, onReload };
  }

  it("holds exactly one job subscription, also across Work switches", () => {
    const view = renderJobs();
    expect(h.listeners.size).toBe(1);
    view.rerender({ id: B });
    expect(h.listeners.size).toBe(1);
    view.unmount();
    expect(h.listeners.size).toBe(0);
  });

  it("routes this Work's frames to their kinds and ignores other Works", () => {
    const view = renderJobs();
    emit(zipJob({ id: "z", status: "running" }), "hello");
    emit(pdfJob({ id: "p", status: "running" }), "hello");
    emit(arxivJob({ id: "a", status: "queued" }), "hello");
    emit(arxivPdfJob({ id: "ap", status: "running" }), "hello");
    emit(zipJob({ id: "elsewhere", status: "failed", error: "not ours", workId: B }), "hello");
    const k = view.result.current.kinds;
    expect([k("zip").job?.id, k("pdf").job?.id, k("arxiv").job?.id, k("arxivPdf").job?.id]).toEqual(["z", "p", "a", "ap"]);
    expect(k("zip").error).toBeNull();
  });

  it("drops a regressing snapshot so a terminal job never comes back", () => {
    const view = renderJobs();
    emit(zipJob({ status: "failed", error: "terminal" }), "job.failed");
    emit(zipJob({ status: "queued" }), "job.created");
    emit(zipJob({ status: "running" }), "job.progress");
    expect(view.result.current.kinds("zip").job).toBeNull();
    expect(view.result.current.kinds("zip").error?.message).toBe("上传失败：terminal");
  });

  it("shares seen snapshots with the submit path: a late 202 does not rewind, a fast failure is not resurrected", async () => {
    let resolve: (r: StartResult) => void = () => {};
    h.uploadLatexZip.mockImplementation(() => new Promise((done) => (resolve = done)));
    const view = renderJobs();
    let accepted: Promise<boolean> = Promise.resolve(false);
    act(() => {
      accepted = view.result.current.kinds("zip").start(new File(["x"], "s.zip"));
    });
    expect(h.uploadLatexZip).toHaveBeenCalledWith(A, expect.any(File));
    emit(zipJob({ status: "failed", error: "fast" }), "job.failed");
    await act(async () => resolve({ ok: true, job: zipJob() }));
    expect(await accepted).toBe(true);
    expect(view.result.current.kinds("zip").job).toBeNull();
    expect(view.result.current.kinds("zip").error?.message).toBe("上传失败：fast");
  });

  it("a PDF fast failure is not an accepted submission", async () => {
    h.uploadPdf.mockResolvedValue({ ok: true, job: pdfJob() });
    const view = renderJobs();
    emit(pdfJob({ status: "failed", error: "unreadable" }), "job.failed");
    let accepted = true;
    await act(async () => {
      accepted = await view.result.current.kinds("pdf").start(new File(["x"], "a.pdf"));
    });
    expect(accepted).toBe(false);
    expect(view.result.current.kinds("pdf")).toMatchObject({ submitting: false, error: { message: "unreadable" } });
  });

  it("409 from a start shows busy and is not accepted", async () => {
    h.uploadLatexZip.mockResolvedValue({ ok: false, status: 409, detail: "document busy" });
    h.attachArxiv.mockResolvedValue({ ok: false, status: 409, detail: "document busy" });
    // Today `POST /api/library/acquire-arxiv-pdf` answers every non-queued start with 409 "could not queue…", never
    // "document busy", so `library.detail.arxivPdf.busy` is unreachable for now; this pins the web side for when the
    // server gains a busy branch.
    h.acquireArxivPdf.mockResolvedValue({ ok: false, status: 409, detail: "document busy" });
    const view = renderJobs();
    const results: boolean[] = [];
    await act(async () => {
      results.push(await view.result.current.kinds("zip").start(new File(["x"], "s.zip")));
      results.push(await view.result.current.kinds("arxiv").start());
      results.push(await view.result.current.kinds("arxivPdf").start());
    });
    expect(results).toEqual([false, false, false]);
    const k = view.result.current.kinds;
    expect(k("zip").error?.message).toBe("该文档正在处理或删除，请稍后重试");
    expect(k("arxiv").error?.message).toBe("arXiv 正文文档正在处理或删除，请稍后重试");
    expect(k("arxiv").error?.extra).toBeUndefined();
    expect(k("arxivPdf").error?.message).toBe("arXiv PDF 文档正在处理或删除，请稍后重试。");
  });

  it("keeps one PDF submission per Work across A → B → A, cleared by a terminal frame for any Work", async () => {
    h.uploadPdf.mockReturnValue(new Promise(() => {}));
    const view = renderJobs(A);
    act(() => {
      void view.result.current.kinds("pdf").start(new File(["x"], "a.pdf"));
    });
    expect(view.result.current.kinds("pdf").submitting).toBe(true);
    let second = true;
    await act(async () => {
      second = await view.result.current.kinds("pdf").start(new File(["x"], "a.pdf"));
    });
    expect(second).toBe(false);
    expect(h.uploadPdf).toHaveBeenCalledTimes(1);

    view.rerender({ id: B });
    expect(view.result.current.kinds("pdf").submitting).toBe(false);
    view.rerender({ id: A });
    expect(view.result.current.kinds("pdf").submitting).toBe(true);

    view.rerender({ id: B });
    // A's PDF job finishes while B is shown: A's submission guard is released
    emit(pdfJob({ id: "pa", status: "failed", error: "A failed", workId: A }), "job.failed");
    expect(view.result.current.kinds("pdf").error).toBeNull();
    view.rerender({ id: A });
    expect(view.result.current.kinds("pdf").submitting).toBe(false);
  });

  it("drops a late POST answer after A → B → A and resets every kind on a Work switch", async () => {
    let resolve: (r: StartResult) => void = () => {};
    h.attachArxiv.mockImplementation(() => new Promise((done) => (resolve = done)));
    const view = renderJobs(A);
    emit(zipJob({ status: "failed", error: "A failed" }), "hello");
    emit(arxivPdfJob({ id: "p", status: "running" }), "hello");
    let accepted: Promise<boolean> = Promise.resolve(true);
    act(() => {
      accepted = view.result.current.kinds("arxiv").start();
    });
    view.rerender({ id: B });
    const k = view.result.current.kinds;
    expect([k("zip").error, k("arxivPdf").job, k("arxiv").job]).toEqual([null, null, null]);
    view.rerender({ id: A });
    await act(async () => resolve({ ok: true, job: arxivJob() }));
    expect(await accepted).toBe(false);
    expect(view.result.current.kinds("arxiv").job).toBeNull();
    // the one-shot adoption is per Work: A may adopt a replayed failure again
    emit(zipJob({ id: "z2", status: "failed", error: "again" }), "hello");
    expect(view.result.current.kinds("zip").error?.message).toBe("上传失败：again");
  });

  it("a hello batch listing the tracked job's failure before an older failure shows the tracked one", () => {
    const view = renderJobs();
    emit(zipJob({ id: "new", status: "running" }), "hello");
    act(() => {
      for (const cb of [...h.listeners]) {
        cb(zipJob({ id: "new", status: "failed", error: "tracked" }), "hello");
        cb(zipJob({ id: "older", status: "failed", error: "older" }), "hello");
      }
    });
    expect(view.result.current.kinds("zip").error?.message).toBe("上传失败：tracked");
    expect(view.result.current.kinds("zip").job).toBeNull();
  });

  it("reloads when the 202 answer arrives after the job's done frame", async () => {
    h.acquireArxivPdf.mockResolvedValue({ ok: true, job: arxivPdfJob({ id: "p" }) });
    const view = renderJobs();
    emit(arxivPdfJob({ id: "p", status: "done" }), "job.done");
    let accepted = false;
    await act(async () => {
      accepted = await view.result.current.kinds("arxivPdf").start();
    });
    expect(accepted).toBe(true);
    expect(view.onReload).toHaveBeenCalledTimes(1);
    expect(view.result.current.kinds("arxivPdf").job).toBeNull();
  });

  it("calls onReload once per finished job", () => {
    const view = renderJobs();
    emit(zipJob({ status: "running" }), "hello");
    emit(arxivPdfJob({ id: "p", status: "running" }), "hello");
    expect(view.onReload).not.toHaveBeenCalled();
    act(() => {
      for (const cb of [...h.listeners]) {
        cb(zipJob({ status: "done" }), "job.done");
        cb(arxivPdfJob({ id: "p", status: "done" }), "job.done");
      }
    });
    expect(view.onReload).toHaveBeenCalledTimes(2);
  });

  it("exposes the Work session generation used to drop stale responses", () => {
    const view = renderJobs(A);
    const first = view.result.current.session.current();
    expect(view.result.current.session.isCurrent(first)).toBe(true);
    view.rerender({ id: B });
    view.rerender({ id: A });
    expect(view.result.current.session.isCurrent(first)).toBe(false);
    expect(view.result.current.session.current().workId).toBe(A);
  });
});

describe("start API functions answer StartResult", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("202 → ok with the job; 409 and other statuses → status + detail; network error → status 0", async () => {
    const api = await vi.importActual<typeof import("../src/api/library")>("../src/api/library");
    const queued = zipJob();
    const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const start of [() => api.uploadLatexZip(A, new Blob(["x"])), () => api.attachArxiv(A), () => api.acquireArxivPdf(A)]) {
      fetchMock.mockResolvedValueOnce(respond(202, { job: queued }));
      expect(await start()).toEqual({ ok: true, job: queued });
      fetchMock.mockResolvedValueOnce(respond(409, { detail: "document busy" }));
      expect(await start()).toEqual({ ok: false, status: 409, detail: "document busy" });
      fetchMock.mockResolvedValueOnce(respond(500, "not json at all"));
      expect(await start()).toMatchObject({ ok: false, status: 500 });
      fetchMock.mockResolvedValueOnce(respond(202, {}));
      expect(await start()).toMatchObject({ ok: false, status: 500 });
      fetchMock.mockRejectedValueOnce(new TypeError("offline"));
      expect(await start()).toEqual({ ok: false, status: 0, detail: "offline" });
    }
  });
});

describe("reduceAcquisitionRisk", () => {
  const flow = (over: Partial<AcquisitionFlow> = {}): AcquisitionFlow => ({
    id: 1,
    riskVersion: 0,
    method: "arxiv",
    targetDocId: "arxiv-1",
    risk: { state: "known", count: 2 },
    file: null,
    fileError: null,
    pdfWarningAccepted: false,
    busy: false,
    error: null,
    ...over,
  });

  it("a vanished target is missing; a changed arXiv target restarts as new or unavailable", () => {
    expect(reduceAcquisitionRisk(null, { type: "payload", versions: [], arxivTarget: null })).toBeNull();
    expect(reduceAcquisitionRisk(flow(), { type: "payload", versions: ["other"], arxivTarget: "arxiv-1" })).toMatchObject({ riskVersion: 1, risk: { state: "missing" } });
    expect(reduceAcquisitionRisk(flow({ targetDocId: null, risk: { state: "new" } }), { type: "payload", versions: ["arxiv-1"], arxivTarget: "arxiv-1" })).toMatchObject({ targetDocId: "arxiv-1", risk: { state: "unavailable" } });
    expect(reduceAcquisitionRisk(flow({ targetDocId: null, risk: { state: "new" } }), { type: "payload", versions: [], arxivTarget: "arxiv-1" })).toMatchObject({ riskVersion: 0, risk: { state: "new" } });
    expect(reduceAcquisitionRisk(flow({ method: "upload", targetDocId: null, risk: { state: "new" } }), { type: "payload", versions: ["d"], arxivTarget: null })).toMatchObject({ risk: { state: "unavailable" } });
    const same = flow();
    expect(reduceAcquisitionRisk(same, { type: "payload", versions: ["arxiv-1"], arxivTarget: "arxiv-1" })).toBe(same);
  });

  it("a fresh payload for the same target re-checks the risk", () => {
    expect(reduceAcquisitionRisk(flow(), { type: "refresh", versions: ["arxiv-1"] })).toMatchObject({ riskVersion: 1, risk: { state: "loading" } });
    const unrelated = flow({ targetDocId: null });
    expect(reduceAcquisitionRisk(unrelated, { type: "refresh", versions: ["arxiv-1"] })).toBe(unrelated);
  });

  it("resolves the upload target for the same flow only", () => {
    const resolving = flow({ method: "upload", targetDocId: null, risk: { state: "resolving" } });
    expect(reduceAcquisitionRisk(resolving, { type: "target-resolved", flowId: 1, expectedDocId: "up-1", versions: ["up-1"] })).toMatchObject({ targetDocId: "up-1", riskVersion: 1, risk: { state: "loading" } });
    expect(reduceAcquisitionRisk(resolving, { type: "target-resolved", flowId: 1, expectedDocId: "up-1", versions: ["x"] })).toMatchObject({ targetDocId: null, risk: { state: "new" } });
    expect(reduceAcquisitionRisk(resolving, { type: "target-resolved", flowId: 2, expectedDocId: "up-1", versions: ["up-1"] })).toBe(resolving);
    expect(reduceAcquisitionRisk(resolving, { type: "target-failed", flowId: 1 })).toMatchObject({ risk: { state: "unavailable" } });
  });

  it("maps the annotation read to known / busy / missing / unknown for the flow that asked", () => {
    const loading = flow({ risk: { state: "loading" } });
    const asked = { id: 1, method: "arxiv" as const, targetDocId: "arxiv-1" };
    const file = { version: 1, rev: 0, content_fingerprint: "f", annotations: [{}, {}, {}] };
    expect(reduceAcquisitionRisk(loading, { type: "annotations", flow: asked, result: { ok: true, file } as never })?.risk).toEqual({ state: "known", count: 3 });
    expect(reduceAcquisitionRisk(loading, { type: "annotations", flow: asked, result: { ok: false, missing: false, status: 409 } })?.risk).toEqual({ state: "busy", source: "annotations" });
    expect(reduceAcquisitionRisk(loading, { type: "annotations", flow: asked, result: { ok: false, missing: true, status: 404 } })?.risk).toEqual({ state: "missing" });
    expect(reduceAcquisitionRisk(loading, { type: "annotations", flow: asked, result: { ok: false, missing: false, status: 500 } })?.risk).toEqual({ state: "unknown" });
    expect(reduceAcquisitionRisk(loading, { type: "annotations", flow: { ...asked, id: 9 }, result: { ok: false, missing: true, status: 404 } })).toBe(loading);
  });

  it("an active job of the flow's own method blocks; its end re-checks", () => {
    const upload = flow({ method: "upload", targetDocId: "up-1" });
    const blocked = reduceAcquisitionRisk(upload, { type: "jobs", uploadActive: true, arxivActive: false });
    expect(blocked).toMatchObject({ riskVersion: 1, risk: { state: "busy", source: "job" } });
    expect(reduceAcquisitionRisk(upload, { type: "jobs", uploadActive: false, arxivActive: true })).toBe(upload);
    expect(reduceAcquisitionRisk(blocked, { type: "jobs", uploadActive: false, arxivActive: false })).toMatchObject({ riskVersion: 2, risk: { state: "loading" } });
    const noTarget = flow({ targetDocId: null });
    expect(reduceAcquisitionRisk(noTarget, { type: "jobs", uploadActive: true, arxivActive: true })).toBe(noTarget);
  });
});

describe("loadDeleteCount", () => {
  const annotations = (n: number) => ({ ok: true, file: { annotations: Array.from({ length: n }, () => ({})) } });

  it("counts PDF, text and other Docs through their own reads", async () => {
    h.fetchPdfAnnotationCount.mockResolvedValue({ ok: true, count: 4 });
    expect(await loadDeleteCount("pdf-1", "pdf")).toEqual({ state: "known", value: 4 });
    expect(h.fetchAnnotations).not.toHaveBeenCalled();

    h.fetchTextDeleteImpact.mockResolvedValue({ ok: true, generated: true });
    h.fetchAnnotations.mockResolvedValue(annotations(2));
    expect(await loadDeleteCount("text-1", "text")).toEqual({ state: "known", value: 2 });
    h.fetchTextDeleteImpact.mockResolvedValue({ ok: true, generated: false, annotations: { state: "known", count: 0 } });
    expect(await loadDeleteCount("text-2", "text")).toEqual({ state: "known", value: 0 });

    h.fetchAnnotations.mockResolvedValue(annotations(1));
    expect(await loadDeleteCount("upload-1", "other")).toEqual({ state: "known", value: 1 });
  });

  it("an unreadable count is unknown, never 0", async () => {
    h.fetchPdfAnnotationCount.mockResolvedValue({ ok: false, status: 500, detail: "corrupt" });
    expect(await loadDeleteCount("pdf-1", "pdf")).toEqual({ state: "unknown" });
    h.fetchTextDeleteImpact.mockResolvedValue({ ok: true, generated: false, annotations: { state: "unknown" } });
    expect(await loadDeleteCount("text-1", "text")).toEqual({ state: "unknown" });
    h.fetchTextDeleteImpact.mockResolvedValue({ ok: false });
    expect(await loadDeleteCount("text-1", "text")).toEqual({ state: "unknown" });
    h.fetchTextDeleteImpact.mockResolvedValue({ ok: true, generated: true });
    h.fetchAnnotations.mockResolvedValue({ ok: false, missing: false, status: 500 });
    expect(await loadDeleteCount("text-1", "text")).toEqual({ state: "unknown" });
    expect(await loadDeleteCount("upload-1", "other")).toEqual({ state: "unknown" });
  });
});
