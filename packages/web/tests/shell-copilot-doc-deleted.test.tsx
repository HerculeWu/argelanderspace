/**
 * Copilot Doc deletion at the Shell (ticket 16): the service tells the bound view that a Doc was deleted through the
 * tool, and the Shell makes the SAME three-state update the Library page makes after its own delete
 * (`docDeleted`): a deleted non-current Doc only leaves the paper list; the current Doc moves to the keeper Work's
 * new main Doc or, with nothing left, to none. The three states and the confirmation click's leave guard are tested on the
 * workspace state's interface (workspace-state.test.ts); this file keeps the Copilot's path through the Shell.
 */
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../src/argelander/workspace";
import { installShellHarness, renderShell, stubShellFetch } from "./shell-harness";

const h = vi.hoisted(() => ({
  ws: null as Workspace | null,
  viewAction: null as null | ((action: unknown) => Promise<{ ok: boolean; detail?: string }>),
}));
vi.mock("../src/api/ws", async () => (await import("./shell-stubs")).quietWs());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe(h));
vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).workspaceProbe(h));

async function boot(papers: string[], route: string) {
  stubShellFetch({ papers: () => papers });
  renderShell(route);
  await waitFor(() => expect(h.ws?.papers).toEqual(papers));
  await waitFor(() => expect(h.viewAction).not.toBeNull());
}
installShellHarness();
beforeEach(() => { h.ws = null; h.viewAction = null; });

describe("the bound view applies the page's own three-state update", () => {
  it("the open Doc moves to the Work's new main Doc and the address follows", async () => {
    await boot(["d1", "d2"], "/doc/d1");
    await act(async () => { await h.viewAction!({ action: "doc_deleted", docId: "d1", remaining: ["d2"] }); });
    await waitFor(() => expect(h.ws!.currentDoc).toBe("d2"));
    expect(h.ws!.papers).toEqual(["d2"]);
    expect(window.location.pathname).toBe("/doc/d2");
  });
});

