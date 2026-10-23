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
import { createWorkspaceState, DOC_GONE_NOTICE_MS, type WorkspaceState } from "../src/argelander/panes/workspace-state";
import { PAGE_FIELD_KEYS, pageFields, type Pane } from "../src/argelander/panes";
import type { PaneAdapter } from "../src/argelander/panes/adapter";
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
  /** Each exploration a Library page started, with its pane (ticket 09). */
  const exploresIn: { paneId: number; seed: string }[] = [];
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
        paneId,
        isExploring: () => exploring.has(paneId),
        explore: (seed) => {
          if (exploring.has(paneId)) return;
          explores.push(seed);
          exploresIn.push({ paneId, seed });
          exploring.add(paneId);
        },
        exit: () => {
          if (exploring.delete(paneId)) exploreExits.push(paneId);
        },
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      exploring.delete(paneId); // the page goes away with its exploration, as the real view's state does
      open.delete(paneId); // and with the graph it showed
    };
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
    exploresIn,
    exploring,
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
  /** The server's library.changed subscription (none unless given). */
  onLibraryChanged?: (cb: () => void) => () => void;
  /** The status of a Doc's description (default: 200 while listed, else 404). */
  docStatus?: (docId: string) => Promise<number>;
  panes?: Pane[];
  activeId?: number;
  /** Install a Shell stand-in that acknowledges every snapshot at once (default true). */
  render?: boolean;
  /** An existing history (a reload: a new page on the same entries); `url` is then ignored. */
  browser?: MemoryBrowser;
  /** The page adapters the pane manager is given (default none). */
  pages?: PaneAdapter[];
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
  // a Doc's description: there (200) while the server lists it, else 404 (a test may answer otherwise)
  const docStatus = vi.fn(o.docStatus ?? (async (id: string) => (papers.includes(id) ? 200 : 404)));
  const setTweak = vi.fn(async (_key: string, _value: unknown) => true);
  let host: DocPaneHost | null = null;
  const x = createWorkspaceState({
    initial: { panes: o.panes ?? [{ id: 1, view: "plan", size: 1 }], activeId: o.activeId ?? 1 },
    pages: (docHost) => {
      host = docHost;
      return o.pages ?? [];
    },
    browser: browser.port,
    timers: timers.port,
    leave: leave.port,
    fetchPapers,
    ...(o.onLibraryChanged ? { onLibraryChanged: o.onLibraryChanged } : {}),
    docStatus,
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
    docStatus,
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

  it("a Doc route that is not in the list opens no Doc: the Library page, the plain URL and the deleted notice (ticket 11)", async () => {
    const t = await booted({ url: "/doc/zz" });
    expect(t.x.getState()).toMatchObject({ currentDoc: "d1", papers: ["d1", "d2"], docGoneNotice: { docId: "zz" } });
    expect(t.views()).toEqual(["library"]);
    expect(t.browser.entries).toEqual(["/"]);
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

  it("an exploration or a graph the page opened itself while the list was being read is not taken for a boot deep link", async () => {
    // The page's own navigation writes the address with pushState (no event); the boot then must not hand that address
    // to a bus again: with a mocked, instant ADS answer the second request sent the same exploration twice (ticket 07).
    for (const [url, bus] of [["/#explore/2020X", exploreBus], ["/#argument/w1", argumentBus]] as const) {
      let answer!: (papers: string[]) => void;
      const t = setup({ panes: [{ id: 1, view: "library", size: 1 }], fetchPapers: () => new Promise((resolve) => (answer = resolve)) });
      await flush();
      const asked = vi.spyOn(bus, "request");
      t.browser.port.push(url); // the Library page explores / opens a graph and writes its URL
      answer(["d1"]);
      await flush();
      expect(asked).not.toHaveBeenCalled();
      expect(t.x.getState()).toMatchObject({ papers: ["d1"], currentDoc: "d1" });
      expect(t.browser.entries).toEqual(["/", url]);
      asked.mockRestore();
      for (const cleanup of cleanups.splice(0)) cleanup();
    }
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
    await flush(); // the server's paper list is read first (ticket 11)
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

    const u = await booted({ url: "/#explore/2020X", papers: ["d1", "d2", "d9"] });
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
    await flush(); // the server's paper list is read first (ticket 11)
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
    await flush(); // the server's paper list is read first (ticket 11)
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

  it("Forward to the Doc a Back parked puts it back into its parked pane, not the active pane (ticket 06)", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "plan", size: 1 },
        { id: 2, view: "library", size: 1 },
      ],
      activeId: 1,
    });
    t.x.openDoc("d2"); // pane 1: Plan → Doc
    expect(t.views()).toEqual(["doc", "library"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["plan", "library"]);
    t.x.select(2); // the person clicks into the other pane
    const asked = t.leave.asks.length;
    t.browser.forward();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["doc", "library"]);
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.leave.asks.slice(asked).filter((a) => a.view === "library")).toEqual([]); // the Library pane is not replaced, so not asked
    // the same Doc pane again: Back still finds its record
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["plan", "library"]);
  });

  it("Forward with a parked session that is void (its pane switched by hand) lands in the active pane as before", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "plan", size: 1 },
        { id: 2, view: "library", size: 1 },
      ],
      activeId: 1,
    });
    t.x.openDoc("d2");
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    t.x.setPaneView(1, "write"); // by hand: pane 1 becomes active and the parked session is void
    t.x.select(2);
    t.browser.forward();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["write", "doc"]);
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

describe("switching the view away from an exploration (the activity bar, the pane menu)", () => {
  /** A Library page with the first Doc current, then an exploration (its address entered by hand, as the view's own push leaves it). */
  const exploring = async (o: Setup = {}) => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }], ...o });
    t.browser.editHash("/#explore/2020X");
    await flush();
    expect(t.library.explores).toEqual(["2020X"]);
    return t;
  };

  it("to the Doc: the exploration is left with a new entry naming the Doc, and Back returns to the exploration", async () => {
    const t = await exploring();
    const before = t.leave.asks.length;
    expect(t.x.setActiveView("doc")).toBe(true);
    expect(t.views()).toEqual(["doc"]);
    expect(t.leave.asks.slice(before)).toEqual([{ view: "library", paneId: 1, origin: "user" }]);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X", "/doc/d1"]);
    await flush();
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/#explore/2020X");
    expect(t.views()).toEqual(["library"]);
    expect(t.library.explores).toEqual(["2020X", "2020X"]);
  });

  it("to the Doc: the replaced view is recorded, so Back puts that pane back even when another pane is active", async () => {
    const t = await exploring({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 1,
    });
    expect(t.x.setActiveView("doc")).toBe(true);
    expect(t.views()).toEqual(["doc", "plan"]);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X", "/doc/d1"]);
    t.x.select(2);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["library", "plan"]);
    expect(t.library.explores).toEqual(["2020X", "2020X"]);
    // Forward (from that pane): the same Doc pane again, and Back still finds its record
    t.x.select(1);
    t.browser.forward();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["doc", "plan"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["library", "plan"]);
  });

  it("the pane menu leaving the exploration for the Doc writes the same entry", async () => {
    const t = await exploring({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 2,
    });
    expect(t.x.setPaneView(1, "doc")).toBe(true);
    expect(t.views()).toEqual(["doc", "plan"]);
    expect(t.x.getState().activeId).toBe(1);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X", "/doc/d1"]);
  });

  it("to the Doc with no Doc to show: the plain URL", async () => {
    const t = await exploring({ papers: [] });
    expect(t.x.setActiveView("doc")).toBe(true);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X", "/"]);
  });

  it("to another page: a new entry with the plain URL, and Back returns to the exploration", async () => {
    const t = await exploring();
    expect(t.x.setActiveView("plan")).toBe(true);
    expect(t.views()).toEqual(["plan"]);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X", "/"]);
    await flush();
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/#explore/2020X");
    expect(t.views()).toEqual(["library"]);
    expect(t.library.explores).toEqual(["2020X", "2020X"]);
  });

  it("refused by the Library page's guard: asked once, nothing changes and no entry is written", async () => {
    const t = await exploring();
    t.leave.answer((view) => view !== "library");
    const before = t.leave.asks.length;
    expect(t.x.setActiveView("doc")).toBe(false);
    expect(t.leave.asks.slice(before)).toEqual([{ view: "library", paneId: 1, origin: "user" }]);
    expect(t.views()).toEqual(["library"]);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X"]);
  });

  it("a guard that answers later: no changes nothing; yes switches and writes the entry then", async () => {
    const t = await exploring();
    t.leave.lateFor("library");
    expect(t.x.setActiveView("doc")).toBe(false);
    t.leave.late[0]!(false);
    await flush();
    expect(t.views()).toEqual(["library"]);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X"]);
    expect(t.x.setActiveView("doc")).toBe(false);
    expect(t.leave.late).toHaveLength(2);
    t.leave.late[1]!(true);
    await flush();
    expect(t.views()).toEqual(["doc"]);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X", "/doc/d1"]);
  });

  it("a late yes after the address moved on switches the view but writes no entry over the newer one", async () => {
    const t = await exploring();
    t.leave.lateFor("library");
    expect(t.x.setActiveView("plan")).toBe(false);
    t.browser.editHash("/#explore/2021Y");
    await flush();
    t.leave.late[0]!(true);
    await flush();
    expect(t.views()).toEqual(["plan"]);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X", "/#explore/2021Y"]);
  });

  it("the Copilot's switch_view leaves it the same way, with origin agent: a new entry, and Back returns to the exploration", async () => {
    const t = await exploring();
    const before = t.leave.asks.length;
    expect(await t.x.runWorkspaceAction({ action: "switch_view", view: "plan" })).toEqual({ ok: true });
    expect(t.views()).toEqual(["plan"]);
    expect(t.leave.asks.slice(before)).toEqual([{ view: "library", paneId: 1, origin: "agent" }]);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X", "/"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/#explore/2020X");
    expect(t.views()).toEqual(["library"]);
  });

  it("the Copilot's switch_view of a named pane to the Doc writes the Doc's address", async () => {
    const u = await exploring();
    expect(await u.x.runWorkspaceAction({ action: "switch_view", view: "doc", paneId: 1 })).toEqual({ ok: true });
    expect(u.browser.entries).toEqual(["/", "/#explore/2020X", "/doc/d1"]);
  });

  it("the Copilot's switch_view with unsaved work is leave_blocked: nothing changes and no entry is written", async () => {
    const t = await exploring();
    t.leave.answer((view, _paneId, origin) => !(view === "library" && origin === "agent"));
    expect(await t.x.runWorkspaceAction({ action: "switch_view", view: "plan" })).toEqual({ ok: false, detail: "leave_blocked" });
    expect(t.views()).toEqual(["library"]);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X"]);
  });

  it("a pane that is not exploring, or an address that names no exploration, writes nothing", async () => {
    const t = await exploring({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "library", size: 1 },
      ],
      activeId: 1,
    });
    // the boot request is served by the first Library page: pane 1 explores, pane 2 does not
    expect(t.x.setPaneView(2, "doc")).toBe(true);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X"]);
    const u = await booted({ url: "/", panes: [{ id: 1, view: "library", size: 1 }] });
    expect(u.x.setActiveView("doc")).toBe(true);
    expect(u.browser.entries).toEqual(["/"]);
  });
});

describe("switching the view away from an argument graph (ticket 05: the same rule as an exploration)", () => {
  /** A Library page with the first Doc current, then the graph of w1 opened in pane 1 (one entry). */
  const graph = async (o: Setup = {}) => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }], ...o });
    t.x.select(1);
    t.x.openArgumentGraph("w1");
    await flush();
    expect(t.library.open.get(1)).toBe("w1");
    expect(t.browser.entries).toEqual(["/", "/#argument/w1"]);
    return t;
  };

  it("to another page: the graph's guard is asked once, a new entry with the plain URL, and Back returns to the graph", async () => {
    const t = await graph();
    const before = t.leave.asks.length;
    expect(t.x.setActiveView("plan")).toBe(true);
    expect(t.views()).toEqual(["plan"]);
    expect(t.leave.asks.slice(before)).toEqual([{ view: "library", paneId: 1, origin: "user" }]);
    expect(t.browser.entries).toEqual(["/", "/#argument/w1", "/"]);
    await flush();
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/#argument/w1");
    expect(t.views()).toEqual(["library"]);
    expect(t.library.open.get(1)).toBe("w1");
    expect(t.leave.asks.slice(before)).toHaveLength(1); // the Back asked nothing: no graph was open to lose
  });

  it("to the Doc: a new entry naming the Doc, the replaced view recorded on the graph's entry, so Back puts that pane back even when another pane is active", async () => {
    const t = await graph({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 1,
    });
    expect(t.x.setActiveView("doc")).toBe(true);
    expect(t.views()).toEqual(["doc", "plan"]);
    expect(t.browser.entries).toEqual(["/", "/#argument/w1", "/doc/d1"]);
    t.x.select(2);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/#argument/w1");
    expect(t.views()).toEqual(["library", "plan"]);
    expect(t.library.open.get(1)).toBe("w1");
  });

  it("the pane menu leaves it the same way (that pane becomes active)", async () => {
    const t = await graph({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 2,
    });
    t.x.select(2);
    expect(t.x.setPaneView(1, "write")).toBe(true);
    expect(t.x.getState().activeId).toBe(1);
    expect(t.browser.entries).toEqual(["/", "/#argument/w1", "/"]);
  });

  it("the Copilot's switch_view: a new entry with origin agent; with an unsaved draft leave_blocked and nothing written", async () => {
    const t = await graph();
    t.leave.answer((view, _paneId, origin) => !(view === "library" && origin === "agent"));
    expect(await t.x.runWorkspaceAction({ action: "switch_view", view: "plan" })).toEqual({ ok: false, detail: "leave_blocked" });
    expect(t.browser.entries).toEqual(["/", "/#argument/w1"]);
    expect(t.views()).toEqual(["library"]);
    t.leave.answer(() => true);
    expect(await t.x.runWorkspaceAction({ action: "switch_view", view: "plan" })).toEqual({ ok: true });
    expect(t.leave.asks[t.leave.asks.length - 1]).toEqual({ view: "library", paneId: 1, origin: "agent" });
    expect(t.browser.entries).toEqual(["/", "/#argument/w1", "/"]);
  });

  it("refused by the graph's guard: nothing changes and no entry is written; a late yes writes the entry then", async () => {
    const t = await graph();
    t.leave.answer((view) => view !== "library");
    expect(t.x.setActiveView("plan")).toBe(false);
    expect(t.views()).toEqual(["library"]);
    expect(t.browser.entries).toEqual(["/", "/#argument/w1"]);
    t.leave.lateFor("library");
    expect(t.x.setActiveView("plan")).toBe(false);
    t.leave.late[0]!(true);
    await flush();
    expect(t.views()).toEqual(["plan"]);
    expect(t.browser.entries).toEqual(["/", "/#argument/w1", "/"]);
  });

  it("a pane that shows no graph writes nothing", async () => {
    const t = await graph({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "library", size: 1 },
      ],
      activeId: 1,
    });
    expect(t.library.open.has(2)).toBe(false);
    expect(t.x.setPaneView(2, "plan")).toBe(true);
    expect(t.browser.entries).toEqual(["/", "/#argument/w1"]);
  });
});

describe("records for every view (ticket 07): a pane's view session decides whether Back puts its view back", () => {
  const twoPanes = (): Pane[] => [
    { id: 1, view: "library", size: 1 },
    { id: 2, view: "plan", size: 1 },
  ];
  /** Pane 1 explores; pane 2 shows the Doc d1 (opened from the Library, so pane 2 is a Doc pane). */
  const exploringBesideDoc = async () => {
    const t = await booted({ panes: twoPanes(), activeId: 1 });
    t.x.select(2);
    expect(t.x.setActiveView("doc")).toBe(true);
    expect(t.views()).toEqual(["library", "doc"]);
    t.x.select(1);
    t.browser.editHash("/#explore/2020X");
    await flush();
    expect(t.library.explores).toEqual(["2020X"]);
    return t;
  };

  it("explore → Plan → Back: the exploring pane gets the Library page and the exploration back; the Doc pane beside it is not changed", async () => {
    const t = await exploringBesideDoc();
    expect(t.x.setActiveView("plan")).toBe(true);
    expect(t.views()).toEqual(["plan", "doc"]);
    t.x.select(2); // the Doc pane is active when Back is pressed
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/#explore/2020X");
    expect(t.views()).toEqual(["library", "doc"]);
    expect(t.library.explores).toEqual(["2020X", "2020X"]);
    expect(t.leave.asks.filter((a) => a.view === "doc" && a.paneId === 2)).toEqual([]);
  });

  it("graph → Plan → Back: the graph's pane gets the Library page and the graph back; the Doc pane beside it is not changed", async () => {
    const t = await booted({ panes: twoPanes(), activeId: 2 });
    expect(t.x.setActiveView("doc")).toBe(true);
    t.x.openArgumentGraph("w1"); // pane 1 shows the graph
    await flush();
    expect(t.library.open.get(1)).toBe("w1");
    expect(t.x.setPaneView(1, "plan")).toBe(true);
    expect(t.views()).toEqual(["plan", "doc"]);
    t.x.select(2);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/#argument/w1");
    expect(t.views()).toEqual(["library", "doc"]);
    expect(t.library.open.get(1)).toBe("w1");
  });

  it("a record whose pane left that view session (switched by hand) is no record, and the fallback leaves the other Doc pane alone", async () => {
    const t = await exploringBesideDoc();
    t.x.setActiveView("plan");
    t.x.setPaneView(1, "write"); // by hand: pane 1 is no longer in the session the switch to the Plan page made
    t.x.select(2);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/#explore/2020X");
    // the exploration needs a Library page: the recorded pane gives it, not the Doc pane that is active
    expect(t.views()).toEqual(["library", "doc"]);
    expect(t.library.explores).toEqual(["2020X", "2020X"]);
  });

  it("a switch by hand back to the same view is a new session too: Plan → Write → Plan voids the record", async () => {
    const t = await exploringBesideDoc();
    t.x.split(2); // pane 3, a third pane (a Doc pane copy), turned into the Writer
    t.x.setActiveView("write");
    t.x.select(1);
    expect(t.views()).toEqual(["library", "doc", "write"]);
    t.x.setActiveView("plan");
    t.x.setPaneView(1, "write");
    t.x.setPaneView(1, "plan");
    t.x.select(3);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    // no record applied (pane 1 would have been put back): the fallback makes the active pane the Library page
    expect(t.views()).toEqual(["plan", "doc", "library"]);
  });

  it("Back to a plain URL with a record that no longer applies changes no other Doc pane", async () => {
    const t = await booted(); // pane 1, the Plan page
    t.x.openDoc("d2"); // pane 1 Plan → Doc; "/" records it
    t.x.split(1); // pane 2: a second Doc pane, active
    expect(t.views()).toEqual(["doc", "doc"]);
    t.x.setPaneView(1, "write"); // pane 1 leaves the Doc session the record names
    t.x.select(2);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/");
    expect(t.views()).toEqual(["write", "doc"]);
  });

  it("each view session is unique per page load: a record written before a reload never matches a pane after it", async () => {
    const browser = memoryBrowser("/");
    const before = await booted({ browser, panes: [{ id: 1, view: "library", size: 1 }] });
    browser.editHash("/#explore/2020X");
    await flush();
    before.x.setActiveView("plan"); // "#explore/2020X" records pane 1's Plan session of this page load
    before.stop();
    before.library.unmount();
    const after = await booted({ browser });
    expect(after.views()).toEqual(["plan"]);
    browser.port.back();
    await browser.settle();
    await flush();
    // no record applies; with no Doc pane anywhere the fallback is the one it always was: the active pane
    expect(after.views()).toEqual(["library"]);
  });
});

describe("Forward restores the view a Back parked, for any view (07 follow-up)", () => {
  it("explore → Plan → Back → Forward puts the Plan page back, and Back again returns to the exploration", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.browser.editHash("/#explore/2020X");
    await flush();
    expect(t.x.setActiveView("plan")).toBe(true);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X", "/"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["library"]);
    t.browser.forward();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/");
    expect(t.views()).toEqual(["plan"]);
    // the same Plan session again: the exploration's record still applies
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/#explore/2020X");
    expect(t.views()).toEqual(["library"]);
    expect(t.library.explores).toEqual(["2020X", "2020X", "2020X"]);
  });

  it("graph → Write → Back → Forward puts the Writer back", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.x.openArgumentGraph("w1");
    await flush();
    expect(t.x.setActiveView("write")).toBe(true);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["library"]);
    expect(t.library.open.get(1)).toBe("w1");
    t.browser.forward();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/");
    expect(t.views()).toEqual(["write"]);
  });

  it("a parking that is void (its pane closed) leaves Forward as it was: no pane changes", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "write", size: 1 },
      ],
      activeId: 1,
    });
    t.browser.editHash("/#explore/2020X");
    await flush();
    t.x.setActiveView("plan");
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["library", "write"]);
    t.x.close(1); // the parked pane goes away (no entry is written for a close)
    t.browser.forward();
    await t.browser.settle();
    await flush();
    expect(t.browser.url()).toBe("/");
    expect(t.views()).toEqual(["write"]);
  });

  it("a parked Plan session is not a Doc session: a Doc address does not take that pane", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "write", size: 1 },
      ],
      activeId: 1,
    });
    t.browser.editHash("/#explore/2020X");
    await flush();
    t.x.setActiveView("plan");
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    t.x.select(2);
    t.browser.pop("/doc/d2");
    await flush();
    expect(t.views()).toEqual(["library", "doc"]);
  });
});

describe("the Copilot's page actions that switch a pane leave an exploration or a graph the same way (04 follow-up)", () => {
  /** A Plan page adapter whose action needs a Plan pane (`any`): with none the active pane is switched to it. */
  const planPage = (): PaneAdapter => ({
    page: "plan",
    status: () => "ready" as never,
    context: () => ({}),
    handles: (action) => (action as { action: string }).action === "plan_test_action",
    needsPane: () => "any",
    timeouts: { readyMs: 0, applyMs: 0 },
  });
  const action = { action: "plan_test_action" } as never;

  it("from an exploration: a new entry with the plain URL, the guard asked with origin agent, and Back returns to the exploration", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }], pages: [planPage()] });
    t.browser.editHash("/#explore/2020X");
    await flush();
    const before = t.leave.asks.length;
    await t.x.runViewAction(action);
    expect(t.views()).toEqual(["plan"]);
    expect(t.leave.asks.slice(before)).toEqual([{ view: "library", paneId: 1, origin: "agent" }]);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X", "/"]);
    t.browser.port.back();
    await t.browser.settle();
    await flush();
    expect(t.views()).toEqual(["library"]);
    expect(t.library.explores).toEqual(["2020X", "2020X"]);
  });

  it("from a graph with an unsaved draft: leave_blocked, nothing changes and no entry is written", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }], pages: [planPage()] });
    t.x.openArgumentGraph("w1");
    await flush();
    t.leave.answer((view, _paneId, origin) => !(view === "library" && origin === "agent"));
    expect(await t.x.runViewAction(action)).toEqual({ ok: false, detail: "leave_blocked" });
    expect(t.views()).toEqual(["library"]);
    expect(t.browser.entries).toEqual(["/", "/#argument/w1"]);
    t.leave.answer(() => true);
    await t.x.runViewAction(action);
    expect(t.browser.entries).toEqual(["/", "/#argument/w1", "/"]);
  });
});

describe("chains of Back and Forward, and fallbacks with nothing left to take (04–07 review)", () => {
  const step = async (t: Awaited<ReturnType<typeof booted>>, dir: "back" | "fwd") => {
    if (dir === "back") t.browser.port.back();
    else t.browser.forward();
    await t.browser.settle();
    await flush();
    return [t.browser.url(), ...t.views()].join(" ");
  };

  it("explore → Plan → Doc: Back, Back, Forward, Forward, Back, Back walk the same screens both ways", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.browser.editHash("/#explore/2020X");
    await flush();
    t.x.setActiveView("plan");
    t.x.openDoc("d2");
    const log = [[t.browser.url(), ...t.views()].join(" ")];
    for (const d of ["back", "back", "fwd", "fwd", "back", "back"] as const) log.push(await step(t, d));
    expect(log).toEqual([
      "/doc/d2 doc",
      "/ plan",
      "/#explore/2020X library",
      "/ plan",
      "/doc/d2 doc",
      "/ plan",
      "/#explore/2020X library",
    ]);
  });

  it("two panes that each left an exploration: Back ×3 and Forward ×3 put each pane's view back", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "library", size: 1 },
      ],
      activeId: 1,
    });
    t.browser.editHash("/#explore/X1");
    await flush();
    t.x.setPaneView(1, "plan");
    t.x.select(2);
    t.browser.editHash("/#explore/Y2");
    await flush();
    t.x.setPaneView(2, "write");
    const log = [[t.browser.url(), ...t.views()].join(" ")];
    for (const d of ["back", "back", "back", "fwd", "fwd", "fwd"] as const) log.push(await step(t, d));
    expect(log).toEqual([
      "/ plan write",
      "/#explore/Y2 plan library",
      "/ plan library",
      "/#explore/X1 library library",
      "/ plan library",
      "/#explore/Y2 plan library",
      "/ plan write",
    ]);
  });

  it("a graph's void record with only another Doc pane left: that Doc pane is not taken; the address names the graph, the screen keeps the Doc", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 2,
    });
    t.x.setActiveView("doc");
    t.x.openArgumentGraph("w1");
    await flush();
    t.x.setPaneView(1, "write");
    t.x.close(1);
    expect(await step(t, "back")).toBe("/#argument/w1 doc");
    expect(t.leave.asks.filter((a) => a.view === "doc")).toEqual([]);
    expect(t.library.opens.filter((o) => o.workId === "w1")).toHaveLength(1); // only the first open
  });

  it("an exploration's void record with only another Doc pane left: the same", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 2,
    });
    t.x.setActiveView("doc");
    t.x.select(1);
    t.browser.editHash("/#explore/2020X");
    await flush();
    t.x.setPaneView(1, "write");
    t.x.close(1);
    expect(await step(t, "back")).toBe("/#explore/2020X doc");
    expect(t.library.explores).toEqual(["2020X"]);
  });

  it("a graph's void record naming a pane that is not active: that pane becomes the Library page and the active pane stays active", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 1,
    });
    t.x.openArgumentGraph("w1");
    await flush();
    t.x.setPaneView(1, "write");
    t.x.setPaneView(1, "mail"); // by hand: the record on the graph's entry is void
    t.x.select(2);
    t.x.setActiveView("doc"); // pane 2 is a Doc pane now, and active
    expect(await step(t, "back")).toBe("/#argument/w1 library doc");
    expect(t.x.getState().activeId).toBe(2);
    expect(t.library.open.get(1)).toBe("w1");
  });

  it("a late yes to a switch away from the graph writes nothing over an entry the graph's own refusal pushed back at the same address", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.x.openArgumentGraph("w1");
    await flush();
    t.leave.lateFor("library");
    expect(t.x.setActiveView("plan")).toBe(false); // the switch's question is open
    t.browser.pop("/"); // a Back while it is open: the graph's own question pushes its address back (a new entry, same address)
    expect(t.browser.entries).toEqual(["/", "/#argument/w1", "/", "/#argument/w1"]);
    t.leave.late[0]!(true); // the switch's yes
    await flush();
    expect(t.views()).toEqual(["plan"]);
    expect(t.browser.entries).toEqual(["/", "/#argument/w1", "/", "/#argument/w1"]);
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

describe("a Doc's deletion and a refused open keep the entry's history state (ticket 08)", () => {
  const planAndWrite = (): Pane[] => [
    { id: 1, view: "plan", size: 1 },
    { id: 2, view: "write", size: 1 },
  ];
  const step = async (t: Awaited<ReturnType<typeof booted>>, dir: "back" | "fwd") => {
    if (dir === "back") t.browser.port.back();
    else t.browser.forward();
    await t.browser.settle();
    await flush();
  };

  it("the open Doc deleted: the address follows to the new main Doc and the entry keeps its state, so Back then Forward puts the Doc back into its own pane", async () => {
    const t = await booted({ panes: planAndWrite(), activeId: 1 });
    t.x.openDoc("d1"); // pane 1: Plan → Doc; "/" records it, "/doc/d1" names pane 1's Doc session
    const state = t.browser.port.state();
    t.x.docDeleted("d1", ["d2"]);
    expect(t.browser.entries).toEqual(["/", "/doc/d2"]);
    expect(t.browser.port.state()).toEqual(state);
    await step(t, "back");
    expect(t.views()).toEqual(["plan", "write"]);
    t.x.select(2);
    await step(t, "fwd");
    expect(t.browser.url()).toBe("/doc/d2");
    expect(t.views()).toEqual(["doc", "write"]);
    expect(t.x.getState().currentDoc).toBe("d2");
  });

  it("the open Doc deleted with nothing left: the address resets to / and the entry keeps its state", async () => {
    const t = await booted({ panes: planAndWrite(), activeId: 1, papers: ["d1"] });
    t.x.openDoc("d1");
    const state = t.browser.port.state();
    expect(state).not.toBeNull();
    t.x.docDeleted("d1", []);
    expect(t.browser.entries).toEqual(["/", "/"]);
    expect(t.browser.port.state()).toEqual(state);
  });

  it("an open the Doc's guard refuses puts the address back keeping the entry's state: Back then Forward still puts the Doc back into its own pane", async () => {
    const t = await booted({ panes: planAndWrite(), activeId: 1 });
    t.x.openDoc("d1");
    const state = t.browser.port.state();
    t.leave.answer((view) => view !== "doc");
    expect(t.x.openDoc("d2")).toBe(false);
    expect(t.browser.entries).toEqual(["/", "/doc/d1"]);
    expect(t.browser.port.state()).toEqual(state);
    t.leave.answer(() => true);
    await step(t, "back");
    expect(t.views()).toEqual(["plan", "write"]);
    t.x.select(2);
    await step(t, "fwd");
    expect(t.views()).toEqual(["doc", "write"]);
    expect(t.x.getState().currentDoc).toBe("d1");
  });

  it("a late no puts the address back keeping the entry's state too", async () => {
    const t = await booted({ panes: planAndWrite(), activeId: 1 });
    t.x.openDoc("d1");
    const state = t.browser.port.state();
    t.leave.lateFor("doc");
    expect(t.x.openDoc("d2")).toBe(false);
    t.leave.late[0]!(false);
    await flush();
    expect(t.browser.entries).toEqual(["/", "/doc/d1"]);
    expect(t.browser.port.state()).toEqual(state);
  });

  it("a record naming a Doc that was deleted is void: Back never brings the deleted Doc back", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "library", size: 1 },
        { id: 2, view: "plan", size: 1 },
      ],
      activeId: 2,
    });
    expect(t.x.setActiveView("doc")).toBe(true); // pane 2 shows d1
    t.x.select(1);
    t.browser.editHash("/#explore/2020X");
    await flush();
    t.x.openDoc("d2"); // the Doc pane switches d1 → d2; the exploration's entry records d1
    expect(t.x.getState().currentDoc).toBe("d2");
    t.x.docDeleted("d1", []);
    await step(t, "back");
    expect(t.browser.url()).toBe("/#explore/2020X");
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.views()).toEqual(["library", "doc"]);
  });
});

describe("the address is rewritten only while it names the Doc deleted or refused (ticket 10)", () => {
  it("an open the Doc's guard refuses at the plain URL leaves / alone", async () => {
    const t = await booted(); // the Plan page, d1 current, the address /
    t.leave.answer((view) => view !== "doc");
    expect(t.x.openDoc("d2")).toBe(false);
    expect(t.browser.entries).toEqual(["/"]);
    expect(t.views()).toEqual(["plan"]);
  });

  it("a late no at the plain URL leaves / alone too", async () => {
    const t = await booted();
    t.leave.lateFor("doc");
    expect(t.x.openDoc("d2")).toBe(false);
    t.leave.late[0]!(false);
    await flush();
    expect(t.browser.entries).toEqual(["/"]);
  });

  it("an open refused during an exploration (the Doc's guard, or the Library page's) leaves #explore/… alone", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.browser.editHash("/#explore/2020X");
    await flush();
    t.leave.answer((view) => view !== "doc");
    expect(t.x.openDoc("d2")).toBe(false);
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X"]);
    t.leave.answer((view) => view !== "library");
    expect(t.x.openDoc("d1")).toBe(false); // d1 is current: only the Library page it would replace is asked
    expect(t.browser.entries).toEqual(["/", "/#explore/2020X"]);
    expect(t.views()).toEqual(["library"]);
  });

  it("the open Doc deleted while the address is /: the address stays, the Doc still moves", async () => {
    const plain = await booted();
    plain.x.docDeleted("d1", ["d2"]);
    expect(plain.x.getState().currentDoc).toBe("d2");
    expect(plain.browser.entries).toEqual(["/"]);
  });

  it("the open Doc deleted while the address is #explore/…: the address stays", async () => {
    const explore = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    explore.browser.editHash("/#explore/2020X");
    await flush();
    explore.x.docDeleted("d1", ["d2"]);
    expect(explore.x.getState().currentDoc).toBe("d2");
    expect(explore.browser.entries).toEqual(["/", "/#explore/2020X"]);
  });

  it("the open Doc deleted while the address is #argument/…: the address stays", async () => {
    const graph = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    graph.x.openArgumentGraph("w1");
    await flush();
    graph.x.docDeleted("d1", []);
    expect(graph.x.getState().currentDoc).toBeNull();
    expect(graph.browser.url()).toBe("/#argument/w1");
  });

  it("another Doc's address stays when the Doc deleted is not the one it names", async () => {
    const t = await booted({ url: "/doc/d2" });
    t.x.docDeleted("d1", ["x"]);
    expect(t.browser.entries).toEqual(["/doc/d2"]);
  });
});

describe("Back, Forward or a deep link to a Doc that is gone (ticket 11)", () => {
  const step = async (t: Awaited<ReturnType<typeof booted>>, dir: "back" | "fwd") => {
    if (dir === "back") t.browser.port.back();
    else t.browser.forward();
    await t.browser.settle();
    await flush();
  };

  it("Back to a Doc deleted in this page load: not opened; a notice names it, the Doc pane turns back into the Library, the address is the plain URL and the entry keeps its state", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.x.openDoc("d1");
    t.x.openDoc("d2"); // the same Doc pane; the d1 entry records d1
    t.x.docDeleted("d1", ["x"]); // not the open Doc: nothing moves
    expect(t.browser.entries).toEqual(["/", "/doc/d1", "/doc/d2"]);
    const asked = t.leave.asks.length;
    await step(t, "back");
    expect(t.browser.entries).toEqual(["/", "/", "/doc/d2"]);
    expect(t.browser.index).toBe(1);
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.views()).toEqual(["library"]);
    expect(t.x.getState().docGoneNotice?.docId).toBe("d1");
    expect(t.leave.asks.slice(asked)).toEqual([{ view: "doc", paneId: 1, origin: "user" }]);
    expect(t.browser.port.state()).toMatchObject({ argelanderShown: { paneId: 1, view: "doc" }, argelanderReplaced: { paneId: 1, view: "doc", prevDocId: "d1" } });
    // Forward to d2 is an ordinary Doc entry
    await step(t, "fwd");
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.views()).toEqual(["doc"]);
  });

  it("Forward to a Doc deleted after Back left it: the notice and the Library page; Back and Forward again never bring a Doc pane back", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.x.openDoc("d1");
    await step(t, "back");
    expect(t.views()).toEqual(["library"]);
    t.x.docDeleted("d1", []);
    expect(t.browser.entries).toEqual(["/", "/doc/d1"]); // ticket 10: / names no Doc
    await step(t, "fwd");
    expect(t.browser.entries).toEqual(["/", "/"]);
    expect(t.browser.index).toBe(1);
    expect(t.views()).toEqual(["library"]);
    expect(t.x.getState().currentDoc).toBeNull();
    expect(t.x.getState().docGoneNotice?.docId).toBe("d1");
    expect(t.browser.port.state()).toMatchObject({ argelanderShown: { paneId: 1, view: "doc" } });
    await step(t, "back");
    await step(t, "fwd");
    expect(t.views()).toEqual(["library"]);
  });

  it("only the Doc pane changes, through its guard: refused, the Doc stays and its address is pushed back after the plain entry", async () => {
    const t = await booted({
      panes: [
        { id: 1, view: "plan", size: 1 },
        { id: 2, view: "library", size: 1 },
      ],
      activeId: 2,
    });
    t.x.openDoc("d1");
    t.x.openDoc("d2");
    t.x.docDeleted("d1", ["x"]);
    t.leave.answer((view) => view !== "doc");
    await step(t, "back");
    expect(t.views()).toEqual(["plan", "doc"]);
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.browser.entries).toEqual(["/", "/", "/doc/d2"]);
    expect(t.x.getState().docGoneNotice?.docId).toBe("d1");
    t.leave.answer(() => true);
    await step(t, "back"); // the plain entry it became: its record names the deleted Doc, so it is void
    expect(t.views()).toEqual(["plan", "library"]);
    expect(t.x.getState().currentDoc).toBe("d2");
  });

  it("a Doc deleted behind the page's back (another tab, the CLI, a bare DELETE): Forward to it reads the list again and shows the notice", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.x.openDoc("d1");
    await step(t, "back");
    expect(t.views()).toEqual(["library"]);
    t.setPapers(["d2"]); // the server no longer has d1; this page was not told
    await step(t, "fwd");
    expect(t.browser.entries).toEqual(["/", "/"]);
    expect(t.views()).toEqual(["library"]);
    expect(t.x.getState().docGoneNotice?.docId).toBe("d1");
    expect(t.x.getState().papers).toEqual(["d2"]);
  });

  it("a Doc found gone counts as deleted even when the Doc pane's guard keeps the open Doc: Back to that entry later never puts it back", async () => {
    const t = await booted({ panes: [{ id: 1, view: "library", size: 1 }] });
    t.x.openDoc("d1");
    t.x.openDoc("d2"); // the d1 entry records {pane 1, doc, prevDocId d1}
    t.setPapers(["d2"]); // d1 deleted elsewhere
    t.leave.answer((view) => view !== "doc");
    await step(t, "back");
    expect(t.browser.entries).toEqual(["/", "/", "/doc/d2"]);
    expect(t.x.getState().currentDoc).toBe("d2");
    t.leave.answer(() => true);
    await step(t, "back"); // the entry that named d1: its record names d1, so it is void
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.views()).toEqual(["library"]);
  });

  it("a Doc deleted in this page while the read is out is gone, whatever the read says, and never comes back into the list", async () => {
    const t = await booted({ url: "/doc/d1" });
    let answer!: (papers: string[]) => void;
    t.fetchPapers.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    t.browser.pop("/doc/d2");
    t.x.docDeleted("d2", []);
    answer(["d1", "d2"]);
    await flush();
    expect(t.x.getState()).toMatchObject({ currentDoc: "d1", papers: ["d1"], docGoneNotice: { docId: "d2" } });
    expect(t.browser.url()).toBe("/");
  });

  it("an older read that answers last never overwrites a newer list", async () => {
    let changed!: () => void;
    const t = await booted({
      url: "/doc/d1",
      onLibraryChanged: (cb) => {
        changed = cb;
        return () => {};
      },
    });
    let older!: (papers: string[]) => void;
    t.fetchPapers.mockImplementationOnce(() => new Promise((resolve) => (older = resolve)));
    t.browser.pop("/doc/d2"); // the arrival's read answers later
    t.setPapers(["d2", "d3"]);
    changed(); // a newer read, answered at once
    await flush();
    expect(t.x.getState().papers).toEqual(["d2", "d3"]);
    older(["d1", "d2"]);
    await flush();
    expect(t.x.getState().papers).toEqual(["d2", "d3"]);
    expect(t.x.getState().currentDoc).toBe("d2"); // the arrival still decides by its own answer
  });

  it("a late yes lets its traversal through at once: no second read, no second question, however slow the server", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.leave.lateFor("doc");
    t.browser.pop("/doc/d2");
    await flush();
    expect(t.leave.late).toHaveLength(1);
    expect(t.browser.url()).toBe("/doc/d1"); // the open Doc's address pushed back while the question is open
    t.fetchPapers.mockImplementation(() => new Promise(() => {}));
    const reads = t.fetchPapers.mock.calls.length;
    t.leave.late[0]!(true);
    await t.browser.settle();
    await flush();
    expect(t.leave.late).toHaveLength(1);
    expect(t.fetchPapers.mock.calls.length).toBe(reads);
    expect(t.x.getState().currentDoc).toBe("d2");
    expect(t.browser.url()).toBe("/doc/d2");
  });

  it("a Doc the list leaves out is gone only when its description answers 404: a 500 (a PDF two Works own) or no answer opens it", async () => {
    const t = await booted({ url: "/doc/d1", docStatus: async (id) => (id === "odd" ? 500 : 404) });
    t.browser.pop("/doc/d2");
    await flush();
    expect(t.docStatus).not.toHaveBeenCalled(); // listed: there
    t.browser.pop("/doc/odd");
    await flush();
    expect(t.docStatus).toHaveBeenCalledWith("odd");
    expect(t.x.getState()).toMatchObject({ currentDoc: "odd", docGoneNotice: null });
    t.docStatus.mockRejectedValueOnce(new Error("offline"));
    t.browser.pop("/doc/zz");
    await flush();
    expect(t.x.getState()).toMatchObject({ currentDoc: "zz", docGoneNotice: null });
  });

  it("a boot deep link the list leaves out but whose description is there opens as before", async () => {
    const t = await booted({ url: "/doc/odd", docStatus: async () => 500 });
    expect(t.x.getState()).toMatchObject({ currentDoc: "odd", docGoneNotice: null });
    expect(t.views()).toEqual(["doc"]);
    expect(t.browser.url()).toBe("/doc/odd");
  });

  it("a deleted Doc re-ingested under the same id: once a read sent after the delete lists it, Back/Forward opens it again", async () => {
    let changed!: () => void;
    const t = await booted({
      panes: [{ id: 1, view: "library", size: 1 }],
      onLibraryChanged: (cb) => {
        changed = cb;
        return () => {};
      },
    });
    t.x.openDoc("d1");
    await step(t, "back");
    t.setPapers(["d2"]);
    t.x.docDeleted("d1", []);
    t.setPapers(["d1", "d2"]); // ingested again under the same id
    changed();
    await flush();
    expect(t.x.getState().papers).toEqual(["d1", "d2"]);
    await step(t, "fwd");
    expect(t.x.getState()).toMatchObject({ currentDoc: "d1", docGoneNotice: null });
    expect(t.views()).toEqual(["doc"]);
    expect(t.browser.url()).toBe("/doc/d1");
  });

  it("a read sent before the delete that answers after it does not bring the deleted Doc back", async () => {
    const t = await booted({ url: "/doc/d1" });
    let answer!: (papers: string[]) => void;
    t.fetchPapers.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    t.browser.pop("/doc/d2"); // a read goes out
    t.x.docDeleted("d1", ["d2"]);
    answer(["d1", "d2"]); // it was sent before the delete
    await flush();
    expect(t.x.getState().papers).toEqual(["d2"]);
  });

  it("the server's library.changed rereads the paper list, so it stays fresh for every path", async () => {
    let changed: (() => void) | null = null;
    const t = await booted({
      onLibraryChanged: (cb) => {
        changed = cb;
        return () => {
          changed = null;
        };
      },
    });
    expect(changed).not.toBeNull();
    t.setPapers(["d2", "d3"]);
    changed!();
    await flush();
    expect(t.x.getState().papers).toEqual(["d2", "d3"]);
    t.stop();
    expect(changed).toBeNull();
  });

  it("a Doc the paper list does not have is checked with one reread of the list: gone, it gets the same treatment", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.browser.pop("/doc/zz");
    await flush();
    expect(t.fetchPapers).toHaveBeenCalledTimes(2);
    expect(t.browser.url()).toBe("/");
    expect(t.views()).toEqual(["library"]);
    expect(t.x.getState().currentDoc).toBe("d1");
    expect(t.x.getState().docGoneNotice?.docId).toBe("zz");
  });

  it("a Doc ingested after the page loaded is found by the reread and opened", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.setPapers(["d1", "d2", "fresh"]);
    t.browser.pop("/doc/fresh");
    await flush();
    expect(t.x.getState()).toMatchObject({ currentDoc: "fresh", papers: ["d1", "d2", "fresh"], docGoneNotice: null });
    expect(t.browser.url()).toBe("/doc/fresh");
  });

  it("every arrival reads the list once (a listed Doc too) and opens a Doc it has; a reread that fails opens it as before (the Doc pane shows its load error)", async () => {
    const t = await booted({ url: "/doc/d1" });
    t.browser.pop("/doc/d2");
    expect(t.x.getState().currentDoc).toBe("d1"); // not before the answer
    await flush();
    expect(t.fetchPapers).toHaveBeenCalledTimes(2);
    expect(t.x.getState().currentDoc).toBe("d2");
    t.fetchPapers.mockRejectedValueOnce(new Error("offline"));
    t.browser.pop("/doc/zz");
    await flush();
    expect(t.x.getState()).toMatchObject({ currentDoc: "zz", docGoneNotice: null });
    expect(t.browser.url()).toBe("/doc/zz");
  });

  it("the reread's answer after the address moved on changes nothing", async () => {
    const t = await booted({ url: "/doc/d1" });
    let answer!: (papers: string[]) => void;
    t.fetchPapers.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    t.browser.pop("/doc/zz");
    t.browser.pop("/doc/d2");
    await flush();
    answer(["d1", "d2"]);
    await flush();
    expect(t.browser.url()).toBe("/doc/d2");
    expect(t.x.getState()).toMatchObject({ currentDoc: "d2", docGoneNotice: null });
  });

  it("a boot deep link to a Doc that is not in the library: the same treatment (no Doc opened, the Library page, the plain URL, the notice)", async () => {
    const t = await booted({ url: "/doc/zz#fig-1" });
    expect(t.views()).toEqual(["library"]);
    expect(t.x.getState()).toMatchObject({ currentDoc: "d1", pendingAnchor: null });
    expect(t.browser.entries).toEqual(["/"]);
    expect(t.x.getState().docGoneNotice?.docId).toBe("zz");
  });

  it("the notice goes away by itself", async () => {
    const t = await booted({ url: "/doc/zz" });
    expect(t.x.getState().docGoneNotice?.docId).toBe("zz");
    t.timers.advance(DOC_GONE_NOTICE_MS);
    expect(t.x.getState().docGoneNotice).toBeNull();
  });
});

describe("Back puts a mode back into the pane it was in, however many Library pages there are (ticket 09)", () => {
  const twoLibraries = (): Pane[] => [
    { id: 1, view: "library", size: 1 },
    { id: 2, view: "library", size: 1 },
  ];
  const step = async (t: Awaited<ReturnType<typeof booted>>, dir: "back" | "fwd") => {
    if (dir === "back") t.browser.port.back();
    else t.browser.forward();
    await t.browser.settle();
    await flush();
  };

  it("explore in pane 1, switch it to the Plan page, Back: the exploration reappears in pane 1, not pane 2", async () => {
    const t = await booted({ panes: twoLibraries(), activeId: 1 });
    t.browser.editHash("/#explore/2020X");
    await flush();
    expect(t.library.exploresIn).toEqual([{ paneId: 1, seed: "2020X" }]);
    expect(t.x.setPaneView(1, "plan")).toBe(true);
    expect(t.views()).toEqual(["plan", "library"]);
    t.x.select(2);
    await step(t, "back");
    expect(t.browser.url()).toBe("/#explore/2020X");
    expect(t.views()).toEqual(["library", "library"]);
    expect(t.library.exploresIn).toEqual([
      { paneId: 1, seed: "2020X" },
      { paneId: 1, seed: "2020X" },
    ]);
    expect([...t.library.exploring]).toEqual([1]);
  });

  it("the graph in pane 1, switch it to the Plan page, Back: the graph reappears in pane 1, not pane 2", async () => {
    const t = await booted({ panes: twoLibraries(), activeId: 1 });
    t.x.openArgumentGraph("w1");
    await flush();
    expect(t.library.open.get(1)).toBe("w1");
    expect(t.x.setPaneView(1, "plan")).toBe(true);
    t.x.select(2);
    await step(t, "back");
    expect(t.browser.url()).toBe("/#argument/w1");
    expect(t.views()).toEqual(["library", "library"]);
    expect(t.library.open.get(1)).toBe("w1");
    expect(t.library.open.has(2)).toBe(false);
  });

  it("two panes that each left an exploration: Back to each exploration puts it in its own pane", async () => {
    const t = await booted({ panes: twoLibraries(), activeId: 1 });
    t.browser.editHash("/#explore/X1");
    await flush();
    t.x.setPaneView(1, "plan");
    t.x.select(2);
    t.browser.editHash("/#explore/Y2");
    await flush();
    t.x.setPaneView(2, "write");
    await step(t, "back"); // Y2 again, in pane 2
    await step(t, "back"); // "/", the entry between the two explorations
    await step(t, "back"); // X1 again, in pane 1
    expect(t.browser.url()).toBe("/#explore/X1");
    expect(t.library.exploresIn.map((e) => `${e.paneId}:${e.seed}`)).toEqual(["1:X1", "2:Y2", "2:Y2", "1:X1"]);
  });

  it("a request that names no pane keeps today's rule (the page that has the mode open, else the first registered)", async () => {
    const t = await booted({ panes: twoLibraries(), activeId: 2 });
    exploreBus.request("2020Y");
    expect(t.library.exploresIn).toEqual([{ paneId: 1, seed: "2020Y" }]);
    exploreBus.exit();
    exploreBus.request("2020Z", { paneId: 2 });
    expect(t.library.exploresIn).toEqual([
      { paneId: 1, seed: "2020Y" },
      { paneId: 2, seed: "2020Z" },
    ]);
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
