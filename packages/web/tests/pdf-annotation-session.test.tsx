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

const renderPanel = (page: number) => render(<PdfAnnotationsPanel session={session} currentPage={page} onNavigatePage={() => {}} onAddRectangle={() => {}} onSelectText={() => {}} selectionMode="read" />);

describe("PDF annotation workbench", () => {
  it("lets the reader explicitly switch between text selection and area marking", () => {
    function ModeControls() {
      const [mode, setMode] = useState<"read" | "text" | "area">("read");
      return <PdfAnnotationsPanel session={session} currentPage={0} onNavigatePage={() => {}}
        selectionMode={mode} onSelectText={() => setMode((previous) => previous === "text" ? "read" : "text")}
        onAddRectangle={() => setMode((previous) => previous === "area" ? "read" : "area")} />;
    }
    render(<ModeControls />);
    const select = screen.getByRole("button", { name: "选择文字" });
    const area = screen.getByRole("button", { name: "框选区域" });
    expect(select.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(select);
    expect(select.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(area);
    expect(select.getAttribute("aria-pressed")).toBe("false");
    expect(area.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(area);
    expect(area.getAttribute("aria-pressed")).toBe("false");
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

  it("does not treat its own in-flight PUT as a foreign annotation revision when an earlier WS read arrives late", async () => {
    renderPanel(1);
    act(() => { for (const listener of ws.listeners) listener(docId); });
    const read = await getRequest("GET");
    fireEvent.click(screen.getByRole("button", { name: "评论第 2 页" }));
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
    const first = await getRequest("PUT");
    await act(async () => { first.resolve(json({ detail: "document busy" }, 409)); });
    expect(session.getSnapshot().failure?.kind).toBe("busy");
    fireEvent.click(screen.getByRole("button", { name: "评论第 2 页" }));
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
