/**
 * Manual editing of the argument graph (ticket 05) at the component seam in happy-dom: new argument to saved, the form,
 * the pickers and their layer filter, delete with undo, clear with its confirmation, a refused write (409, 400, the
 * pure operations' refusals) keeping what was typed, an update from elsewhere during editing, the leave-draft guard and
 * source editing. The server is a small stateful stand-in behind a stubbed global fetch (the real `api/` and the real
 * schema run), the socket is `createFakeBus`. The role chooser after a canvas drag is in argument-edit-connect.test.tsx
 * (it needs the canvas stubbed); layout and pixels are checked in a real browser.
 */
import { type ArgumentGraph, ArgumentGraphSchema } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { askWorkspaceLeave } from "../src/argelander/workspace";
import { ArgumentGraphMode } from "../src/argument/ArgumentGraphMode";
import type { LibraryRef } from "../src/library/types";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";
import { graphChanged } from "./fake-ws";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const last = <T,>(a: T[]): T => a[a.length - 1] as T;
const WORK_ID = "arxiv:0000.00001";
const LATEX = "arxiv-0000.00001";
const PDF = "pdf-7c1e-synthetic";
const WORK: LibraryRef = { id: WORK_ID, title: "合成星团论文", authors: "Zhang, Li & Wang", year: 2024, venue: "ApJ", type: "article", cite: "zhang2024", tags: [], pdf: false, read: false, star: false, doc_ids: [LATEX, PDF] };

const IR = {
  sections: [
    { id: "sec-1", level: 1, number: "1", heading: "Introduction", blocks: [], children: [] },
    {
      id: "sec-4",
      level: 1,
      number: "3",
      heading: "Method",
      blocks: [
        { id: "fig-4", type: "figure", number: "4" },
        { id: "tab-2", type: "table", number: "2" },
        { id: "eq-7", type: "equation", number: "7" },
        { id: "eq-x", type: "equation" },
        { id: "p-1", type: "paragraph" },
      ],
      children: [{ id: "sec-5", level: 2, number: "3.2", heading: "Selection", blocks: [], children: [] }],
    },
  ],
};
const pdfDescription = {
  doc_id: PDF,
  format: "pdf",
  acquired_via: "user_pdf_upload",
  acquired_at: "2026-01-01T00:00:00+00:00",
  owner_work_id: WORK_ID,
  work_title: "t",
  display_name: "p.pdf",
  byte_length: 10,
  sha256: "a".repeat(64),
  page_count: 14,
  pages: Array.from({ length: 14 }, () => ({ width: 600, height: 800, rotation: 0 })),
};

/** A stateful stand-in for the argument graph endpoints. */
let store: ArgumentGraph;
let puts: ArgumentGraph[];
let putReply: ((body: ArgumentGraph) => Response | null) | null;
let beforePut: (() => void) | null;
/** While set, a PUT waits for it before the server looks at it (a write in flight). */
let holdPut: Promise<void> | null;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  void i18n.changeLanguage("zh-CN");
  vi.stubGlobal("ResizeObserver", RO);
  store = ARGUMENT_FIXTURES.clean();
  puts = [];
  putReply = null;
  beforePut = null;
  holdPut = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/argument-graph")) {
        if (init?.method === "PUT") {
          beforePut?.();
          const body = JSON.parse(String(init.body)) as ArgumentGraph;
          puts.push(body);
          if (holdPut) await holdPut;
          const forced = putReply?.(body);
          if (forced) return forced;
          if (body.rev !== store.rev) return json(409, { detail: "rev mismatch", rev: store.rev });
          const parsed = ArgumentGraphSchema.safeParse(body);
          if (!parsed.success) return json(400, { detail: parsed.error.issues.map((i) => i.message).join("; ") });
          store = { ...parsed.data, rev: store.rev + 1 };
          return json(200, store);
        }
        return json(200, store);
      }
      if (url.endsWith(`/api/paper/${LATEX}/description`)) return json(200, { doc_id: LATEX, format: "latex" });
      if (url.endsWith(`/api/paper/${PDF}/description`)) return json(200, pdfDescription);
      if (url.endsWith(`/api/paper/${LATEX}/ir`)) return json(200, IR);
      return json(404, { detail: "no" });
    })
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = (props: Partial<Parameters<typeof ArgumentGraphMode>[0]> = {}) => render(<ArgumentGraphMode workId={WORK_ID} work={WORK} onExit={() => {}} onOpenDoc={() => {}} {...props} />);
const ready = async (c: HTMLElement) => waitFor(() => expect(c.querySelector('[data-ui="argument-graph-view"]')!.getAttribute("data-phase")).toBe("ready"));
const q = <T extends HTMLElement = HTMLElement>(root: ParentNode, ui: string, key?: string): T | null => (key === undefined ? root.querySelector<T>(`[data-ui="${ui}"]`) : root.querySelector<T>(`[data-ui="${ui}"][data-ui-key="${key}"]`));
const must = <T extends HTMLElement = HTMLElement>(root: ParentNode, ui: string, key?: string): T => {
  const el = q<T>(root, ui, key);
  if (!el) throw new Error(`no [data-ui=${ui}]${key ? `[${key}]` : ""}`);
  return el;
};
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const open = async (c: HTMLElement, id: string) => {
  fireEvent.click(must(c, "argument-outline-row", id));
  await waitFor(() => expect(q(c, "argument-detail")?.getAttribute("data-ui-key")).toBe(id));
};
const field = (c: HTMLElement, key: string) => must<HTMLTextAreaElement>(must(c, "argument-field", key), "argument-field-input");
const sectionLinks = (c: HTMLElement, key: string) => [...must(c, "argument-field", key).querySelectorAll('[data-ui="argument-link"]')].map((e) => e.getAttribute("data-ui-key"));

async function startNew(c: HTMLElement) {
  fireEvent.click(must(c, "create-argument"));
  await waitFor(() => expect(q(c, "argument-title-input")).not.toBeNull());
}

describe("new argument", () => {
  it("opens the panel in edit mode on the short title; an empty title cannot be saved; Save writes at the rev that was read and selects it", async () => {
    const { container } = mount();
    await ready(container);
    await startNew(container);
    const panel = must(container, "argument-detail");
    expect(panel.getAttribute("data-mode")).toBe("edit");
    expect(document.activeElement).toBe(must(container, "argument-title-input"));
    const save = must<HTMLButtonElement>(container, "save-argument");
    expect(save.disabled).toBe(true);
    type(must(container, "argument-title-input"), "新的论证");
    type(field(container, "claim"), "新 Claim");
    fireEvent.click(must(must(container, "argument-kind"), "argument-kind-option", "native"));
    expect(save.disabled).toBe(false);
    await act(async () => fireEvent.click(save));
    await waitFor(() => expect(puts).toHaveLength(1));
    const sent = puts[0]!;
    expect(sent.rev).toBe(7);
    expect(sent.arguments).toHaveLength(12);
    expect(last(sent.arguments)).toMatchObject({ title: "新的论证", claim: "新 Claim", kind: "native" });
    // the answer is adopted without waiting for the broadcast: counts move, the new argument is selected and read
    await waitFor(() => expect(must(container, "argument-graph-counts").textContent).toBe("12 个论证 · 13 条边"));
    await waitFor(() => expect(must(container, "argument-detail").getAttribute("data-mode")).toBe("read"));
    expect(must(container, "argument-detail-title").textContent).toBe("新的论证");
  });

  it("Cancel discards it without any write, and an empty graph's first argument goes the same way", async () => {
    store = ARGUMENT_FIXTURES.empty();
    const { container } = mount();
    await ready(container);
    fireEvent.click(must(container, "create-first-argument"));
    await waitFor(() => expect(q(container, "argument-title-input")).not.toBeNull());
    type(must(container, "argument-title-input"), "草稿");
    fireEvent.click(must(container, "cancel-argument-edit"));
    expect(q(container, "argument-detail")).toBeNull();
    expect(puts).toHaveLength(0);
    // the discard of a typed draft asked first (it was dirty) and the answer was yes
    expect(window.confirm).not.toHaveBeenCalled(); // Cancel is the explicit discard: no second question
    fireEvent.click(must(container, "create-first-argument"));
    await waitFor(() => expect(q(container, "argument-title-input")).not.toBeNull());
    type(must(container, "argument-title-input"), "第一个");
    await act(async () => fireEvent.click(must(container, "save-argument")));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ rev: 0, arguments: [{ id: expect.stringMatching(/^a[0-9a-z]{5}$/), title: "第一个" }] });
    await waitFor(() => expect(q(container, "argument-graph-empty")).toBeNull());
  });

  it("linking waits for the first save", async () => {
    const { container } = mount();
    await ready(container);
    await startNew(container);
    for (const b of container.querySelectorAll<HTMLButtonElement>('[data-ui="add-argument-link"], [data-ui="add-argument-use"]')) expect(b.disabled).toBe(true);
    expect(q(container, "delete-argument")).toBeNull();
  });
});

describe("editing an existing argument", () => {
  it("edits the title, kind, fields and Warrant's implicit flag, saving only what changed over the stored argument", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m2");
    fireEvent.click(must(container, "edit-argument"));
    expect(must<HTMLButtonElement>(container, "save-argument").disabled).toBe(true); // nothing changed yet
    type(must(container, "argument-title-input"), "成员延伸得更远");
    type(field(container, "rebuttal"), "反驳");
    fireEvent.click(must(container, "argument-warrant-implicit-input"));
    expect(must<HTMLButtonElement>(container, "save-argument").disabled).toBe(false);
    await act(async () => fireEvent.click(must(container, "save-argument")));
    await waitFor(() => expect(puts).toHaveLength(1));
    const m2 = puts[0]!.arguments.find((a) => a.id === "m2")!;
    expect(m2).toMatchObject({ title: "成员延伸得更远", rebuttal: "反驳", warrant_implicit: false });
    expect(m2.claim).toBe(ARGUMENT_FIXTURES.clean().arguments.find((a) => a.id === "m2")!.claim);
    expect(puts[0]!.edges).toEqual(ARGUMENT_FIXTURES.clean().edges);
    await waitFor(() => expect(must(container, "argument-detail").getAttribute("data-mode")).toBe("read"));
  });

  it("Cancel puts the stored text back", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m2");
    fireEvent.click(must(container, "edit-argument"));
    type(must(container, "argument-title-input"), "改了");
    fireEvent.click(must(container, "cancel-argument-edit"));
    expect(must(container, "argument-detail-title").textContent).toBe("成员延伸到潮汐半径之外");
    expect(puts).toHaveLength(0);
  });
});

describe("linking from the panel", () => {
  it("lists only the arguments one layer below by default, 'show all' puts them first, and one with the role already is left out", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m1"); // layer 1: n1, n2 feed it
    fireEvent.click(must(container, "edit-argument")); // an empty Backing shows (and takes links) in edit mode only
    fireEvent.click(must(must(container, "argument-field", "backing"), "add-argument-link"));
    const picker = must(container, "argument-picker", "backing");
    expect(picker.getAttribute("data-scope")).toBe("near");
    const titles = (el: Element) => [...el.querySelectorAll("option")].map((o) => o.textContent).filter((x) => x && !x.includes("选择论证"));
    const select = must<HTMLSelectElement>(picker, "argument-picker-select");
    const near = titles(select);
    expect(near).toEqual(expect.arrayContaining(["Gaia DR3 的自行精度足够", "收敛点法能识别共动恒星"]));
    expect(near).not.toContain("星团正在瓦解"); // higher up
    expect(near).not.toContain("成员延伸到潮汐半径之外"); // one layer above
    fireEvent.click(must(picker, "argument-picker-show-all"));
    expect(picker.getAttribute("data-scope")).toBe("all");
    const groups = [...select.querySelectorAll("optgroup")].map((g) => g.label);
    expect(groups).toEqual(["低一层的论证", "其他论证"]);
    expect(titles(select)).toContain("星团正在瓦解");
    // Grounds: n1 already supports m1 as Grounds, so it is not offered there
    fireEvent.click(must(must(container, "argument-field", "grounds"), "add-argument-link"));
    const grounds = must(container, "argument-picker", "grounds");
    expect(titles(must(grounds, "argument-picker-select"))).not.toContain("Gaia DR3 的自行精度足够");
  });

  it("falls back to all arguments by itself when the layer below is empty (a bottom-layer argument)", async () => {
    const lo = ARGUMENT_FIXTURES.empty();
    lo.arguments = [
      { id: "lo", title: "底", claim: "", grounds: "", warrant: "", backing: "", qualifier: "", rebuttal: "", warrant_implicit: false, kind: "native", sources: [] },
      { id: "hi", title: "顶", claim: "", grounds: "", warrant: "", backing: "", qualifier: "", rebuttal: "", warrant_implicit: false, kind: "end", sources: [] },
    ];
    lo.edges = [{ from: "lo", to: "hi", role: "grounds" }];
    store = lo;
    const { container } = mount();
    await ready(container);
    fireEvent.click(must(container, "argument-outline-row", "hi"));
    fireEvent.click(must(container, "select-linked-argument")); // hi's Grounds link to lo
    await waitFor(() => expect(q(container, "argument-detail")?.getAttribute("data-ui-key")).toBe("lo"));
    fireEvent.click(must(must(container, "argument-field", "grounds"), "add-argument-link"));
    const picker = must(container, "argument-picker", "grounds");
    expect(picker.getAttribute("data-scope")).toBe("all");
    expect(must<HTMLInputElement>(picker, "argument-picker-show-all").disabled).toBe(true);
  });

  it("picking one writes a Grounds edge into this argument; 'used by' picks one a layer above and a role", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m1");
    fireEvent.click(must(container, "edit-argument"));
    fireEvent.click(must(must(container, "argument-field", "backing"), "add-argument-link"));
    const picker = must(container, "argument-picker", "backing");
    type(must(picker, "argument-picker-select"), "n3");
    await act(async () => fireEvent.click(must(picker, "add-picked-argument")));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(last(puts[0]!.edges)).toEqual({ from: "n3", to: "m1", role: "backing" });
    await waitFor(() => expect(sectionLinks(container, "backing")).toEqual(["n3"]));
    // used by: layer above m1 is m2/m3/m5; a role the pair already has is not selectable
    fireEvent.click(must(container, "add-argument-use"));
    const use = must(container, "argument-picker", "use");
    expect(use.getAttribute("data-scope")).toBe("near");
    type(must(use, "argument-picker-select"), "m2");
    const role = must<HTMLSelectElement>(use, "argument-picker-role");
    expect([...role.options].find((o) => o.value === "grounds")!.disabled).toBe(true); // m1 -> m2 grounds exists
    type(role, "rebuttal");
    await act(async () => fireEvent.click(must(use, "add-picked-argument")));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(last(puts[1]!.edges)).toEqual({ from: "m1", to: "m2", role: "rebuttal" });
    expect(puts[1]!.rev).toBe(8);
  });

  it("removes a relation from the panel", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m1");
    const link = must(must(container, "argument-field", "grounds"), "argument-link", "n1");
    await act(async () => fireEvent.click(must(link, "remove-argument-link")));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.edges.some((e) => e.from === "n1" && e.to === "m1")).toBe(false);
    expect(puts[0]!.edges).toHaveLength(12);
  });

  it("a write that loses the race to another writer says so and loads the latest, nothing is overwritten", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m1");
    store = { ...store, rev: 9 }; // someone else wrote meanwhile
    const link = must(must(container, "argument-field", "grounds"), "argument-link", "n1");
    await act(async () => fireEvent.click(must(link, "remove-argument-link")));
    await waitFor(() => expect(within(container).getByText(/已在别处更新，这次改动没有写入/)).toBeTruthy());
    expect(store.edges).toHaveLength(13);
    expect(store.rev).toBe(9);
  });
});

describe("delete and undo", () => {
  it("deletes without asking, with its edges, and offers Undo that restores it through a rev-carrying write", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m5");
    await act(async () => fireEvent.click(must(container, "delete-argument")));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull(); // no confirmation dialog of any kind
    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.rev).toBe(7);
    expect(puts[0]!.arguments.some((a) => a.id === "m5")).toBe(false);
    expect(puts[0]!.edges.some((e) => e.from === "m5" || e.to === "m5")).toBe(false);
    await waitFor(() => expect(must(container, "argument-graph-counts").textContent).toBe("10 个论证 · 11 条边"));
    expect(q(container, "argument-detail")).toBeNull();
    const notice = must(container, "argument-notice");
    expect(notice.textContent).toContain("已删除「尾部质量函数更平」及其 2 条边");
    await act(async () => fireEvent.click(must(notice, "argument-notice-action")));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]!.rev).toBe(8);
    expect(puts[1]).toEqual({ ...ARGUMENT_FIXTURES.clean(), rev: 8 });
    await waitFor(() => expect(must(container, "argument-graph-counts").textContent).toBe("11 个论证 · 13 条边"));
    await waitFor(() => expect(q(container, "argument-detail")?.getAttribute("data-ui-key")).toBe("m5"));
  });

  it("if the graph was changed meanwhile, Undo fails and says so; nothing is overwritten", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m5");
    await act(async () => fireEvent.click(must(container, "delete-argument")));
    await waitFor(() => expect(must(container, "argument-notice-action")).toBeTruthy());
    store = { ...store, rev: store.rev + 1, arguments: store.arguments.map((a) => (a.id === "m4" ? { ...a, title: "别处改的" } : a)) };
    await act(async () => fireEvent.click(must(container, "argument-notice-action")));
    await waitFor(() => expect(within(container).getByText(/期间被改动过，无法撤销/)).toBeTruthy());
    expect(store.arguments.some((a) => a.id === "m5")).toBe(false);
    expect(store.arguments.find((a) => a.id === "m4")!.title).toBe("别处改的");
  });

  it("a later write of its own ends the chance to undo the delete before it", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m5");
    await act(async () => fireEvent.click(must(container, "delete-argument")));
    await waitFor(() => expect(q(container, "argument-notice-action")).not.toBeNull());
    await open(container, "m4");
    await act(async () => fireEvent.click(must(must(must(container, "argument-field", "grounds"), "argument-link", "m2"), "remove-argument-link")));
    await waitFor(() => expect(puts).toHaveLength(2));
    await waitFor(() => expect(q(container, "argument-notice-action")).toBeNull());
  });
});

describe("notices (toast position and keyboard)", () => {
  it("each notice and its buttons carry a key that tells the instances apart; Undo is reachable by Ctrl+Z outside a text field, and not inside one", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m5");
    await act(async () => fireEvent.click(must(container, "delete-argument")));
    const action = await waitFor(() => must(container, "argument-notice-action"));
    const notice = must(container, "argument-notice");
    expect(notice.getAttribute("data-ui-key")).toBe(action.getAttribute("data-ui-key"));
    expect(must(container, "dismiss-argument-notice").getAttribute("data-ui-key")).toBe(action.getAttribute("data-ui-key"));
    expect(must(container, "argument-notices").getAttribute("aria-live")).toBe("polite");
    // the notices sit inside the canvas column (the toast convention), not as a corner box over the view
    expect(must(container, "argument-main").contains(must(container, "argument-notices"))).toBe(true);
    // typing in a field: Ctrl+Z is the field's own
    await open(container, "m2");
    fireEvent.click(must(container, "edit-argument"));
    fireEvent.keyDown(must(container, "argument-title-input"), { key: "z", ctrlKey: true });
    expect(store.arguments.some((a) => a.id === "m5")).toBe(false);
    fireEvent.click(must(container, "cancel-argument-edit"));
    // the keyboard outside this view (another pane, the page behind) is not ours
    await act(async () => fireEvent.keyDown(document.body, { key: "z", ctrlKey: true }));
    expect(store.arguments.some((a) => a.id === "m5")).toBe(false);
    await act(async () => fireEvent.keyDown(must(container, "argument-main"), { key: "z", ctrlKey: true }));
    await waitFor(() => expect(store.arguments.some((a) => a.id === "m5")).toBe(true));
  });
});

describe("clear", () => {
  it("asks first, naming the counts, with the focus on Cancel; Cancel writes nothing, Clear writes the empty graph", async () => {
    const { container } = mount();
    await ready(container);
    fireEvent.click(must(container, "clear-argument-graph"));
    const dialog = must(document.body, "clear-argument-graph-dialog");
    expect(dialog.textContent).toContain("全部 11 个论证和 13 条边");
    expect(dialog.textContent).toContain("不能撤销");
    expect(document.activeElement).toBe(must(dialog, "cancel-clear-argument-graph"));
    fireEvent.click(must(dialog, "cancel-clear-argument-graph"));
    expect(puts).toHaveLength(0);
    fireEvent.click(must(container, "clear-argument-graph"));
    await act(async () => fireEvent.click(must(must(document.body, "clear-argument-graph-dialog"), "confirm-clear-argument-graph")));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ rev: 7, arguments: [], edges: [] });
    await waitFor(() => expect(q(container, "argument-graph-empty")).not.toBeNull());
    expect(q(document.body, "clear-argument-graph-dialog")).toBeNull();
  });

  it("a refused clear keeps the dialog open and says why", async () => {
    const { container } = mount();
    await ready(container);
    store = { ...store, rev: 12 };
    fireEvent.click(must(container, "clear-argument-graph"));
    await act(async () => fireEvent.click(must(must(document.body, "clear-argument-graph-dialog"), "confirm-clear-argument-graph")));
    await waitFor(() => expect(within(must(document.body, "clear-argument-graph-dialog")).getByText(/没有写入/)).toBeTruthy());
    expect(store.arguments).toHaveLength(11);
  });
});

describe("refused saves keep the draft", () => {
  it("a 409 overwrites nothing, shows the conflict, keeps every typed character; after Reload the same text saves", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m2");
    fireEvent.click(must(container, "edit-argument"));
    type(must(container, "argument-title-input"), "我的标题");
    type(field(container, "claim"), "我写的很长的 Claim");
    // someone else writes first (an external agent), a different argument
    store = { ...store, rev: 8, arguments: store.arguments.map((a) => (a.id === "e1" ? { ...a, qualifier: "外部" } : a)) };
    await act(async () => fireEvent.click(must(container, "save-argument")));
    const box = await waitFor(() => must(container, "argument-save-conflict"));
    expect(box.textContent).toContain("论证图已在别处更新");
    expect(box.textContent).toContain("从 7 变为 8");
    expect(store.arguments.find((a) => a.id === "m2")!.title).toBe("成员延伸到潮汐半径之外"); // not overwritten
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe("我的标题");
    expect(field(container, "claim").value).toBe("我写的很长的 Claim");
    expect(must<HTMLButtonElement>(container, "save-argument").disabled).toBe(true);
    await act(async () => fireEvent.click(must(container, "reload-argument-graph")));
    await waitFor(() => expect(q(container, "argument-save-conflict")).toBeNull());
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe("我的标题");
    await act(async () => fireEvent.click(must(container, "save-argument")));
    await waitFor(() => expect(store.arguments.find((a) => a.id === "m2")!.title).toBe("我的标题"));
    expect(store.rev).toBe(9);
  });

  it("a Save queued behind another write is judged against the graph it runs on: an argument changed elsewhere meanwhile is not overwritten", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m1");
    fireEvent.click(must(container, "edit-argument"));
    type(must(container, "argument-title-input"), "我改的标题");
    let release!: () => void;
    holdPut = new Promise<void>((r) => (release = r));
    // a link's x is a write in flight (held) ...
    fireEvent.click(container.querySelector<HTMLElement>('[data-ui="remove-argument-link"]')!);
    await waitFor(() => expect(puts).toHaveLength(1));
    // ... Save is queued behind it (the page still believes nothing changed) ...
    fireEvent.click(must(container, "save-argument"));
    // ... and someone else edits this very argument; the page reads the newer graph before the first PUT answers
    store = { ...store, rev: store.rev + 1, arguments: store.arguments.map((a) => (a.id === "m1" ? { ...a, qualifier: "别处写的" } : a)) };
    await act(async () => graphChanged(WORK_ID));
    await waitFor(() => expect(q(container, "argument-save-conflict")).not.toBeNull());
    await act(async () => release());
    await waitFor(() => expect(q(container, "argument-save-conflict")).not.toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(puts).toHaveLength(1); // the queued Save never wrote
    expect(store.arguments.find((a) => a.id === "m1")!.qualifier).toBe("别处写的");
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe("我改的标题");
  });

  it("an update from elsewhere during editing never drops the draft; one that touches this argument blocks Save until Reload", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m2");
    fireEvent.click(must(container, "edit-argument"));
    type(must(container, "argument-title-input"), "草稿标题");
    // another argument changed: the draft is still saveable (rebased on the newer rev)
    store = { ...store, rev: 8, arguments: store.arguments.map((a) => (a.id === "e1" ? { ...a, qualifier: "外部" } : a)) };
    await act(async () => graphChanged(WORK_ID));
    await waitFor(() => expect(store.rev).toBe(8));
    await waitFor(() => expect(must(container, "argument-graph-view").getAttribute("data-phase")).toBe("ready"));
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe("草稿标题");
    expect(q(container, "argument-save-conflict")).toBeNull();
    // this very argument changed: the draft stays, the conflict is shown at once
    store = { ...store, rev: 9, arguments: store.arguments.map((a) => (a.id === "m2" ? { ...a, claim: "别处改的 claim" } : a)) };
    await act(async () => graphChanged(WORK_ID));
    await waitFor(() => expect(q(container, "argument-save-conflict")).not.toBeNull());
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe("草稿标题");
    expect(must<HTMLButtonElement>(container, "save-argument").disabled).toBe(true);
    expect(puts).toHaveLength(0);
  });

  it("an argument deleted elsewhere while its form is dirty keeps the form; Reload then lets Save create it again", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m5");
    fireEvent.click(must(container, "edit-argument"));
    type(must(container, "argument-title-input"), "还在写");
    store = { ...store, rev: 8, arguments: store.arguments.filter((a) => a.id !== "m5"), edges: store.edges.filter((e) => e.from !== "m5" && e.to !== "m5") };
    await act(async () => graphChanged(WORK_ID));
    await waitFor(() => expect(must(container, "argument-save-conflict").textContent).toContain("已在别处被删除"));
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe("还在写");
    await act(async () => fireEvent.click(must(container, "reload-argument-graph")));
    await waitFor(() => expect(q(container, "argument-save-conflict")).toBeNull());
    await act(async () => fireEvent.click(must(container, "save-argument")));
    await waitFor(() => expect(store.arguments.some((a) => a.id === "m5" && a.title === "还在写")).toBe(true));
  });

  it("says in words what the pure operations refuse: a title over the limit is never sent", async () => {
    const { container } = mount();
    await ready(container);
    await startNew(container);
    type(must(container, "argument-title-input"), "字".repeat(81));
    await act(async () => fireEvent.click(must(container, "save-argument")));
    const msg = await waitFor(() => must(container, "argument-save-invalid"));
    expect(msg.textContent).toContain("短标题最多 80 个字符");
    expect(puts).toHaveLength(0);
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toHaveLength(81);
  });

  it("a server 400 is shown with its reason and the draft stays", async () => {
    const { container } = mount();
    await ready(container);
    await startNew(container);
    type(must(container, "argument-title-input"), "好标题");
    putReply = () => json(400, { detail: "arguments.0.title: nope" });
    await act(async () => fireEvent.click(must(container, "save-argument")));
    const msg = await waitFor(() => must(container, "argument-save-invalid"));
    expect(msg.textContent).toContain("没有保存");
    expect(msg.textContent).toContain("arguments.0.title: nope");
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe("好标题");
  });
});

describe("leave-draft protection (the app's own dialog, never window.confirm)", () => {
  const leaveDialog = () => q(document.body, "argument-leave-dialog");
  const answer = async (ui: "keep-editing-argument" | "discard-argument-draft") => {
    await act(async () => fireEvent.click(must(must(document.body, "argument-leave-dialog"), ui)));
  };

  it("moving to another argument or closing the panel asks with a dialog while the draft is dirty, and only then", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { container } = mount();
    await ready(container);
    await open(container, "m2");
    fireEvent.click(must(container, "edit-argument"));
    fireEvent.click(must(container, "argument-outline-row", "m3")); // not dirty: no question
    await waitFor(() => expect(q(container, "argument-detail")?.getAttribute("data-ui-key")).toBe("m3"));
    expect(leaveDialog()).toBeNull();
    await open(container, "m2");
    fireEvent.click(must(container, "edit-argument"));
    type(must(container, "argument-title-input"), "没存的");
    fireEvent.click(must(container, "argument-outline-row", "m3"));
    const dialog = await waitFor(() => must(document.body, "argument-leave-dialog"));
    // names the argument whose changes would go; the default focus is on keeping them
    expect(dialog.textContent).toContain("成员延伸到潮汐半径之外");
    expect(document.activeElement).toBe(must(dialog, "keep-editing-argument"));
    await answer("keep-editing-argument");
    expect(leaveDialog()).toBeNull();
    expect(must(container, "argument-detail").getAttribute("data-ui-key")).toBe("m2");
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe("没存的");
    fireEvent.click(must(container, "close-argument-detail"));
    await waitFor(() => expect(leaveDialog()).not.toBeNull());
    await answer("keep-editing-argument");
    expect(q(container, "argument-detail")).not.toBeNull();
    fireEvent.click(must(container, "argument-outline-row", "m3"));
    await waitFor(() => expect(leaveDialog()).not.toBeNull());
    await answer("discard-argument-draft");
    await waitFor(() => expect(q(container, "argument-detail")?.getAttribute("data-ui-key")).toBe("m3"));
    expect(q(container, "argument-title-input")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("the return button and a new-argument click are guarded the same way; discarding a dirty new draft starts a blank one", async () => {
    const onExit = vi.fn();
    const { container } = mount({ onExit });
    await ready(container);
    await startNew(container);
    type(must(container, "argument-title-input"), "半截");
    fireEvent.click(must(container, "argument-return-to-library"));
    await waitFor(() => expect(leaveDialog()).not.toBeNull());
    expect(leaveDialog()!.textContent).toContain("新建的论证");
    await answer("keep-editing-argument");
    expect(onExit).not.toHaveBeenCalled();
    fireEvent.click(must(container, "create-argument")); // starting another new one is the same question
    await waitFor(() => expect(leaveDialog()).not.toBeNull());
    await answer("keep-editing-argument");
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe("半截");
    fireEvent.click(must(container, "create-argument"));
    await waitFor(() => expect(leaveDialog()).not.toBeNull());
    await answer("discard-argument-draft");
    await waitFor(() => expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe(""));
    expect(document.activeElement).toBe(must(container, "argument-title-input"));
    fireEvent.click(must(container, "argument-return-to-library"));
    expect(onExit).toHaveBeenCalledTimes(1); // the blank form is untouched: nothing to ask
  });

  it("an untouched new argument is not a draft: leaving asks nothing", async () => {
    const onExit = vi.fn();
    const { container } = mount({ onExit });
    await ready(container);
    await startNew(container);
    fireEvent.click(must(container, "argument-return-to-library"));
    expect(leaveDialog()).toBeNull();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("clearing the graph over a dirty draft asks the same question first", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m2");
    fireEvent.click(must(container, "edit-argument"));
    type(must(container, "argument-title-input"), "没存的");
    fireEvent.click(must(container, "clear-argument-graph"));
    await waitFor(() => expect(leaveDialog()).not.toBeNull());
    expect(q(document.body, "clear-argument-graph-dialog")).toBeNull();
    await answer("discard-argument-draft");
    await waitFor(() => expect(q(document.body, "clear-argument-graph-dialog")).not.toBeNull());
  });

  it("the workspace leave guard exists only while a draft is unsaved, speaks only for leaving this pane's Library page, and waits for the dialog", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { container } = mount({ paneId: 3 });
    await ready(container);
    expect(askWorkspaceLeave("library")).toBe(true);
    await open(container, "m2");
    fireEvent.click(must(container, "edit-argument"));
    expect(askWorkspaceLeave("library")).toBe(true);
    type(must(container, "argument-title-input"), "没存的");
    await waitFor(() => expect(askWorkspaceLeave("doc")).toBe(true)); // leaving a Doc pane is not about this draft ...
    expect(askWorkspaceLeave()).toBe(true); // ... nor is switching the open Doc ...
    expect(askWorkspaceLeave("library", 4)).toBe(true); // ... nor closing another Library pane
    expect(leaveDialog()).toBeNull();
    const pending = askWorkspaceLeave("library", 3);
    expect(typeof pending).toBe("object");
    await waitFor(() => expect(leaveDialog()).not.toBeNull());
    await answer("keep-editing-argument");
    await expect(pending).resolves.toBe(false);
    const second = askWorkspaceLeave("library"); // no pane named: the draft speaks
    await waitFor(() => expect(leaveDialog()).not.toBeNull());
    await answer("discard-argument-draft");
    await expect(second).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(must(container, "cancel-argument-edit"));
    await waitFor(() => expect(askWorkspaceLeave("library")).toBe(true));
  });

  it("when the Copilot asks to leave, the draft refuses at once: no dialog, nothing pending, and the person's own ask still shows the dialog", async () => {
    const { container } = mount({ paneId: 3 });
    await ready(container);
    await open(container, "m2");
    fireEvent.click(must(container, "edit-argument"));
    type(must(container, "argument-title-input"), "没存的");
    await waitFor(() => expect(askWorkspaceLeave("library", 3, "agent")).toBe(false));
    expect(leaveDialog()).toBeNull();
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe("没存的");
    const user = askWorkspaceLeave("library", 3);
    await waitFor(() => expect(leaveDialog()).not.toBeNull());
    await answer("keep-editing-argument");
    await expect(user).resolves.toBe(false);
  });

  it("Undo after a delete restores the argument but never switches away from a form being edited", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m5");
    await act(async () => fireEvent.click(must(container, "delete-argument")));
    await waitFor(() => expect(q(container, "argument-notice-action")).not.toBeNull());
    await open(container, "m2");
    fireEvent.click(must(container, "edit-argument"));
    type(must(container, "argument-title-input"), "没存的");
    await act(async () => fireEvent.click(must(container, "argument-notice-action")));
    await waitFor(() => expect(store.arguments.some((a) => a.id === "m5")).toBe(true));
    expect(leaveDialog()).toBeNull();
    expect(must(container, "argument-detail").getAttribute("data-ui-key")).toBe("m2");
    expect(must<HTMLInputElement>(container, "argument-title-input").value).toBe("没存的");
  });
});

describe("form details", () => {
  it("the picker counts the near group in its own direction's words: 'used by' says one layer above", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m1");
    fireEvent.click(must(container, "add-argument-use"));
    const used = must(container, "argument-picker", "use");
    expect(used.textContent).toMatch(/高一层 \d+ 个/);
    expect(used.textContent).not.toMatch(/低一层 \d+ 个/);
    fireEvent.click(must(container, "edit-argument"));
    fireEvent.click(must(must(container, "argument-field", "backing"), "add-argument-link"));
    expect(must(container, "argument-picker", "backing").textContent).toMatch(/低一层 \d+ 个/);
  });

  it("a target linked in two roles has two distinguishable link rows and remove buttons", async () => {
    store = { ...store, edges: [...store.edges, { from: "m1", to: "m2", role: "backing" }] };
    const { container } = mount();
    await ready(container);
    await open(container, "m1");
    const keys = [...container.querySelectorAll('[data-ui="remove-argument-link"]')].map((e) => e.getAttribute("data-ui-key"));
    expect(keys.filter((k) => k?.startsWith("m2:")).sort()).toEqual(["m2:backing", "m2:grounds"]);
    const rows = [...must(container, "argument-used-by").querySelectorAll('[data-ui="argument-link"]')].map((e) => e.getAttribute("data-ui-key"));
    expect(new Set(rows).size).toBe(rows.length);
  });

  it("the kind control is one tab stop and the arrow keys move the choice; Native and End are explained in visible text", async () => {
    const { container } = mount();
    await ready(container);
    await startNew(container);
    const group = must(container, "argument-kind");
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    await waitFor(() => expect(document.activeElement).toBe(radios[1]));
    fireEvent.keyDown(radios[1]!, { key: "End" });
    expect(radios[2]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radios[2]!, { key: "ArrowRight" });
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    const help = must(container, "argument-kind-help");
    expect(help.textContent).toContain("依据完全来自本文之外");
    expect(help.textContent).toContain("本文的最终贡献或结论");
    expect(group.getAttribute("aria-describedby")).toBe(help.id);
  });

  it("the Doc list names each Doc's format", async () => {
    const { container } = mount();
    await ready(container);
    await open(container, "m4");
    fireEvent.click(must(container, "edit-argument"));
    fireEvent.click(must(container, "add-argument-source"));
    const rows = container.querySelectorAll('[data-ui="argument-source-row"]');
    const doc = must(rows[rows.length - 1] as HTMLElement, "argument-source-doc");
    // the format and the main-Doc mark come before the id, so a narrow list that cuts the end still shows them
    await waitFor(() => expect([...doc.querySelectorAll("option")].some((o) => /^PDF · /.test(o.textContent ?? ""))).toBe(true));
    const labels = [...doc.querySelectorAll("option")].map((o) => o.textContent ?? "");
    expect(labels.find((l) => l.endsWith(LATEX))).toMatch(/^LaTeX · 主 · /);
    expect(labels.find((l) => l.endsWith(PDF))).toBe(`PDF · ${PDF}`);
    // the whole label is also the tooltip of the closed list and of each option
    fireEvent.change(doc, { target: { value: PDF } });
    expect(doc.getAttribute("title")).toBe(`PDF · ${PDF}`);
  });

  it("while Clear is being written the dialog's Cancel is disabled and has no tooltip of its own", async () => {
    const { container } = mount();
    await ready(container);
    fireEvent.click(must(container, "clear-argument-graph"));
    const dialog = await waitFor(() => must(document.body, "clear-argument-graph-dialog"));
    expect(must(dialog, "cancel-clear-argument-graph").closest(".ui-tooltip-anchor")).toBeNull(); // no tooltip repeating its own label
    let release!: () => void;
    holdPut = new Promise<void>((r) => (release = r));
    await act(async () => fireEvent.click(must(dialog, "confirm-clear-argument-graph")));
    await waitFor(() => expect(must<HTMLButtonElement>(dialog, "cancel-clear-argument-graph").disabled).toBe(true));
    await act(async () => release());
    await waitFor(() => expect(q(document.body, "clear-argument-graph-dialog")).toBeNull());
  });

});

describe("sources", () => {
  const editSources = async (c: HTMLElement) => {
    await open(c, "m4");
    fireEvent.click(must(c, "edit-argument"));
  };

  it("lists a shared-IR Doc's sections, figures, tables and numbered equations; a chosen location fills empty text as Section 3.2 / Figure 4, never with §", async () => {
    const { container } = mount();
    await ready(container);
    await editSources(container);
    fireEvent.click(must(container, "add-argument-source"));
    const row = container.querySelectorAll('[data-ui="argument-source-row"]');
    const added = row[row.length - 1] as HTMLElement;
    type(must(added, "argument-source-doc"), LATEX);
    const anchor = await waitFor(() => must<HTMLSelectElement>(added, "argument-source-anchor"));
    const groups = [...anchor.querySelectorAll("optgroup")].map((g) => `${g.label}:${[...g.querySelectorAll("option")].map((o) => o.textContent).join("|")}`);
    expect(groups).toEqual(["章节:1 Introduction|3 Method|3.2 Selection", "图:Figure 4", "表:Table 2", "公式:Equation 7"]); // the unnumbered equation and the paragraph are not offered
    type(anchor, "sec-5");
    expect(must<HTMLInputElement>(added, "argument-source-text-input").value).toBe("Section 3.2");
    type(must(added, "argument-source-text-input"), "");
    type(anchor, "fig-4");
    expect(must<HTMLInputElement>(added, "argument-source-text-input").value).toBe("Figure 4");
    // text the person wrote is kept
    type(must(added, "argument-source-text-input"), "见图 4 的上半");
    type(anchor, "tab-2");
    expect(must<HTMLInputElement>(added, "argument-source-text-input").value).toBe("见图 4 的上半");
    await act(async () => fireEvent.click(must(container, "save-argument")));
    await waitFor(() => expect(puts).toHaveLength(1));
    const sources = puts[0]!.arguments.find((a) => a.id === "m4")!.sources;
    expect(last(sources)).toEqual({ text: "见图 4 的上半", target: { doc_id: LATEX, anchor: "tab-2" } });
  });

  it("a PDF Doc takes a page number; empty text becomes Page 5; text emptied afterwards is filled at save too", async () => {
    const { container } = mount();
    await ready(container);
    await editSources(container);
    fireEvent.click(must(container, "add-argument-source"));
    const rows = container.querySelectorAll('[data-ui="argument-source-row"]');
    const added = rows[rows.length - 1] as HTMLElement;
    type(must(added, "argument-source-doc"), PDF);
    const page = await waitFor(() => must<HTMLInputElement>(added, "argument-source-page"));
    expect(page.max).toBe("14");
    type(page, "5");
    expect(must<HTMLInputElement>(added, "argument-source-text-input").value).toBe("Page 5");
    type(must(added, "argument-source-text-input"), "");
    await act(async () => fireEvent.click(must(container, "save-argument")));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(last(puts[0]!.arguments.find((a) => a.id === "m4")!.sources)).toEqual({ text: "Page 5", target: { doc_id: PDF, page: 5 } });
  });

  it("a source without a complete target is stored as text only; a source with no text at all is refused in words", async () => {
    const { container } = mount();
    await ready(container);
    await editSources(container);
    fireEvent.click(must(container, "add-argument-source"));
    let rows = container.querySelectorAll('[data-ui="argument-source-row"]');
    let added = rows[rows.length - 1] as HTMLElement;
    type(must(added, "argument-source-doc"), LATEX); // a Doc but no location yet
    await act(async () => fireEvent.click(must(container, "save-argument")));
    await waitFor(() => expect(must(container, "argument-save-invalid").textContent).toMatch(/出处需要显示文字/));
    expect(puts).toHaveLength(0);
    rows = container.querySelectorAll('[data-ui="argument-source-row"]');
    added = rows[rows.length - 1] as HTMLElement;
    type(must(added, "argument-source-text-input"), "Appendix B");
    await act(async () => fireEvent.click(must(container, "save-argument")));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(last(puts[0]!.arguments.find((a) => a.id === "m4")!.sources)).toEqual({ text: "Appendix B" });
  });

  it("when a Doc's structure cannot be read the person can still write display text", async () => {
    const { container } = mount();
    await ready(container);
    await editSources(container);
    fireEvent.click(must(container, "add-argument-source"));
    const rows = container.querySelectorAll('[data-ui="argument-source-row"]');
    const added = rows[rows.length - 1] as HTMLElement;
    vi.mocked(fetch).mockImplementationOnce(async () => json(500, { detail: "x" })); // the description
    type(must(added, "argument-source-doc"), LATEX);
    await waitFor(() => expect(added.textContent).toContain("没能读取该 Doc 的结构"));
    expect(q(added, "argument-source-text-input")).not.toBeNull();
  });
});
