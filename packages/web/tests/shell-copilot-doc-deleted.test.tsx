/**
 * Copilot Doc deletion at the Shell (ticket 16): the service tells the bound view that a Doc was deleted through the
 * tool, and the Shell makes the SAME three-state update the Library page makes after its own delete
 * (`docDeleted`): a deleted non-current Doc only leaves the paper list; the current Doc moves to the keeper Work's
 * new main Doc or, with nothing left, to none. The confirmation click asks the same leave guard as the dialog.
 */
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceLeaveGuard, type Workspace } from "../src/argelander/workspace";
import { installShellHarness, renderShell, stubShellFetch } from "./shell-harness";

const h = vi.hoisted(() => ({
  ws: null as Workspace | null,
  viewAction: null as null | ((action: unknown) => Promise<{ ok: boolean; detail?: string }>),
  beforeDelete: null as null | ((docId: string) => boolean),
}));
vi.mock("../src/api/ws", async () => (await import("./shell-stubs")).quietWs());
vi.mock("../src/copilot/Copilot", async () =>
  (await import("./shell-stubs")).copilotProbe(h, { also: ({ guards }) => { h.beforeDelete = guards!.leaveDoc!; } })
);
vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).workspaceProbe(h));

async function boot(papers: string[], route: string) {
  stubShellFetch({ papers: () => papers });
  renderShell(route);
  await waitFor(() => expect(h.ws?.papers).toEqual(papers));
  await waitFor(() => expect(h.viewAction).not.toBeNull());
}
installShellHarness();
beforeEach(() => { h.ws = null; h.viewAction = null; h.beforeDelete = null; });

describe("the bound view applies the page's own three-state update", () => {
  it("a non-current Doc leaves the paper list; the open Doc and the URL stay", async () => {
    await boot(["d1", "d2"], "/doc/d1");
    let result: { ok: boolean } | undefined;
    await act(async () => { result = await h.viewAction!({ action: "doc_deleted", docId: "d2", remaining: ["x"] }); });
    expect(result).toEqual({ ok: true });
    await waitFor(() => expect(h.ws!.papers).toEqual(["d1"]));
    expect(h.ws!.currentDoc).toBe("d1");
    expect(window.location.pathname).toBe("/doc/d1");
  });
  it("the open Doc moves to the Work's new main Doc and the address follows", async () => {
    await boot(["d1", "d2"], "/doc/d1");
    await act(async () => { await h.viewAction!({ action: "doc_deleted", docId: "d1", remaining: ["d2"] }); });
    await waitFor(() => expect(h.ws!.currentDoc).toBe("d2"));
    expect(h.ws!.papers).toEqual(["d2"]);
    expect(window.location.pathname).toBe("/doc/d2");
  });
  it("with no Doc left, no Doc is open and the address resets", async () => {
    await boot(["d1"], "/doc/d1#fig-1");
    await act(async () => { await h.viewAction!({ action: "doc_deleted", docId: "d1", remaining: [] }); });
    await waitFor(() => expect(h.ws!.currentDoc).toBeNull());
    expect(h.ws!.papers).toEqual([]);
    expect(window.location.pathname).toBe("/");
  });
});

describe("the confirmation click asks the workspace's leave guard only when it would take the open Doc away", () => {
  it("the open Doc is guarded; another Doc is not", async () => {
    await boot(["d1", "d2"], "/doc/d1");
    const calls = vi.fn(() => false);
    const release = registerWorkspaceLeaveGuard(calls);
    try {
      expect(h.beforeDelete!("d1")).toBe(false); // unsaved work in the open Doc keeps the card
      expect(calls).toHaveBeenCalledTimes(1);
      calls.mockClear();
      expect(h.beforeDelete!("d2")).toBe(true);
      expect(calls).not.toHaveBeenCalled();
    } finally { release(); }
    expect(h.beforeDelete!("d1")).toBe(true);
  });
});
