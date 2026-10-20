/**
 * A workspace action and the page the Copilot publishes after it (architecture-deepening ticket 04, guarded rule 9):
 * the real Shell and the real Copilot panel, a view action delivered the way the server's message is. When the view
 * reports the action's result, the last PageContext it published (`PUT /api/copilot/views/<viewId>`) already shows the
 * change: the workspace answers only after the Shell has rendered it, and the panel publishes before it reports.
 */
import type { WsCopilotViewAction } from "@argelanderspace/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import type { CopilotSubscription } from "../src/api/ws-bus";
import { copilotRoutes, installShellHarness, rememberConversation, stubShellFetch } from "./shell-harness";

const channel = vi.hoisted(() => ({ subscription: null as CopilotSubscription | null, subscribed: undefined as undefined | ((s: CopilotSubscription) => void) }));
vi.mock("../src/api/ws", async () => (await import("./shell-stubs")).copilotWs(channel));
vi.mock("../src/plan/PlanView", async () => (await import("./shell-stubs")).pageStub("plan"));
vi.mock("../src/library/LibraryView", async () => (await import("./shell-stubs")).pageStub("library"));
vi.mock("../src/writer/WriterView", async () => (await import("./shell-stubs")).pageStub("write"));
vi.mock("../src/mail/MailView", async () => (await import("./shell-stubs")).pageStub("mail"));
vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).pageStub("doc"));

installShellHarness();

/** The keys of a published PageContext, in order: the Shell's own, the nine page fields, the workspace. */
const CONTEXT_KEYS = ["version", "viewId", "revision", "paneId", "view", "otherPanes", "status", "plan", "library", "discovery", "argument", "reader", "pdf", "textSource", "writer", "mail", "workspace"];

async function boot() {
  const copilot = copilotRoutes();
  stubShellFetch({ routes: copilot.route, papers: () => ["d1"] });
  rememberConversation();
  channel.subscription = null;
  const subscribed = new Promise<CopilotSubscription>((resolve) => (channel.subscribed = resolve));
  render(<Shell />);
  const subscription = await subscribed;
  const first = await copilot.firstPut;
  return { copilot, subscription, first };
}

const deliver = (subscription: CopilotSubscription, actionId: string, action: WsCopilotViewAction["action"]) =>
  subscription.viewAction!({ type: "copilot.view-action", viewId: subscription.viewId, actionId, action } as WsCopilotViewAction);

describe("a workspace action is reported once the page that shows it is published", () => {
  it("switch_view: the last PageContext published before the ok is the new view", async () => {
    const { copilot, subscription, first } = await boot();
    expect(first.view).toBe("plan");
    expect(Object.keys(first)).toEqual(CONTEXT_KEYS);
    const reported = copilot.nextResult();
    deliver(subscription, "a1", { action: "switch_view", view: "library" });
    expect(await reported).toEqual({ actionId: "a1", ok: true });
    const [{ publishedBefore }] = copilot.results;
    const last = copilot.puts[publishedBefore! - 1]!;
    expect(last.view).toBe("library");
    expect(last.workspace?.panes).toEqual([{ paneId: 1, view: "library", share: 1 }]);
    expect(last.revision).toBeGreaterThan(first.revision);
  });

  it("split_pane and open_copilot: the published page has the new pane, then the open panel", async () => {
    const { copilot, subscription } = await boot();
    const split = copilot.nextResult();
    deliver(subscription, "a1", { action: "split_pane" });
    expect(await split).toEqual({ actionId: "a1", ok: true });
    expect(copilot.puts[copilot.results[0]!.publishedBefore - 1]!.workspace).toMatchObject({ activePaneId: 2, panes: [{ paneId: 1 }, { paneId: 2 }] });
    const opened = copilot.nextResult();
    deliver(subscription, "a2", { action: "open_copilot" });
    expect(await opened).toEqual({ actionId: "a2", ok: true });
    expect(copilot.puts[copilot.results[1]!.publishedBefore - 1]!.workspace?.copilotOpen).toBe(true);
  });
});
