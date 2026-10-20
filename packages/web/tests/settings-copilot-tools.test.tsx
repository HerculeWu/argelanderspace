/**
 * The Copilot group's file and command permission (copilot ticket 57, ADR 0011) on the settings page: the real Shell
 * against the stand-in settings endpoints. Three choices in one segmented control, ask-each-time as the default, the
 * risk sentence always there, a warning on "automatic", and the usual source badge and restore for a value that came
 * from the file.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import i18n from "../src/i18n";
import { type FakeSettings, fakeSettings } from "./settings-fake";
import { installShellHarness } from "./shell-harness";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotStub());
vi.mock("../src/plan/PlanView", async () => (await import("./shell-stubs")).pageStub("plan"));
vi.mock("../src/writer/WriterView", async () => (await import("./shell-stubs")).pageStub("write"));
vi.mock("../src/library/LibraryView", async () => (await import("./shell-stubs")).pageStub("library"));
vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).pageStub("doc"));
vi.mock("../src/mail/MailView", async () => (await import("./shell-stubs")).pageStub("mail"));

let settings: FakeSettings;
const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const row = () => q('[data-ui="setting-row"][data-ui-key="copilot_file_tools"]');
const pressed = () => qa('[data-ui="copilot-permission-option"][aria-pressed="true"]').map((el) => el.getAttribute("data-ui-key"));

installShellHarness({ settings: () => settings });
beforeEach(() => {
  settings = fakeSettings({ "ui.language": "en" });
});

async function openCopilotGroup() {
  render(<Shell />);
  await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="settings"]')!);
  await waitFor(() => expect(q('[data-ui="settings-group"][data-ui-key="copilot"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="settings-group"][data-ui-key="copilot"]')!);
  await waitFor(() => expect(row()).not.toBeNull());
}

describe("the Copilot group's file and command permission", () => {
  it("shows off / ask each time / automatic after the provider entry, with ask each time as the default", async () => {
    await openCopilotGroup();
    expect(qa('[data-ui="setting-row"]').map((el) => el.getAttribute("data-ui-key"))).toEqual(["copilot-provider", "copilot_file_tools"]);
    expect(qa('[data-ui="copilot-permission-option"]').map((el) => el.textContent)).toEqual(["Off", "Ask each time", "Automatic"]);
    expect(pressed()).toEqual(["ask"]);
    expect(row()!.querySelector(".st-key")!.textContent).toBe("copilot_file_tools");
    expect(row()!.textContent).toContain("Default");
    // the risk sentence is always there, and the sentence of the chosen mode
    expect(q('[data-ui="copilot-permission-hint"]')!.textContent).toContain("Lets Copilot read and write files and run commands.");
    expect(q('[data-ui="copilot-permission-mode-hint"]')!.textContent).toContain("Ask each time:");
    expect(q('[data-ui="copilot-permission-auto-warning"]')).toBeNull();
    expect(row()!.querySelector('[data-ui="restore-default"]')).toBeNull();
  });

  it("choosing a mode writes the key; automatic adds the warning, the file badge and a restore that goes back to the default", async () => {
    await openCopilotGroup();
    fireEvent.click(q('[data-ui="copilot-permission-option"][data-ui-key="auto"]')!);
    await waitFor(() => expect(settings.puts).toEqual([{ key: "copilot_file_tools", body: { set: "auto" } }]));
    await waitFor(() => expect(pressed()).toEqual(["auto"]));
    expect(settings.file.copilot_file_tools).toBe("auto");
    expect(q('[data-ui="copilot-permission-auto-warning"]')!.getAttribute("role")).toBe("status");
    expect(q('[data-ui="copilot-permission-auto-warning"]')!.textContent).toContain("at your own risk");
    expect(row()!.textContent).toContain("From file");
    expect(q('[data-ui="copilot-permission-mode-hint"]')!.textContent).toContain("Automatic:");
    fireEvent.click(row()!.querySelector('[data-ui="restore-default"]')!);
    await waitFor(() => expect(pressed()).toEqual(["ask"]));
    expect(settings.file.copilot_file_tools).toBeUndefined();
    fireEvent.click(q('[data-ui="copilot-permission-option"][data-ui-key="off"]')!);
    await waitFor(() => expect(pressed()).toEqual(["off"]));
    expect(q('[data-ui="copilot-permission-mode-hint"]')!.textContent).toContain("Off:");
    expect(q('[data-ui="copilot-permission-auto-warning"]')).toBeNull();
  });

  it("a value in the file that is not one of the three is shown as invalid, with the default in effect and a way back", async () => {
    settings.file.copilot_file_tools = "yolo";
    settings.problems = [{ key: "copilot_file_tools", reason: "not_one_of" } as never];
    await openCopilotGroup();
    expect(row()!.querySelector('[data-ui="setting-invalid"]')!.textContent).toContain("Invalid value in the file");
    expect(pressed()).toEqual(["ask"]);
  });

  it("reads in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    settings = fakeSettings({ "ui.language": "zh-CN" });
    await openCopilotGroup();
    expect(qa('[data-ui="copilot-permission-option"]').map((el) => el.textContent)).toEqual(["关闭", "逐次确认", "自动"]);
    expect(row()!.textContent).toContain("文件与命令权限");
  });
});
