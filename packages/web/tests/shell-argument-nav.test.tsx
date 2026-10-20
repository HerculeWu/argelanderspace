/**
 * The Shell's side of the argument graph view's navigation (ticket 04), rendered end to end: the real Shell with the
 * browser's own history (`windowBrowser`), the pane manager and the route bus, and a Library page stub that registers
 * on the bus exactly as the real LibraryView does. The routing itself — the boot hash, Back/Forward, the Reader's
 * entry, opening a Doc from the graph, the leave guard and its one-navigation permission — is tested on the workspace
 * state's interface without rendering (workspace-state.test.ts); this file keeps one run through the wiring.
 */
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import { registerWorkspaceLeaveGuard } from "../src/argelander/workspace";
import { installShellHarness } from "./shell-harness";

const h = vi.hoisted(() => ({
  /** pane id -> the Work whose graph that Library pane shows */
  open: new Map<number, string>(),
  exits: [] as (number | undefined)[],
}));
vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotStub());
vi.mock("../src/plan/PlanView", async () => (await import("./shell-stubs")).pageStub("plan", "plan-stub"));
vi.mock("../src/writer/WriterView", async () => (await import("./shell-stubs")).pageStub("write", "writer-stub"));
vi.mock("../src/mail/MailView", async () => (await import("./shell-stubs")).pageStub("mail", "mail-stub"));
vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).pageStub("doc", "doc-stub"));
vi.mock("../src/library/LibraryView", async () => {
  const react = await import("react");
  const { argumentBus, pushArgumentUrl, clearArgumentUrl } = await import("../src/lib/argument-route");
  return {
    LibraryView: ({ paneId }: { paneId?: number }) => {
      const [, rerender] = react.useState(0);
      react.useEffect(
        () =>
          argumentBus.register({
            paneId,
            isOpen: () => h.open.has(paneId ?? -1),
            workId: () => h.open.get(paneId ?? -1) ?? null,
            open: (workId, opts) => {
              // (happy-dom fires `hashchange` for pushState, a browser does not; the real view opens idempotently)
              if (h.open.get(paneId ?? -1) === workId) return;
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
        [paneId]
      );
      return <div data-ui="library-stub" data-ui-key={paneId} data-graph={h.open.get(paneId ?? -1) ?? ""} />;
    },
  };
});

installShellHarness({ papers: () => ["d1", "d2"] });
beforeEach(() => {
  h.open.clear();
  h.exits.length = 0;
});

describe("a guard that answers later (the argument graph's own dialog, ticket 05 fix round A)", () => {
  it("the browser's Back waits: the graph's URL is put back at once, the view stays, and 'discard' then goes back for real, asking once", async () => {
    window.history.pushState(null, "", "/");
    window.history.pushState(null, "", "/#argument/w1");
    render(<Shell />);
    await waitFor(() => expect(h.open.get(1)).toBeDefined());
    const asked: ((ok: boolean) => void)[] = [];
    const off = registerWorkspaceLeaveGuard(() => new Promise<boolean>((resolve) => asked.push(resolve)), "library");
    window.history.back();
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(h.exits).toEqual([]);
    expect(window.location.hash).toBe("#argument/w1"); // restored while the question is open
    await act(async () => asked[0]!(true));
    await waitFor(() => expect(h.exits).toEqual([1]));
    expect(window.location.hash).toBe("");
    expect(asked).toHaveLength(1); // the one navigation asked once
    off();
  });
});
