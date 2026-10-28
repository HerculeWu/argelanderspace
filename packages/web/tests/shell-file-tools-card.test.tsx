/**
 * The Shell's side of the intake card for the Copilot file permission (project-intake ticket 06): the panel is given
 * the permission as the settings hold it now, and "Open settings" shows the settings page on the Copilot group.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import { registerWorkspaceLeaveGuard } from "../src/argelander/workspace";
import type { CopilotProps } from "./shell-stubs";
import { type FakeSettings, fakeSettings } from "./settings-fake";
import { installShellHarness } from "./shell-harness";

const h = vi.hoisted(() => ({ props: null as CopilotProps | null, viewAction: null as unknown }));
vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe(h));
vi.mock("../src/plan/PlanView", async () => (await import("./shell-stubs")).pageStub("plan"));
vi.mock("../src/writer/WriterView", async () => (await import("./shell-stubs")).pageStub("write"));
vi.mock("../src/library/LibraryView", async () => (await import("./shell-stubs")).pageStub("library"));
vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).pageStub("doc"));
vi.mock("../src/mail/MailView", async () => (await import("./shell-stubs")).pageStub("mail"));

let settings: FakeSettings;
const q = (selector: string) => document.querySelector<HTMLElement>(selector);

installShellHarness({ settings: () => settings });
beforeEach(() => { h.props = null; settings = fakeSettings({ "ui.language": "en" }); });

describe("the file permission card's Shell wiring", () => {
  it("gives the panel the permission the settings hold (a value in the file)", async () => {
    settings = fakeSettings({ "ui.language": "en", copilot_file_tools: "off" });
    render(<Shell />);
    await waitFor(() => expect(h.props?.fileTools).toBe("off"));
  });

  it("the default is ask each time", async () => {
    render(<Shell />);
    await waitFor(() => expect(h.props?.fileTools).toBe("ask"));
  });

  it("Open settings shows the settings page on the Copilot group, and the request is used once", async () => {
    render(<Shell />);
    await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
    await waitFor(() => expect(h.props?.onOpenFileToolsSettings).toBeTypeOf("function"));
    h.props!.onOpenFileToolsSettings!();
    await waitFor(() => expect(q('[data-ui="settings-group-body"]')?.getAttribute("data-group")).toBe("copilot"));
    expect(q('[data-ui="copilot-permission-option"][data-ui-key="ask"]')).not.toBeNull();
    // another group by hand stays: the request is not applied again
    fireEvent.click(q('[data-ui="settings-group"][data-ui-key="appearance"]')!);
    await waitFor(() => expect(q('[data-ui="settings-group-body"]')?.getAttribute("data-group")).toBe("appearance"));
    // the permission changed on the page reaches the panel
    fireEvent.click(q('[data-ui="settings-group"][data-ui-key="copilot"]')!);
    fireEvent.click(q('[data-ui="copilot-permission-option"][data-ui-key="off"]')!);
    await waitFor(() => expect(h.props?.fileTools).toBe("off"));
  });

  const nav = (key: string) => fireEvent.click(q(`[data-ui="navigate-view"][data-ui-key="${key}"]`)!);

  it("the request is used once: leaving the settings page and coming back (a new mount) lands on the default group", async () => {
    render(<Shell />);
    await waitFor(() => expect(h.props?.onOpenFileToolsSettings).toBeTypeOf("function"));
    h.props!.onOpenFileToolsSettings!();
    await waitFor(() => expect(q('[data-ui="settings-group-body"]')?.getAttribute("data-group")).toBe("copilot"));
    nav("plan");
    await waitFor(() => expect(q('[data-ui="settings-group-body"]')).toBeNull());
    nav("settings");
    await waitFor(() => expect(q('[data-ui="settings-group-body"]')?.getAttribute("data-group")).toBe("appearance"));
  });

  it("a refused leave leaves no request behind: opening the settings by hand afterwards lands on the default group", async () => {
    render(<Shell />);
    await waitFor(() => expect(h.props?.onOpenFileToolsSettings).toBeTypeOf("function"));
    nav("library");
    await waitFor(() => expect(q('[data-ui="stub-library"]')).not.toBeNull());
    const release = registerWorkspaceLeaveGuard(() => false, "library");
    h.props!.onOpenFileToolsSettings!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(q('[data-ui="stub-library"]')).not.toBeNull();
    release();
    nav("settings");
    await waitFor(() => expect(q('[data-ui="settings-group-body"]')?.getAttribute("data-group")).toBe("appearance"));
  });
});
