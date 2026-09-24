import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefDetail } from "../src/library/RefDetail";
import type { LibraryRef } from "../src/library/types";

vi.mock("../src/api/ws", () => ({
  onJobEvent: () => () => {},
}));

const REF: LibraryRef = {
  id: "doi:10.0000/long",
  title:
    "A joint view of stellar kinematics and chemical evolution across the Galactic disc: selection effects and non-axisymmetric structure",
  authors: "Y. Lin, A. Moreau & L. Chen",
  year: 2026,
  venue: "Monthly Notices of the Royal Astronomical Society",
  type: "article",
  cite: "Lin2026Disc",
  tags: ["dynamics"],
  pdf: false,
  read: false,
  star: false,
  abstract: "We compare $v_\\phi$ with <b>chemical abundance</b>.",
  doi: "10.0000/demo.stellar-disc.selection-functions.non-axisymmetric-structure.2026",
  arxiv_id: "2609.17036",
  doc_id: "upload-demo-stellar-disc-7ad91e",
  doc_ids: ["upload-demo-stellar-disc-7ad91e"],
  citedBy: 42,
  sourceLabel: "planner-only publisher HTML",
};

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderDetail(r: LibraryRef = REF) {
  const onOpenDoc = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <RefDetail r={r} node={null} onClose={onClose} onOpenDoc={onOpenDoc} />
  );
  return { ...view, onOpenDoc, onClose };
}

describe("RefDetail reading-first interaction", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("leads with the complete Work identity, defaults to Info, and opens the actual main Doc", () => {
    const { onOpenDoc } = renderDetail();

    expect(screen.getByRole("heading", { level: 1, name: REF.title })).toBeTruthy();
    expect(screen.getByText(REF.authors)).toBeTruthy();
    expect(screen.getAllByText(REF.venue).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("2026").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("被引 42")).toBeTruthy();
    expect(screen.queryByText(/planner-only publisher HTML/)).toBeNull();

    const info = screen.getByRole("tab", { name: "信息" });
    expect(info.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "信息" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "阅读全文" }));
    expect(onOpenDoc).toHaveBeenCalledWith("upload-demo-stellar-disc-7ad91e");
  });

  it("keeps all five content tabs keyboard-accessible and uses the existing cleaned abstract renderer", () => {
    const { container } = renderDetail();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "信息",
      "摘要",
      "BibTeX",
      "笔记",
      "全文",
    ]);

    const info = screen.getByRole("tab", { name: "信息" });
    info.focus();
    fireEvent.keyDown(info, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "摘要" }));
    expect(screen.getByRole("tabpanel", { name: "摘要" }).textContent).toContain(
      "chemical abundance"
    );
    expect(container.querySelector(".katex")).toBeTruthy();
  });

  it("routes a docless primary action to the existing full-text acquisition and upload entries", () => {
    renderDetail({
      ...REF,
      doc_id: undefined,
      doc_ids: undefined,
      needs_upload: true,
    });

    expect(screen.getByText("暂无全文")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "获取全文" }));
    expect(screen.getByRole("tab", { name: "全文" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText(/可获取 · arXiv 全文/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "获取全文…" }));
    expect(screen.getByRole("radio", { name: /从 arXiv 获取 PDF/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /从 arXiv 获取 LaTeX 源码/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /上传 LaTeX 源码包/ })).toBeTruthy();
  });

  it("reports successful cite-key and BibTeX copies through real clipboard calls", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "复制引用键" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Lin2026Disc"));
    expect(screen.getByRole("status").textContent).toBe("引用键已复制");

    fireEvent.click(screen.getByRole("tab", { name: "BibTeX" }));
    fireEvent.click(screen.getByRole("button", { name: "复制 BibTeX" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls[1]?.[0]).toContain("@article{Lin2026Disc");
    expect(screen.getByRole("status").textContent).toBe("BibTeX 已复制");
  });

  it("shows an honest error when clipboard permission rejects the copy", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) },
    });
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "复制引用键" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "复制失败；浏览器未授予剪贴板权限"
    );
    expect(screen.queryByText("引用键已复制")).toBeNull();
  });

  it("discards a clipboard result that settles after switching to another Work", async () => {
    const oldCopy = deferred<void>();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(() => oldCopy.promise) } });
    const view = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "复制引用键" }));

    view.rerender(
      <RefDetail
        r={{ ...REF, id: "doi:10.0000/other", title: "Another Work", cite: "Other2026" }}
        node={null}
        onClose={() => {}}
        onOpenDoc={() => {}}
      />
    );
    await act(async () => oldCopy.resolve());

    expect(screen.getByRole("heading", { name: "Another Work" })).toBeTruthy();
    expect(screen.queryByText("引用键已复制")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the newest copy feedback when clipboard requests settle out of order", async () => {
    const oldCopy = deferred<void>();
    const newCopy = deferred<void>();
    const writeText = vi
      .fn()
      .mockImplementationOnce(() => oldCopy.promise)
      .mockImplementationOnce(() => newCopy.promise);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "复制引用键" }));
    fireEvent.click(screen.getByRole("tab", { name: "BibTeX" }));
    fireEvent.click(screen.getByRole("button", { name: "复制 BibTeX" }));
    await act(async () => newCopy.resolve());
    expect(screen.getByRole("status").textContent).toBe("BibTeX 已复制");

    await act(async () => oldCopy.resolve());
    expect(screen.getByRole("status").textContent).toBe("BibTeX 已复制");
    expect(screen.queryByText("引用键已复制")).toBeNull();
  });

  it("keeps close and enabled Discovery callbacks connected", () => {
    const onClose = vi.fn();
    const onExplore = vi.fn();
    render(
      <RefDetail
        r={REF}
        node={null}
        onClose={onClose}
        onOpenDoc={() => {}}
        explore={{ bibcode: "2026MNRAS.demo", live: true, onExplore }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "探索相关文献" }));
    expect(onExplore).toHaveBeenCalledWith("2026MNRAS.demo");
  });
});
