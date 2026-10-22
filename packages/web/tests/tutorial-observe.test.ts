import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBus } from "../src/api/ws-bus";
import { activeRungs, domQuery, isRendered, resolveAll, resolveAnchor, resolveLadder } from "../src/tutorial/anchors";
import { watchSources } from "../src/tutorial/l2";
import type { L2Source } from "../src/tutorial/types";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("L3: the DOM query (happy-dom)", () => {
  it("presence and attributes of anchors with and without key", () => {
    document.body.innerHTML = `
      <section data-ui="environment-check" data-state="checking"></section>
      <button data-ui="navigate-view" data-ui-key="library"></button>
      <button data-ui="navigate-view" data-ui-key="settings"></button>`;
    const dom = domQuery(document, 1);
    expect(dom.present({ ui: "environment-check" })).toBe(true);
    expect(dom.attr({ ui: "environment-check" }, "data-state")).toBe("checking");
    expect(dom.present({ ui: "navigate-view", key: "settings" })).toBe(true);
    expect(dom.present({ ui: "navigate-view", key: "mail" })).toBe(false);
    expect(dom.present({ ui: "command-palette" })).toBe(false);
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="command-palette"></div><div data-ui="dialog-overlay"></div>`);
    expect(dom.present({ ui: "command-palette" })).toBe(true);
    expect(dom.present({ ui: "dialog-overlay" })).toBe(true);
    document.querySelector('[data-ui="environment-check"]')!.setAttribute("data-state", "done");
    expect(dom.attr({ ui: "environment-check" }, "data-state")).toBe("done");
  });

  it("an active-pane anchor looks only inside the active workspace pane", () => {
    document.body.innerHTML = `
      <div data-ui="workspace-pane" data-ui-key="1"><div data-ui="pane-header" id="h1"></div></div>
      <div data-ui="workspace-pane" data-ui-key="2"><div data-ui="pane-header" id="h2"></div></div>`;
    expect(resolveAnchor(document, { ui: "pane-header", scope: "active-pane" }, 2, false)?.id).toBe("h2");
    expect(resolveAnchor(document, { ui: "pane-header", scope: "active-pane" }, 3, false)).toBeNull();
  });

  it("a `within` anchor looks only inside the named element", () => {
    document.body.innerHTML = `
      <div data-ui="titlebar-actions"><button data-ui="split-pane" id="title"></button></div>
      <div data-ui="pane-header"><button data-ui="split-pane" id="pane"></button></div>`;
    expect(resolveAnchor(document, { ui: "split-pane", within: { ui: "titlebar-actions" } }, 1, false)?.id).toBe("title");
    expect(resolveAll(document, { ui: "split-pane" }, 1)).toHaveLength(2);
  });

  it("conditional rungs: a rung whose condition is false is skipped, as if absent", () => {
    document.body.innerHTML = `<button data-ui="a"></button><button data-ui="b"></button>`;
    const ladder = [{ ui: "a" }, { ui: "b", when: (s: { modalOpen: boolean }) => s.modalOpen }];
    const snap = (modalOpen: boolean) => ({ modalOpen }) as never;
    expect(resolveLadder(document, activeRungs(ladder, snap(false)), 1)?.anchor.ui).toBe("a");
    expect(resolveLadder(document, activeRungs(ladder, snap(true)), 1)?.anchor.ui).toBe("b");
  });

  it("several matches: the first in document order, with one warning", () => {
    document.body.innerHTML = `<button data-ui="close-pane" id="a"></button><button data-ui="close-pane" id="b"></button>`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveAnchor(document, { ui: "close-pane" }, 1, true)?.id).toBe("a");
    resolveAnchor(document, { ui: "close-pane" }, 1, true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rendered: a zero-size or invisible element is not there for the ladder", () => {
    document.body.innerHTML = `<button data-ui="a" id="a"></button><button data-ui="b" id="b"></button><button data-ui="c" id="c" style="visibility: hidden"></button>`;
    const box = (w: number, h: number) => () => new DOMRect(0, 0, w, h);
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    const c = document.getElementById("c")!;
    a.getBoundingClientRect = box(40, 20);
    b.getBoundingClientRect = box(0, 0);
    c.getBoundingClientRect = box(40, 20);
    expect(isRendered(a)).toBe(true);
    expect(isRendered(b)).toBe(false);
    expect(isRendered(c)).toBe(false);
    const ladder = [{ ui: "a" }, { ui: "b" }, { ui: "c" }];
    expect(resolveLadder(document, ladder, 1, isRendered)?.anchor.ui).toBe("a");
  });

  it("a ladder highlights its last rung present now", () => {
    document.body.innerHTML = `<nav data-ui="primary-navigation"></nav>`;
    const ladder = [{ ui: "primary-navigation" }, { ui: "command-palette" }];
    expect(resolveLadder(document, ladder, 1)?.anchor.ui).toBe("primary-navigation");
    document.body.insertAdjacentHTML("beforeend", `<div data-ui="command-palette"></div>`);
    expect(resolveLadder(document, ladder, 1)?.anchor.ui).toBe("command-palette");
    document.body.innerHTML = "";
    expect(resolveLadder(document, ladder, 1)).toBeNull();
  });
});

describe("L2: an existing /ws event triggers a read back (fake ws bus)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function librarySource(bus: ReturnType<typeof createFakeBus>, read: (signal: AbortSignal) => Promise<unknown>): L2Source {
    return { id: "library", subscribe: (changed) => bus.on("library.changed", () => changed()), read };
  }

  it("reads once at the start, again after each event, and stops listening when the step is left", async () => {
    const bus = createFakeBus();
    let n = 0;
    const read = vi.fn(async () => ++n);
    const seen: unknown[] = [];
    const stop = watchSources([librarySource(bus, read)], (_id, v) => seen.push(v));
    await flush();
    expect(seen).toEqual([1]);
    bus.emit("library.changed", {} as never);
    await flush();
    expect(seen).toEqual([1, 2]);
    stop();
    bus.emit("library.changed", {} as never);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([1, 2]);
  });

  it("events during a read collapse into one more read after it (no overlap, no polling)", async () => {
    const bus = createFakeBus();
    const pending: ((v: number) => void)[] = [];
    const read = vi.fn(() => new Promise<number>((resolve) => pending.push(resolve)));
    const seen: unknown[] = [];
    const stop = watchSources([librarySource(bus, read)], (_id, v) => seen.push(v));
    expect(read).toHaveBeenCalledTimes(1);
    bus.emit("library.changed", {} as never);
    bus.emit("library.changed", {} as never);
    bus.emit("library.changed", {} as never);
    expect(read).toHaveBeenCalledTimes(1);
    pending.shift()!(1);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    pending.shift()!(2);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([1, 2]);
    stop();
  });

  it("an answer that arrives after the step was left is dropped and the read is aborted", async () => {
    const bus = createFakeBus();
    let resolve: (v: number) => void = () => {};
    let signal: AbortSignal | null = null;
    const seen: unknown[] = [];
    const stop = watchSources(
      [librarySource(bus, (s) => { signal = s; return new Promise<number>((r) => { resolve = r; }); })],
      (_id, v) => seen.push(v),
    );
    stop();
    expect(signal!.aborted).toBe(true);
    resolve(1);
    await flush();
    expect(seen).toEqual([]);
  });

  it("a failed read is not retried by itself; the next event reads again", async () => {
    const bus = createFakeBus();
    const read = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(5);
    const seen: unknown[] = [];
    const stop = watchSources([librarySource(bus, read)], (_id, v) => seen.push(v));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    bus.emit("library.changed", {} as never);
    await flush();
    expect(seen).toEqual([5]);
    stop();
  });
});
