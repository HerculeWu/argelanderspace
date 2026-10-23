/**
 * Adding a Work to the Shelf (shelf ticket 05): the dialog's defaults and choices, the replacement confirmation, the
 * failure report, and the request it sends — against stubbed HTTP (contracts shelf-write.ts).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import type { LibraryRef } from "../src/library/types";
import { AddToShelfDialog } from "../src/shelf/AddToShelf";
import { bodiesOf, IMPACT, json, must, type Route, stubFetch } from "./shelf-fixtures";

vi.mock("../src/api/ws-instance", async () => {
  const { createFakeBus } = await import("../src/api/ws-bus");
  return { bus: createFakeBus() };
});

const WORK: LibraryRef = {
  id: "doi:10.1051/hyades",
  title: "Extended stellar systems",
  authors: "Meingast, S. & Alves, J.",
  year: 2019,
  venue: "A&A",
  type: "article",
  cite: "meingast2019",
  tags: [],
  pdf: true,
  read: false,
  star: false,
  doi: "10.1051/hyades",
  arxiv_id: "1901.06387",
  doc_id: "arxiv-1901.06387",
  doc_ids: ["arxiv-1901.06387", "pdf-7c1e52d0", "text-3fa29b11"],
  note: "Tidal tails to 800 pc.",
};

const ANN = (id: string, quote: string) => ({
  id,
  target: { type: "text", block: "p-1", container: { type: "content" }, start: 0, end: quote.length, quote },
  body: `body of ${id}`,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

function routes(opts: { impact?: typeof IMPACT | null; sourcePdf?: string; add?: Route; latexState?: "current" | "stale" } = {}): Route {
  return (url, init) => {
    if (url === "/api/shelf/entries/preview") return json({ impact: opts.impact ?? null, carried: { docs: [], argumentGraph: false, note: false }, notCarried: [] });
    if (url === `/api/shelf/add-candidates/${encodeURIComponent(WORK.id)}`)
      return json({
        workId: WORK.id,
        docs: (WORK.doc_ids ?? []).map((docId) => ({
          docId,
          kind: docId.startsWith("arxiv-") ? "latex" : docId.startsWith("text-") ? "text" : "pdf",
          bytes: 2048,
          annotations: docId.startsWith("arxiv-")
            ? opts.latexState === "stale"
              ? { state: "stale" }
              : { state: "current", list: [ANN("a_00000001", "two tidal tails"), ANN("a_00000002", "800 pc")] }
            : docId.startsWith("text-")
              ? { state: "current", list: [] }
              : { state: "pdf" },
        })),
      });
    if (url === "/api/shelf/entries" && init?.method === "POST") return opts.add?.(url, init);
    if (url.endsWith("/argument-graph")) return json({ version: 1, rev: 3, work_id: WORK.id, arguments: [{ id: "x1", title: "A", claim: "", grounds: "", warrant: "", backing: "", qualifier: "", rebuttal: "", warrant_implicit: false, kind: "normal", sources: [] }], edges: [] });
    const m = /^\/api\/paper\/([^/]+)\/(description|annotations|pdf\/snapshot)$/.exec(url);
    if (!m) return undefined;
    const docId = decodeURIComponent(m[1]);
    if (m[2] === "description") {
      if (docId.startsWith("arxiv-")) return json({ doc_id: docId, format: "latex", acquired_via: "arxiv_eprint" });
      if (docId.startsWith("text-")) return json({ doc_id: docId, format: "text", generated: true, source_rev: 1, published_source_rev: 1, source_pdf: { doc_id: opts.sourcePdf ?? "pdf-7c1e52d0", sha256: "a".repeat(64) } });
      return json({ doc_id: docId, format: "pdf", acquired_via: "user_pdf_upload", acquired_at: "2026-01-01T00:00:00.000Z", owner_work_id: WORK.id, work_title: "t", display_name: "x.pdf", byte_length: 10, sha256: "b".repeat(64), page_count: 1, pages: [{ width: 1, height: 1, rotation: 0 }] });
    }
    if (m[2] === "pdf/snapshot") return json({ detail: "boom" }, 500);
    if (docId.startsWith("arxiv-")) return json({ version: 1, rev: 0, content_fingerprint: "f", annotations: [ANN("a_00000001", "two tidal tails"), ANN("a_00000002", "800 pc")] });
    return json({ version: 1, rev: 0, content_fingerprint: "f", annotations: [] });
  };
}

const okAnswer = (replaced = false) =>
  json({
    entry: { entryId: IMPACT.entries[0].entryId, rev: replaced ? 3 : 1 },
    replaced: replaced ? [{ entryId: IMPACT.entries[0].entryId, rev: 2 }] : [],
    carried: { docs: [{ docId: "arxiv-1901.06387", kind: "latex", annotations: 1 }], argumentGraph: false, note: false },
    notCarried: [],
    archived: [],
  });

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const docBox = (docId: string) => within(document.querySelector(`[data-ui="add-to-shelf-doc"][data-ui-key="${docId}"]`) as HTMLElement).getByRole("checkbox") as HTMLInputElement;

describe("add to Shelf dialog", () => {
  it("defaults: every Doc checked, no annotation, no graph, no note; the request carries exactly that", async () => {
    const onAdded = vi.fn();
    const fetchMock = stubFetch(routes({ add: () => okAnswer() }));
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={onAdded} />);
    await screen.findByText("“two tidal tails”");
    for (const d of WORK.doc_ids!) expect(docBox(d).checked).toBe(true);
    const anns = document.querySelectorAll<HTMLInputElement>('[data-ui="add-to-shelf-annotation"] input');
    expect(anns.length).toBe(2);
    expect([...anns].every((a) => !a.checked)).toBe(true);
    const graph = within(document.querySelector('[data-ui="add-to-shelf-argument-graph"]') as HTMLElement).getByRole("checkbox") as HTMLInputElement;
    await waitFor(() => expect(graph.disabled).toBe(false));
    expect(graph.checked).toBe(false);
    expect((within(document.querySelector('[data-ui="add-to-shelf-note"]') as HTMLElement).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    // the PDF's annotations could not be read: said so, nothing to choose
    expect(document.querySelector('[data-ui="add-to-shelf-annotations-unreadable"]')).not.toBeNull();

    fireEvent.click(anns[1]);
    const submit = document.querySelector('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(bodiesOf(fetchMock, "/api/shelf/entries")).toEqual([
      {
        workId: WORK.id,
        docs: [
          { docId: "arxiv-1901.06387", annotationIds: ["a_00000002"] },
          { docId: "pdf-7c1e52d0", annotationIds: [] },
          { docId: "text-3fa29b11", annotationIds: [] },
        ],
        argumentGraph: false,
        note: false,
      },
    ]);
  });

  it("checking a text Doc checks its source PDF too (which can be unchecked); an unchecked Doc's annotations cannot be chosen", async () => {
    stubFetch(routes());
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={() => {}} />);
    await screen.findByText("由 pdf-7c1e52d0 转录");
    fireEvent.click(docBox("pdf-7c1e52d0"));
    fireEvent.click(docBox("text-3fa29b11"));
    expect(docBox("text-3fa29b11").checked).toBe(false);
    fireEvent.click(docBox("text-3fa29b11"));
    expect(docBox("pdf-7c1e52d0").checked).toBe(true);
    expect(document.querySelector('[data-ui="linked-source-pdf"]')?.textContent).toContain("pdf-7c1e52d0");
    fireEvent.click(docBox("pdf-7c1e52d0"));
    expect(docBox("pdf-7c1e52d0").checked).toBe(false);

    await screen.findByText("“two tidal tails”");
    fireEvent.click(docBox("arxiv-1901.06387"));
    const ann = document.querySelector<HTMLInputElement>('[data-ui="add-to-shelf-annotation"][data-ui-key="a_00000001"] input')!;
    expect(ann.disabled).toBe(true);
  });

  it("a text Doc whose source PDF is not in the Work says the source PDF is missing", async () => {
    stubFetch(routes({ sourcePdf: "pdf-gone" }));
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={() => {}} />);
    await waitFor(() => expect(document.querySelector('[data-ui="add-to-shelf-source-pdf-missing"]')?.textContent).toContain("源 PDF 缺失"));
  });

  it("the same paper on the Shelf: says so, and submitting first shows the replacement card; confirming echoes the impact", async () => {
    const onAdded = vi.fn();
    const fetchMock = stubFetch(routes({ impact: IMPACT, add: () => okAnswer(true) }));
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={onAdded} />);
    await waitFor(() => expect(document.querySelector('[data-ui="already-on-shelf"]')).not.toBeNull());
    expect(document.querySelector('[data-ui="already-on-shelf"]')?.textContent).toContain("/home/u/research/hyades-tails");
    const submit = document.querySelector('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement;
    expect(submit.textContent).toBe("替换文献仓条目…");
    fireEvent.click(submit);
    const card = await waitFor(() => must('[data-ui="replace-shelf-entry-dialog"]'));
    expect(within(card).getByText("替换文献仓里的这一条？")).toBeTruthy();
    expect(card.querySelector('[data-ui="replace-old-entry"]')?.textContent).toContain("arxiv-1901.06387");
    // the safe action has the focus
    expect(document.activeElement?.getAttribute("data-ui")).toBe("back-to-add-to-shelf");
    expect(bodiesOf(fetchMock, "/api/shelf/entries")).toEqual([]);
    fireEvent.click(card.querySelector('[data-ui="confirm-replace-shelf-entry"]') as HTMLButtonElement);
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect((bodiesOf(fetchMock, "/api/shelf/entries")[0] as { confirm: unknown }).confirm).toEqual(IMPACT);
  });

  it("a 409 confirmation_required from the server opens the replacement card with the server's impact", async () => {
    let calls = 0;
    const fetchMock = stubFetch(routes({ add: () => (++calls === 1 ? json({ detail: "same paper", code: "confirmation_required", impact: IMPACT }, 409) : okAnswer(true)) }));
    const onAdded = vi.fn();
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={onAdded} />);
    const submit = document.querySelector('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    const confirm = await waitFor(() => must('[data-ui="confirm-replace-shelf-entry"]') as HTMLButtonElement);
    fireEvent.click(confirm);
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(bodiesOf(fetchMock, "/api/shelf/entries").map((b) => (b as { confirm?: unknown }).confirm)).toEqual([undefined, IMPACT]);
  });

  it("a part that cannot be read: the dialog stays open, names the Doc and the problem, and says what was not and what was changed", async () => {
    stubFetch(
      routes({
        add: () =>
          json(
            {
              detail: "the annotations of arxiv-1901.06387 could not be read; nothing was written to the Shelf",
              code: "item_unreadable",
              item: { kind: "annotations", docId: "arxiv-1901.06387", path: "current.json" },
              problem: "annotations_invalid",
              archived: [{ docId: "pdf-7c1e52d0", count: 2 }],
            },
            500
          ),
      })
    );
    const onAdded = vi.fn();
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={onAdded} />);
    const submit = document.querySelector('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    const box = await waitFor(() => must('[data-ui="add-to-shelf-error"]'));
    expect(box.textContent).toContain("arxiv-1901.06387 的标注（current.json）：标注文件损坏或不属于这个 Doc");
    expect(box.textContent).toContain("文献仓没有写入任何内容。");
    expect(box.textContent).toContain("pdf-7c1e52d0 (2)");
    expect(box.textContent).toContain("nothing was written to the Shelf");
    expect(onAdded).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ui="add-to-shelf-dialog"]')).not.toBeNull();
  });

  it("a busy Doc is reported as busy (system state, not a content problem) and the project as unchanged", async () => {
    stubFetch(routes({ add: () => json({ detail: "document busy", code: "doc_busy", docId: "pdf-7c1e52d0" }, 409) }));
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={() => {}} />);
    const submit = document.querySelector('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    const box = await waitFor(() => must('[data-ui="add-to-shelf-error"]'));
    expect(box.textContent).toContain("pdf-7c1e52d0 正在处理中");
    expect(box.textContent).toContain("项目没有改动。");
  });

  it("opening the dialog never goes through the annotations access path's ensure (no GET /annotations); sizes are shown", async () => {
    const fetchMock = stubFetch(routes());
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={() => {}} />);
    await screen.findByText("“two tidal tails”");
    expect(fetchMock.mock.calls.some(([u]) => /\/api\/paper\/[^/]+\/annotations/.test(String(u)))).toBe(false);
    expect(must('[data-ui="add-to-shelf-doc"][data-ui-key="arxiv-1901.06387"]').textContent).toContain("2 KB");
    expect(must('[data-ui="add-to-shelf-summary"]').textContent).toContain("约 6 KB");
  });

  it("annotations of older content: said so, and none can be chosen", async () => {
    stubFetch(routes({ latexState: "stale" }));
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={() => {}} />);
    const note = await waitFor(() => must('[data-ui="add-to-shelf-annotations-stale"]'));
    expect(note.textContent).toContain("这次加入不会带入，也不会归档它们");
    expect(document.querySelectorAll('[data-ui="add-to-shelf-annotation"]').length).toBe(0);
  });

  it("a Work without DOI, arXiv or OpenAlex id says every add is a new entry; one with an OpenAlex id does not", async () => {
    stubFetch(routes());
    const plain = { ...WORK, doi: undefined, arxiv_id: undefined };
    render(<AddToShelfDialog work={plain} onClose={() => {}} onAdded={() => {}} />);
    await waitFor(() => must('[data-ui="no-identity"]'));
    cleanup();
    render(<AddToShelfDialog work={{ ...plain, openalex_id: "W123" }} onClose={() => {}} onAdded={() => {}} />);
    await waitFor(() => expect((must('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement).disabled).toBe(false));
    expect(document.querySelector('[data-ui="no-identity"]')).toBeNull();
  });

  it("confirmation_changed with a fresh impact: the card again, saying it changed and what was archived on the way", async () => {
    const fresh = { entries: [{ ...IMPACT.entries[0], rev: 3, annotations: 7 }] };
    stubFetch(routes({ impact: IMPACT, add: () => json({ detail: "changed; the old annotations of arxiv-1901.06387 were archived", code: "confirmation_changed", impact: fresh, archived: [{ docId: "arxiv-1901.06387", count: 2 }] }, 409) }));
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={() => {}} />);
    const submit = await waitFor(() => must('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement);
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    fireEvent.click(await waitFor(() => must('[data-ui="confirm-replace-shelf-entry"]')));
    const changed = await waitFor(() => must('[data-ui="replace-shelf-entry-changed"]'));
    expect(changed.textContent).toContain("刚刚有了变化");
    expect(changed.textContent).toContain("arxiv-1901.06387 (2)");
    expect(must('[data-ui="replace-old-entry"]').textContent).toContain("7 条标注");
  });

  it("confirmation_changed with nothing left to replace: back to the form, saying so (and the archive)", async () => {
    stubFetch(routes({ impact: IMPACT, add: () => json({ detail: "gone", code: "confirmation_changed", archived: [{ docId: "arxiv-1901.06387", count: 1 }] }, 409) }));
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={() => {}} />);
    const submit = await waitFor(() => must('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement);
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    fireEvent.click(await waitFor(() => must('[data-ui="confirm-replace-shelf-entry"]')));
    const changed = await waitFor(() => must('[data-ui="add-to-shelf-changed"]'));
    expect(changed.textContent).toContain("已没有可替换的条目");
    expect(changed.textContent).toContain("arxiv-1901.06387 (1)");
    expect((must('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement).textContent).toBe("加入文献仓");
  });

  it("Back from the replacement card keeps the focus inside the dialog", async () => {
    stubFetch(routes({ impact: IMPACT }));
    render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={() => {}} />);
    const submit = await waitFor(() => must('[data-ui="submit-add-to-shelf"]') as HTMLButtonElement);
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    fireEvent.click(await waitFor(() => must('[data-ui="back-to-add-to-shelf"]')));
    await new Promise((r) => setTimeout(r, 20));
    expect(must('[role="dialog"]').contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("data-ui")).toBe("submit-add-to-shelf");
  });

  it("a Doc removed from the Work while the dialog is open is neither shown nor sent", async () => {
    const onAdded = vi.fn();
    const fetchMock = stubFetch(routes({ add: () => okAnswer() }));
    const { rerender } = render(<AddToShelfDialog work={WORK} onClose={() => {}} onAdded={onAdded} />);
    await screen.findByText("“two tidal tails”");
    rerender(<AddToShelfDialog work={{ ...WORK, doc_ids: ["arxiv-1901.06387", "pdf-7c1e52d0"] }} onClose={() => {}} onAdded={onAdded} />);
    await waitFor(() => expect(document.querySelector('[data-ui="add-to-shelf-doc"][data-ui-key="text-3fa29b11"]')).toBeNull());
    fireEvent.click(must('[data-ui="submit-add-to-shelf"]'));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect((bodiesOf(fetchMock, "/api/shelf/entries")[0] as { docs: { docId: string }[] }).docs.map((d) => d.docId)).toEqual(["arxiv-1901.06387", "pdf-7c1e52d0"]);
  });
});
