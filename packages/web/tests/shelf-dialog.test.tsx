/**
 * The Shelf dialog (shelf ticket 05; review Q1 plan A, Q5): list states, search, the summary of each entry status, the
 * separate delete confirmation over the dialog, the take flow with its plan digest and result, and the list following
 * `shelf.changed` — against stubbed HTTP and the real WS routing table.
 */
import type { ShelfTakeResult } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bus } from "../src/api/ws-instance";
import i18n from "../src/i18n";
import type { LibraryRef } from "../src/library/types";
import { ShelfDialog } from "../src/shelf/ShelfDialog";
import { bodiesOf, ENTRY_A, ENTRY_B, ENTRY_C, ENTRY_D, INCOMPATIBLE_ROW, json, must, OK_ROW, OTHER_ROW, type Route, stubFetch, UNREADABLE_ROW } from "./shelf-fixtures";

vi.mock("../src/api/ws-instance", async () => {
  const { createFakeBus } = await import("../src/api/ws-bus");
  return { bus: createFakeBus() };
});
const fakeBus = bus as unknown as { emit: (type: string, msg: object) => void };

const LODIEU: LibraryRef = { id: "arxiv:1906.03924", title: "A 5D view", authors: "Lodieu", year: 2019, venue: "A&A", type: "article", cite: "lodieu2019", tags: [], pdf: false, read: false, star: false, arxiv_id: "1906.03924" };

const PLAN: ShelfTakeResult = {
  work: { id: "doi:10.1/gaia", title: "Gaia DR2", created: true, citeKey: "gaia2018", filled: [] },
  mainDoc: { before: null, after: "arxiv-1804.09378", changed: false },
  docs: { taken: [{ docId: "pdf-0f3b7d21", kind: "pdf", annotations: 1, stamped: false }], skipped: [{ docId: "arxiv-1804.09378", kind: "latex", reason: "exists" }] },
  argumentGraph: "kept_local",
  note: "written",
};

const ANNOTATIONS = {
  entryId: ENTRY_A,
  rev: 2,
  docs: [
    { docId: "arxiv-1804.09378", kind: "latex", annotations: [{ id: "a_00000001", kind: "text", location: { sectionPath: "2 Data", number: null, pageIndex: null }, snippet: "HRD", body: "skip me", createdAt: "x", updatedAt: "x" }] },
    { docId: "pdf-0f3b7d21", kind: "pdf", annotations: [{ id: "p1", kind: "highlight", location: { sectionPath: null, number: null, pageIndex: 11 }, snippet: "Fig. 9", body: "velocities", createdAt: "x", updatedAt: "x" }] },
  ],
};

function shelfRoutes(rows: () => unknown[], extra?: Route, plan: () => ShelfTakeResult = () => PLAN): Route {
  return async (url, init) => {
    const own = await extra?.(url, init);
    if (own) return own;
    if (url === "/api/shelf") return json({ entries: rows() });
    if (url === `/api/shelf/entries/${ENTRY_A}`) return json({ ...OK_ROW, bibliography: { title: "Gaia", authors: [], year: 2018, venue: "A&A" } });
    if (url === `/api/shelf/entries/${ENTRY_A}/annotations?rev=2`) return json(ANNOTATIONS);
    if (url === `/api/shelf/entries/${ENTRY_A}/take/preview`) return json({ plan: plan(), planDigest: "d".repeat(64) });
    return undefined;
  };
}

const open = (props: Partial<Parameters<typeof ShelfDialog>[0]> = {}) => {
  const onViewWork = vi.fn();
  render(<ShelfDialog works={[LODIEU]} onClose={() => {}} onViewWork={onViewWork} {...props} />);
  return { onViewWork };
};
const row = (id: string) => must(`[data-ui="shelf-entry"][data-ui-key="${id}"]`);

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Shelf dialog", () => {
  it("lists entries with their marks; an unreadable entry is not called damaged; search filters", async () => {
    stubFetch(shelfRoutes(() => [OK_ROW, OTHER_ROW, INCOMPATIBLE_ROW, UNREADABLE_ROW]));
    open();
    await waitFor(() => row(ENTRY_A));
    expect(must('[data-ui="shelf-count"]').textContent).toContain("4 篇");
    expect(row(ENTRY_A).textContent).toContain("2 个 Doc");
    expect(row(ENTRY_A).textContent).toContain("3 条标注");
    expect(row(ENTRY_B).textContent).toContain("本项目已有");
    expect(row(ENTRY_A).textContent).not.toContain("本项目已有");
    expect(row(ENTRY_C).querySelector('[data-ui="shelf-entry-needs-update"]')?.textContent).toBe("需要更新工作台");
    expect(row(ENTRY_D).textContent).toContain("暂时读不了");
    expect(row(ENTRY_D).textContent).not.toContain("损坏");
    fireEvent.change(must('[data-ui="search-shelf"]'), { target: { value: "pleiades" } });
    expect(document.querySelectorAll('[data-ui="shelf-entry"]').length).toBe(2);
    fireEvent.change(must('[data-ui="search-shelf"]'), { target: { value: "zzz" } });
    expect(must('[data-ui="shelf-no-match"]')).toBeTruthy();
  });

  it("an entry of a newer format can be viewed and deleted, not taken", async () => {
    stubFetch(shelfRoutes(() => [INCOMPATIBLE_ROW]));
    open();
    await waitFor(() => must('[data-ui="shelf-entry-needs-update-note"]'));
    expect(must('[data-ui="shelf-entry-needs-update-note"]').textContent).toContain("格式版本 3");
    expect((must('[data-ui="take-shelf-entry"]') as HTMLButtonElement).disabled).toBe(true);
    expect((must('[data-ui="delete-shelf-entry"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it("empty and unreadable Shelf states", async () => {
    stubFetch(shelfRoutes(() => []));
    open();
    await waitFor(() => must('[data-ui="shelf-empty"]'));
    cleanup();
    stubFetch(async (url) => (url === "/api/shelf" ? json({ detail: "EACCES", code: "shelf_unreadable" }, 500) : undefined));
    open();
    await waitFor(() => must('[data-ui="shelf-read-error"]'));
    expect(must('[data-ui="shelf-read-error"]').textContent).toContain("读不了文献仓");
  });

  it("delete asks in a dialog of its own above the Shelf dialog (focus on Cancel; Escape closes only it), then deletes that rev", async () => {
    let rows: unknown[] = [OK_ROW, OTHER_ROW];
    const fetchMock = stubFetch(shelfRoutes(() => rows, (url, init) => {
      if (url === `/api/shelf/entries/${ENTRY_A}?rev=2` && init?.method === "DELETE") {
        rows = [OTHER_ROW];
        return json({ deleted: { entryId: ENTRY_A, rev: 2 } });
      }
      return undefined;
    }));
    open();
    await waitFor(() => must('[data-ui="shelf-entry-summary"]'));
    fireEvent.click(must('[data-ui="delete-shelf-entry"]'));
    const confirm = await waitFor(() => must('[data-ui="delete-shelf-entry-dialog"]'));
    expect(must('[data-ui="shelf-dialog"]')).toBeTruthy();
    expect(document.activeElement?.getAttribute("data-ui")).toBe("cancel-delete-shelf-entry");
    expect(confirm.textContent).toContain("只删文献仓里的这一份");
    expect(confirm.textContent).toContain("2 个 Doc、3 条标注、论证图、笔记");
    expect(confirm.textContent).toContain("不能恢复");
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(document.querySelector('[data-ui="delete-shelf-entry-dialog"]')).toBeNull());
    expect(document.querySelector('[data-ui="shelf-dialog"]')).not.toBeNull();

    fireEvent.click(must('[data-ui="delete-shelf-entry"]'));
    fireEvent.click(await waitFor(() => must('[data-ui="confirm-delete-shelf-entry"]')));
    await waitFor(() => expect(must('[data-ui="shelf-notice"]').textContent).toContain("已删除文献仓条目"));
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === `/api/shelf/entries/${ENTRY_A}?rev=2` && i?.method === "DELETE")).toBe(true);
    await waitFor(() => expect(document.querySelector(`[data-ui="shelf-entry"][data-ui-key="${ENTRY_A}"]`)).toBeNull());
  });

  it("take: the plan says where it goes and what is skipped; the take sends the digest; the result names what happened", async () => {
    const taken = { ...PLAN };
    const fetchMock = stubFetch(shelfRoutes(() => [OK_ROW], (url) => (url === `/api/shelf/entries/${ENTRY_A}/take` ? json(taken) : undefined)));
    const { onViewWork } = open({ entryId: ENTRY_A, take: true });
    const pane = await waitFor(() => must('[data-ui="take-from-shelf"]'));
    await waitFor(() => expect(must('[data-ui="take-target"]').textContent).toContain("新建 Work，引用键按本项目规则分配为 gaia2018"));
    expect(pane.querySelector('[data-ui="take-doc"][data-ui-key="arxiv-1804.09378"] [data-ui="take-doc-skipped"]')?.textContent).toContain("跳过");
    await waitFor(() => must('[data-ui="take-annotation"][data-ui-key="a_00000001"]'));
    const skippedAnn = must('[data-ui="take-annotation"][data-ui-key="a_00000001"] input') as HTMLInputElement;
    expect(skippedAnn.disabled).toBe(true);
    expect(must('[data-ui="take-keep-local-graph"]')).toBeTruthy();
    expect((must('[data-ui="take-argument-graph"] input') as HTMLInputElement).disabled).toBe(true);
    // uncheck the PDF highlight: the preview is asked again with it excluded
    fireEvent.click(must('[data-ui="take-annotation"][data-ui-key="p1"] input'));
    await waitFor(() => expect(bodiesOf(fetchMock, `/api/shelf/entries/${ENTRY_A}/take/preview`).slice(-1)[0]).toMatchObject({ rev: 2, excludeAnnotations: { "pdf-0f3b7d21": ["p1"] } }));
    const submit = must('[data-ui="submit-take-from-shelf"]') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    const result = await waitFor(() => must('[data-ui="take-from-shelf-result"]'));
    expect(bodiesOf(fetchMock, `/api/shelf/entries/${ENTRY_A}/take`)[0]).toMatchObject({ rev: 2, planDigest: "d".repeat(64), excludeAnnotations: { "pdf-0f3b7d21": ["p1"] } });
    expect(result.textContent).toContain("新建了 Work gaia2018。");
    expect(result.textContent).toContain("跳过同 id 的 Doc：arxiv-1804.09378");
    expect(result.textContent).toContain("保留了本地论证图");
    expect(document.activeElement?.getAttribute("data-ui")).toBe("view-taken-work");
    fireEvent.click(must('[data-ui="view-taken-work"]'));
    expect(onViewWork).toHaveBeenCalledWith("doi:10.1/gaia");
  });

  it("a plan that changed before the take is shown again and nothing is taken", async () => {
    const changed = { ...PLAN, work: { ...PLAN.work, created: false, title: "Gaia (local)", citeKey: "gaia2018b" } };
    stubFetch(shelfRoutes(() => [OK_ROW], (url) => (url === `/api/shelf/entries/${ENTRY_A}/take` ? json({ detail: "plan changed", code: "plan_changed", plan: changed, planDigest: "e".repeat(64) }, 409) : undefined)));
    open({ entryId: ENTRY_A, take: true });
    const submit = await waitFor(() => must('[data-ui="submit-take-from-shelf"]') as HTMLButtonElement);
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => must('[data-ui="take-plan-changed"]'));
    expect(must('[data-ui="take-target"]').textContent).toContain("并入本项目已有的「Gaia (local)」");
    expect(document.querySelector('[data-ui="take-from-shelf-result"]')).toBeNull();
  });

  it("a take refusal keeps the pane and reports it", async () => {
    stubFetch(shelfRoutes(() => [OK_ROW], (url) => (url === `/api/shelf/entries/${ENTRY_A}/take` ? json({ detail: "several", code: "multiple_works", workIds: ["doi:a", "arxiv:b"] }, 409) : undefined)));
    open({ entryId: ENTRY_A, take: true });
    const submit = await waitFor(() => must('[data-ui="submit-take-from-shelf"]') as HTMLButtonElement);
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    const box = await waitFor(() => must('[data-ui="take-from-shelf-error"]'));
    expect(box.textContent).toContain("doi:a, arxiv:b");
    expect(box.textContent).toContain("项目与文献仓里的条目都没有改动。");
  });

  it("follows shelf.changed: the list is read again", async () => {
    let rows: unknown[] = [OK_ROW];
    stubFetch(shelfRoutes(() => rows));
    open();
    await waitFor(() => row(ENTRY_A));
    rows = [OK_ROW, OTHER_ROW];
    act(() => fakeBus.emit("shelf.changed", { cause: "add", entry_id: ENTRY_B, rev: 1, removed: [], at: "2026-10-23T00:00:00Z" }));
    await waitFor(() => row(ENTRY_B));
    expect(screen.getByText("A 5D view of the alpha Per, Pleiades, and Praesepe clusters")).toBeTruthy();
    expect(within(must('[data-ui="shelf-list"]')).getAllByRole("button").length).toBeGreaterThanOrEqual(2);
  });

  it("while the list is read: a loading state", async () => {
    let release: (r: Response) => void = () => {};
    stubFetch((url) => (url === "/api/shelf" ? new Promise<Response>((r) => (release = r)) : undefined));
    open();
    expect(must('[data-ui="shelf-loading"]').textContent).toContain("正在读取文献仓");
    await act(async () => release(json({ entries: [] })));
    await waitFor(() => must('[data-ui="shelf-empty"]'));
  });

  it("a damaged entry's reason is said in words, not as a code", async () => {
    stubFetch(shelfRoutes(() => [{ status: "damaged", entryId: ENTRY_C, rev: 1, bytes: 10, problem: "file_changed" }]));
    open();
    const note = await waitFor(() => must('[data-ui="shelf-entry-damaged-note"]'));
    expect(note.textContent).toContain("有文件与记录不符");
    expect(note.textContent).not.toContain("file_changed");
  });

  it("take into a new Work: every annotation is taken by default; a merge keeps the project note and says so", async () => {
    const noSkip: ShelfTakeResult = { ...PLAN, docs: { ...PLAN.docs, skipped: [] } };
    let plan = noSkip;
    stubFetch(shelfRoutes(() => [OK_ROW], undefined, () => plan));
    open({ entryId: ENTRY_A, take: true });
    await waitFor(() => must('[data-ui="take-annotation"][data-ui-key="p1"]'));
    for (const id of ["a_00000001", "p1"]) expect((must(`[data-ui="take-annotation"][data-ui-key="${id}"] input`) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector('[data-ui="take-note-not-written"]')).toBeNull();
    cleanup();
    plan = { ...noSkip, work: { ...noSkip.work, created: false }, note: "kept_local" };
    open({ entryId: ENTRY_A, take: true });
    const kept = await waitFor(() => must('[data-ui="take-note-not-written"]'));
    expect(kept.textContent).toContain("笔记不为空");
  });

  it("the summary and the take step give the graph's argument count; the take step shows the opening of the note (follow-up 01)", async () => {
    const preview = { text: "与 Röser 2019 同期发现 Hyades 潮汐尾", truncated: true };
    const localGraph = { version: 1, rev: 3, work_id: "doi:10.1/gaia", arguments: ["l1", "l2", "l3", "l4"].map((id) => ({ id, title: id, claim: "", grounds: "", warrant: "", backing: "", qualifier: "", rebuttal: "", warrant_implicit: false, kind: "normal", sources: [] })), edges: [] };
    stubFetch(
      shelfRoutes(() => [OK_ROW], (url) =>
        url === `/api/shelf/entries/${ENTRY_A}`
          ? json({ ...OK_ROW, bibliography: { title: "Gaia", authors: [], year: 2018 }, notePreview: preview })
          : url === `/api/works/${encodeURIComponent("doi:10.1/gaia")}/argument-graph`
            ? json(localGraph)
            : undefined
      )
    );
    open({ entryId: ENTRY_A });
    const summary = await waitFor(() => must('[data-ui="shelf-entry-summary"]'));
    expect(summary.textContent).toContain("论证图7 条论证");
    // the summary's note row shows the same opening (prototype)
    await waitFor(() => expect(summary.textContent).toContain("Work 笔记与 Röser 2019 同期发现 Hyades 潮汐尾…"));
    fireEvent.click(must('[data-ui="take-shelf-entry"]'));
    await waitFor(() => must('[data-ui="take-from-shelf"]'));
    expect(must('[data-ui="take-argument-graph"]').textContent).toContain("7 条论证");
    await waitFor(() => expect(must('[data-ui="take-note"]').textContent).toContain("与 Röser 2019 同期发现 Hyades 潮汐尾…"));
    // the project's own graph is kept: its argument count is named (prototype)
    await waitFor(() => expect(must('[data-ui="take-keep-local-graph"]').textContent).toBe("本项目这篇已有论证图（4 条论证），保留本地的，不取入文献仓的。"));
  });

  it("a graph whose count is unknown and a note whose opening could not be read say only that they are carried", async () => {
    const unknown = { ...OK_ROW, argumentCount: null };
    stubFetch(shelfRoutes(() => [unknown], (url) => (url === `/api/shelf/entries/${ENTRY_A}` ? json({ ...unknown, bibliography: { title: "Gaia", authors: [], year: 2018 }, notePreview: null }) : undefined)));
    open({ entryId: ENTRY_A, take: true });
    await waitFor(() => must('[data-ui="take-from-shelf"]'));
    expect(must('[data-ui="take-argument-graph"]').textContent).toContain("文献仓里这一条带着论证图");
    expect(must('[data-ui="take-note"]').textContent).toContain("文献仓里这一条带着笔记");
    // the project's graph could not be counted (no answer here): the kept-local line stays as it was
    await waitFor(() => must('[data-ui="take-keep-local-graph"]'));
    expect(must('[data-ui="take-keep-local-graph"]').textContent).toBe("本项目这篇已有论证图，保留本地的，不取入文献仓的。");
    cleanup();
    open({ entryId: ENTRY_A });
    const summary = await waitFor(() => must('[data-ui="shelf-entry-summary"]'));
    await waitFor(() => expect(summary.textContent).toContain("Work 笔记有"));
  });

  it("the Take button waits for the plan of what is chosen now", async () => {
    let release: (r: Response) => void = () => {};
    let calls = 0;
    stubFetch(shelfRoutes(() => [OK_ROW], (url) => (url === `/api/shelf/entries/${ENTRY_A}/take/preview` && ++calls === 2 ? new Promise<Response>((r) => (release = r)) : undefined)));
    open({ entryId: ENTRY_A, take: true });
    const submit = await waitFor(() => must('[data-ui="submit-take-from-shelf"]') as HTMLButtonElement);
    await waitFor(() => expect(submit.disabled).toBe(false));
    await waitFor(() => must('[data-ui="take-annotation"][data-ui-key="p1"]'));
    fireEvent.click(must('[data-ui="take-annotation"][data-ui-key="p1"] input'));
    await waitFor(() => expect((must('[data-ui="submit-take-from-shelf"]') as HTMLButtonElement).disabled).toBe(true));
    await act(async () => release(json({ plan: PLAN, planDigest: "f".repeat(64) })));
    await waitFor(() => expect((must('[data-ui="submit-take-from-shelf"]') as HTMLButtonElement).disabled).toBe(false));
  });

  it("an entry replaced before the take: refused, the list is read again (as the message says)", async () => {
    let lists = 0;
    stubFetch(shelfRoutes(() => {
      lists += 1;
      return [OK_ROW];
    }, (url) => (url === `/api/shelf/entries/${ENTRY_A}/take` ? json({ detail: "replaced", code: "changed", currentRev: 3 }, 409) : undefined)));
    open({ entryId: ENTRY_A, take: true });
    const submit = await waitFor(() => must('[data-ui="submit-take-from-shelf"]') as HTMLButtonElement);
    await waitFor(() => expect(submit.disabled).toBe(false));
    const before = lists;
    fireEvent.click(submit);
    const box = await waitFor(() => must('[data-ui="take-from-shelf-error"]'));
    expect(box.textContent).toContain("列表已重新读取");
    await waitFor(() => expect(lists).toBe(before + 1));
  });

  it("an entry replaced before the preview: the list is read again too (the Take button never gets a plan)", async () => {
    let lists = 0;
    stubFetch(shelfRoutes(() => {
      lists += 1;
      return [OK_ROW];
    }, (url) => (url === `/api/shelf/entries/${ENTRY_A}/take/preview` ? json({ detail: "replaced", code: "changed", currentRev: 3 }, 409) : undefined)));
    open({ entryId: ENTRY_A, take: true });
    await waitFor(() => expect(lists).toBeGreaterThanOrEqual(2));
  });

  it("entry_invalid names the part and the problem in words; a write failure without cleanedUp claims no undo", async () => {
    let answer = json({ detail: "x", code: "entry_invalid", docId: "pdf-0f3b7d21", part: "annotations", problem: "pdf_annotations" }, 422);
    stubFetch(shelfRoutes(() => [OK_ROW], (url) => (url === `/api/shelf/entries/${ENTRY_A}/take` ? answer.clone() : undefined)));
    open({ entryId: ENTRY_A, take: true });
    const submit = await waitFor(() => must('[data-ui="submit-take-from-shelf"]') as HTMLButtonElement);
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    const box = await waitFor(() => must('[data-ui="take-from-shelf-error"]'));
    expect(box.textContent).toContain("pdf-0f3b7d21 的标注：PDF 标注文件与原件不符");
    answer = json({ detail: "the library could not be read", code: "write_failed" }, 500);
    fireEvent.click(submit);
    await waitFor(() => expect(must('[data-ui="take-from-shelf-error"]').textContent).toContain("写入项目失败。"));
    expect(must('[data-ui="take-from-shelf-error"]').textContent).not.toContain("已撤销");
  });

  it("the entry on screen goes away (another tab deleted it): back to a summary, not another paper's take step", async () => {
    let rows: unknown[] = [OK_ROW, OTHER_ROW];
    stubFetch(shelfRoutes(() => rows));
    open({ entryId: ENTRY_A, take: true });
    await waitFor(() => must('[data-ui="take-from-shelf"]'));
    rows = [OTHER_ROW];
    act(() => fakeBus.emit("shelf.changed", { cause: "delete", entry_id: ENTRY_A, rev: 2, removed: [{ entry_id: ENTRY_A, rev: 2 }], at: "x" }));
    await waitFor(() => expect(document.querySelector('[data-ui="take-from-shelf"]')).toBeNull());
    expect(must('[data-ui="shelf-entry-summary"]').getAttribute("data-ui-key")).toBe(ENTRY_B);
  });

  it("after a delete the focus is inside the Shelf dialog", async () => {
    let rows: unknown[] = [OK_ROW];
    stubFetch(shelfRoutes(() => rows, (_url, init) => {
      if (init?.method !== "DELETE") return undefined;
      rows = [];
      return json({ deleted: { entryId: ENTRY_A, rev: 2 } });
    }));
    open();
    await waitFor(() => must('[data-ui="delete-shelf-entry"]'));
    must('[data-ui="delete-shelf-entry"]').focus();
    fireEvent.click(must('[data-ui="delete-shelf-entry"]'));
    fireEvent.click(await waitFor(() => must('[data-ui="confirm-delete-shelf-entry"]')));
    await waitFor(() => expect(document.querySelector('[data-ui="delete-shelf-entry-dialog"]')).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(must('[data-ui="shelf-dialog"]').contains(document.activeElement)).toBe(true);
  });
});
