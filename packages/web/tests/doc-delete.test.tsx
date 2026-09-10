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
let deleteStatus: number; // 200 | 409 | 404
let annotationsOk: boolean;

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
        if (deleteStatus === 200) {
          return { ok: true, status: 200, json: async () => ({ deleted: delMatch[1] }) } as Response;
        }
        const detail = deleteStatus === 409 ? "document busy" : "not found";
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
  fireEvent.click(screen.getByRole("button", { name: "附件" }));
}

/** Open the delete dialog for one of the two versions (0 = main, 1 = old). */
async function openDeleteDialog(which: 0 | 1) {
  const buttons = screen.getAllByTitle("删除此文档（含其标注）");
  fireEvent.click(buttons[which]);
  await waitFor(() => expect(screen.getByText("删除文档")).toBeTruthy());
}

beforeEach(() => {
  deleteCalls = [];
  deleteStatus = 200;
  annotationsOk = true;
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
    expect(screen.getAllByTitle("删除此文档（含其标注）")).toHaveLength(2);
  });

  it("the dialog states the fetched annotation count; confirm deletes and wires the transitions", async () => {
    const onDocDeleted = vi.fn();
    const { onReload } = renderDetail(onDocDeleted);
    openFilesTab();
    await openDeleteDialog(0); // the main doc, upload-main-1

    // N fetched from the doc's own annotations file
    await waitFor(() =>
      expect(
        screen.getByText(/该文档及其 2 条标注将永久删除，此文档将从所有关联文献条目中移除/)
      ).toBeTruthy()
    );

    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(deleteCalls).toEqual(["upload-main-1"]));
    // success: dialog closes, the workspace transition gets the remaining
    // docs of THIS work (their [0] becomes the new main), library reloads
    await waitFor(() => expect(screen.queryByText("删除文档")).toBeNull());
    expect(onDocDeleted).toHaveBeenCalledWith("upload-main-1", ["arxiv-old-2"]);
    expect(onReload).toHaveBeenCalled();
  });

  it("deleting the old version leaves the main doc in `remaining`", async () => {
    const onDocDeleted = vi.fn();
    renderDetail(onDocDeleted);
    openFilesTab();
    await openDeleteDialog(1);
    await waitFor(() =>
      expect(screen.getByText(/该文档及其 0 条标注将永久删除/)).toBeTruthy()
    );
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
    await waitFor(() => expect(screen.getByText(/数量未知/)).toBeTruthy());
    expect(screen.getByText(/将永久删除，此文档将从所有关联文献条目中移除/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(deleteCalls).toEqual(["upload-main-1"]));
  });

  it('409 "document busy" → the retry hint shows, nothing is torn down', async () => {
    deleteStatus = 409;
    const onDocDeleted = vi.fn();
    const { onReload } = renderDetail(onDocDeleted);
    openFilesTab();
    await openDeleteDialog(0);
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(deleteCalls).toEqual(["upload-main-1"]));
    await waitFor(() =>
      expect(screen.getByText("文档正在摄入，请稍后删除")).toBeTruthy()
    );
    // the dialog stays open (the ingest task ends on its own; the user retries)
    expect(screen.getByText("删除文档")).toBeTruthy();
    expect(onDocDeleted).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
  });

  it("404 (doc already gone) → the dialog closes and the library reloads, no error shown", async () => {
    deleteStatus = 404;
    const onDocDeleted = vi.fn();
    const { onReload } = renderDetail(onDocDeleted);
    openFilesTab();
    await openDeleteDialog(0);
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(deleteCalls).toEqual(["upload-main-1"]));
    await waitFor(() => expect(screen.queryByText("删除文档")).toBeNull());
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
