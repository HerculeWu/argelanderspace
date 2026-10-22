/**
 * The Shell's wiring of the Copilot's manuscript-delete guard (backlog-sweep group 2): approving the delete of an open
 * manuscript with unsaved edits asks with the app's own dialog (never `window.confirm`), the card waits for the answer,
 * "keep editing" keeps it and "discard" lets it go. Whether the guard asks at all is `manuscriptDeleteGuard`'s own rule
 * (writer-copilot-parity.test.tsx); here it is stubbed to always ask, so the test is about what the Shell passes as `confirm`.
 */
import { fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installShellHarness, renderShell, stubShellFetch } from "./shell-harness";

const h = vi.hoisted(() => ({ props: null as null | { guards?: { leaveManuscript?: (id: string) => boolean | Promise<boolean> } }, viewAction: null as unknown }));
vi.mock("../src/api/ws", async () => (await import("./shell-stubs")).quietWs());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe(h as never));
vi.mock("../src/writer/writer-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/writer/writer-context")>()),
  manuscriptDeleteGuard: (_pages: unknown, _id: string, confirm: () => boolean | Promise<boolean>) => confirm(),
}));

installShellHarness();
beforeEach(() => { h.props = null; });

const dialog = () => document.querySelector('[data-ui="leave-dialog"]');
const click = (ui: string) => fireEvent.click(document.querySelector(`[data-ui="${ui}"]`)!);

describe("Copilot manuscript delete with unsaved edits", () => {
  it("asks in the app's dialog: keep editing refuses, discard allows, and window.confirm is never used", async () => {
    const confirm = vi.spyOn(window, "confirm");
    stubShellFetch({ papers: () => [] });
    renderShell("/");
    await waitFor(() => expect(h.props?.guards?.leaveManuscript).toBeTruthy());
    const stay = h.props!.guards!.leaveManuscript!("m_0000aaaa");
    expect(stay).toBeInstanceOf(Promise);
    await waitFor(() => expect(dialog()).toBeTruthy());
    expect(document.querySelector('[data-ui="leave-dialog-body"]')?.textContent).toContain("稿件");
    click("leave-dialog-stay");
    expect(await stay).toBe(false);
    const discard = h.props!.guards!.leaveManuscript!("m_0000aaaa");
    await waitFor(() => expect(dialog()).toBeTruthy());
    click("leave-dialog-discard");
    expect(await discard).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
