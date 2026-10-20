import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefDetail } from "../src/library/RefDetail";
import type { LibraryRef } from "../src/library/types";

vi.mock("../src/api/ws", () => ({
  onJobEvent: () => () => {},
}));

const TEXT_DOC = "text-11111111-1111-4111-8111-111111111111";
const REF: LibraryRef = {
  id: "doi:10.0000/text",
  title: "A Work with text",
  authors: "A. Author",
  year: 2026,
  venue: "ApJ",
  type: "article",
  cite: "Author2026Text",
  tags: [],
  pdf: false,
  read: false,
  star: false,
  doc_id: "arxiv-2609.17036",
  doc_ids: ["arxiv-2609.17036", TEXT_DOC],
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function renderDetail() {
  const onOpenDoc = vi.fn();
  const view = render(<RefDetail r={REF} node={null} onClose={() => {}} onOpenDoc={onOpenDoc} onReload={() => {}} />);
  fireEvent.click(screen.getByRole("tab", { name: "全文" }));
  return { ...view, onOpenDoc };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("RefDetail text Docs (ticket 25)", () => {
  it("labels a text Doc from its explicit description and opens it like any Doc", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`${TEXT_DOC}/description`)) return Promise.resolve(json({ doc_id: TEXT_DOC, format: "text", generated: false, source_rev: 0, published_source_rev: null }));
      if (url.endsWith("arxiv-2609.17036/description")) return Promise.resolve(json({ doc_id: "arxiv-2609.17036", format: "latex", acquired_via: "arxiv_eprint" }));
      throw new Error(`unexpected fetch ${url}`);
    }));
    const { onOpenDoc } = renderDetail();
    expect(await screen.findByText("文本文档")).toBeTruthy();
    const items = document.querySelectorAll('[data-ui="doc-item"]');
    const row = [...items].find((item) => item.getAttribute("data-ui-key") === TEXT_DOC)!;
    fireEvent.click(row.querySelector('[data-ui="open-doc"]')!);
    expect(onOpenDoc).toHaveBeenCalledWith(TEXT_DOC);
  });

  it("creates an empty text Doc under this Work with a fresh operation id and opens its source editor", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/library/text-docs") {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(json({ description: { doc_id: "text-new", format: "text", generated: false, source_rev: 0, published_source_rev: null }, source: {} }, 201));
      }
      return Promise.resolve(json({ doc_id: "x", format: "latex" }));
    }));
    const { onOpenDoc } = renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "新建文本文档" }));
    await waitFor(() => expect(onOpenDoc).toHaveBeenCalledWith("text-new"));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ workId: REF.id });
    expect((bodies[0] as { operationId: string }).operationId.length).toBeGreaterThanOrEqual(8);
  });

  it("shows a creation failure and does not open anything", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      if (String(input) === "/api/library/text-docs") return Promise.resolve(json({ detail: "work not found" }, 404));
      return Promise.resolve(json({ doc_id: "x", format: "latex" }));
    }));
    const { onOpenDoc } = renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "新建文本文档" }));
    expect(await screen.findByText("work not found")).toBeTruthy();
    expect(onOpenDoc).not.toHaveBeenCalled();
  });

  describe("delete confirmation count for a text Doc", () => {
    const openDelete = async (impact: unknown) => {
      vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith(`${TEXT_DOC}/description`)) return Promise.resolve(json({ doc_id: TEXT_DOC, format: "text", generated: false, source_rev: 0, published_source_rev: null }));
        if (url.endsWith("arxiv-2609.17036/description")) return Promise.resolve(json({ doc_id: "arxiv-2609.17036", format: "latex", acquired_via: "arxiv_eprint" }));
        if (url.endsWith(`${TEXT_DOC}/source/delete-impact`)) return Promise.resolve(json(impact));
        return Promise.resolve(json({ detail: "unexpected" }, 500));
      }));
      renderDetail();
      await screen.findByText("文本文档");
      const row = [...document.querySelectorAll('[data-ui="doc-item"]')].find((item) => item.getAttribute("data-ui-key") === TEXT_DOC)!;
      fireEvent.click(row.querySelector("summary")!);
      fireEvent.click(row.querySelector('[data-ui="delete-doc"]') ?? screen.getAllByRole("button", { name: /删除/ })[0]!);
    };
    it("a never-generated draft with no annotations directory is a known zero, like the Copilot card", async () => {
      await openDelete({ generated: false, annotations: { state: "known", count: 0 } });
      expect(await screen.findByText("包含 0 条当前标注。")).toBeTruthy();
      expect(screen.getByText(/包括尚未生成的文字/)).toBeTruthy();
    });
    it("an annotations directory that exists for a draft is an unknown count, never zero", async () => {
      await openDelete({ generated: false, annotations: { state: "unknown" } });
      expect(await screen.findByText(/无法获取标注数量/)).toBeTruthy();
    });
  });
});
