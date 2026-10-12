/**
 * The argument graph view's narrow-pane layout (ticket 04, user decision 2026-10-12): the pure rule over every width
 * class and state, and the view's behaviour at three pane widths in happy-dom (the pane's width is stubbed; real
 * pixels are checked in a real browser). The Library's own rule stays in library-layout.test.tsx.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/i18n";
import i18n from "../src/i18n";
import { ArgumentGraphMode } from "../src/argument/ArgumentGraphMode";
import { OUTLINE_FOLD_CANVAS, OUTLINE_RAIL, OUTLINE_WIDTH, PANEL_WIDTH, argumentLayout, outlineAutoFold } from "../src/argument/layout";
import { MIN_GRAPH_COLUMN } from "../src/library/layout";
import type { LibraryRef } from "../src/library/types";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());

const idle = { userFolded: false, userUnfolded: false };

describe("argumentLayout (pure rule)", () => {
  it("uses the prototype widths and the Library's minimum canvas column", () => {
    expect([OUTLINE_WIDTH, PANEL_WIDTH, OUTLINE_RAIL, MIN_GRAPH_COLUMN, OUTLINE_FOLD_CANVAS]).toEqual([300, 392, 34, 240, 480]);
  });

  it("never folds the outline without a panel, whatever the width", () => {
    for (const width of [null, 300, 686, 1024, 1440]) {
      const l = argumentLayout({ width, panelOpen: false, ...idle });
      expect(l).toEqual({ outlineFolded: false, autoFolded: false, panel: "none" });
    }
    expect(argumentLayout({ width: 1440, panelOpen: false, userFolded: true, userUnfolded: false }).outlineFolded).toBe(true);
  });

  it("keeps both side by side while the canvas beside them keeps 480 (300 + 480 + 392 = 1172)", () => {
    expect(outlineAutoFold(1172, true)).toBe(false);
    expect(argumentLayout({ width: 1172, panelOpen: true, ...idle })).toEqual({ outlineFolded: false, autoFolded: false, panel: "side" });
    expect(argumentLayout({ width: 1378, panelOpen: true, ...idle }).outlineFolded).toBe(false); // a 1440 window
    expect(argumentLayout({ width: 1440, panelOpen: true, ...idle }).panel).toBe("side");
  });

  it("folds the outline when the panel opens in a narrower pane, the panel stays beside while 34 + 240 + 392 fit (>= 666)", () => {
    expect(outlineAutoFold(1171, true)).toBe(true);
    expect(argumentLayout({ width: 1171, panelOpen: true, ...idle })).toEqual({ outlineFolded: true, autoFolded: true, panel: "side" });
    expect(argumentLayout({ width: 962, panelOpen: true, ...idle })).toEqual({ outlineFolded: true, autoFolded: true, panel: "side" }); // a 1024 window
    expect(argumentLayout({ width: 900, panelOpen: true, ...idle })).toEqual({ outlineFolded: true, autoFolded: true, panel: "side" });
    expect(argumentLayout({ width: 686, panelOpen: true, ...idle }).panel).toBe("side");
    expect(argumentLayout({ width: 666, panelOpen: true, ...idle }).panel).toBe("side");
  });

  it("floats the panel over the canvas when even the folded outline leaves less than 240 (< 666)", () => {
    expect(argumentLayout({ width: 665, panelOpen: true, ...idle })).toEqual({ outlineFolded: true, autoFolded: true, panel: "overlay" });
    expect(argumentLayout({ width: 420, panelOpen: true, ...idle }).panel).toBe("overlay");
  });

  it("a manual unfold wins while the panel is open: the panel floats instead of the outline folding again", () => {
    const unfolded = { userFolded: false, userUnfolded: true };
    expect(argumentLayout({ width: 800, panelOpen: true, ...unfolded })).toEqual({ outlineFolded: false, autoFolded: true, panel: "overlay" });
    expect(argumentLayout({ width: 931, panelOpen: true, ...unfolded }).panel).toBe("overlay"); // 931 - 300 - 392 = 239
    expect(argumentLayout({ width: 932, panelOpen: true, ...unfolded }).panel).toBe("side"); // the Library's bare 240 floor
    // wide enough for both: the flag is moot
    expect(argumentLayout({ width: 1440, panelOpen: true, ...unfolded }).panel).toBe("side");
  });

  it("the user's own fold stays at every width and with the panel open or closed", () => {
    const folded = { userFolded: true, userUnfolded: false };
    expect(argumentLayout({ width: 1440, panelOpen: true, ...folded })).toEqual({ outlineFolded: true, autoFolded: false, panel: "side" });
    expect(argumentLayout({ width: 1024, panelOpen: false, ...folded }).outlineFolded).toBe(true);
  });

  it("an unmeasured pane changes nothing", () => {
    expect(argumentLayout({ width: null, panelOpen: true, ...idle })).toEqual({ outlineFolded: false, autoFolded: false, panel: "side" });
  });
});

// ---- the view -------------------------------------------------------------------------------------------- //

const WORK_ID = "arxiv:0000.00001";
const WORK: LibraryRef = { id: WORK_ID, title: "合成星团论文", authors: "Zhang, Li & Wang", year: 2024, venue: "ApJ", type: "article", cite: "zhang2024", tags: [], pdf: false, read: false, star: false, doc_ids: ["arxiv-0000.00001"] };

let width = 1440;
const observers = new Set<() => void>();
class RO {
  private readonly run = () => this.cb();
  constructor(private cb: () => void) {}
  observe(el: Element) {
    if (el.getAttribute("data-ui") === "argument-graph-view") observers.add(this.run);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.run);
  }
}
const real = Element.prototype.getBoundingClientRect;
const resize = async (next: number) => {
  width = next;
  await act(async () => observers.forEach((cb) => cb()));
};
const ui = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-ui="${id}"]`);

beforeEach(() => {
  void i18n.changeLanguage("zh-CN");
  width = 1440;
  vi.stubGlobal("ResizeObserver", RO);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this.getAttribute("data-ui") === "argument-graph-view" ? ({ width, height: 700, top: 0, left: 0, right: width, bottom: 700, x: 0, y: 0, toJSON() {} } as DOMRect) : real.call(this);
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ARGUMENT_FIXTURES.clean()), { status: 200, headers: { "Content-Type": "application/json" } })));
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = real;
  vi.unstubAllGlobals();
});

async function mount(w: number) {
  width = w;
  const view = render(<ArgumentGraphMode workId={WORK_ID} work={WORK} onExit={() => {}} onOpenDoc={() => {}} />);
  await waitFor(() => expect(ui(view.container, "argument-graph-view")!.getAttribute("data-phase")).toBe("ready"));
  return view;
}
const select = (c: HTMLElement, id: string) => fireEvent.click(c.querySelector(`[data-ui="argument-outline-row"][data-ui-key="${id}"]`)!);
const panelPlacement = (c: HTMLElement) => ui(c, "argument-detail")?.getAttribute("data-placement") ?? null;

describe("the view in a narrow pane", () => {
  it("1440: outline and panel side by side, nothing folds, no fold control state change", async () => {
    const { container } = await mount(1440);
    expect(ui(container, "argument-side")).not.toBeNull();
    select(container, "e1");
    await waitFor(() => expect(ui(container, "argument-detail")).not.toBeNull());
    expect(ui(container, "argument-side")).not.toBeNull();
    expect(ui(container, "expand-argument-outline")).toBeNull();
    expect(panelPlacement(container)).toBe("side");
  });

  it("900: opening the panel folds the outline to a rail, closing the panel brings it back", async () => {
    const { container } = await mount(900);
    expect(ui(container, "argument-side")).not.toBeNull();
    // the outline stays open until the panel does
    select(container, "e1");
    await waitFor(() => expect(ui(container, "argument-detail")).not.toBeNull());
    expect(ui(container, "argument-side")).toBeNull();
    expect(ui(container, "expand-argument-outline")).not.toBeNull();
    expect(panelPlacement(container)).toBe("side");
    fireEvent.click(ui(container, "close-argument-detail")!);
    await waitFor(() => expect(ui(container, "argument-detail")).toBeNull());
    expect(ui(container, "argument-side")).not.toBeNull();
    expect(ui(container, "expand-argument-outline")).toBeNull();
  });

  it("900: a manual unfold is respected while the panel stays open, and the panel floats instead", async () => {
    const { container } = await mount(900);
    select(container, "e1");
    await waitFor(() => expect(ui(container, "expand-argument-outline")).not.toBeNull());
    fireEvent.click(ui(container, "expand-argument-outline")!);
    expect(ui(container, "argument-side")).not.toBeNull();
    expect(panelPlacement(container)).toBe("overlay");
    // choosing another argument keeps the panel open and the user's choice
    select(container, "m4");
    await waitFor(() => expect(ui(container, "argument-detail")!.getAttribute("data-ui-key")).toBe("m4"));
    expect(ui(container, "argument-side")).not.toBeNull();
    expect(panelPlacement(container)).toBe("overlay");
    // closing the panel and opening it again folds it again
    fireEvent.click(ui(container, "close-argument-detail")!);
    await waitFor(() => expect(ui(container, "argument-detail")).toBeNull());
    select(container, "e1");
    await waitFor(() => expect(ui(container, "argument-detail")).not.toBeNull());
    expect(ui(container, "argument-side")).toBeNull();
    expect(panelPlacement(container)).toBe("side");
  });

  it("the outline's own collapse control folds it to a rail with a bilingual, named expand control", async () => {
    const { container } = await mount(1440);
    fireEvent.click(ui(container, "collapse-argument-outline")!);
    expect(ui(container, "argument-side")).toBeNull();
    const rail = ui(container, "expand-argument-outline")!;
    expect(rail.getAttribute("aria-label")).toBe("展开大纲");
    await act(async () => void i18n.changeLanguage("en"));
    expect(ui(container, "expand-argument-outline")!.getAttribute("aria-label")).toBe("Expand outline");
    fireEvent.click(ui(container, "expand-argument-outline")!);
    expect(ui(container, "collapse-argument-outline")!.getAttribute("aria-label")).toBe("Collapse outline");
  });

  it("a user fold survives a panel that opens and closes in a narrow pane", async () => {
    const { container } = await mount(900);
    fireEvent.click(ui(container, "collapse-argument-outline")!);
    fireEvent.click(ui(container, "expand-argument-outline")!);
    fireEvent.click(ui(container, "collapse-argument-outline")!);
    expect(ui(container, "expand-argument-outline")).not.toBeNull();
    await resize(1440);
    expect(ui(container, "expand-argument-outline")).not.toBeNull();
  });

  it("600: the panel floats over the canvas, Esc closes it, the canvas reserves the covered width", async () => {
    const { container } = await mount(600);
    select(container, "e1");
    await waitFor(() => expect(ui(container, "argument-detail")).not.toBeNull());
    expect(panelPlacement(container)).toBe("overlay");
    expect(ui(container, "argument-detail")!.className).toContain("ag-panel-overlay");
    expect(ui(container, "argument-canvas")!.style.getPropertyValue("--cover-r")).toBe("392px");
    expect(ui(container, "close-argument-detail")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(ui(container, "argument-detail")).toBeNull());
    expect(ui(container, "argument-canvas")!.style.getPropertyValue("--cover-r")).toBe("");
  });

  it("an open audit list takes the first Esc, a floating panel the second", async () => {
    const f = ARGUMENT_FIXTURES.flawed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(f), { status: 200, headers: { "Content-Type": "application/json" } })));
    const { container } = await mount(600);
    select(container, f.arguments.find((a) => a.kind === "end")!.id);
    await waitFor(() => expect(ui(container, "argument-detail")).not.toBeNull());
    fireEvent.click(ui(container, "argument-audit-summary")!);
    expect(ui(container, "argument-audit-popover")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(ui(container, "argument-audit-popover")).toBeNull());
    expect(ui(container, "argument-detail")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(ui(container, "argument-detail")).toBeNull());
  });

  it("an Esc that closes a dialog or the command palette does not also close the floating panel", async () => {
    const { container } = await mount(600);
    select(container, "e1");
    await waitFor(() => expect(ui(container, "argument-detail")).not.toBeNull());
    // the shared Dialog: a modal that takes Escape in the capture phase and prevents the default
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    const takeEscape = (event: KeyboardEvent) => event.key === "Escape" && event.preventDefault();
    document.addEventListener("keydown", takeEscape, true);
    fireEvent.keyDown(document, { key: "Escape" });
    document.removeEventListener("keydown", takeEscape, true);
    expect(ui(container, "argument-detail")).not.toBeNull();
    // a dialog that does not prevent the default is still a layer above the panel
    fireEvent.keyDown(document, { key: "Escape" });
    expect(ui(container, "argument-detail")).not.toBeNull();
    dialog.remove();
    // the command palette closes on the window's Escape, after the panel's listener would have run
    const palette = document.createElement("div");
    palette.setAttribute("data-ui", "command-palette");
    document.body.append(palette);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(ui(container, "argument-detail")).not.toBeNull();
    palette.remove();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(ui(container, "argument-detail")).toBeNull());
  });

  it("closing a floating panel puts the focus back on the argument's node, not on the page", async () => {
    const { container } = await mount(600);
    select(container, "e1");
    await waitFor(() => expect(ui(container, "argument-detail")).not.toBeNull());
    ui(container, "close-argument-detail")!.focus();
    fireEvent.click(ui(container, "close-argument-detail")!);
    await waitFor(() => expect(ui(container, "argument-detail")).toBeNull());
    const node = container.querySelector<HTMLElement>('[data-ui="argument-node"][data-ui-key="e1"]')!;
    expect(node).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(node));
    // Esc does the same
    select(container, "e1");
    await waitFor(() => expect(ui(container, "argument-detail")).not.toBeNull());
    ui(container, "close-argument-detail")!.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(ui(container, "argument-detail")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('[data-ui="argument-node"][data-ui-key="e1"]')));
  });

  it("a wide pane leaves Esc alone", async () => {
    const { container } = await mount(1440);
    select(container, "e1");
    await waitFor(() => expect(ui(container, "argument-detail")).not.toBeNull());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(ui(container, "argument-detail")).not.toBeNull();
  });

  it("the outline keeps its expanded rows across a fold", async () => {
    const { container } = await mount(1440);
    const before = container.querySelectorAll('[data-ui="argument-outline-item"]').length;
    const tw = container.querySelector<HTMLElement>('[data-ui="toggle-argument-outline-node"]')!;
    fireEvent.click(tw);
    const after = container.querySelectorAll('[data-ui="argument-outline-item"]').length;
    expect(after).not.toBe(before);
    fireEvent.click(ui(container, "collapse-argument-outline")!);
    fireEvent.click(ui(container, "expand-argument-outline")!);
    expect(container.querySelectorAll('[data-ui="argument-outline-item"]').length).toBe(after);
  });
});
