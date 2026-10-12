/**
 * The Shell's side of the argument graph view's navigation (ticket 04): the boot hash, popstate, the Reader's entry
 * (`Workspace.openArgumentGraph`), opening a Doc from the graph, and the exclusion with exploration. The real Shell, the
 * pane manager and the two route buses run; the Library page is a stub that registers on the buses exactly as the real
 * LibraryView does (the view itself is covered by argument-entry.test.tsx and argument-view.test.tsx).
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import { registerWorkspaceLeaveGuard } from "../src/argelander/workspace";
import i18n from "../src/i18n";
import { setOpenArgumentWork } from "../src/lib/argument-route";

const h = vi.hoisted(() => ({
  /** pane id -> the Work whose graph that Library pane shows */
  open: new Map<number, string>(),
  opens: [] as { paneId: number | undefined; workId: string; push: boolean }[],
  requests: [] as { workId: string; confirmed: boolean }[],
  exits: [] as (number | undefined)[],
  explores: [] as string[],
  exploring: new Set<number>(),
}));
vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/copilot/Copilot", () => ({ Copilot: () => null }));
vi.mock("../src/plan/PlanView", () => ({ PlanView: () => <div data-ui="plan-stub" /> }));
vi.mock("../src/writer/WriterView", () => ({ WriterView: () => <div data-ui="writer-stub" /> }));
vi.mock("../src/mail/MailView", () => ({ MailView: () => <div data-ui="mail-stub" /> }));
vi.mock("../src/doc/DocPane", async () => {
  const { useWorkspace: workspace } = await import("../src/argelander/workspace");
  return {
    DocPane: () => {
      const ws = workspace();
      return (
        <div data-ui="doc-stub">
          <button type="button" data-ui="stub-enter-graph" onClick={() => ws.openArgumentGraph?.("w1")} />
          <button type="button" data-ui="stub-open-d2" onClick={() => ws.openDoc("d2", "sec-1")} />
        </div>
      );
    },
  };
});
vi.mock("../src/library/LibraryView", async () => {
  const react = await import("react");
  const { argumentBus, pushArgumentUrl, clearArgumentUrl } = await import("../src/lib/argument-route");
  const { exploreBus } = await import("../src/lib/explore-route");
  const { useWorkspace: workspace } = await import("../src/argelander/workspace");
  return {
    LibraryView: ({ paneId }: { paneId?: number }) => {
      const [, rerender] = react.useState(0);
      const ws = workspace();
      react.useEffect(() => {
        const offs = [
          argumentBus.register({
            paneId,
            isOpen: () => h.open.has(paneId ?? -1),
            open: (workId, opts) => {
              h.requests.push({ workId, confirmed: !!opts.confirmed });
              // (happy-dom fires `hashchange` for pushState, a browser does not; the real view opens idempotently)
              if (h.open.get(paneId ?? -1) === workId) return;
              h.opens.push({ paneId, workId, push: opts.push });
              h.open.set(paneId ?? -1, workId);
              if (opts.push) pushArgumentUrl(workId);
              rerender((n) => n + 1);
            },
            exit: () => {
              h.exits.push(paneId);
              h.open.delete(paneId ?? -1);
              clearArgumentUrl();
              rerender((n) => n + 1);
            },
          }),
          exploreBus.register({
            isExploring: () => h.exploring.has(paneId ?? -1),
            explore: (seed) => {
              if (h.exploring.has(paneId ?? -1)) return;
              h.explores.push(seed);
              h.exploring.add(paneId ?? -1);
            },
            exit: () => h.exploring.delete(paneId ?? -1) && undefined,
          }),
        ];
        return () => offs.forEach((off) => off());
      }, [paneId]);
      return (
        <div data-ui="library-stub" data-ui-key={paneId} data-graph={h.open.get(paneId ?? -1) ?? ""}>
          <button type="button" data-ui="stub-lib-open-d1" onClick={() => ws.openDoc("d1")} />
          <button type="button" data-ui="stub-lib-enter-w2" onClick={() => ws.openArgumentGraph?.("w2")} />
        </div>
      );
    },
  };
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.sessionStorage.clear();
  window.localStorage.clear();
  h.open.clear();
  h.opens.length = 0;
  h.requests.length = 0;
  h.exits.length = 0;
  h.explores.length = 0;
  h.exploring.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/papers") return ok({ papers: ["d1", "d2"] });
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const libraries = () => qa('[data-ui="library-stub"]').map((el) => Number(el.getAttribute("data-ui-key")));
/** A Shell showing a Doc in pane 1 (the Reader's situation). */
async function bootInDoc() {
  window.history.replaceState(null, "", "/doc/d1");
  render(<Shell />);
  await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
}
const popTo = (url: string) => {
  window.history.pushState(null, "", url);
  act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
};

describe("boot", () => {
  it("a #argument/ hash makes the Library pane and hands the Work to the bus without writing history", async () => {
    window.history.replaceState(null, "", "/#argument/w1");
    const before = window.history.length;
    render(<Shell />);
    await waitFor(() => expect(h.opens).toEqual([{ paneId: 1, workId: "w1", push: false }]));
    expect(libraries()).toEqual([1]);
    expect(window.history.length).toBe(before);
  });

  it("a doc route opens the Doc and neither mode", async () => {
    await bootInDoc();
    expect(h.opens).toEqual([]);
    expect(h.explores).toEqual([]);
  });
});

describe("popstate", () => {
  it("to #argument/ with no Library pane makes one first, as the boot path does", async () => {
    await bootInDoc();
    expect(libraries()).toEqual([]);
    popTo("/#argument/w1");
    await waitFor(() => expect(h.opens).toEqual([{ paneId: 1, workId: "w1", push: false }]));
    expect(libraries()).toEqual([1]);
    expect(q('[data-ui="doc-stub"]')).toBeNull();
  });

  it("to a plain URL or to a Doc leaves the graph (a Doc route used to return before the graph heard of it)", async () => {
    window.history.replaceState(null, "", "/#argument/w1");
    render(<Shell />);
    await waitFor(() => expect(h.open.get(1)).toBe("w1"));
    popTo("/");
    expect(h.exits).toEqual([1]);
    expect(h.open.size).toBe(0);
    popTo("/#argument/w1");
    await waitFor(() => expect(h.open.get(1)).toBe("w1"));
    popTo("/doc/d2");
    expect(h.exits).toEqual([1, 1]);
    expect(h.open.size).toBe(0);
    await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
  });

  it("with an unsaved draft in the open graph, the browser's Back out of it asks first; refused, the URL goes back to the graph and the view stays (ticket 05)", async () => {
    window.history.replaceState(null, "", "/#argument/w1");
    render(<Shell />);
    await waitFor(() => expect(h.open.get(1)).toBe("w1"));
    setOpenArgumentWork("w1"); // the real view does this while open
    let allow = false;
    const off = registerWorkspaceLeaveGuard(() => allow, "library");
    popTo("/");
    expect(h.exits).toEqual([]);
    expect(h.open.get(1)).toBe("w1");
    expect(window.location.hash).toBe("#argument/w1");
    allow = true;
    popTo("/");
    expect(h.exits).toEqual([1]);
    off();
    setOpenArgumentWork(null);
  });

  it("exploration and the graph exclude each other by URL: an #explore/ URL closes the graph, an #argument/ URL goes to the graph only", async () => {
    window.history.replaceState(null, "", "/#argument/w1");
    render(<Shell />);
    await waitFor(() => expect(h.open.get(1)).toBe("w1"));
    popTo("/#explore/2020X");
    expect(h.explores).toEqual(["2020X"]);
    expect(h.exits).toEqual([1]);
    popTo("/#argument/w2");
    await waitFor(() => expect(h.open.get(1)).toBe("w2"));
    expect(h.explores).toEqual(["2020X"]);
  });
});

describe("the Reader's entry (openArgumentGraph)", () => {
  it("with no Library pane the active pane becomes one and gets the view, with one history entry", async () => {
    await bootInDoc();
    const before = window.history.length;
    fireEvent.click(q('[data-ui="stub-enter-graph"]')!);
    await waitFor(() => expect(h.opens).toEqual([{ paneId: 1, workId: "w1", push: true }]));
    expect(window.location.hash).toBe("#argument/w1");
    expect(window.history.length).toBe(before + 1);
  });

  it("with several Library panes the pane that is shown is the pane that is served", async () => {
    await bootInDoc();
    // pane 1: Doc (active); split twice -> panes 2 and 3 are Plan copies; make 3 and 2 Library panes, 3 registered first
    fireEvent.click(q('[data-ui="split-pane"]')!);
    await waitFor(() => expect(qa('[data-ui="workspace-pane"]')).toHaveLength(2));
    fireEvent.click(q('[data-ui="split-pane"]')!);
    await waitFor(() => expect(qa('[data-ui="workspace-pane"]')).toHaveLength(3));
    const choose = async (paneId: number) => {
      const pane = qa('[data-ui="workspace-pane"]').find((el) => el.getAttribute("data-ui-key") === String(paneId))!;
      fireEvent.click(pane.querySelector('[data-ui="choose-pane-view"]')!);
      fireEvent.click([...pane.querySelectorAll<HTMLElement>('[data-ui="pane-view-option"]')].find((el) => el.getAttribute("data-ui-key") === "library")!);
    };
    await choose(3);
    await waitFor(() => expect(libraries()).toEqual([3]));
    await choose(2);
    await waitFor(() => expect(libraries().sort()).toEqual([2, 3]));
    // the Doc pane (1) asks while pane 2 is the active Library pane
    fireEvent.mouseDown(qa('[data-ui="workspace-pane"]').find((el) => el.getAttribute("data-ui-key") === "1")!);
    fireEvent.click(q('[data-ui="stub-enter-graph"]')!);
    await waitFor(() => expect(h.opens).toHaveLength(1));
    // not the active pane (the Doc pane): the first Library pane in the layout, which is the pane the Shell selected
    expect(h.opens[0]).toMatchObject({ workId: "w1", push: true, paneId: 2 });
    expect([...h.open.keys()]).toEqual([2]);
    expect(h.opens).toHaveLength(1);
  });
});

describe("opening a Doc from the graph", () => {
  it("keeps the graph's history entry (a new entry for the Doc), so Back returns to the graph", async () => {
    window.history.replaceState(null, "", "/#argument/w1");
    render(<Shell />);
    await waitFor(() => expect(h.open.get(1)).toBe("w1"));
    const before = window.history.length;
    // the graph's source link calls openDoc; reach it through the workspace of a Doc pane in a second pane
    fireEvent.click(q('[data-ui="split-pane"]')!);
    await waitFor(() => expect(qa('[data-ui="workspace-pane"]')).toHaveLength(2));
    const pane2 = qa('[data-ui="workspace-pane"]').find((el) => el.getAttribute("data-ui-key") === "2")!;
    fireEvent.click(pane2.querySelector('[data-ui="choose-pane-view"]')!);
    fireEvent.click([...pane2.querySelectorAll<HTMLElement>('[data-ui="pane-view-option"]')].find((el) => el.getAttribute("data-ui-key") === "doc")!);
    await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="stub-open-d2"]')!);
    expect(window.location.pathname).toBe("/doc/d2");
    expect(window.history.length).toBe(before + 1);
    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe("#argument/w1"));
  });

  it("a leave guard that says no keeps the graph's URL: the entry is not rewritten to the open Doc", async () => {
    await bootInDoc(); // a Doc (d1) is open, so a refused switch has a Doc to fall back to
    fireEvent.click(q('[data-ui="split-pane"]')!);
    await waitFor(() => expect(qa('[data-ui="workspace-pane"]')).toHaveLength(2));
    fireEvent.click(qa('[data-ui="stub-enter-graph"]')[0]!);
    await waitFor(() => expect(window.location.hash).toBe("#argument/w1"));
    await waitFor(() => expect(qa('[data-ui="doc-stub"]').length).toBeGreaterThan(0));
    const off = registerWorkspaceLeaveGuard(() => false);
    try {
      const before = window.history.length;
      fireEvent.click(qa('[data-ui="stub-open-d2"]')[0]!);
      expect(window.location.hash).toBe("#argument/w1");
      expect(window.location.pathname).toBe("/");
      expect(window.history.length).toBe(before);
    } finally {
      off();
    }
  });

  it("from any other URL it replaces the entry as before", async () => {
    await bootInDoc();
    const before = window.history.length;
    fireEvent.click(q('[data-ui="stub-open-d2"]')!);
    expect(window.location.pathname).toBe("/doc/d2");
    expect(window.history.length).toBe(before);
  });
});

describe("a guard that answers later (the argument graph's own dialog, ticket 05 fix round A)", () => {
  /** A guard whose answer the test gives; counts how often it is asked. */
  function lateGuard() {
    const asked: ((ok: boolean) => void)[] = [];
    const off = registerWorkspaceLeaveGuard(() => new Promise<boolean>((resolve) => asked.push(resolve)), "library");
    return { asked, off };
  }
  const boot = async (hash = "/#argument/w1") => {
    window.history.replaceState(null, "", hash);
    render(<Shell />);
    await waitFor(() => expect(h.open.get(1)).toBeDefined());
    setOpenArgumentWork("w1");
  };

  it("the browser's Back waits: the graph's URL is put back at once, the view stays, and 'discard' then goes back for real, asking once", async () => {
    window.history.pushState(null, "", "/");
    window.history.pushState(null, "", "/#argument/w1");
    await boot("/#argument/w1");
    const guard = lateGuard();
    window.history.back();
    await waitFor(() => expect(guard.asked).toHaveLength(1));
    expect(h.exits).toEqual([]);
    expect(window.location.hash).toBe("#argument/w1"); // restored while the question is open
    await act(async () => guard.asked[0]!(true));
    await waitFor(() => expect(h.exits).toEqual([1]));
    expect(window.location.hash).toBe("");
    expect(guard.asked).toHaveLength(1); // the one navigation asked once
    guard.off();
    setOpenArgumentWork(null);
  });

  it("'keep editing' leaves the view and the graph's URL in place", async () => {
    await boot();
    const guard = lateGuard();
    popTo("/");
    await waitFor(() => expect(guard.asked).toHaveLength(1));
    await act(async () => guard.asked[0]!(false));
    expect(h.exits).toEqual([]);
    expect(window.location.hash).toBe("#argument/w1");
    guard.off();
    setOpenArgumentWork(null);
  });

  it("between two graph URLs it asks too, and the confirmed request is not asked about again by the view", async () => {
    window.history.pushState(null, "", "/#argument/w2");
    window.history.pushState(null, "", "/#argument/w1");
    await boot("/#argument/w1");
    const guard = lateGuard();
    window.history.back();
    await waitFor(() => expect(guard.asked).toHaveLength(1));
    expect(h.open.get(1)).toBe("w1");
    expect(window.location.hash).toBe("#argument/w1");
    await act(async () => guard.asked[0]!(true));
    await waitFor(() => expect(h.open.get(1)).toBe("w2"));
    expect(h.requests[h.requests.length - 1]).toEqual({ workId: "w2", confirmed: true });
    expect(guard.asked).toHaveLength(1);
    guard.off();
    setOpenArgumentWork(null);
  });

  it("Back to a Doc that is not the open one asks once, not once for the navigation and again for the pane it replaces", async () => {
    await boot("/#argument/w1");
    const guard = lateGuard();
    popTo("/doc/d2");
    await waitFor(() => expect(guard.asked).toHaveLength(1));
    await act(async () => guard.asked[0]!(true));
    await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
    expect(guard.asked).toHaveLength(1);
    guard.off();
    setOpenArgumentWork(null);
  });

  it("opening the Doc that is already current, with no Doc pane, replaces the Library page and asks first", async () => {
    window.history.replaceState(null, "", "/doc/d1");
    render(<Shell />);
    await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="stub-enter-graph"]')!);
    await waitFor(() => expect(h.open.get(1)).toBe("w1"));
    expect(q('[data-ui="doc-stub"]')).toBeNull();
    const guard = lateGuard();
    fireEvent.click(q('[data-ui="stub-lib-open-d1"]')!);
    await waitFor(() => expect(guard.asked).toHaveLength(1));
    expect(q('[data-ui="doc-stub"]')).toBeNull(); // not yet
    await act(async () => guard.asked[0]!(false));
    expect(q('[data-ui="doc-stub"]')).toBeNull();
    fireEvent.click(q('[data-ui="stub-lib-open-d1"]')!);
    await waitFor(() => expect(guard.asked).toHaveLength(2));
    await act(async () => guard.asked[1]!(true));
    await waitFor(() => expect(q('[data-ui="doc-stub"]')).not.toBeNull());
    guard.off();
  });

  it("the Reader's entry to another Work's graph reaches the view unconfirmed, so the view itself asks", async () => {
    await boot();
    fireEvent.click(q('[data-ui="stub-lib-enter-w2"]')!);
    await waitFor(() => expect(h.requests[h.requests.length - 1]).toEqual({ workId: "w2", confirmed: false }));
    setOpenArgumentWork(null);
  });
});
