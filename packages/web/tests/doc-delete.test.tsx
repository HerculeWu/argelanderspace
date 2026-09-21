/**
 * Document delete UI (Stage 8 §8 / MS3): RefDetail's per-version delete
 * button → confirm dialog with the fetched annotation count (degrading to
 * 数量未知 on fetch failure) → DELETE /api/paper/:doc_id → busy-409 message /
 * success wiring (onDocDeleted + onReload). Plus the pure three-state
 * workspace transition (`applyDocDeletion`) the Shell applies locally.
 *
 * The annotations + delete endpoints ride the real `api/annotations` module
 * over a stubbed global fetch; `api/ws` is mocked (RefDetail subscribes to
 * job events for its upload tracking).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefDetail } from "../src/library/RefDetail";
import { applyDocDeletion } from "../src/argelander/workspace";
import type { LibraryRef } from "../src/library/types";

vi.mock("../src/api/ws", () => ({
  onJobEvent: () => () => {},
  onLibraryChanged: () => () => {},
  onAnnotationChanged: () => () => {},
}));

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
  doc_id: "upload-main-1",
  doc_ids: ["upload-main-1", "arxiv-old-2"],
};

let deleteCalls: string[];
let deleteStatus: number; // 200 | 409 | 404 | 500
let annotationsOk: boolean;
let deleteGate: Promise<void> | null;
let annotationResponses: Map<string, Promise<Response>>;

function annFile(n: number) {
  return {
    version: 1,
    rev: 0,
    content_fingerprint: "fp",
    annotations: Array.from({ length: n }, (_, i) => ({
      id: `a_0000000${i}`,
      target: { type: "document" },
      body: `note ${i}`,
      created_at: "2026-09-10T08:00:00.000Z",
      updated_at: "2026-09-10T08:00:00.000Z",
    })),
  };
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const annMatch = /^\/api\/paper\/([^/]+)\/annotations$/.exec(url);
      if (annMatch && method === "GET") {
        const docId = decodeURIComponent(annMatch[1]);
        const controlled = annotationResponses.get(docId);
        if (controlled) return await controlled;
        if (!annotationsOk) {
          return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
        }
        // upload-main-1 carries two annotations; the old version none
        const n = decodeURIComponent(annMatch[1]) === "upload-main-1" ? 2 : 0;
        return { ok: true, status: 200, json: async () => annFile(n) } as Response;
      }
      const delMatch = /^\/api\/paper\/([^/]+)$/.exec(url);
      if (delMatch && method === "DELETE") {
        deleteCalls.push(decodeURIComponent(delMatch[1]));
        if (deleteGate) await deleteGate;
        if (deleteStatus === 200) {
          return { ok: true, status: 200, json: async () => ({ deleted: delMatch[1] }) } as Response;
        }
        const detail = deleteStatus === 409 ? "document busy" : deleteStatus === 404 ? "not found" : "EACCES: remove failed";
        return {
          ok: false,
          status: deleteStatus,
          json: async () => ({ detail }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    })
  );
}

function renderDetail(onDocDeleted?: (docId: string, remaining: string[]) => void) {
  const onReload = vi.fn();
  const utils = render(
    <RefDetail
      r={REF}
      node={null}
      onClose={() => {}}
      onOpenDoc={() => {}}
      onReload={onReload}
      onDocDeleted={onDocDeleted}
    />
  );
  return { ...utils, onReload };
}

function openFilesTab() {
  fireEvent.click(screen.getByRole("tab", { name: "全文" }));
}

/** Open the delete dialog for one of the two versions (0 = main, 1 = old). */
async function openDeleteDialog(which: 0 | 1) {
  const buttons = screen.getAllByRole("button", { name: "删除此文档（含其标注）" });
  const trigger = buttons[which];
  trigger.focus();
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getByRole("dialog", { name: "删除这份文档？" })).toBeTruthy());
  return trigger;
}

beforeEach(() => {
  deleteCalls = [];
  deleteStatus = 200;
  annotationsOk = true;
  deleteGate = null;
  annotationResponses = new Map();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RefDetail document delete", () => {
  it("offers a delete button per version (main + old)", () => {
    renderDetail();
    openFilesTab();
    expect(screen.getAllByRole("button", { name: "删除此文档（含其标注）" })).toHaveLength(2);
  });

  it("the dialog states the fetched annotation count; confirm deletes and wires the transitions", async () => {
    const onDocDeleted = vi.fn();
    const { onReload } = renderDetail(onDocDeleted);
    openFilesTab();
    await openDeleteDialog(0); // the main doc, upload-main-1

    // N fetched from the doc's own annotations file
    await waitFor(() =>
      expect(
        screen.getByText(/包含 2 条当前标注/)
      ).toBeTruthy()
    );

    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(deleteCalls).toEqual(["upload-main-1"]));
    // success: dialog closes, the workspace transition gets the remaining
    // docs of THIS work (their [0] becomes the new main), library reloads
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除这份文档？" })).toBeNull());
    expect(onDocDeleted).toHaveBeenCalledWith("upload-main-1", ["arxiv-old-2"]);
    expect(onReload).toHaveBeenCalled();
  });

  it("deleting the old version leaves the main doc in `remaining`", async () => {
    const onDocDeleted = vi.fn();
    renderDetail(onDocDeleted);
    openFilesTab();
    await openDeleteDialog(1);
    await waitFor(() => expect(screen.getByText(/包含 0 条当前标注/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(deleteCalls).toEqual(["arxiv-old-2"]));
    await waitFor(() =>
      expect(onDocDeleted).toHaveBeenCalledWith("arxiv-old-2", ["upload-main-1"])
    );
  });

  it("a failed count fetch degrades to 数量未知 and never blocks the delete", async () => {
    annotationsOk = false;
    const onDocDeleted = vi.fn();
    renderDetail(onDocDeleted);
    openFilesTab();
    await openDeleteDialog(0);
    await waitFor(() => expect(screen.getByText(/无法获取标注数量/)).toBeTruthy());
    expect(screen.getByText(/当前标注及历史归档都会被删除/)).toBeTruthy();
    expect(screen.getByText(/从所有关联的文献条目中移除/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(deleteCalls).toEqual(["upload-main-1"]));
  });

  it.each([2, 0, null])(
    "blocks DELETE while the count loads, then permits confirmation after count %s is shown",
    async (count) => {
      let resolveCount = (_response: Response) => {};
      annotationResponses.set(
        "upload-main-1",
        new Promise<Response>((resolve) => { resolveCount = resolve; })
      );
      renderDetail();
      openFilesTab();
      await openDeleteDialog(0);
      expect(screen.getByText("正在获取标注数量…")).toBeTruthy();
      const confirm = screen.getByRole("button", { name: "永久删除" }) as HTMLButtonElement;
      fireEvent.click(confirm);
      expect(deleteCalls).toEqual([]);
      expect(confirm.disabled).toBe(true);
      expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(false);

      resolveCount(new Response(JSON.stringify(count === null ? {} : annFile(count)), {
        status: count === null ? 500 : 200,
      }));
      if (count === null) await screen.findByText(/无法获取标注数量/);
      else await screen.findByText(new RegExp(`包含 ${count} 条当前标注`));
      expect(confirm.disabled).toBe(false);
      fireEvent.click(confirm);
      await waitFor(() => expect(deleteCalls).toEqual(["upload-main-1"]));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  );

  it('409 "document busy" → the retry hint shows, nothing is torn down', async () => {
    deleteStatus = 409;
    const onDocDeleted = vi.fn();
    const { onReload } = renderDetail(onDocDeleted);
    openFilesTab();
    await openDeleteDialog(0);
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(deleteCalls).toEqual(["upload-main-1"]));
    await waitFor(() =>
      expect(screen.getByText("文档正在处理，暂时不能删除")).toBeTruthy()
    );
    // the dialog stays open (the ingest task ends on its own; the user retries)
    expect(screen.getByRole("dialog", { name: "删除这份文档？" })).toBeTruthy();
    expect(onDocDeleted).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
  });

  it("blocks duplicate submit and every close path while DELETE is in flight, then returns focus", async () => {
    let releaseDelete = () => {};
    deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const trigger = await (async () => {
      renderDetail(vi.fn());
      openFilesTab();
      return await openDeleteDialog(0);
    })();
    await screen.findByText(/包含 2 条当前标注/);

    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(deleteCalls).toEqual(["upload-main-1"]));
    const deleting = screen.getByRole("button", { name: "正在删除…" }) as HTMLButtonElement;
    expect(deleting.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(deleting);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByTestId("dialog-backdrop"));
    expect(deleteCalls).toEqual(["upload-main-1"]);
    expect(screen.getByRole("dialog")).toBeTruthy();

    releaseDelete();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps a system error in the dialog and allows retry or cancel", async () => {
    deleteStatus = 500;
    renderDetail(vi.fn());
    openFilesTab();
    await openDeleteDialog(0);
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(await screen.findByText("未能删除文档")).toBeTruthy();
    expect(screen.getByText("EACCES: remove failed")).toBeTruthy();
    expect((screen.getByRole("button", { name: "永久删除" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(false);

    deleteStatus = 200;
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(deleteCalls).toEqual(["upload-main-1", "upload-main-1"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not let a late annotation response from a closed dialog replace the current Doc count", async () => {
    let resolveMain = (_response: Response) => {};
    let resolveOld = (_response: Response) => {};
    annotationResponses.set("upload-main-1", new Promise<Response>((resolve) => { resolveMain = resolve; }));
    annotationResponses.set("arxiv-old-2", new Promise<Response>((resolve) => { resolveOld = resolve; }));
    renderDetail();
    openFilesTab();
    await openDeleteDialog(0);
    expect(screen.getByText("正在获取标注数量…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await openDeleteDialog(1);
    resolveOld({ ok: true, status: 200, json: async () => annFile(0) } as Response);
    await screen.findByText(/包含 0 条当前标注/);
    resolveMain({ ok: true, status: 200, json: async () => annFile(2) } as Response);
    await Promise.resolve();
    expect(screen.queryByText(/包含 2 条当前标注/)).toBeNull();
    expect(screen.getByText(/包含 0 条当前标注/)).toBeTruthy();
  });

  it("404 (doc already gone) → the dialog closes and the library reloads, no error shown", async () => {
    deleteStatus = 404;
    const onDocDeleted = vi.fn();
    const { onReload } = renderDetail(onDocDeleted);
    openFilesTab();
    await openDeleteDialog(0);
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(deleteCalls).toEqual(["upload-main-1"]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除这份文档？" })).toBeNull());
    expect(onReload).toHaveBeenCalled();
    // the doc is gone server-side; the local workspace transition is left to
    // the reload surfaces (remaining doc_ids are unknown to this stale payload)
    expect(onDocDeleted).not.toHaveBeenCalled();
    expect(screen.queryByText(/not found/i)).toBeNull();
  });
});

describe("applyDocDeletion (workspace three-state transition)", () => {
  it("deleted doc ≠ currentDoc → only the papers list loses the id", () => {
    expect(
      applyDocDeletion({ papers: ["a", "b", "c"], currentDoc: "b" }, "a", [])
    ).toEqual({ papers: ["b", "c"], currentDoc: "b" });
  });

  it("deleted == currentDoc with docs left → switch to the work's new main", () => {
    expect(
      applyDocDeletion({ papers: ["a", "b"], currentDoc: "a" }, "a", ["b"])
    ).toEqual({ papers: ["b"], currentDoc: "b" });
  });

  it("deleted == currentDoc with none left → currentDoc = null (empty state)", () => {
    expect(applyDocDeletion({ papers: ["a"], currentDoc: "a" }, "a", [])).toEqual({
      papers: [],
      currentDoc: null,
    });
  });

  it("a doc absent from the papers list still migrates currentDoc", () => {
    // defensive: the papers list was boot-time data; the rule keys off currentDoc
    expect(applyDocDeletion({ papers: [], currentDoc: "a" }, "a", ["z"])).toEqual({
      papers: [],
      currentDoc: "z",
    });
  });
});
