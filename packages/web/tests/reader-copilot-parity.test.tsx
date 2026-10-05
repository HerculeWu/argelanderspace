/**
 * The Reader for Copilot (ticket 18). The real Shell, DocPane, ReaderSession, store and annotation layer are
 * rendered over a stubbed HTTP; only the Copilot panel and the WebSocket are replaced. What the assistant is told
 * is built from the admitted epoch (never the mounted DOM), and its navigation goes through the Reader's own
 * jumpTo / anchor / undo / fold controllers.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  buildReaderReading,
  type CopilotViewAction,
  type PageContext,
  PageContextSchema,
  type TexDocIr,
} from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import { registerWorkspaceLeaveGuard } from "../src/argelander/workspace";
import i18n from "../src/i18n";

vi.setConfig({ testTimeout: 30000 });
const h = vi.hoisted(() => ({
  viewAction: null as null | ((action: unknown) => Promise<{ ok: boolean; detail?: string }>),
  context: null as null | PageContext,
  contexts: [] as PageContext[],
  library: new Set<() => void>(),
  annotation: new Set<(id: string) => void>(),
}));
vi.mock("../src/api/ws", () => ({
  onPlanChanged: () => () => {},
  onLibraryChanged: (cb: () => void) => {
    h.library.add(cb);
    return () => h.library.delete(cb);
  },
  onJobEvent: () => () => {},
  onAnnotationChanged: (cb: (id: string) => void) => {
    h.annotation.add(cb);
    return () => h.annotation.delete(cb);
  },
  onWriterChanged: () => () => {},
}));
vi.mock("../src/copilot/Copilot", () => ({
  Copilot: ({ onViewAction, context }: { onViewAction: typeof h.viewAction; context: PageContext }) => {
    h.viewAction = onViewAction;
    if (h.context !== context) h.contexts.push(context);
    h.context = context;
    return null;
  },
}));

const golden = JSON.parse(
  readFileSync(fileURLToPath(new NodeURL("../../../tests/golden/tex/arxiv-2501.17225.json", import.meta.url)), "utf8")
) as TexDocIr;
const END = "UNIQUE-LAST-PARAGRAPH-MARKER-5c1d";
const DOC = golden.docId;
/** The golden paper (38 sections, 25 figures, 4 tables, 76 references) with one unique paragraph at the very end. */
function longIr(): TexDocIr {
  const ir = structuredClone(golden);
  let last = ir.sections[ir.sections.length - 1]!;
  while (last.children.length) last = last.children[last.children.length - 1]!;
  last.blocks.push({ id: "p-end", type: "paragraph", segments: [{ type: "text", text: END }] });
  return ir;
}
function assetsOf(ir: TexDocIr) {
  const paths = new Set<string>();
  const walk = (sections: TexDocIr["sections"]) => {
    for (const s of sections) {
      for (const b of s.blocks) if ((b.type === "figure" || b.type === "table") && b.imgPath) paths.add(b.imgPath);
      walk(s.children);
    }
  };
  walk(ir.sections);
  return [...paths].map((imgPath) => ({ imgPath, sha256: "a".repeat(64) }));
}
const FP = "fp-1";
let ir: TexDocIr;
let annotations: object[];
let fingerprint: string;
let rev: number;
let readStatus: number;
let hold: Promise<void> | null;
let descriptionStatus: number;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

// The store observes blocks with IntersectionObserver (absent in happy-dom): report the first few as visible.
class IOStub {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    if (target.classList.contains("verified-figure")) return;
    const id = (target as HTMLElement).dataset?.blockId;
    if (id === "p-1" || id === "p-2")
      this.cb([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const scrolled: Element[] = [];
const realScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.sessionStorage.clear();
  window.localStorage.clear();
  ir = longIr();
  annotations = [];
  fingerprint = FP;
  rev = 0;
  readStatus = 200;
  hold = null;
  descriptionStatus = 200;
  h.viewAction = null;
  h.context = null;
  h.contexts = [];
  h.library.clear();
  h.annotation.clear();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
  vi.stubGlobal("IntersectionObserver", IOStub);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/plans") return ok({ version: 1, rev: 1, plans: [] });
      if (url === "/api/papers") return ok({ papers: [DOC, "other-doc"] });
      if (url === `/api/paper/${DOC}/description`)
        return descriptionStatus === 200 ? ok({ doc_id: DOC, format: "latex" }) : ({ ok: false, status: descriptionStatus, json: async () => ({}) } as unknown as Response);
      if (url === `/api/paper/${DOC}/annotations?coherent=1`) {
        if (hold) await hold;
        if (readStatus !== 200) return { ok: false, status: readStatus, json: async () => ({}) } as unknown as Response;
        return ok({ version: 1, ir, file: { version: 1, rev, content_fingerprint: fingerprint, annotations }, assets: assetsOf(ir) });
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = realScrollIntoView;
  window.history.replaceState(null, "", "/");
});

/** A settled selection, as the floating annotate bar sees it (selectionchange, then the settle delay). */
function settle(base: Node, from: number, extent: Node, to: number) {
  vi.useFakeTimers();
  act(() => {
    window.getSelection()?.setBaseAndExtent(base, from, extent, to);
    document.dispatchEvent(new Event("selectionchange"));
    vi.advanceTimersByTime(250);
  });
  vi.useRealTimers();
}
const textOf = (el: Element) => document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode() as Node;
const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const run = async (action: CopilotViewAction) => h.viewAction!(action);
const reader = () => h.context!.reader!;
async function boot() {
  render(<Shell />);
  await waitFor(() => expect(h.viewAction).not.toBeNull());
  expect(await run({ action: "switch_view", view: "doc" })).toEqual({ ok: true });
  await waitFor(() => expect(h.context?.reader?.reading).toBeTruthy(), { timeout: 10000 });
}

describe("the page the assistant receives", () => {
  it("is the whole document of the admitted epoch: the last unique paragraph, every block, a valid complete context", async () => {
    await boot();
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
    await waitFor(() => expect(h.context).toMatchObject({ view: "doc", status: "complete" }));
    const reading = reader().reading!;
    expect(reading.entries[reading.entries.length - 1]).toMatchObject({ id: "p-end", text: END });
    expect(reading.epoch.fingerprint).toBe(FP);
    // it is the builder's output for that epoch (the same one the server's read tool uses), not a DOM scrape
    expect(JSON.stringify(reading)).toBe(JSON.stringify(buildReaderReading({ ir, file: { version: 1, rev: 0, content_fingerprint: FP, annotations: [] }, assets: assetsOf(ir) })));
    expect(reading.coverage.sections).toBe(38);
    expect(reading.references).toHaveLength(76);
    expect(reading.entries.filter((e) => e.kind === "figure")).toHaveLength(25);
    expect(reading.entries.filter((e) => e.kind === "table")).toHaveLength(4);
    expect(reading.entries.filter((e) => e.kind === "table").every((e) => e.kind === "table" && (!!e.body || !!e.asset))).toBe(true);
    // every entry is a block the Reader shows
    for (const entry of reading.entries) expect(document.querySelector(`[data-block-id="${entry.id}"]`), entry.id).not.toBeNull();
  });

  it("carries the saved annotations of that epoch with their exact bodies", async () => {
    annotations = [{ id: "a_0000aaaa", target: { type: "document" }, body: " exact bytes ", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }];
    rev = 4;
    await boot();
    await waitFor(() => expect(reader().reading!.annotations.map((a) => a.body)).toEqual([" exact bytes "]));
    await waitFor(() => expect(reader().reading!.epoch).toMatchObject({ annotationsRev: 4, annotations: "current" }));
  });

  it("reports where the user is as a hint and the state of the folds and the back button", async () => {
    await boot();
    await waitFor(() => expect(reader().position?.visibleBlockIds).toEqual(["p-1", "p-2"]), { timeout: 3000 });
    await waitFor(() => expect(reader().position?.activeSectionId).toBeTruthy());
    await waitFor(() => expect(reader().panels).toEqual({ outlineCollapsed: false, rightCollapsed: false, rightTab: "references" }));
    await waitFor(() => expect(reader().canGoBack).toBe(false));
  });

  it("a failed read is an error with no reading, never the old text as if it were current", async () => {
    await boot();
    readStatus = 500;
    act(() => { for (const cb of [...h.annotation]) cb(DOC); });
    await waitFor(() => expect(h.context?.reader?.sync.phase).toBe("error"));
    await waitFor(() => expect(h.context).toMatchObject({ status: "error" }));
    await waitFor(() => expect(reader().reading).toBeNull());
    await waitFor(() => expect(reader().selection).toBeNull());
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
    // the Reader still shows its retained text, but the page does not hand it over as the document
    expect(document.querySelector('[data-block-id="p-end"]')).not.toBeNull();
    readStatus = 200;
    expect(await run({ action: "retry_sync", docId: DOC })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.reader?.sync.phase).toBe("ready"));
    await waitFor(() => expect(reader().reading?.entries[reader().reading!.entries.length - 1]).toMatchObject({ id: "p-end" }));
  });

  it("the selection survives the page selection collapsing (focus moving to the Copilot input) and goes when the user presses in the reading area", async () => {
    await boot();
    const paragraph = document.querySelector("[data-block-id='p-1']")!;
    const text = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode()!;
    vi.useFakeTimers();
    act(() => {
      window.getSelection()!.setBaseAndExtent(text, 0, text, 6);
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersByTime(250);
    });
    vi.useRealTimers();
    await waitFor(() => expect(h.context?.reader?.selection).not.toBeNull(), { timeout: 5000 });
    // the focus moves out: the document selection collapses and the user presses outside the reading area
    act(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
      fireEvent.mouseDown(document.body);
      fireEvent.mouseUp(document.body);
    });
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    await waitFor(() => expect(reader().selection).toMatchObject({ fingerprint: FP, target: { block: "p-1", start: 0, end: 6 } }));
    // a press inside the reading area is the user giving the selection up
    act(() => { fireEvent.mouseDown(document.querySelector("[data-block-id='p-2']")!); });
    await waitFor(() => expect(h.context?.reader?.selection).toBeNull());
  });

  it("a new epoch replaces the reading and drops the old selection; no page ever pairs a selection with another epoch", async () => {
    await boot();
    // the user selects text in p-1 (a settled selection, as the floating bar sees it)
    const paragraph = document.querySelector("[data-block-id='p-1']")!;
    const text = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode()!;
    vi.useFakeTimers();
    act(() => {
      window.getSelection()!.setBaseAndExtent(text, 0, text, 6);
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersByTime(250);
    });
    vi.useRealTimers();
    await waitFor(() => expect(h.context?.reader?.selection).not.toBeNull(), { timeout: 5000 });
    await waitFor(() => expect(reader().selection).toMatchObject({ fingerprint: FP, target: { type: "text", block: "p-1", start: 0, end: 6 } }));
    await waitFor(() => expect(reader().selection?.target.quote).toHaveLength(6));
    // the document is replaced: a different fingerprint is admitted
    fingerprint = "fp-2";
    rev = 0;
    act(() => { for (const cb of [...h.annotation]) cb(DOC); });
    await waitFor(() => expect(h.context?.reader?.reading?.epoch.fingerprint).toBe("fp-2"), { timeout: 5000 });
    await waitFor(() => expect(reader().selection).toBeNull());
    for (const context of h.contexts) {
      expect(PageContextSchema.safeParse(context).success).toBe(true);
      if (context.reader?.selection) expect(context.reader.selection.fingerprint).toBe(context.reader.reading?.epoch.fingerprint);
    }
  });
});

describe("a selection that no longer is the target is not reported", () => {
  async function selected() {
    await boot();
    const text = textOf(document.querySelector("[data-block-id='p-1']") as Element);
    settle(text, 0, text, 6);
    await waitFor(() => expect(h.context?.reader?.selection).not.toBeNull(), { timeout: 5000 });
  }
  it("a new selection in the right panel (outside the reading area) replaces it with nothing", async () => {
    await selected();
    const label = document.querySelector('[data-ui="latex-reference-annotation-panel"] .panel-title') as Element;
    expect(label).not.toBeNull();
    const text = textOf(label);
    settle(text, 0, text, 3);
    await waitFor(() => expect(h.context?.reader?.selection).toBeNull());
  });
  it("a selection extended across two paragraphs (no single target) replaces it with nothing", async () => {
    await selected();
    const first = textOf(document.querySelector("[data-block-id='p-1']") as Element);
    const second = textOf(document.querySelector("[data-block-id='p-2']") as Element);
    settle(first, 0, second, 5);
    await waitFor(() => expect(h.context?.reader?.selection).toBeNull());
  });
});

describe("states the page reports", () => {
  it("syncing is paused too: no reading, navigation and back are unavailable and nothing scrolls until the read lands", async () => {
    await boot();
    let release!: () => void;
    hold = new Promise<void>((resolve) => { release = resolve; });
    act(() => { for (const cb of [...h.annotation]) cb(DOC); });
    await waitFor(() => expect(h.context?.reader?.sync.phase).toBe("syncing"));
    await waitFor(() => expect(h.context).toMatchObject({ status: "unavailable" }));
    await waitFor(() => expect(reader().reading).toBeNull());
    const before = scrolled.length;
    expect(await run({ action: "navigate", docId: DOC, anchor: "p-end" })).toEqual({ ok: false, detail: "unavailable" });
    expect(scrolled.length).toBe(before);
    release();
    await waitFor(() => expect(h.context?.reader?.sync.phase).toBe("ready"));
    expect(await run({ action: "navigate", docId: DOC, anchor: "p-end" })).toEqual({ ok: true });
  }, 15000);

  it("a Doc whose description cannot be loaded is an error with its reason, like the banner, not merely unavailable", async () => {
    descriptionStatus = 500;
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
    await run({ action: "switch_view", view: "doc" });
    await waitFor(() => expect(h.context?.reader?.sync).toEqual({ phase: "error", reason: "read" }), { timeout: 5000 });
    await waitFor(() => expect(h.context).toMatchObject({ view: "doc", status: "error" }));
    await waitFor(() => expect(reader().reading).toBeNull());
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
    // its Retry is the model's retry_sync too
    descriptionStatus = 200;
    expect(await run({ action: "retry_sync", docId: DOC })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.reader?.sync.phase).toBe("ready"), { timeout: 5000 });
  });

  it("the annotation whose popover is open is reported, and gone once it is closed", async () => {
    annotations = [{ id: "a_0000aaaa", target: { type: "structure", id: "p-3", kind: "paragraph", snapshot: { text: "x" } }, body: "note", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }];
    await boot();
    await waitFor(() => expect(reader().openAnnotationId).toBeNull());
    await run({ action: "navigate", docId: DOC, anchor: "ann-a_0000aaaa" });
    await waitFor(() => expect(h.context?.reader?.openAnnotationId).toBe("a_0000aaaa"));
    fireEvent.click(q('[data-ui="close-latex-annotation"]') as HTMLElement);
    await waitFor(() => expect(h.context?.reader?.openAnnotationId).toBeNull());
  });
});

describe("navigation through the Reader's own controllers", () => {
  it("scrolls to a block deep in the document and says so only when it happened", async () => {
    await boot();
    expect(await run({ action: "navigate", docId: DOC, anchor: "p-end" })).toEqual({ ok: true });
    expect(scrolled.map((el) => el.getAttribute("data-block-id"))).toContain("p-end");
    expect(document.querySelector('[data-block-id="p-end"]')!.classList.contains("flash")).toBe(true);
    await waitFor(() => expect(h.context?.reader?.canGoBack).toBe(true));
  });

  it("an unknown anchor is not_found and moves nothing", async () => {
    await boot();
    const before = scrolled.length;
    expect(await run({ action: "navigate", docId: DOC, anchor: "fig-999" })).toEqual({ ok: false, detail: "not_found" });
    expect(scrolled.length).toBe(before);
  });

  it("a reference anchor lands on the first citing block like the deep link does; an annotation anchor opens it", async () => {
    annotations = [{ id: "a_0000aaaa", target: { type: "structure", id: "p-3", kind: "paragraph", snapshot: { text: "x" } }, body: "note", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }];
    await boot();
    expect(await run({ action: "navigate", docId: DOC, anchor: "ref-6" })).toEqual({ ok: true });
    await waitFor(() => expect(scrolled.some((el) => el.getAttribute("data-block-id") === "p-6")).toBe(true));
    expect(await run({ action: "navigate", docId: DOC, anchor: "ann-a_0000aaaa" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="latex-annotation-popover"]')).not.toBeNull());
    expect(scrolled.some((el) => el.getAttribute("data-block-id") === "p-3")).toBe(true);
    expect(await run({ action: "navigate", docId: DOC, anchor: "ann-a_deadbeef" })).toEqual({ ok: false, detail: "not_found" });
  });

  it("pauses while the Reader syncs or shows an error: nothing scrolls, and it is reported unavailable", async () => {
    await boot();
    readStatus = 500;
    act(() => { for (const cb of [...h.annotation]) cb(DOC); });
    await waitFor(() => expect(h.context?.reader?.sync.phase).toBe("error"));
    const before = scrolled.length;
    expect(await run({ action: "navigate", docId: DOC, anchor: "p-end" })).toEqual({ ok: false, detail: "unavailable" });
    expect(await run({ action: "jump_back", docId: DOC })).toEqual({ ok: false, detail: "unavailable" });
    expect(scrolled.length).toBe(before);
    // and no native hash scroll is left pending on the retained text
    expect(document.querySelector('[data-block-id="p-end"]')!.id).toBe("");
  }, 15000);

  it("opens the Doc first when another page is showing; a missing Doc and a Doc that is not open are answered", async () => {
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
    await waitFor(() => expect(h.context?.view).toBe("plan"));
    expect(await run({ action: "navigate", docId: DOC, anchor: "p-end" })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.view).toBe("doc"));
    expect(scrolled.map((el) => el.getAttribute("data-block-id"))).toContain("p-end");
    expect(await run({ action: "navigate", docId: "nope", anchor: "p-1" })).toEqual({ ok: false, detail: "not_found" });
    // retry has nothing to retry on a Doc that is not open
    expect(await run({ action: "retry_sync", docId: "other-doc" })).toEqual({ ok: false, detail: "unavailable" });
  });

  it("a Doc switch that the leave-draft protection refuses is leave_blocked and the open Reader stays", async () => {
    await boot();
    const off = registerWorkspaceLeaveGuard(() => false);
    try {
      expect(await run({ action: "navigate", docId: "other-doc", anchor: "p-1" })).toEqual({ ok: false, detail: "leave_blocked" });
      await waitFor(() => expect(h.context?.reader?.docId).toBe(DOC));
    } finally {
      off();
    }
  });

  it("jump_back is the back button: disabled without a jump, then it returns", async () => {
    await boot();
    expect(await run({ action: "jump_back", docId: DOC })).toEqual({ ok: false, detail: "disabled" });
    await run({ action: "navigate", docId: DOC, anchor: "p-end" });
    await waitFor(() => expect(q('[data-ui="undo-latex-navigation"]')).not.toBeNull());
    expect(await run({ action: "jump_back", docId: DOC })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="undo-latex-navigation"]')).toBeNull());
  });

  it("the folds and the right tabs are the user's own controls", async () => {
    await boot();
    expect(await run({ action: "set_panel", docId: DOC, panel: "outline", collapsed: true })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="latex-outline-panel"]')!.classList.contains("collapsed")).toBe(true));
    await waitFor(() => expect(reader().panels.outlineCollapsed).toBe(true));
    expect(await run({ action: "set_panel", docId: DOC, panel: "right", collapsed: true })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="latex-right-panel"]')!.classList.contains("collapsed")).toBe(true));
    expect(await run({ action: "set_right_tab", docId: DOC, tab: "annotations" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="latex-annotations-list"]')).not.toBeNull());
    await waitFor(() => expect(reader().panels.rightTab).toBe("annotations"));
    // the user's click on a tab is the same state
    fireEvent.click(q('[data-ui="show-references"]')!);
    await waitFor(() => expect(reader().panels.rightTab).toBe("references"));
    fireEvent.click(q('[data-ui="toggle-latex-outline"]')!);
    await waitFor(() => expect(reader().panels.outlineCollapsed).toBe(false));
  });
});

describe("two Reader panes", () => {
  it("the page and the navigation belong to the active pane", async () => {
    await boot();
    expect(await run({ action: "split_pane" })).toEqual({ ok: true });
    await waitFor(() => expect(qa('[data-ui="workspace-pane"]')).toHaveLength(2));
    const panes = qa('[data-ui="workspace-pane"]');
    const second = Number(panes[1]!.getAttribute("data-ui-key") ?? "0");
    // the split pane is active and shows the Doc too; wait for both Readers
    await waitFor(() => expect(h.context?.paneId).toBe(h.context?.workspace?.activePaneId));
    await waitFor(() => expect(h.context?.reader?.reading).toBeTruthy());
    const activeId = h.context!.paneId;
    await waitFor(() => expect(h.context?.otherPanes).toHaveLength(1));
    scrolled.length = 0;
    expect(await run({ action: "navigate", docId: DOC, anchor: "p-end" })).toEqual({ ok: true });
    const active = qa('[data-ui="workspace-pane"]').find((pane) => pane.getAttribute("data-ui-key") === String(activeId))!;
    expect(scrolled.length).toBe(1);
    expect(active.contains(scrolled[0]!)).toBe(true);
    // select the other pane: the page and the target follow it
    const other = h.context!.otherPanes[0]!.paneId;
    expect(await run({ action: "select_pane", paneId: other })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.paneId).toBe(other));
    scrolled.length = 0;
    expect(await run({ action: "navigate", docId: DOC, anchor: "p-end" })).toEqual({ ok: true });
    const now = qa('[data-ui="workspace-pane"]').find((pane) => pane.getAttribute("data-ui-key") === String(other))!;
    expect(scrolled.length).toBe(1);
    expect(now.contains(scrolled[0]!)).toBe(true);
    void second;
  });
});
