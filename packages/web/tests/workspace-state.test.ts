/**
 * The workspace state (src/argelander/panes/workspace-state.ts, architecture-deepening ticket 04) at its interface,
 * without rendering: the boot deep link, the browser's Back/Forward with the leave guard and its one-navigation
 * permission, opening, switching and deleting Docs, and the Copilot's workspace actions with every answer each can give.
 *
 * The pane manager inside it and the two route buses (argument graph, exploration) are the real ones. Around them: an
 * in-memory history with a browser's event semantics and manual timers (memory-browser.ts), a scripted leave guard, a
 * fake paper list and appearance setter, and Library pages that register on the buses when a pane shows the Library —
 * a microtask later, as a mounted page's effect does — and write the history the way the real view does.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { argumentBus, argumentUrl, parseArgumentHash } from "../src/lib/argument-route";
import { exploreBus } from "../src/lib/explore-route";
import type { LeaveOrigin, LeaveVerdict } from "../src/argelander/workspace";
import type { DocPaneHost } from "../src/doc/doc-pane-adapter";
import type { LeavePort } from "../src/argelander/panes/browser";
import { createWorkspaceState, type WorkspaceState } from "../src/argelander/panes/workspace-state";
import { PAGE_FIELD_KEYS, pageFields, type Pane } from "../src/argelander/panes";
import { usePreferencesState } from "../src/argelander/preferences";
import { shareOf } from "../src/argelander/layout";
import { manualTimers, memoryBrowser, type MemoryBrowser } from "./memory-browser";

/** A leave guard whose answers the test scripts; `view` is normalised as the guard registry does (none: the Doc views). */
function scriptedLeave() {
  const asks: { view: string; paneId?: number; origin: LeaveOrigin }[] = [];
  const late: ((ok: boolean) => void)[] = [];
  let answer: (view: string, paneId: number | undefined, origin: LeaveOrigin) => LeaveVerdict = () => true;
  const port: LeavePort = {
    ask: (view, paneId, origin = "user") => {
      asks.push({ view: view ?? "doc", paneId, origin });
      return answer(view ?? "doc", paneId, origin);
    },
  };
  return {
    port,
    asks,
    late,
    answer(fn: typeof answer) {
      answer = fn;
    },
    /** `view`'s guard answers later (the argument graph page's dialog); the others say yes. */
    lateFor(view: string) {
      answer = (v) => (v === view ? new Promise<boolean>((resolve) => late.push(resolve)) : true);
    },
  };
}

/** Library pages on the real buses: one per pane that shows the Library, registered a microtask after it appears. */
function libraryPages(x: WorkspaceState, browser: MemoryBrowser) {
  const open = new Map<number, string>();
  const opens: { paneId: number; workId: string; push: boolean }[] = [];
  /** Each request a Library page was given, with the graph it showed when it came. */
  const requests: { workId: string; confirmed: boolean; showing: string | null }[] = [];
  const exits: number[] = [];
  const explores: string[] = [];
  const exploreExits: number[] = [];
  const exploring = new Set<number>();
  const mounted = new Map<number, () => void>();
  const mount = (paneId: number) => {
    const offs = [
      argumentBus.register({
        paneId,
        isOpen: () => open.has(paneId),
        workId: () => open.get(paneId) ?? null,
        open: (workId, opts) => {
          requests.push({ workId, confirmed: !!opts.confirmed, showing: open.get(paneId) ?? null });
          if (open.get(paneId) === workId) return; // the real view opens idempotently
          opens.push({ paneId, workId, push: opts.push });
          open.set(paneId, workId);
          if (opts.push && browser.url() !== argumentUrl(workId)) browser.port.push(argumentUrl(workId));
        },
        exit: () => {
          exits.push(paneId);
          open.delete(paneId);
          const at = browser.port.location();
          if (parseArgumentHash(at.hash) !== null) browser.port.push(at.pathname || "/");
        },
      }),
      exploreBus.register({
        isExploring: () => exploring.has(paneId),
        explore: (seed) => {
          if (exploring.has(paneId)) return;
          explores.push(seed);
          exploring.add(paneId);
        },
        exit: () => {
          if (exploring.delete(paneId)) exploreExits.push(paneId);
        },
      }),
    ];
    return () => offs.forEach((off) => off());
  };
  const sync = () => {
    const shown = new Set(x.getState().panes.filter((p) => p.view === "library").map((p) => p.id));
    for (const [paneId, off] of mounted)
      if (!shown.has(paneId)) {
        off();
        mounted.delete(paneId);
      }
    for (const paneId of shown)
      if (!mounted.has(paneId)) {
        mounted.set(paneId, () => {});
        queueMicrotask(() => {
          if (mounted.get(paneId) && x.getState().panes.some((p) => p.id === paneId && p.view === "library")) mounted.set(paneId, mount(paneId));
        });
      }
  };
  const off = x.subscribe(sync);
  sync();
  return {
    open,
    opens,
    requests,
    exits,
    explores,
    exploreExits,
    unmount: () => {
      off();
      for (const unregister of mounted.values()) unregister();
      mounted.clear();
    },
  };
}

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

interface Setup {
  url?: string;
  papers?: string[];
  fetchPapers?: () => Promise<string[]>;
  panes?: Pane[];
  activeId?: number;
  /** Install a Shell stand-in that acknowledges every snapshot at once (default true). */
  render?: boolean;
  /** An existing history (a reload: a new page on the same entries); `url` is then ignored. */
  browser?: MemoryBrowser;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  // the route buses are module singletons: drop a request left pending by a test
  argumentBus.exit();
  exploreBus.exit();
  vi.unstubAllGlobals();
});

function setup(o: Setup = {}) {
  const browser = o.browser ?? memoryBrowser(o.url ?? "/");
  const timers = manualTimers();
  const leave = scriptedLeave();
  let papers = o.papers ?? ["d1", "d2"];
  const fetchPapers = vi.fn(o.fetchPapers ?? (async () => [...papers]));
  const setTweak = vi.fn(async (_key: string, _value: unknown) => true);
  let host: DocPaneHost | null = null;
  const x = createWorkspaceState({
    initial: { panes: o.panes ?? [{ id: 1, view: "plan", size: 1 }], activeId: o.activeId ?? 1 },
    pages: (docHost) => {
      host = docHost;
      return [];
    },
    browser: browser.port,
    timers: timers.port,
    leave: leave.port,
    fetchPapers,
    setTweak: setTweak as never,
  });
  const notified = { count: 0 };
  cleanups.push(x.subscribe(() => notified.count++));
  if (o.render !== false) {
    cleanups.push(x.subscribe(() => x.rendered(x.getState())));
    x.rendered(x.getState());
  }
  const library = libraryPages(x, browser);
  cleanups.push(library.unmount);
  const stop = x.start();
  cleanups.push(stop);
  return {
    x,
    browser,
    timers,
    leave,
    library,
    fetchPapers,
    setTweak,
    notified,
    stop,
    host: () => host!,
    setPapers: (next: string[]) => {
      papers = next;
    },
    views: () => x.getState().panes.map((p) => p.view),
  };
}

/** Booted and settled (the paper list read, a pending bus request served). */
async function booted(o: Setup = {}) {
  const t = setup(o);
  await flush();
  return t;
}

describe("boot", () => {
  it("/doc/<id>#<anchor> opens the Doc with its anchor in one change, and neither mode", async () => {
    const t = setup({ url: "/doc/d2#sec-1" });
    const seen: [string | null, string | null][] = [];
    t.x.subscribe(() => seen.push([t.x.getState().currentDoc, t.x.getState().pendingAnchor]));
    await flush();
    expect(t.x.getState()).toMatchObject({ papers: ["d1", "d2"], currentDoc: "d2", pendingAnchor: "sec-1" });
    expect(t.views()).toEqual(["doc"]);
    // the list, the Doc, its anchor and the Doc pane arrive in one snapshot
    expect(seen).toEqual([["d2", "sec-1"]]);
    expect(t.browser.url()).toBe("/doc/d2#sec-1");
    expect(t.library.opens).toEqual([]);
    expect(t.library.explores).toEqual([]);
  });

  it("a Doc route that is not in the list is opened anyway (the Doc pane shows its load error)", async () => {
    const t = await booted({ url: "/doc/zz" });
    expect(t.x.getState()).toMatchObject({ currentDoc: "zz", papers: ["d1", "d2"] });
    expect(t.views()).toEqual(["doc"]);
  });

  it("#explore/<bibcode> makes the active pane a Library pane and hands the seed to the explore bus", async () => {
    const t = await booted({ url: "/#explore/2020X" });
    expect(t.views()).toEqual(["library"]);
    expect(t.library.explores).toEqual(["2020X"]);
    expect(t.x.getState().currentDoc).toBeNull();
  });

  it("#argument/<work id> makes the Library pane and hands the Work to the bus without writing history", async () => {
    const t = await booted({ url: "/#argument/w1" });
    expect(t.library.opens).toEqual([{ paneId: 1, workId: "w1", push: false }]);
    expect(t.views()).toEqual(["library"]);
    expect(t.browser.entries).toEqual(["/#argument/w1"]);
  });

  it("?doc=<id> picks a listed Doc; one that is not listed falls back to the first", async () => {
    expect((await booted({ url: "/?doc=d2" })).x.getState().currentDoc).toBe("d2");
    expect((await booted({ url: "/?doc=gone" })).x.getState().currentDoc).toBe("d1");
  });

  it("with no deep link the first Doc is current, the panes stay as they are and the address is not touched", async () => {
    const t = await booted();
    expect(t.x.getState()).toMatchObject({ currentDoc: "d1", pendingAnchor: null });
    expect(t.views()).toEqual(["plan"]);
    expect(t.browser.entries).toEqual(["/"]);
    expect((await booted({ papers: [] })).x.getState().currentDoc).toBeNull();
  });

  it("precedence: a Doc route over the hash modes", async () => {
    const doc = await booted({ url: "/doc/d1?doc=d2#explore/2020X" });
    expect(doc.x.getState()).toMatchObject({ currentDoc: "d1", pendingAnchor: "explore/2020X" });
    expect(doc.library.explores).toEqual([]);
  });

  it("precedence: #explore/ over ?doc=", async () => {
    const explore = await booted({ url: "/?doc=d2#explore/2020X" });
    expect(explore.library.explores).toEqual(["2020X"]);
    expect(explore.x.getState().currentDoc).toBeNull();
  });

  it("precedence: #argument/ over ?doc=", async () => {
    const graph = await booted({ url: "/?doc=d2#argument/w1" });
    expect(graph.library.opens).toEqual([{ paneId: 1, workId: "w1", push: false }]);
    expect(graph.x.getState().currentDoc).toBeNull();
  });

  it("a paper list that cannot be read counts as empty; the deep link still opens", async () => {
    const offline = async () => {
      throw new Error("offline");
    };
    const plain = await booted({ fetchPapers: offline });
    expect(plain.x.getState()).toMatchObject({ papers: [], currentDoc: null });
    const linked = await booted({ url: "/doc/d1#fig-1", fetchPapers: offline });
    expect(linked.x.getState()).toMatchObject({ papers: [], currentDoc: "d1", pendingAnchor: "fig-1" });
  });

  it("stopped before the list arrives (React StrictMode's first mount), nothing is applied and nothing listens", async () => {
    let answer!: (papers: string[]) => void;
    const t = setup({ url: "/doc/d1", fetchPapers: () => new Promise((resolve) => (answer = resolve)) });
    expect(t.browser.listeners()).toBe(1);
    t.stop();
    expect(t.browser.listeners()).toBe(0);
    answer(["d1"]);
    await flush();
    expect(t.x.getState()).toMatchObject({ papers: [], currentDoc: null });
    expect(t.views()).toEqual(["plan"]);
  });
});

describe("Back/Forward and hand-edited hashes", () => {
  it("to #argument/ with no Library pane makes one first, as the boot path does", async () => {
    const t = await booted({ url: "/doc/d1" });
    expect(t.views()).toEqual(["doc"]);
    t.browser.pop("/#argument/w1");
    await flush();
    expect(t.library.opens).toEqual([{ paneId: 1, workId: "w1", push: false }]);
    expect(t.views()).toEqual(["library"]);
  });

  it("to a plain URL or to a Doc leaves the graph", async () => {
    const t = await booted({ url: "/#argument/w1" });
    t.browser.pop("/");
    expect(t.library.exits).toEqual([1]);
    expect(t.library.open.size).toBe(0);
    t.browser.pop("/#argument/w1");
    await flush();
    expect(t.library.open.get(1)).toBe("w1");
    t.browser.pop("/doc/d2");
    expect(t.library.exits).toEqual([1, 1]);
    expect(t.library.open.size).toBe(0);
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.views()).toEqual(["doc"]);
  });

  it("Back to a plain URL turns the Doc pane back into a Library page, asking the Doc's guard as the person", async () => {
    const t = await booted({ url: "/doc/d1" });
    expect(t.views()).toEqual(["doc"]);
    t.browser.pop("/");
    expect(t.views()).toEqual(["library"]);
    expect(t.leave.asks).toContainEqual({ view: "doc", paneId: 1, origin: "user" });
    expect(t.browser.url()).toBe("/");
  });

  it("Back to a plain URL where a Library pane already is changes no pane", async () => {
    const t = await booted({
      url: "/doc/d1",
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "doc", size: 1 },
      ],
    });
    t.browser.pop("/");
    expect(t.views()).toEqual(["library", "doc"]);
  });

  it("Back to a plain URL with no Doc pane changes no pane", async () => {
    const t = await booted({ url: "/", panes: [{ id: 1, view: "plan", size: 1 }] });
    t.browser.pop("/");
    expect(t.views()).toEqual(["plan"]);
  });

  it("Back to a plain URL that the Doc's guard refuses: the Doc stays and its URL is put back", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.answer((view) => view !== "doc");
    t.browser.pop("/");
    expect(t.views()).toEqual(["doc"]);
    expect(t.browser.url()).toBe("/doc/d1");
  });

  it("Back to a plain URL that the Doc's guard answers later: kept until yes, URL put back on no", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.lateFor("doc");
    t.browser.pop("/");
    expect(t.views()).toEqual(["doc"]);
    t.leave.late[0]!(false);
    await flush();
    expect(t.views()).toEqual(["doc"]);
    expect(t.browser.url()).toBe("/doc/d1");
    t.browser.pop("/");
    t.leave.late[1]!(true);
    await flush();
    expect(t.views()).toEqual(["library"]);
  });

  it("to #explore/ with no Library pane makes one first, as the boot path does", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.browser.pop("/#explore/2020X");
    await flush();
    expect(t.views()).toEqual(["library"]);
    expect(t.library.explores).toEqual(["2020X"]);
  });

  it("to #explore/ whose Library pane the guard of a Doc pane keeps away: nothing is opened", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.answer((view) => view !== "doc");
    t.browser.pop("/#explore/2020X");
    await flush();
    expect(t.views()).toEqual(["doc"]);
    expect(t.library.explores).toEqual([]);
  });

  it("Back (a real traversal: popstate, then hashchange) to #explore/ that the Doc's guard refuses asks once and puts the Doc's URL back", async () => {
    const t = await booted({ url: "/#explore/2020X" });
    expect(t.x.openDoc("d2")).toBe(true);
    expect(t.views()).toEqual(["doc"]);
    t.leave.answer((view) => view !== "doc");
    const before = t.leave.asks.length;
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.leave.asks.slice(before).filter((a) => a.view === "doc")).toHaveLength(1);
    expect(t.browser.url()).toBe("/doc/d2");
    expect(t.views()).toEqual(["doc"]);
  });

  it("Back to #explore/ that the Doc's guard answers later: asked once, yes makes the Library pane, an answer after the address moved on changes nothing", async () => {
    const t = await booted({ url: "/#explore/2020X" });
    t.x.openDoc("d2");
    t.leave.lateFor("doc");
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.leave.late).toHaveLength(1);
    expect(t.views()).toEqual(["doc"]);
    t.leave.late[0]!(true);
    await flush();
    expect(t.views()).toEqual(["library"]);
    expect(t.browser.url()).toBe("/#explore/2020X");

    const u = await booted({ url: "/#explore/2020X" });
    u.x.openDoc("d2");
    u.leave.lateFor("doc");
    u.browser.port.back();
    await u.browser.settle();
    expect(u.leave.late).toHaveLength(1);
    u.leave.answer(() => true);
    u.browser.pop("/doc/d9"); // the address moved on while the question was open
    u.leave.late[0]!(true);
    await flush();
    expect(u.views()).toEqual(["doc"]);
    expect(u.x.getState().currentDoc).toBe("d9");
  });

  it("Back to a plain URL that the Doc's guard answers later: a second event asks nothing, and a late no after the address moved on leaves the address alone", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.lateFor("doc");
    t.browser.pop("/");
    t.browser.pop("/"); // popstate then hashchange of one traversal
    expect(t.leave.late).toHaveLength(1);
    t.leave.answer(() => true);
    t.browser.pop("/doc/d2");
    t.leave.late[0]!(false);
    await flush();
    expect(t.browser.url()).toBe("/doc/d2");
  });

  it("to a Doc address leaves the exploration (the Doc pane is already open, so the picture alone would not change)", async () => {
    const t = await booted({
      url: "/#explore/2020X",
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "doc", size: 1 },
      ],
    });
    expect(t.library.explores).toEqual(["2020X"]);
    t.browser.pop("/doc/d2");
    expect(t.library.exploreExits).toEqual([1]);
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.views()).toEqual(["library", "doc"]);
  });

  it("a hand-edited hash (hashchange alone) is handled like a traversal", async () => {
    const t = await booted({ url: "/#argument/w1" });
    t.browser.editHash("/#explore/2020X");
    expect(t.library.exits).toEqual([1]);
    expect(t.library.explores).toEqual(["2020X"]);
  });

  it("with an unsaved draft in the open graph, Back out of it asks first; refused, the graph's URL is put back and the view stays", async () => {
    const t = await booted({ url: "/#argument/w1" });
    let allow = false;
    t.leave.answer((view) => (view === "library" ? allow : true));
    t.browser.pop("/");
    expect(t.leave.asks).toEqual([{ view: "library", paneId: 1, origin: "user" }]);
    expect(t.library.exits).toEqual([]);
    expect(t.library.open.get(1)).toBe("w1");
    expect(t.browser.url()).toBe("/#argument/w1");
    allow = true;
    t.browser.pop("/");
    expect(t.library.exits).toEqual([1]);
  });

  it("exploration and the graph exclude each other by URL: #explore/ closes the graph, #argument/ goes to the graph only", async () => {
    const t = await booted({ url: "/#argument/w1" });
    t.browser.pop("/#explore/2020X");
    expect(t.library.explores).toEqual(["2020X"]);
    expect(t.library.exits).toEqual([1]);
    t.browser.pop("/#argument/w2");
    await flush();
    expect(t.library.open.get(1)).toBe("w2");
    expect(t.library.explores).toEqual(["2020X"]);
  });

  it("a Doc route refused by the open Doc's guard puts the open Doc's URL back", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.answer((view) => view !== "doc");
    t.browser.pop("/doc/d2");
    expect(t.x.getState().currentDoc).toBe("d1");
    expect(t.browser.url()).toBe("/doc/d1");
  });

  it("back to a graph URL whose Library pane the guard of a Doc pane keeps away: nothing is opened", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.answer((view) => view !== "doc");
    t.browser.pop("/#argument/w1");
    await flush();
    expect(t.views()).toEqual(["doc"]);
    expect(t.library.opens).toEqual([]);
  });
});

describe("the Reader's entry (openArgumentGraph)", () => {
  it("with no Library pane the active pane becomes one and gets the view, with one history entry", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.x.openArgumentGraph("w1");
    await flush();
    expect(t.library.opens).toEqual([{ paneId: 1, workId: "w1", push: true }]);
    expect(t.browser.entries).toEqual(["/doc/d1", "/#argument/w1"]);
  });

  it("with several Library panes the pane that is shown is the pane that is served", async () => {
    const t = await booted({
      url: "/doc/d1",
      panes: [
        { id: 1, view: "doc", size: 1 },
        { id: 2, view: "library", size: 1 },
        { id: 3, view: "library", size: 1 },
      ],
    });
    t.x.openArgumentGraph("w1");
    await flush();
    // not the active pane (the Doc pane): the first Library pane in the layout, which is selected
    expect(t.library.opens).toEqual([{ paneId: 2, workId: "w1", push: true }]);
    expect([...t.library.open.keys()]).toEqual([2]);
    expect(t.x.getState().activeId).toBe(2);
  });

  it("a Doc pane the guard keeps: nothing is opened and no entry is written", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.answer((view) => view !== "doc");
    t.x.openArgumentGraph("w1");
    await flush();
    expect(t.library.opens).toEqual([]);
    expect(t.browser.entries).toEqual(["/doc/d1"]);
  });

  it("another Work's graph reaches the view unconfirmed, so the view itself asks", async () => {
    const t = await booted({ url: "/#argument/w1" });
    t.leave.lateFor("library");
    t.x.openArgumentGraph("w2");
    expect(t.library.requests[t.library.requests.length - 1]).toEqual({ workId: "w2", confirmed: false, showing: "w1" });
    expect(t.leave.asks).toEqual([]);
  });
});

describe("opening a Doc", () => {
  it("from the graph keeps the graph's history entry (a new entry for the Doc), so Back returns to the graph", async () => {
    const t = await booted({
      url: "/#argument/w1",
      panes: [
        { id: 1, view: "plan", size: 1 },
        { id: 2, view: "doc", size: 1 },
      ],
    });
    // the boot made pane 1 the Library pane; the graph's source link opens a Doc
    expect(t.library.open.get(1)).toBe("w1");
    expect(t.x.openDoc("d2", "sec-1")).toBe(true);
    expect(t.browser.entries).toEqual(["/#argument/w1", "/doc/d2#sec-1"]);
    expect(t.x.getState()).toMatchObject({ currentDoc: "d2", pendingAnchor: "sec-1" });
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/#argument/w1");
    expect(t.library.open.get(1)).toBe("w1");
  });

  it("refused by the open Doc's guard from the graph: the graph's URL stays and no entry is written", async () => {
    const t = await booted({
      url: "/#argument/w1",
      panes: [
        { id: 1, view: "plan", size: 1 },
        { id: 2, view: "doc", size: 1 },
      ],
    });
    t.x.setCurrentDoc("d1");
    const before = t.browser.entries;
    t.leave.answer((view) => view !== "doc");
    expect(t.x.openDoc("d2", "sec-1")).toBe(false);
    expect(t.browser.entries).toEqual(before);
    expect(t.browser.url()).toBe("/doc/d1");
  });

  it("from the Library it writes a new entry, so Back returns to the Library page", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    expect(t.x.openDoc("d2", "sec-1")).toBe(true);
    expect(t.browser.entries).toEqual(["/", "/doc/d2#sec-1"]);
    expect(t.views()).toEqual(["doc"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/");
    expect(t.views()).toEqual(["library"]);
    t.browser.forward();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/doc/d2#sec-1");
    expect(t.views()).toEqual(["doc"]);
    expect(t.x.getState()).toMatchObject({ currentDoc: "d2", pendingAnchor: "sec-1" });
    expect(t.browser.entries).toEqual(["/", "/doc/d2#sec-1"]);
  });

  it("from a Plan page it records the view it replaces: Back puts the Plan page back, Forward the Doc, Back the Plan again", async () => {
    const t = await booted(); // one pane, the Plan page
    expect(t.x.openDoc("d2")).toBe(true);
    expect(t.views()).toEqual(["doc"]);
    expect(t.browser.entries).toEqual(["/", "/doc/d2"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["plan"]);
    expect(t.browser.url()).toBe("/");
    t.browser.forward();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["doc"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["plan"]);
  });

  it("the recorded view returns to the pane the Doc replaced, even where another pane shows the Library", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 2,
    });
    t.x.openDoc("d2");
    expect(t.views()).toEqual(["library", "doc"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["library", "plan"]);
  });

  it("a Doc pane that already existed is recorded too: opening another Doc and going Back shows the previous Doc, the pane stays a Doc pane", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "doc", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 2,
    });
    expect(t.x.getState().currentDoc).toBe("d1");
    t.x.openDoc("d2");
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.browser.entries).toEqual(["/", "/doc/d2"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["doc", "plan"]);
    expect(t.x.getState().currentDoc).toBe("d1");
    expect(t.leave.asks.filter((a) => a.view === "doc" && a.origin === "user").length).toBeGreaterThan(0);
  });

  it("with nothing recorded (a boot deep link) Back to a plain URL still falls back to the Library page", async () => {
    const t = await booted({ url: "/doc/d1", panes: [{ id: 1, view: "plan", size: 1 }] });
    t.browser.pop("/");
    expect(t.views()).toEqual(["library"]);
  });

  it("a switch inside the Doc pane (setCurrentDoc) keeps the record: Back still puts the view the pane had before the open back", async () => {
    const t = await booted();
    t.x.openDoc("d2");
    t.x.setCurrentDoc("d1"); // a switch inside the Doc pane
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["plan"]);
    expect(t.browser.url()).toBe("/");
  });

  it("a record whose pane is no longer the Doc pane that open made is no record: Back to a plain URL falls back to the Library page", async () => {
    // switched away by hand, and back to a Doc pane by hand: another Doc pane than the one the open made
    const t = await booted();
    t.x.openDoc("d2");
    t.x.setPaneView(1, "write");
    t.x.setPaneView(1, "doc");
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["library"]);

    // switched away by hand and still no Doc pane: no record and no Doc pane to turn, so nothing changes
    const u = await booted();
    u.x.openDoc("d2");
    u.x.setPaneView(1, "write");
    u.browser.port.back();
    await u.browser.settle();
    await flush();
    expect(u.views()).toEqual(["write"]);

    // a record written before a reload: the pane ids are numbered again, so pane 1 is not the pane the record names
    const v = await booted({ url: "/doc/d2" });
    expect(v.views()).toEqual(["doc"]);
    v.browser.port.replace("/");
    v.browser.port.setState({ argelanderReplaced: { paneId: 1, view: "plan", session: "an-earlier-page-load:1", docId: "d2" } });
    v.browser.port.push("/doc/d2");
    v.browser.port.back();
    await v.browser.settle();
    await flush();
    expect(v.views()).toEqual(["library"]);
  });

  it("the record also puts the replaced view back when Back lands on #explore/ or #argument/", async () => {
    for (const url of ["/#explore/2020X", "/#argument/w1"]) {
      const t = await booted({
        url,
        panes: [
          { id: 1, view: "library", size: 1 },
          { id: 2, view: "plan", size: 1 },
        ],
        activeId: 2,
      });
      t.x.openDoc("d2");
      expect(t.views()).toEqual(["library", "doc"]);
      expect(t.browser.entries).toEqual([url, "/doc/d2"]);
      t.browser.port.back();
      await t.browser.settle();
      await flush();
      expect(t.views()).toEqual(["library", "plan"]);
      expect(t.browser.url()).toBe(url);
    }
  });

  it("a second, different Back while the Doc's question is open asks for itself, and the earlier answer is void", async () => {
    const t = await booted();
    t.x.openDoc("d2");
    t.leave.lateFor("doc");
    t.browser.port.back(); // to "/": asks (record: the Plan page)
    await t.browser.settle();
    expect(t.leave.late).toHaveLength(1);
    t.browser.pop("/#explore/2020X"); // another navigation before the answer
    expect(t.leave.late).toHaveLength(2);
    t.leave.late[0]!(true); // the answer to the first question
    await flush();
    expect(t.views()).toEqual(["doc"]);
    t.leave.late[1]!(true);
    await flush();
    expect(t.views()).toEqual(["library"]);
    expect(t.library.explores).toEqual(["2020X"]);
  });

  it("a refused Back to the recorded view asks once and puts the Doc's URL back", async () => {
    const t = await booted();
    t.x.openDoc("d2");
    t.leave.answer((view) => view !== "doc");
    const before = t.leave.asks.length;
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.leave.asks.slice(before).filter((a) => a.view === "doc")).toHaveLength(1);
    expect(t.views()).toEqual(["doc"]);
    expect(t.browser.url()).toBe("/doc/d2");
  });

  it("a Back the Doc's guard refuses pushes the Doc's address back instead of rewriting the entry: after saving, Back lands on the Plan page", async () => {
    const t = await booted();
    t.x.openDoc("d2");
    t.leave.answer((view) => view !== "doc"); // "keep editing"
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["doc"]);
    expect(t.browser.url()).toBe("/doc/d2");
    expect(t.browser.entries).toEqual(["/", "/doc/d2"]); // the Plan page's entry is still there
    expect(t.browser.index).toBe(1);
    t.leave.answer(() => true); // saved
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["plan"]);
    expect(t.browser.url()).toBe("/");
  });

  it("a Back the Doc's guard answers later: the Doc's address is pushed back at once; no keeps it; yes goes back for real and asks nothing more", async () => {
    const t = await booted();
    t.x.openDoc("d2");
    t.leave.lateFor("doc");
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.leave.late).toHaveLength(1);
    expect(t.browser.url()).toBe("/doc/d2");
    expect(t.browser.entries).toEqual(["/", "/doc/d2"]);
    t.leave.late[0]!(false); // "keep editing"
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["doc"]);
    expect(t.browser.entries).toEqual(["/", "/doc/d2"]);
    expect(t.browser.index).toBe(1);

    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.leave.late).toHaveLength(2);
    t.leave.late[1]!(true); // "discard"
    await t.browser.settle();
    await flush();
    expect(t.leave.late).toHaveLength(2); // the traversal it let through asked nothing more
    expect(t.views()).toEqual(["plan"]);
    expect(t.browser.url()).toBe("/");
  });

  it("with no record (a boot deep link) a refused Back also pushes the Doc's address back: after saving, Back lands on the Library page", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.browser.port.push("/"); // the person's earlier entry before the Doc, as the boot path would have it
    t.browser.port.push("/doc/d1");
    t.leave.answer((view) => view !== "doc");
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["doc"]);
    expect(t.browser.entries).toEqual(["/doc/d1", "/", "/doc/d1"]);
    expect(t.browser.index).toBe(2);
    t.leave.answer(() => true);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["library"]);
    expect(t.browser.url()).toBe("/");
  });

  it("a refused Back keeps the open Doc's anchor in the address it pushes back", async () => {
    const t = await booted();
    t.x.openDoc("d2", "sec-1");
    t.leave.answer((view) => view !== "doc");
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.entries).toEqual(["/", "/doc/d2#sec-1"]);
    expect(t.browser.url()).toBe("/doc/d2#sec-1");
  });

  it("Doc a → Doc b, a Back to Doc a the guard refuses pushes Doc b's address back (anchor kept) and keeps Doc a's entry: after saving, Back lands on Doc a", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.x.openDoc("d2", "fig-2");
    expect(t.browser.entries).toEqual(["/doc/d1", "/doc/d2#fig-2"]);
    t.leave.answer((view) => view !== "doc"); // d2 has unsaved work: "keep editing"
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.browser.entries).toEqual(["/doc/d1", "/doc/d2#fig-2"]);
    expect(t.browser.index).toBe(1);
    t.leave.answer(() => true); // saved
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.x.getState().currentDoc).toBe("d1");
    expect(t.browser.url()).toBe("/doc/d1");
  });

  it("a Back to another Doc the guard answers later: the open Doc's address is pushed back at once; no keeps it; yes goes back for real and asks nothing more", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.x.openDoc("d2");
    t.leave.lateFor("doc");
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.leave.late).toHaveLength(1);
    expect(t.browser.entries).toEqual(["/doc/d1", "/doc/d2"]);
    expect(t.browser.index).toBe(1);
    t.leave.late[0]!(false);
    await t.browser.settle();
    await flush();
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.browser.url()).toBe("/doc/d2");
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.leave.late).toHaveLength(2);
    t.leave.late[1]!(true);
    await t.browser.settle();
    await flush();
    expect(t.leave.late).toHaveLength(2);
    expect(t.x.getState().currentDoc).toBe("d1");
    expect(t.browser.url()).toBe("/doc/d1");
  });

  it("the argument graph's yes lets its own Back through and never answers the Doc's question", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 2,
    });
    t.x.openDoc("d2"); // pane 2 becomes the Doc pane; "/" records the Plan page
    t.x.openArgumentGraph("w1"); // pane 1 shows the graph
    await flush();
    expect(t.browser.entries).toEqual(["/", "/doc/d2", "/#argument/w1"]);
    const graphAnswers: ((ok: boolean) => void)[] = [];
    t.leave.answer((view) => (view === "library" ? new Promise<boolean>((resolve) => graphAnswers.push(resolve)) : view !== "doc"));
    t.browser.go(-2); // the Back button's menu: straight to "/"
    await t.browser.settle();
    await flush();
    expect(graphAnswers).toHaveLength(1);
    const docAsksBefore = t.leave.asks.filter((a) => a.view === "doc").length;
    graphAnswers[0]!(true); // the graph: "discard"
    await t.browser.settle();
    await flush();
    expect(t.leave.asks.filter((a) => a.view === "doc").length).toBe(docAsksBefore + 1); // the Doc is asked for itself
    expect(t.views()).toEqual(["library", "doc"]);
    expect(t.browser.url()).toBe("/doc/d2");
  });

  it("a record written before a reload never applies after it, though the new page numbers its sessions the same way", async () => {
    const browser = memoryBrowser("/");
    const before = await booted({ browser });
    before.x.openDoc("d2"); // pane 1: Plan → Doc; "/" records the Plan page with this page's first session
    before.stop();
    before.library.unmount();
    // the reload: a new page on the same history, its pane 1 again a Doc pane with its own first session
    const after = await booted({ browser });
    expect(after.views()).toEqual(["doc"]);
    browser.port.back();
    await browser.settle();
    await flush();
    expect(after.views()).toEqual(["library"]);
  });

  it("a parked session is void once its pane is switched by hand: Forward then Back is no record, so the Library page", async () => {
    const t = await booted(); // Plan
    t.x.openDoc("d2");
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["plan"]);
    t.x.setPaneView(1, "write"); // by hand, while parked
    t.browser.forward();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["doc"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["library"]);
  });

  it("from any other URL it writes a new entry too (the task drawer, the Copilot's open_doc)", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.x.openDoc("d2", "sec-1");
    expect(t.browser.entries).toEqual(["/doc/d1", "/doc/d2#sec-1"]);
    expect((await t.x.openDocAction("d1")).ok).toBe(true);
    expect(t.browser.entries).toEqual(["/doc/d1", "/doc/d2#sec-1", "/doc/d1"]);
  });

  it("the address it would write is the address already there: no second entry", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.x.openDoc("d1");
    t.x.openDoc("d1", null);
    expect(t.browser.entries).toEqual(["/doc/d1"]);
  });

  it("Back/Forward to a Doc address opens the Doc without writing an entry of its own", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.x.openDoc("d1");
    t.x.setPaneView(1, "library");
    t.x.openDoc("d2");
    expect(t.browser.entries).toEqual(["/", "/doc/d1", "/doc/d2"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.x.getState().currentDoc).toBe("d1");
    expect(t.browser.entries).toEqual(["/", "/doc/d1", "/doc/d2"]);
    expect(t.browser.index).toBe(1);
  });

  it("from an exploration it writes a new entry, so Back returns to the exploration (the Library pane is made again)", async () => {
    const t = await booted({ url: "/#explore/2020X" });
    expect(t.library.explores).toEqual(["2020X"]);
    expect(t.x.openDoc("d2")).toBe(true);
    expect(t.browser.entries).toEqual(["/#explore/2020X", "/doc/d2"]);
    expect(t.views()).toEqual(["doc"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/#explore/2020X");
    expect(t.views()).toEqual(["library"]);
  });

  it("refused by the open Doc's guard: no entry is written", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.answer((view) => view !== "doc");
    expect(t.x.openDoc("d2")).toBe(false);
    expect(t.browser.entries).toEqual(["/doc/d1"]);
  });

  it("a Doc guard that answers later (its dialog): the switch waits for yes; no keeps the Doc and its address; the Copilot is not asked", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.lateFor("doc");
    expect(t.x.openDoc("d2")).toBe(false); // not yet
    expect(t.x.getState().currentDoc).toBe("d1");
    expect(t.browser.entries).toEqual(["/doc/d1"]);
    t.leave.late[0]!(true);
    await flush();
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.browser.entries).toEqual(["/doc/d1", "/doc/d2"]);
    t.leave.late.length = 0;
    t.x.openDoc("d1");
    t.leave.late[0]!(false); // "keep editing"
    await flush();
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.browser.url()).toBe("/doc/d2");
    // the Copilot's open_doc is a request with origin agent: the guard refuses it without a question
    t.leave.answer((_view, _pane, origin) => origin !== "agent");
    expect(await t.x.openDocAction("d1")).toEqual({ ok: false, detail: "leave_blocked" });
    expect(t.leave.asks[t.leave.asks.length - 1]).toEqual({ view: "doc", paneId: undefined, origin: "agent" });
  });

  it("Back to a Doc address the Doc's guard answers later: one traversal (popstate, then hashchange) asks once; yes opens it, no puts the open Doc's address back", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.lateFor("doc");
    t.browser.pop("/doc/d2");
    t.browser.pop("/doc/d2");
    await flush();
    expect(t.leave.late).toHaveLength(1);
    expect(t.x.getState().currentDoc).toBe("d1");
    t.leave.late[0]!(false);
    await flush();
    expect(t.browser.url()).toBe("/doc/d1");
    expect(t.x.getState().currentDoc).toBe("d1");
    t.leave.late.length = 0;
    t.browser.pop("/doc/d2");
    t.browser.pop("/doc/d2");
    await flush();
    expect(t.leave.late).toHaveLength(1);
    t.leave.late[0]!(true);
    await flush();
    expect(t.x.getState().currentDoc).toBe("d2");
  });

  it("a second Doc open while the first question is open supersedes it: the earlier no (superseded) changes nothing, and the later answer decides", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.lateFor("doc");
    t.x.openDoc("d2");
    t.x.openDoc("d3"); // the dialog now carries this question; the first is answered no
    expect(t.leave.late).toHaveLength(2);
    t.leave.late[0]!(false);
    await flush();
    expect(t.browser.url()).toBe("/doc/d1"); // the superseded no puts nothing back and opens nothing
    expect(t.x.getState().currentDoc).toBe("d1");
    t.leave.late[1]!(true);
    await flush();
    expect(t.x.getState().currentDoc).toBe("d3");
    expect(t.browser.url()).toBe("/doc/d3");
  });

  it("a Doc open whose question a Back supersedes: its late no leaves the address alone, and the Back's own answer decides", async () => {
    const t = await booted(); // the Plan page
    t.x.openDoc("d2"); // Doc A
    t.leave.lateFor("doc"); // A has unsaved work
    t.x.openDoc("d1"); // question 1: open Doc B
    t.browser.port.back(); // to "/", the Plan page's entry: question 2 supersedes question 1
    await t.browser.settle();
    await flush();
    expect(t.leave.late).toHaveLength(2);
    t.leave.late[0]!(false); // question 1's late no
    await flush();
    t.leave.late[1]!(true); // question 2: "discard"
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["plan"]);
    expect(t.browser.url()).toBe("/");
  });

  it("a Doc open's late no after the address moved on (with no question of its own) leaves the address alone", async () => {
    const t = await booted({
      url: "/doc/d2",
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "doc", size: 1 },
      ],
    });
    t.leave.lateFor("doc");
    expect(t.x.openDoc("d1")).toBe(false); // question 1
    t.browser.pop("/#explore/2020X"); // the Library pane is there: the exploration asks nothing
    await flush();
    expect(t.leave.late).toHaveLength(1);
    t.leave.late[0]!(false);
    await flush();
    expect(t.browser.url()).toBe("/#explore/2020X");
    expect(t.x.getState().currentDoc).toBe("d2");
  });

  it("a late no from the Library page's guard after the address moved on leaves the address alone", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.leave.lateFor("library");
    expect(t.x.openDoc("d2")).toBe(false);
    t.browser.pop("/#explore/2020X"); // the address moves on while the question is open
    t.leave.late[0]!(false);
    await flush();
    expect(t.browser.url()).toBe("/#explore/2020X");
    expect(t.views()).toEqual(["library"]);
  });

  it("setCurrentDoc waits for a Doc guard that answers later", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.lateFor("doc");
    t.x.setCurrentDoc("d2");
    expect(t.x.getState().currentDoc).toBe("d1");
    t.leave.late[0]!(true);
    await flush();
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.browser.url()).toBe("/doc/d2");
  });

  it("with no Doc given it shows the current Doc (else the first) and leaves the address and the anchor alone", async () => {
    const t = await booted({ url: "/doc/d2#sec-1" });
    t.x.clearPendingAnchor();
    t.x.setPaneView(1, "plan");
    expect(t.x.openDoc()).toBe(true);
    expect(t.x.getState()).toMatchObject({ currentDoc: "d2", pendingAnchor: null });
    expect(t.views()).toEqual(["doc"]);
    expect(t.browser.entries).toEqual(["/doc/d2#sec-1"]);
  });

  it("prefers an existing Doc pane, else the active pane becomes one", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "doc", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 2,
    });
    t.x.openDoc("d2");
    expect(t.views()).toEqual(["doc", "plan"]);
    t.x.setPaneView(1, "write");
    t.x.select(2);
    t.x.openDoc("d1");
    expect(t.views()).toEqual(["write", "doc"]);
  });

  it("replacing a Library page asks its guard first: refused at once, refused later, and allowed later", async () => {
    const t = await booted({ url: "/doc/d1", panes: [{ id: 1, view: "library", size: 1 }] });
    // the boot opened d1 in pane 1 after asking (yes); now pane 1 is a Library page again
    t.x.setPaneView(1, "library");
    t.leave.answer((view) => view !== "library");
    expect(t.x.openDoc("d1")).toBe(false);
    expect(t.views()).toEqual(["library"]);
    t.leave.lateFor("library");
    expect(t.x.openDoc("d1")).toBe(false);
    expect(t.leave.late).toHaveLength(1);
    t.leave.late[0]!(false);
    await flush();
    expect(t.views()).toEqual(["library"]);
    expect(t.x.openDoc("d1")).toBe(false);
    t.leave.late[1]!(true);
    await flush();
    expect(t.views()).toEqual(["doc"]);
    expect(t.x.getState().currentDoc).toBe("d1");
  });

  it("a later 'no' from the Library page puts the open Doc's URL back when the browser had moved", async () => {
    const t = await booted({ url: "/doc/d1", panes: [{ id: 1, view: "library", size: 1 }] });
    t.x.setPaneView(1, "library");
    t.leave.lateFor("library");
    t.browser.pop("/doc/d1#fig-2");
    await flush();
    t.leave.late[0]!(false);
    await flush();
    expect(t.browser.url()).toBe("/doc/d1");
  });

  it("the Copilot's request to replace a Library page passes its origin to the guard", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.leave.answer((view, _paneId, origin) => !(view === "library" && origin === "agent"));
    expect(t.x.openDoc("d2", undefined, { origin: "agent" })).toBe(false);
    expect(t.leave.asks[t.leave.asks.length - 1]).toEqual({ view: "library", paneId: 1, origin: "agent" });
  });
});

describe("a guard that answers later (the argument graph's own dialog)", () => {
  it("'keep editing' leaves the view and the graph's URL in place", async () => {
    const t = await booted({ url: "/#argument/w1" });
    t.leave.lateFor("library");
    t.browser.pop("/");
    expect(t.leave.late).toHaveLength(1);
    t.leave.late[0]!(false);
    await flush();
    expect(t.library.exits).toEqual([]);
    expect(t.browser.url()).toBe("/#argument/w1");
  });

  it("'discard' goes back for real and that traversal's popstate and hashchange ask nothing", async () => {
    const t = await booted({ url: "/#argument/w1" });
    t.leave.lateFor("library");
    t.browser.pop("/");
    expect(t.browser.url()).toBe("/#argument/w1"); // put back while the question is open
    t.leave.late[0]!(true);
    await flush();
    await t.browser.settle();
    expect(t.library.exits).toEqual([1]);
    expect(t.browser.url()).toBe("/");
    expect(t.leave.asks).toHaveLength(1);
  });

  it("between two graph URLs it asks too, and the confirmed request is not asked about again by the view", async () => {
    const t = await booted({ url: "/#argument/w1" });
    t.leave.lateFor("library");
    t.browser.pop("/#argument/w2");
    expect(t.library.open.get(1)).toBe("w1");
    expect(t.browser.url()).toBe("/#argument/w1");
    t.leave.late[0]!(true);
    await flush();
    await t.browser.settle();
    await flush();
    expect(t.library.open.get(1)).toBe("w2");
    expect(t.library.requests).toContainEqual({ workId: "w2", confirmed: true, showing: "w1" });
    // the traversal's hashchange followed the popstate: it asked nothing, and no unconfirmed request reached the view
    // while it still showed the other graph (the one that follows finds w2 open and is idempotent)
    expect(t.library.requests.filter((r) => r.workId === "w2" && !r.confirmed && r.showing !== "w2")).toEqual([]);
    expect(t.leave.late).toHaveLength(1);
  });

  it("Back to a Doc that is not the open one asks once, not again for the Library page it replaces", async () => {
    const t = await booted({ url: "/#argument/w1" });
    t.leave.lateFor("library");
    t.browser.pop("/doc/d2");
    expect(t.leave.late).toHaveLength(1);
    t.leave.late[0]!(true);
    await flush();
    await t.browser.settle();
    expect(t.views()).toEqual(["doc"]);
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.leave.asks.filter((a) => a.view === "library")).toHaveLength(1);
  });

  it("while the question is open a further navigation asks nothing more: 'discard' goes to the last place asked for", async () => {
    const t = await booted({ url: "/#argument/w1" });
    t.leave.lateFor("library");
    t.browser.pop("/");
    t.browser.pop("/#explore/2020X"); // a hand-edited hash while the dialog is open
    t.browser.pop("/doc/d2");
    expect(t.leave.late).toHaveLength(1);
    expect(t.library.exits).toEqual([]);
    expect(t.browser.url()).toBe("/#argument/w1");
    t.leave.late[0]!(true);
    await flush();
    await t.browser.settle();
    expect(t.browser.url()).toBe("/doc/d2");
    expect(t.library.exits).toEqual([1]);
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.leave.late).toHaveLength(1);
  });

  it("'keep editing' after further navigations leaves the graph as it is", async () => {
    const t = await booted({ url: "/#argument/w1" });
    t.leave.lateFor("library");
    t.browser.pop("/");
    t.browser.pop("/doc/d2");
    t.leave.late[0]!(false);
    await flush();
    expect(t.library.exits).toEqual([]);
    expect(t.browser.url()).toBe("/#argument/w1");
    // the question is closed: the next Back asks again
    t.browser.pop("/");
    expect(t.leave.late).toHaveLength(2);
  });
});

describe("a Back that was let through is let through once", () => {
  /** Discard on the first question, with a browser whose Back does not move (the permission then waits unused). */
  async function letThrough(o: { backMoves: boolean }) {
    const t = await booted({ url: "/#argument/w1" });
    if (!o.backMoves) t.browser.port.back = () => {};
    t.leave.lateFor("library");
    t.browser.pop("/");
    t.leave.late[0]!(true);
    await flush();
    await t.browser.settle();
    return t;
  }

  it("a permission nobody takes lasts 2000 ms", async () => {
    const t = await letThrough({ backMoves: false });
    t.timers.advance(1999);
    t.browser.pop("/");
    expect(t.leave.late).toHaveLength(1); // let through
    expect(t.library.exits).toEqual([1]);
  });

  it("after 2000 ms the same Back asks again", async () => {
    const t = await letThrough({ backMoves: false });
    t.timers.advance(2000);
    t.browser.pop("/");
    expect(t.leave.late).toHaveLength(2);
    expect(t.library.exits).toEqual([]);
  });

  it("taken, it lasts 100 ms more for the rest of that navigation (each take starts the 100 ms again)", async () => {
    const t = await letThrough({ backMoves: true });
    expect(t.library.exits).toEqual([1]);
    // the graph is back with a draft
    t.browser.pop("/#argument/w1");
    await flush();
    t.timers.advance(99);
    t.browser.pop("/");
    expect(t.leave.late).toHaveLength(1); // let through again, for another 100 ms
    t.browser.pop("/#argument/w1");
    await flush();
    t.timers.advance(100);
    t.browser.pop("/");
    expect(t.leave.late).toHaveLength(2);
  });

  it("a draft made after re-entering the graph is asked about again on the next Back", async () => {
    const t = await booted({ url: "/#argument/w1" });
    t.browser.port.back = () => {}; // the permission would linger unused
    t.leave.lateFor("library");
    t.browser.pop("/");
    t.leave.late[0]!(true);
    await flush();
    // the person re-enters a graph from the Reader's entry (no popstate, no hashchange) and edits
    t.x.openArgumentGraph("w2");
    await flush();
    expect(t.library.open.get(1)).toBe("w2");
    t.browser.pop("/");
    expect(t.leave.late).toHaveLength(2);
    expect(t.browser.url()).toBe("/#argument/w2");
  });

  it("with two Library panes, Back asks the pane that shows the graph and not the other one", async () => {
    const t = await booted({ url: "/#argument/w1" });
    expect(t.library.open.get(1)).toBe("w1");
    t.x.split(1); // pane 2: another Library page, showing no graph
    await flush();
    t.leave.answer((view) => view !== "library");
    t.browser.pop("/");
    expect(t.leave.asks).toEqual([{ view: "library", paneId: 1, origin: "user" }]);
    expect(t.library.exits).toEqual([]);
    expect(t.browser.url()).toBe("/#argument/w1");
  });
});

describe("the current Doc", () => {
  it("setCurrentDoc asks the Doc views' guard, replaces the address without the anchor, and does nothing for the same Doc", async () => {
    const t = await booted({ url: "/doc/d1#sec-1" });
    t.x.setCurrentDoc("d1");
    expect(t.leave.asks).toHaveLength(1); // the boot's own switch
    t.leave.answer(() => false);
    t.x.setCurrentDoc("d2");
    expect(t.x.getState().currentDoc).toBe("d1");
    expect(t.browser.url()).toBe("/doc/d1#sec-1");
    t.leave.answer(() => true);
    t.x.setCurrentDoc("d2");
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.browser.entries).toEqual(["/doc/d2"]);
  });

  it("clearing an anchor that is already clear is no change: no new snapshot", async () => {
    const t = await booted({ url: "/doc/d1#sec-1" });
    const before = t.notified.count;
    const snapshot = t.x.getState();
    t.x.clearPendingAnchor();
    expect(t.x.getState().pendingAnchor).toBeNull();
    expect(t.notified.count).toBe(before + 1);
    t.x.clearPendingAnchor();
    t.x.setCopilotOpen(false);
    expect(t.notified.count).toBe(before + 1);
    expect(t.x.getState()).not.toBe(snapshot);
  });

  it("the Doc pane's host reads the current Doc and opens another through the workspace", async () => {
    const t = await booted({ url: "/doc/d1" });
    expect(t.host().currentDoc()).toBe("d1");
    expect(await t.host().openDoc("d2")).toEqual({ ok: true });
    expect(t.host().currentDoc()).toBe("d2");
  });
});

describe("the Library pages' remembered selection", () => {
  it("is kept per pane and dropped when the pane closes", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "library", size: 1 },
      ],
    });
    t.x.librarySelection.set(1, "n1");
    t.x.librarySelection.set(2, "n2");
    expect(t.x.librarySelection.get(1)).toBe("n1");
    t.x.close(2);
    expect(t.x.librarySelection.get(2)).toBeUndefined();
    expect(t.x.librarySelection.get(1)).toBe("n1");
  });
});

describe("a Doc's deletion: the three states", () => {
  it("a non-current Doc leaves the paper list; the open Doc and the URL stay", async () => {
    const t = await booted({ url: "/doc/d1#fig-1" });
    t.x.docDeleted("d2", ["x"]);
    expect(t.x.getState()).toMatchObject({ papers: ["d1"], currentDoc: "d1" });
    expect(t.browser.entries).toEqual(["/doc/d1#fig-1"]);
  });

  it("the open Doc moves to the Work's new main Doc, in the same change as the list, and the address follows", async () => {
    const t = await booted({ url: "/doc/d1" });
    const before = t.notified.count;
    t.x.docDeleted("d1", ["d2"]);
    expect(t.notified.count).toBe(before + 1);
    expect(t.x.getState()).toMatchObject({ papers: ["d2"], currentDoc: "d2" });
    expect(t.browser.entries).toEqual(["/doc/d2"]);
  });

  it("with no Doc left, no Doc is open and the address resets", async () => {
    const t = await booted({ url: "/doc/d1#fig-1", papers: ["d1"] });
    t.x.docDeleted("d1", []);
    expect(t.x.getState()).toMatchObject({ papers: [], currentDoc: null });
    expect(t.browser.entries).toEqual(["/"]);
  });

  it("a Copilot approval asks the leave guard only when it would take the open Doc away", async () => {
    const t = await booted({ url: "/doc/d1" });
    const asked = t.leave.asks.length;
    t.leave.answer(() => false);
    expect(t.x.leaveDoc("d1")).toBe(false); // unsaved work in the open Doc keeps the card
    expect(t.leave.asks.slice(asked)).toEqual([{ view: "doc", paneId: undefined, origin: "user" }]);
    expect(t.x.leaveDoc("d2")).toBe(true);
    expect(t.leave.asks.slice(asked)).toHaveLength(1);
    t.leave.answer(() => true);
    expect(t.x.leaveDoc("d1")).toBe(true);
    // a guard that answers later (its dialog) is passed on as a pending answer, never counted as a refusal
    t.leave.lateFor("doc");
    const pending = t.x.leaveDoc("d1");
    expect(pending).toBeInstanceOf(Promise);
    t.leave.late[0]!(true);
    expect(await pending).toBe(true);
  });
});

describe("the Copilot's workspace actions", () => {
  const twoPanes = async (o: Setup = {}) => {
    const t = await booted(o);
    expect(await t.x.runWorkspaceAction({ action: "split_pane" })).toEqual({ ok: true });
    expect(t.x.getState().panes.map((p) => p.id)).toEqual([1, 2]);
    return t;
  };

  it("switch_view: the active pane like the activity bar, a named pane like the pane menu (which becomes active), not_found", async () => {
    const t = await booted();
    expect(await t.x.runWorkspaceAction({ action: "switch_view", view: "library" })).toEqual({ ok: true });
    expect(t.views()).toEqual(["library"]);
    await t.x.runWorkspaceAction({ action: "split_pane" });
    expect(await t.x.runWorkspaceAction({ action: "switch_view", view: "write", paneId: 1 })).toEqual({ ok: true });
    expect(t.views()).toEqual(["write", "library"]);
    expect(t.x.getState().activeId).toBe(1);
    expect(await t.x.runWorkspaceAction({ action: "switch_view", view: "plan", paneId: 99 })).toEqual({ ok: false, detail: "not_found" });
  });

  it("split_pane: at most three panes, the fourth is disabled; a pane that is not there is not_found", async () => {
    const t = await twoPanes();
    expect(await t.x.runWorkspaceAction({ action: "split_pane" })).toEqual({ ok: true });
    expect(await t.x.runWorkspaceAction({ action: "split_pane" })).toEqual({ ok: false, detail: "disabled" });
    expect(t.x.getState().panes).toHaveLength(3);
    expect(await t.x.runWorkspaceAction({ action: "split_pane", paneId: 9 })).toEqual({ ok: false, detail: "not_found" });
  });

  it("close_pane and select_pane: a named pane, the last pane is disabled, a missing one not_found", async () => {
    const t = await twoPanes();
    expect(await t.x.runWorkspaceAction({ action: "select_pane", paneId: 1 })).toEqual({ ok: true });
    expect(t.x.getState().activeId).toBe(1);
    expect(await t.x.runWorkspaceAction({ action: "close_pane", paneId: 2 })).toEqual({ ok: true });
    expect(t.x.getState().panes.map((p) => p.id)).toEqual([1]);
    expect(await t.x.runWorkspaceAction({ action: "close_pane", paneId: 1 })).toEqual({ ok: false, detail: "disabled" });
    expect(await t.x.runWorkspaceAction({ action: "close_pane", paneId: 7 })).toEqual({ ok: false, detail: "not_found" });
    expect(await t.x.runWorkspaceAction({ action: "select_pane", paneId: 7 })).toEqual({ ok: false, detail: "not_found" });
  });

  it("select_pane asks no leave guard: a Doc pane with unsaved work can be left by selecting another pane", async () => {
    const t = await twoPanes({ panes: [{ id: 1, view: "doc", size: 1 }] });
    t.leave.answer(() => false);
    const asked = t.leave.asks.length;
    expect(await t.x.runWorkspaceAction({ action: "select_pane", paneId: 1 })).toEqual({ ok: true });
    expect(t.leave.asks.length).toBe(asked);
  });

  it("resize_pane: the divider rule, answered at once without waiting for a render; a missing pane is not_found", async () => {
    const t = await booted({ render: false, panes: [{ id: 1, view: "plan", size: 1 }, { id: 2, view: "plan", size: 1 }] });
    expect(await t.x.runWorkspaceAction({ action: "resize_pane", paneId: 1, share: 0.7 })).toEqual({ ok: true });
    expect(shareOf(t.x.getState().panes.map((p) => p.size), 0)).toBeCloseTo(0.7, 5);
    expect(await t.x.runWorkspaceAction({ action: "resize_pane", paneId: 9, share: 0.5 })).toEqual({ ok: false, detail: "not_found" });
  });

  it("resize_pane with three panes refuses a share the divider could not give", async () => {
    const t = await twoPanes();
    await t.x.runWorkspaceAction({ action: "split_pane" });
    expect(await t.x.runWorkspaceAction({ action: "resize_pane", paneId: 1, share: 0.84 })).toEqual({ ok: false, detail: "disabled" });
  });

  it("a Doc pane with unsaved work keeps its page: switch_view, close_pane and open_task_doc are leave_blocked, a split goes through", async () => {
    const t = await booted({ panes: [{ id: 1, view: "doc", size: 1 }] });
    t.leave.answer((view) => view !== "doc");
    expect(await t.x.runWorkspaceAction({ action: "switch_view", view: "library" })).toEqual({ ok: false, detail: "leave_blocked" });
    expect(t.views()).toEqual(["doc"]);
    expect(await t.x.runWorkspaceAction({ action: "split_pane" })).toEqual({ ok: true }); // a copy; nothing is left
    expect(await t.x.runWorkspaceAction({ action: "close_pane", paneId: 1 })).toEqual({ ok: false, detail: "leave_blocked" });
    expect(t.x.getState().panes).toHaveLength(2);
    expect(await t.x.openDocAction("d2")).toEqual({ ok: false, detail: "leave_blocked" });
    t.leave.answer(() => true);
    expect(await t.x.runWorkspaceAction({ action: "switch_view", view: "library", paneId: 1 })).toEqual({ ok: true });
  });

  it("an unsaved argument draft: the Copilot's requests are leave_blocked at once with origin agent, the person's own switch asks", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    const questions: ((ok: boolean) => void)[] = [];
    t.leave.answer((view, _paneId, origin) => (view !== "library" ? true : origin === "agent" ? false : new Promise<boolean>((resolve) => questions.push(resolve))));
    expect(await t.x.runWorkspaceAction({ action: "switch_view", view: "plan" })).toEqual({ ok: false, detail: "leave_blocked" });
    expect(await t.x.runWorkspaceAction({ action: "open_doc", docId: "d2" })).toEqual({ ok: false, detail: "leave_blocked" }); // it would replace this pane
    await t.x.runWorkspaceAction({ action: "split_pane" });
    expect(await t.x.runWorkspaceAction({ action: "close_pane", paneId: 1 })).toEqual({ ok: false, detail: "leave_blocked" });
    expect(await t.x.runWorkspaceAction({ action: "switch_view", view: "plan", paneId: 1 })).toEqual({ ok: false, detail: "leave_blocked" });
    expect(questions).toHaveLength(0);
    expect(t.leave.asks.filter((a) => a.view === "library").every((a) => a.origin === "agent")).toBe(true);
    expect(t.views()).toEqual(["library", "library"]);
    // the person's own switch asks (and waits)
    expect(t.x.setActiveView("plan")).toBe(false);
    expect(questions).toHaveLength(1);
  });

  it("set_appearance: every value through the appearance setter; ok only when config.toml took each of them", async () => {
    const t = await booted({ render: false });
    expect(await t.x.runWorkspaceAction({ action: "set_appearance", theme: "light", accent: "teal", density: "compact", language: "zh-CN" })).toEqual({ ok: true });
    expect(t.setTweak.mock.calls).toEqual([
      ["theme", "light"],
      ["accent", "teal"],
      ["density", "compact"],
      ["language", "zh-CN"],
    ]);
    t.setTweak.mockImplementation(async (key) => key !== "density");
    expect(await t.x.runWorkspaceAction({ action: "set_appearance", theme: "dark", density: "regular" })).toEqual({ ok: false, detail: "unavailable" });
  });

  it("open_copilot and close_copilot: the toolbar's own state", async () => {
    const t = await booted();
    expect(await t.x.runWorkspaceAction({ action: "open_copilot" })).toEqual({ ok: true });
    expect(t.x.getState().copilotOpen).toBe(true);
    expect(await t.x.runWorkspaceAction({ action: "open_copilot" })).toEqual({ ok: true });
    expect(await t.x.runWorkspaceAction({ action: "close_copilot" })).toEqual({ ok: true });
    expect(t.x.getState().copilotOpen).toBe(false);
  });

  it("open_doc: a known Doc in the Doc pane (else the active one); unknown is not_found and touches nothing", async () => {
    const t = await twoPanes();
    expect(await t.x.runWorkspaceAction({ action: "open_doc", docId: "d2" })).toEqual({ ok: true });
    expect(t.views()).toEqual(["plan", "doc"]);
    expect(t.browser.url()).toBe("/doc/d2");
    expect(await t.x.runWorkspaceAction({ action: "open_doc", docId: "not-in-library" })).toEqual({ ok: false, detail: "not_found" });
    expect(t.browser.url()).toBe("/doc/d2");
    expect(t.fetchPapers).toHaveBeenCalledTimes(2); // the boot, and one reread for the unknown Doc
  });

  it("open_doc finds a Doc ingested after the page loaded by rereading the paper list once", async () => {
    const t = await booted();
    t.setPapers(["d1", "d2", "fresh"]);
    expect(await t.x.openDocAction("fresh")).toEqual({ ok: true });
    expect(t.x.getState()).toMatchObject({ papers: ["d1", "d2", "fresh"], currentDoc: "fresh" });
  });

  it("open_doc with a paper list that cannot be reread is unavailable", async () => {
    const t = await booted();
    t.fetchPapers.mockRejectedValueOnce(new Error("offline"));
    expect(await t.x.openDocAction("fresh")).toEqual({ ok: false, detail: "unavailable" });
  });

  it("open_doc is held back by unsaved work in the open Doc, like the Reader's own switch", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.answer(() => false);
    expect(await t.x.runWorkspaceAction({ action: "open_doc", docId: "d2" })).toEqual({ ok: false, detail: "leave_blocked" });
    expect(t.browser.url()).toBe("/doc/d1");
  });

  it("open_copilot_settings is the panel's own: unavailable here", async () => {
    const t = await booted();
    expect(await t.x.runWorkspaceAction({ action: "open_copilot_settings" } as never)).toEqual({ ok: false, detail: "unavailable" });
  });
});

describe("an action answers ok once the Shell has rendered its change", () => {
  it("waits for the render receipt of the snapshot that has the change", async () => {
    const t = await booted({ render: false });
    t.x.rendered(t.x.getState());
    let answer: unknown = null;
    void t.x.runWorkspaceAction({ action: "switch_view", view: "library" }).then((a) => (answer = a));
    await flush();
    expect(answer).toBeNull();
    expect(t.views()).toEqual(["library"]); // changed at once
    t.x.rendered(t.x.getState());
    await flush();
    expect(answer).toEqual({ ok: true });
    expect(t.timers.pending()).toBe(0);
  });

  it("a receipt of an older snapshot is not enough; a later one is", async () => {
    const t = await booted({ render: false });
    const old = t.x.getState();
    let answer: unknown = null;
    void t.x.runWorkspaceAction({ action: "open_copilot" }).then((a) => (answer = a));
    t.x.rendered(old);
    await flush();
    expect(answer).toBeNull();
    t.x.setCopilotOpen(true); // unchanged: no newer snapshot
    t.x.split(1); // a newer snapshot
    t.x.rendered(t.x.getState());
    await flush();
    expect(answer).toEqual({ ok: true });
  });

  it("nothing changed and the latest snapshot already shown: answered at once", async () => {
    const t = await booted({ render: false });
    t.x.rendered(t.x.getState());
    expect(await t.x.runWorkspaceAction({ action: "select_pane", paneId: 1 })).toEqual({ ok: true });
  });

  it.each([
    ["switch_view", { action: "switch_view", view: "library" }],
    ["split_pane", { action: "split_pane" }],
    ["close_pane", { action: "close_pane", paneId: 2 }],
    ["select_pane", { action: "select_pane", paneId: 1 }],
    ["open_copilot", { action: "open_copilot" }],
    ["close_copilot", { action: "close_copilot" }],
    ["open_doc", { action: "open_doc", docId: "d2" }],
  ] as const)("%s with no render within 1000 ms is unavailable", async (_name, action) => {
    const t = await booted({ render: false, panes: [{ id: 1, view: "plan", size: 1 }, { id: 2, view: "plan", size: 1 }], activeId: 2 });
    if (action.action === "close_copilot") t.x.setCopilotOpen(true);
    let answer: unknown = null;
    void t.x.runWorkspaceAction(action).then((a) => (answer = a));
    await flush();
    t.timers.advance(999);
    await flush();
    expect(answer).toBeNull();
    t.timers.advance(1);
    await flush();
    expect(answer).toEqual({ ok: false, detail: "unavailable" });
  });

  it("the Doc pane host's openDoc waits the same way", async () => {
    const t = await booted({ render: false });
    let answer: unknown = null;
    void t.host().openDoc("d2").then((a) => (answer = a));
    await flush();
    t.timers.advance(1000);
    await flush();
    expect(answer).toEqual({ ok: false, detail: "unavailable" });
  });
});

describe("the page fields of the published context", () => {
  it("are the nine page keys in the order the Shell publishes them, each null unless a page reports it", () => {
    expect(PAGE_FIELD_KEYS).toEqual(["plan", "library", "discovery", "argument", "reader", "pdf", "textSource", "writer", "mail"]);
    const filled = pageFields({ mail: null, plan: { selectedPlanId: null } as never });
    expect(Object.keys(filled)).toEqual(["plan", "library", "discovery", "argument", "reader", "pdf", "textSource", "writer", "mail"]);
    expect(filled).toEqual({ plan: { selectedPlanId: null }, library: null, discovery: null, argument: null, reader: null, pdf: null, textSource: null, writer: null, mail: null });
  });
});

describe("the appearance setter handed to the workspace once", () => {
  it("is the same function on every render of the preferences", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
    const { result, rerender } = renderHook(() => usePreferencesState());
    const first = result.current.setTweak;
    rerender();
    rerender();
    expect(result.current.setTweak).toBe(first);
  });
});
