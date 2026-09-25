import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PdfAnnotationsFile } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfAnnotationSession } from "../src/doc/PdfAnnotationSession";
import { PdfAnnotationsPanel } from "../src/doc/PdfAnnotationsPanel";
import i18n from "../src/i18n";

const ws = vi.hoisted(() => ({ listeners: new Set<(docId: string) => void>() }));
vi.mock("../src/api/ws", () => ({ onAnnotationChanged: (callback: (docId: string) => void) => {
  ws.listeners.add(callback);
  return () => ws.listeners.delete(callback);
} }));

const docId = "pdf-session-test";
const sha = "a".repeat(64);
const initial: PdfAnnotationsFile = { version: 1, doc_id: docId, content_sha256: sha, rev: 0, annotations: [] };
const metadata = { version: 1, doc_id: docId, format: "pdf", display_name: "test.pdf", original_filename: "test.pdf", acquired_via: "user_pdf_upload", acquired_at: "2026-09-23T00:00:00.000Z", byte_length: 42, sha256: sha, page_count: 2, pages: [{ width: 612, height: 792, rotation: 0 }, { width: 612, height: 792, rotation: 0 }] };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
type Request = { url: string; init?: RequestInit; resolve: (response: Response) => void; reject: (reason: Error) => void };
let requests: Request[];
let session: PdfAnnotationSession;
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  ws.listeners.clear();
  requests = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => requests.push({ url: String(url), init, resolve, reject }))));
  session = new PdfAnnotationSession(docId, sha, initial);
  session.start();
});
afterEach(() => { cleanup(); session.stop(); vi.unstubAllGlobals(); });

const getRequest = async (method: string, index = 0) => {
  await waitFor(() => expect(requests.filter((request) => (request.init?.method ?? "GET") === method).length).toBeGreaterThan(index));
  return requests.filter((request) => (request.init?.method ?? "GET") === method)[index]!;
};

const renderPanel = (page: number) => {
  function ReaderSeam() {
    const [request, setRequest] = useState<{ kind: "page_comment" | "document_comment"; pageIndex?: number; key: number } | null>(null);
    const [, setKey] = useState(0);
    return <>
      <button onClick={() => setKey((value) => { const next = value + 1; setRequest({ kind: "page_comment", pageIndex: page, key: next }); return next; })}>评论第 {page + 1} 页</button>
      <button onClick={() => setKey((value) => { const next = value + 1; setRequest({ kind: "document_comment", key: next }); return next; })}>评论整篇文档</button>
      <button hidden onClick={() => setKey((value) => value + 1)}>request key</button>
      <PdfAnnotationsPanel session={session} currentPage={page} commentRequest={request} onNavigatePage={() => {}} />
    </>;
  }
  return render(<ReaderSeam />);
};

describe("PDF annotation workbench", () => {
  it("uses icon-only history and item actions with an icon/page heading and adjacent color dot", () => {
    session.stop();
    const at = "2026-09-24T12:00:00.000Z";
    session = new PdfAnnotationSession(docId, sha, { ...initial, annotations: [{
      id: "highlight-1", kind: "highlight", target: { quote: "text", fragments: [{ page_index: 0, rectangles: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }] }] },
      body: "Note", created_at: at, updated_at: at,
    }] });
    session.start();
    const onNavigatePage = vi.fn();
    const { container } = render(<PdfAnnotationsPanel session={session} currentPage={0} onNavigatePage={onNavigatePage} />);
    for (const id of ["undo-pdf-annotation", "redo-pdf-annotation", "edit-pdf-annotation-body", "delete-pdf-annotation"]) {
      const button = container.querySelector<HTMLButtonElement>(`[data-ui="${id}"]`)!;
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg")).toBeTruthy();
      expect(button.getAttribute("aria-label")).toBeTruthy();
    }
    const item = container.querySelector('[data-ui="pdf-annotation"]')!;
    const head = item.querySelector('.pdf-workbench-item-head')!;
    expect(head.querySelector('[data-ui="navigate-pdf-annotation"] svg')).toBeTruthy();
    expect(head.textContent).toContain("第 1 页");
    expect(head.querySelector('[data-ui="pdf-highlight-color-picker"]')).toBeTruthy();
    fireEvent.click(head.querySelector('[data-ui="navigate-pdf-annotation"]')!);
    expect(onNavigatePage).toHaveBeenCalledWith(0);
    expect(container.querySelector('[data-ui="pdf-highlight-color-current"]')).toBeTruthy();
  });

  it("removes the retired right-panel text-creation entry", () => {
    renderPanel(0);
    expect(screen.queryByRole("button", { name: "选择文字" })).toBeNull();
    expect(screen.queryByRole("button", { name: "高亮" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下划线" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除线" })).toBeNull();
  });

  it("keeps area and three text mark tools mutually exclusive and lets the selected tool toggle off", async () => {
    const { PdfAnnotationToolButtons } = await import("../src/doc/PdfAnnotationsPanel");
    function ModeControls() {
      const [mode, setMode] = useState<"read" | "area" | "highlight" | "underline" | "strikeout">("read");
      return <PdfAnnotationToolButtons mode={mode} blocked={false} onMode={setMode} />;
    }
    render(<ModeControls />);
    const area = screen.getByRole("button", { name: "框选区域" });
    const highlight = screen.getByRole("button", { name: "高亮" });
    const underline = screen.getByRole("button", { name: "下划线" });
    const strikeout = screen.getByRole("button", { name: "删除线" });
    fireEvent.click(highlight);
    expect(highlight.getAttribute("aria-pressed")).toBe("true");
    expect(area.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(underline);
    expect(highlight.getAttribute("aria-pressed")).toBe("false");
    expect(underline.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(strikeout);
    expect(underline.getAttribute("aria-pressed")).toBe("false");
    expect(strikeout.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(area);
    expect(strikeout.getAttribute("aria-pressed")).toBe("false");
    expect(area.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(area);
    expect(area.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a new comment as an empty unsaved draft until explicit save and renders saved bodies", async () => {
    renderPanel(0);
    fireEvent.click(screen.getByRole("button", { name: "评论第 1 页" }));
    expect(session.getSnapshot().file.annotations).toHaveLength(0);
    expect(requests.filter((request) => request.init?.method === "PUT")).toHaveLength(0);
    const body = screen.getByRole("textbox");
    expect((body as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(body, { target: { value: "  $x^2$  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存评论" }));
    const put = await getRequest("PUT");
    expect(JSON.parse(String(put.init?.body)).annotations[0].body).toBe("  $x^2$  ");
    const saved = { ...JSON.parse(String(put.init?.body)), rev: 1 };
    await act(async () => { put.resolve(json(saved)); });
    await waitFor(() => expect(document.querySelector(".pdf-workbench-body .katex")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "编辑评论" }));
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("locks a page-comment target when invoked even if the reader navigates before saving", async () => {
    function PageCapture() {
      const [page, setPage] = useState(0);
      const [request, setRequest] = useState<{ kind: "page_comment"; pageIndex: number; key: number } | null>(null);
      return <>
        <button onClick={() => setRequest({ kind: "page_comment", pageIndex: page, key: page + 1 })}>Comment this page</button>
        <button onClick={() => setPage(1)}>Next page</button>
        <PdfAnnotationsPanel session={session} currentPage={page} commentRequest={request} onNavigatePage={() => {}} />
      </>;
    }
    render(<PageCapture />);
    fireEvent.click(screen.getByRole("button", { name: "Comment this page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "page-bound note" } });
    fireEvent.click(screen.getByRole("button", { name: "保存评论" }));
    const put = await getRequest("PUT");
    expect(JSON.parse(String(put.init?.body)).annotations[0].page_index).toBe(0);
    await act(async () => { put.resolve(json({ ...JSON.parse(String(put.init?.body)), rev: 1 })); });
  });

  it("cancels a blank comment draft without writing the sidecar", async () => {
    renderPanel(0);
    fireEvent.click(screen.getByRole("button", { name: "评论整篇文档" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(session.getSnapshot().file.annotations).toHaveLength(0);
    expect(requests.filter((request) => request.init?.method === "PUT")).toHaveLength(0);
  });

  it("retains comment text and the current sidecar when its save fails", async () => {
    renderPanel(0);
    fireEvent.click(screen.getByRole("button", { name: "评论整篇文档" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "preserve this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "保存评论" }));
    const before = session.getSnapshot().file;
    const put = await getRequest("PUT");
    await act(async () => { put.resolve(json({ detail: "write denied" }, 500)); });
    expect(session.getSnapshot().file).toEqual(before);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("preserve this draft");
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
    expect(session.getSnapshot().failure?.kind).toBe("error");
  });

  it("persists, deletes, undoes, and redoes a cross-page text target as one logical annotation", async () => {
    const target = { quote: "continued across pages", fragments: [
      { page_index: 0, rectangles: [{ x: 0.1, y: 0.8, width: 0.6, height: 0.02 }] },
      { page_index: 1, rectangles: [{ x: 0.05, y: 0.01, width: 0.5, height: 0.02 }] },
    ] };
    const at = "2026-09-24T12:00:00.000Z";
    const item = { id: "stable-cross-page", kind: "highlight" as const, target, body: "Research note", created_at: at, updated_at: at };
    act(() => { session.create(item); });
    const createPut = await getRequest("PUT");
    const created = JSON.parse(String(createPut.init?.body)) as PdfAnnotationsFile;
    expect(created.annotations).toEqual([item]);
    expect(created.annotations).toHaveLength(1);
    expect(created.annotations[0]?.id).toBe("stable-cross-page");
    await act(async () => { createPut.resolve(json({ ...created, rev: 1 })); });
    expect(session.getSnapshot().file.annotations).toEqual([item]);
    act(() => { session.undo(); });
    const undoPut = await getRequest("PUT", 1);
    expect(JSON.parse(String(undoPut.init?.body)).annotations).toEqual([]);
    await act(async () => { undoPut.resolve(json({ ...JSON.parse(String(undoPut.init?.body)), rev: 2 })); });
    act(() => { session.redo(); });
    const redoPut = await getRequest("PUT", 2);
    const redone = JSON.parse(String(redoPut.init?.body)) as PdfAnnotationsFile;
    expect(redone.annotations).toEqual([item]);
    await act(async () => { redoPut.resolve(json({ ...redone, rev: 3 })); });
    expect(session.getSnapshot().file).toMatchObject({ rev: 3, annotations: [item] });
  });

  it("changes a saved highlight color once, leaves the legacy yellow a no-op, and keeps failed colors pending", async () => {
    renderPanel(0);
    const at = "2026-09-24T12:00:00.000Z";
    const target = { quote: "a highlight", fragments: [
      { page_index: 0, rectangles: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }] },
      { page_index: 1, rectangles: [{ x: 0.2, y: 0.3, width: 0.3, height: 0.04 }] },
    ] };
    const legacy = { id: "legacy-yellow", kind: "highlight" as const, target, body: "note", created_at: at, updated_at: at };
    act(() => { session.create(legacy); });
    const first = await getRequest("PUT");
    await act(async () => { first.resolve(json({ ...JSON.parse(String(first.init?.body)), rev: 1 })); });
    fireEvent.click(screen.getByRole("button", { name: "高亮颜色" }));
    fireEvent.click(screen.getByRole("button", { name: "黄色" }));
    expect(requests.filter((request) => request.init?.method === "PUT")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "高亮颜色" }));
    fireEvent.click(screen.getByRole("button", { name: "蓝色" }));
    const bluePut = await getRequest("PUT", 1);
    const blueFile = JSON.parse(String(bluePut.init?.body)) as PdfAnnotationsFile;
    expect(blueFile.annotations[0]).toMatchObject({ color: "#387bd1", target });
    await act(async () => { bluePut.resolve(json({ ...blueFile, rev: 2 })); });
    expect(session.getSnapshot().file.annotations[0]).toMatchObject({ color: "#387bd1", target });
    fireEvent.click(screen.getByRole("button", { name: "高亮颜色" }));
    fireEvent.click(screen.getByRole("button", { name: "蓝色" }));
    expect(requests.filter((request) => request.init?.method === "PUT")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "高亮颜色" }));
    fireEvent.click(screen.getByRole("button", { name: "绿色" }));
    const failed = await getRequest("PUT", 2);
    await act(async () => { failed.resolve(json({ detail: "rev mismatch", rev: 2 }, 409)); });
    expect(session.getSnapshot().failure?.kind).toBe("rev-mismatch");
    expect(session.annotation("legacy-yellow")).toMatchObject({ color: "#40a25b", target });
    expect(session.getSnapshot().file.annotations[0]).toMatchObject({ color: "#387bd1" });
  });

  it("commits a highlight color as one reversible cross-page annotation change", async () => {
    const at = "2026-09-24T12:00:00.000Z";
    const highlight = { id: "color-1", kind: "highlight" as const, target: { quote: "across pages", fragments: [
      { page_index: 0, rectangles: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }] },
      { page_index: 1, rectangles: [{ x: 0.2, y: 0.3, width: 0.3, height: 0.04 }] },
    ] }, body: "Research note", created_at: at, updated_at: at };
    act(() => { session.create(highlight); });
    const createPut = await getRequest("PUT");
    await act(async () => { createPut.resolve(json({ ...JSON.parse(String(createPut.init?.body)), rev: 1 })); });
    act(() => { session.mutate([{ ...session.getSnapshot().file.annotations[0]!, color: "#387bd1" }]); });
    const colorPut = await getRequest("PUT", 1);
    expect(JSON.parse(String(colorPut.init?.body)).annotations[0]).toMatchObject({ id: "color-1", color: "#387bd1", target: highlight.target });
    await act(async () => { colorPut.resolve(json({ ...JSON.parse(String(colorPut.init?.body)), rev: 2 })); });
    act(() => { session.undo(); });
    const undoPut = await getRequest("PUT", 2);
    expect(JSON.parse(String(undoPut.init?.body)).annotations[0]).not.toHaveProperty("color");
    await act(async () => { undoPut.resolve(json({ ...JSON.parse(String(undoPut.init?.body)), rev: 3 })); });
    act(() => { session.redo(); });
    const redoPut = await getRequest("PUT", 3);
    expect(JSON.parse(String(redoPut.init?.body)).annotations[0]).toMatchObject({ color: "#387bd1", target: highlight.target });
  });

  it("does not treat its own in-flight PUT as a foreign annotation revision when an earlier WS read arrives late", async () => {
    renderPanel(1);
    act(() => { for (const listener of ws.listeners) listener(docId); });
    const read = await getRequest("GET");
    fireEvent.click(screen.getByRole("button", { name: "评论第 2 页" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "local page note" } });
    fireEvent.click(screen.getByRole("button", { name: "保存评论" }));
    const put = await getRequest("PUT");
    const saved = { ...JSON.parse(String(put.init?.body)), rev: 1 };
    // Server committed this same local request before its response reached the browser.
    await act(async () => { read.resolve(json({ metadata, annotations: saved, reading_position: { status: "ready", file: { version: 1, doc_id: docId, content_sha256: sha, rev: 0, position: null } } })); });
    expect(screen.queryByText("PDF annotations changed elsewhere")).toBeNull();
    expect(session.getSnapshot().failure).toBeNull();
    await act(async () => { put.resolve(json(saved)); });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("标注已保存"));
    expect(session.getSnapshot().file.rev).toBe(1);
    expect(session.getSnapshot().file.annotations).toHaveLength(1);
  });

  it("keeps a failed operation and later edits pending until the user explicitly retries", async () => {
    renderPanel(1);
    fireEvent.click(screen.getByRole("button", { name: "评论整篇文档" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "document note" } });
    fireEvent.click(screen.getByRole("button", { name: "保存评论" }));
    const first = await getRequest("PUT");
    await act(async () => { first.resolve(json({ detail: "document busy" }, 409)); });
    expect(session.getSnapshot().failure?.kind).toBe("busy");
    fireEvent.click(screen.getByRole("button", { name: "评论第 2 页" }));
    fireEvent.change(document.querySelector('[data-ui="pdf-new-comment-body"]')!, { target: { value: "page note" } });
    fireEvent.click(document.querySelector('[data-ui="save-new-pdf-comment"]')!);
    expect(requests.filter((request) => request.init?.method === "PUT")).toHaveLength(1);
    expect(session.getSnapshot().pending).toBe(2);
    expect(session.getSnapshot().failure?.kind).toBe("busy");
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    const retry = await getRequest("PUT", 1);
    const savedFirst = { ...JSON.parse(String(retry.init?.body)), rev: 1 };
    await act(async () => { retry.resolve(json(savedFirst)); });
    const second = await getRequest("PUT", 2);
    expect(JSON.parse(String(second.init?.body)).rev).toBe(1);
    const savedSecond = { ...JSON.parse(String(second.init?.body)), rev: 2 };
    await act(async () => { second.resolve(json(savedSecond)); });
    expect(session.getSnapshot()).toMatchObject({ pending: 0, failure: null });
    expect(session.getSnapshot().file.annotations).toHaveLength(2);
  });

  it("does not overwrite another tab's edit of the same comment on deliberate revision retry", async () => {
    session.stop();
    const item = { id: "note-1", kind: "page_comment" as const, page_index: 0, body: "original", created_at: "2026-09-23T00:00:00.000Z", updated_at: "2026-09-23T00:00:00.000Z" };
    session = new PdfAnnotationSession(docId, sha, { ...initial, annotations: [item] });
    session.start();
    renderPanel(0);
    fireEvent.click(screen.getByRole("button", { name: "编辑评论" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "local $x$" } });
    fireEvent.click(screen.getByRole("button", { name: "保存评论" }));
    const put = await getRequest("PUT");
    await act(async () => { put.resolve(json({ detail: "rev mismatch", rev: 1 }, 409)); });
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    const read = await getRequest("GET");
    const remote = { ...initial, rev: 1, annotations: [{ ...item, body: "remote newer body", updated_at: "2026-09-23T00:01:00.000Z" }] };
    await act(async () => { read.resolve(json({ metadata, annotations: remote, reading_position: { status: "ready", file: { version: 1, doc_id: docId, content_sha256: sha, rev: 0, position: null } } })); });
    expect(requests.filter((request) => request.init?.method === "PUT")).toHaveLength(1);
    expect(session.getSnapshot().failure?.kind).toBe("rev-mismatch");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("local $x$");
  });

  it("reports a failed conflict re-read as a system error without inventing a new document revision", async () => {
    renderPanel(0);
    fireEvent.click(screen.getByRole("button", { name: "评论整篇文档" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "local draft" } });
    fireEvent.click(screen.getByRole("button", { name: "保存评论" }));
    const put = await getRequest("PUT");
    await act(async () => { put.resolve(json({ detail: "rev mismatch", rev: 1 }, 409)); });
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    const read = await getRequest("GET");
    await act(async () => { read.reject(new Error("snapshot unavailable")); });
    expect(session.getSnapshot().failure).toMatchObject({ kind: "error", detail: "snapshot unavailable" });
    expect(session.getSnapshot().pending).toBe(1);
    expect(requests.filter((request) => request.init?.method === "PUT")).toHaveLength(1);
  });

  it("ignores the failed completion of a previous Doc session after a new session starts", async () => {
    renderPanel(0);
    act(() => { for (const listener of ws.listeners) listener(docId); });
    const oldRead = await getRequest("GET");
    act(() => { session.stop(); session.start(); });
    await act(async () => { oldRead.reject(new Error("late connection failure")); });
    expect(session.getSnapshot().failure).toBeNull();
    expect(screen.queryByText("late connection failure")).toBeNull();
  });
});
