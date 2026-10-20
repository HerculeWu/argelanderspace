/**
 * The settings page's "Command line & agents" group (desktop-app ticket 24), as in the approved prototype: listed only
 * in the desktop app; the command-line tool's state, install and uninstall through `/api/host/cli` (no body sent), the
 * line to add when its directory is not on PATH, a file of someone else's reported and not overwritten, and the
 * bundled skills folder shown by the `open_skills_folder` native request. Fakes for the endpoints; the host itself is
 * `packages/server/tests/desktop-host.test.ts`, the launcher `packages/infra/tests/cli-launcher.test.ts`, the layout a
 * real browser (ticket evidence).
 */
import type { HostCliStatus, HostInfo } from "@argelanderspace/contracts";
import { HOST_REQUEST_KINDS } from "@argelanderspace/contracts";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import { resetHostInfoForTests } from "../src/host";
import i18n from "../src/i18n";
import { type FakeSettings, fakeSettings } from "./settings-fake";
import { installShellHarness } from "./shell-harness";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotStub("stub-copilot"));
vi.mock("../src/plan/PlanView", async () => (await import("./shell-stubs")).pageStub("plan"));
vi.mock("../src/writer/WriterView", async () => (await import("./shell-stubs")).pageStub("write"));
vi.mock("../src/library/LibraryView", async () => (await import("./shell-stubs")).pageStub("library"));
vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).pageStub("doc"));
vi.mock("../src/mail/MailView", async () => (await import("./shell-stubs")).pageStub("mail"));

const EN = { "ui.language": "en" } as const;
const DESKTOP: HostInfo = { version: 1, app: "argelanderspace", mode: "desktop", requests: [...HOST_REQUEST_KINDS], portFallback: null, project: "open" };
const BROWSER: HostInfo = { version: 1, app: "argelanderspace", mode: "browser", requests: [], portFallback: null, project: "open" };

const STATUS = (over: Partial<HostCliStatus> = {}): HostCliStatus => ({
  version: 1,
  command: "argelanderspace",
  state: "not_installed",
  file: { path: "/home/someone/.local/bin/argelanderspace", display: "~/.local/bin/argelanderspace" },
  dir: { path: "/home/someone/.local/bin", display: "~/.local/bin" },
  inPath: false,
  pathLine: 'export PATH="$HOME/.local/bin:$PATH"',
  platform: "posix",
  ...over,
});

let settings: FakeSettings;
let host: HostInfo | number;
/** What `GET /api/host/cli` answers: a status, a status code without one, or a status code with a body. */
let cli: HostCliStatus | number | { status: number; body: unknown };
/** What the next install / uninstall answers. */
let change: { status: number; body: unknown } | null;
let calls: Array<{ url: string; method: string | undefined; body: unknown }>;

const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => structuredClone(body) }) as Response;
installShellHarness({
  settings: () => settings,
  routes: (url, init) => {
    if (url === "/api/host") return typeof host === "number" ? ok({ detail: "x" }, host) : ok(host);
    if (url.startsWith("/api/host/requests/") || url.startsWith("/api/host/cli/")) {
      calls.push({ url, method: init?.method, body: init?.body });
      if (url.startsWith("/api/host/requests/")) return ok({ ok: true }, 202);
      const reply = change ?? { status: 500, body: { code: "write_failed", detail: "EIO" } };
      return ok(reply.body, reply.status);
    }
    if (url === "/api/host/cli") {
      if (typeof cli === "number") return ok({ code: "x" }, cli);
      if ("body" in cli) return ok(cli.body, cli.status);
      return ok(cli);
    }
    return null;
  },
});
beforeEach(() => {
  resetHostInfoForTests();
  settings = fakeSettings(EN);
  host = DESKTOP;
  cli = STATUS();
  change = null;
  calls = [];
});

const q = (selector: string, root: ParentNode = document) => root.querySelector<HTMLElement>(selector);
const settled = () => new Promise((r) => setTimeout(r, 30));

async function openSettings(): Promise<void> {
  render(<Shell />);
  await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="settings"]')!);
  await waitFor(() => expect(q('[data-ui="setting-row"][data-ui-key="ui.theme"]')).not.toBeNull());
  await settled();
}

async function openCli(): Promise<HTMLElement> {
  await openSettings();
  await waitFor(() => expect(q('[data-ui="settings-group"][data-ui-key="cli"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="settings-group"][data-ui-key="cli"]')!);
  await waitFor(() => expect(q('[data-ui="cli-status"]')?.getAttribute("data-state")).not.toBe("loading"));
  return q('[data-ui="setting-row"][data-ui-key="cli-tool"]')!;
}

describe("the browser form", () => {
  for (const [what, answer] of [
    ["the server says browser", BROWSER],
    ["the server gives no usable answer", 404],
  ] as const) {
    it(`${what}: the group is not listed and nothing of it is asked for`, async () => {
      host = answer;
      await openSettings();
      expect(q('[data-ui="settings-group"][data-ui-key="mail"]')).not.toBeNull();
      expect(q('[data-ui="settings-group"][data-ui-key="cli"]')).toBeNull();
      expect(q('[data-ui="cli-install"]')).toBeNull();
      expect(q('[data-ui="show-skills-folder"]')).toBeNull();
      const fetched = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
      expect(fetched.filter((u) => u.startsWith("/api/host/cli"))).toEqual([]);
    });
  }
});

describe("the desktop form", () => {
  it("listed between Mail and Diagnostics; before installing: not installed, where it goes, the install button, the skills", async () => {
    await openSettings();
    const keys = [...document.querySelectorAll('[data-ui="settings-group"]')].map((b) => b.getAttribute("data-ui-key"));
    expect(keys.slice(keys.indexOf("mail"), keys.indexOf("mail") + 3)).toEqual(["mail", "cli", "diagnostics"]);
    fireEvent.click(q('[data-ui="settings-group"][data-ui-key="cli"]')!);
    await waitFor(() => expect(q('[data-ui="cli-status"]')?.getAttribute("data-state")).toBe("not_installed"));
    expect(q('[data-ui="settings-group-body"] .st-group-title')!.textContent).toBe("Command line & agents");
    const row = q('[data-ui="setting-row"][data-ui-key="cli-tool"]')!;
    expect(q('[data-ui="cli-status"]', row)!.textContent).toBe("Not installed");
    expect(row.textContent).toContain("Install location: ~/.local/bin/argelanderspace");
    expect(q('[data-ui="cli-install"]', row)!.textContent).toBe("Install the command-line tool");
    expect(q('[data-ui="cli-uninstall"]')).toBeNull();
    expect(q('[data-ui="cli-path-hint"]')).toBeNull();
    expect(q('[data-ui="show-skills-folder"]')!.textContent).toBe("Show the skills folder");
  });

  it("install: a POST with no body; installed and its directory not on PATH: the line to add, which can be copied", async () => {
    const row = await openCli();
    change = { status: 200, body: { outcome: "installed", status: STATUS({ state: "installed" }) } };
    fireEvent.click(q('[data-ui="cli-install"]', row)!);
    await waitFor(() => expect(q('[data-ui="cli-status"]')!.getAttribute("data-state")).toBe("installed"));
    expect(calls).toEqual([{ url: "/api/host/cli/install", method: "POST", body: undefined }]);
    expect(q('[data-ui="cli-status"]')!.textContent).toBe("Installed");
    const hint = q('[data-ui="cli-path-hint"]')!;
    expect(hint.textContent).toContain("The install location is not on PATH");
    expect(hint.textContent).toContain("The app does not change your environment.");
    expect(q('[data-ui="cli-path-line"]', hint)!.textContent).toBe('export PATH="$HOME/.local/bin:$PATH"');
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    // What is copied is the whole line, so it is named a line, and so is the notice.
    expect(q('[data-ui="copy-path-line"]', hint)!.getAttribute("aria-label")).toBe("Copy line");
    fireEvent.click(q('[data-ui="copy-path-line"]', hint)!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('export PATH="$HOME/.local/bin:$PATH"'));
    await waitFor(() =>
      expect([...document.querySelectorAll('[data-ui="toast"]')].map((el) => el.textContent)).toContain("Line copied")
    );
    expect(q('[data-ui="cli-install"]')).toBeNull();
    expect(q('[data-ui="cli-uninstall"]')!.textContent).toBe("Uninstall");
  });

  it("installed with its directory on PATH: no line to add", async () => {
    cli = STATUS({ state: "installed", inPath: true });
    await openCli();
    expect(q('[data-ui="cli-status"]')!.getAttribute("data-state")).toBe("installed");
    expect(q('[data-ui="cli-path-hint"]')).toBeNull();
  });

  it("on Windows the directory itself is what to add to the user PATH", async () => {
    cli = STATUS({
      state: "installed",
      platform: "windows",
      file: { path: "C:\\Users\\u\\AppData\\Local\\Programs\\argelanderspace\\bin\\argelanderspace.cmd", display: "~\\AppData\\Local\\Programs\\argelanderspace\\bin\\argelanderspace.cmd" },
      pathLine: "C:\\Users\\u\\AppData\\Local\\Programs\\argelanderspace\\bin",
    });
    await openCli();
    const hint = q('[data-ui="cli-path-hint"]')!;
    expect(hint.textContent).toContain("Add this directory to your user PATH:");
    expect(q('[data-ui="cli-path-line"]', hint)!.textContent).toBe("C:\\Users\\u\\AppData\\Local\\Programs\\argelanderspace\\bin");
    // There it is a directory that is copied.
    expect(q('[data-ui="copy-path-line"]', hint)!.getAttribute("aria-label")).toBe("Copy path");
  });

  it("someone else's file of that name: install is refused, the page says it was not overwritten", async () => {
    const row = await openCli();
    change = { status: 409, body: { code: "foreign", detail: "x", status: STATUS({ state: "foreign" }) } };
    fireEvent.click(q('[data-ui="cli-install"]', row)!);
    await waitFor(() => expect(q('[data-ui="cli-conflict"]')).not.toBeNull());
    expect(q('[data-ui="cli-conflict"]')!.textContent).toContain("Not installed: a different file is already there");
    expect(q('[data-ui="cli-conflict"]')!.textContent).toContain("~/.local/bin/argelanderspace was not placed by this app, so it was not overwritten.");
    expect(q('[data-ui="cli-status"]')!.textContent).toBe("Not installed");
    // Installing again stays possible once the user has moved the file.
    expect(q('[data-ui="cli-install"]')).not.toBeNull();
  });

  it("an install that fails says so with the error's code", async () => {
    const row = await openCli();
    change = { status: 500, body: { code: "write_failed", detail: "EACCES" } };
    fireEvent.click(q('[data-ui="cli-install"]', row)!);
    await waitFor(() => expect(q('[data-ui="cli-install-failed"]')).not.toBeNull());
    expect(q('[data-ui="cli-install-failed"]')!.textContent).toBe("Not installed (EACCES); no file was written.");
    expect(q('[data-ui="cli-status"]')!.getAttribute("data-state")).toBe("not_installed");
  });

  it("uninstall asks first (focus on Cancel), names the file and the command; confirmed: a POST with no body", async () => {
    cli = STATUS({ state: "installed", inPath: true });
    await openCli();
    fireEvent.click(q('[data-ui="cli-uninstall"]')!);
    const dialog = q('[data-ui="uninstall-cli"]')!;
    expect(dialog.textContent).toContain("Uninstall the command-line tool?");
    expect(dialog.textContent).toContain(
      "~/.local/bin/argelanderspace will be deleted. Agents will not find the argelanderspace command in a terminal until it is installed again."
    );
    await waitFor(() => expect(document.activeElement).toBe(q('[data-ui="uninstall-cli-cancel"]')));
    fireEvent.click(q('[data-ui="uninstall-cli-cancel"]')!);
    expect(q('[data-ui="uninstall-cli"]')).toBeNull();
    expect(calls).toEqual([]);

    fireEvent.click(q('[data-ui="cli-uninstall"]')!);
    change = { status: 500, body: { code: "remove_failed", detail: "EBUSY" } };
    fireEvent.click(q('[data-ui="uninstall-cli-confirm"]')!);
    // Refused: the dialog stays, to retry or cancel.
    await waitFor(() => expect(q('[data-ui="cli-uninstall-failed"]')).not.toBeNull());
    expect(q('[data-ui="cli-uninstall-failed"]')!.textContent).toBe("Not uninstalled (EBUSY); the file is unchanged.");
    change = { status: 200, body: { outcome: "removed", status: STATUS() } };
    fireEvent.click(q('[data-ui="uninstall-cli-confirm"]')!);
    await waitFor(() => expect(q('[data-ui="uninstall-cli"]')).toBeNull());
    expect(q('[data-ui="cli-status"]')!.getAttribute("data-state")).toBe("not_installed");
    expect(calls.map((c) => [c.url, c.method, c.body])).toEqual([
      ["/api/host/cli/uninstall", "POST", undefined],
      ["/api/host/cli/uninstall", "POST", undefined],
    ]);
  });

  it("uninstall finds someone else's file there by now: said in the dialog in uninstall's words, the dialog stays", async () => {
    cli = STATUS({ state: "installed", inPath: true });
    await openCli();
    fireEvent.click(q('[data-ui="cli-uninstall"]')!);
    change = { status: 409, body: { code: "foreign", detail: "x", status: STATUS({ state: "foreign", inPath: true }) } };
    fireEvent.click(q('[data-ui="uninstall-cli-confirm"]')!);
    await waitFor(() => expect(q('[data-ui="cli-uninstall-foreign"]')).not.toBeNull());
    const dialog = q('[data-ui="uninstall-cli"]')!;
    expect(dialog).not.toBeNull();
    expect(q('[data-ui="cli-uninstall-foreign"]', dialog)!.textContent).toBe(
      "Not uninstalled: ~/.local/bin/argelanderspace is no longer the app's file, so it was not deleted."
    );
    expect(dialog.textContent).not.toContain("Not installed");
    // Nothing of the app's is left to remove.
    expect((q('[data-ui="uninstall-cli-confirm"]') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(q('[data-ui="uninstall-cli-cancel"]')!);
    expect(q('[data-ui="uninstall-cli"]')).toBeNull();
    expect(q('[data-ui="cli-status"]')!.getAttribute("data-state")).toBe("foreign");
  });

  it("the app's launcher for another place of the app: said, and reinstalling points it here", async () => {
    cli = STATUS({ state: "outdated", inPath: true });
    await openCli();
    expect(q('[data-ui="cli-status"]')!.textContent).toBe("Installed");
    expect(q('[data-ui="cli-outdated"]')!.textContent).toContain("does not run this app");
    // Either the app has moved, or the app was updated and writes its script differently now.
    expect(q('[data-ui="cli-outdated"]')!.textContent).toContain("moved");
    expect(q('[data-ui="cli-outdated"]')!.textContent).toContain("updated");
    change = { status: 200, body: { outcome: "installed", status: STATUS({ state: "installed", inPath: true }) } };
    expect(q('[data-ui="cli-install"]')!.textContent).toBe("Reinstall");
    fireEvent.click(q('[data-ui="cli-install"]')!);
    await waitFor(() => expect(q('[data-ui="cli-outdated"]')).toBeNull());
    expect(q('[data-ui="cli-status"]')!.getAttribute("data-state")).toBe("installed");
  });

  it("Show the skills folder asks the host, with no body; a host without the request shows no such row", async () => {
    await openCli();
    fireEvent.click(q('[data-ui="show-skills-folder"]')!);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: "/api/host/requests/open_skills_folder", method: "POST", body: undefined });
    cleanup();
    resetHostInfoForTests();
    host = { ...DESKTOP, requests: HOST_REQUEST_KINDS.filter((k) => k !== "open_skills_folder") };
    await openCli();
    expect(q('[data-ui="setting-row"][data-ui-key="skills-folder"]')).toBeNull();
  });

  it("works whatever the state of config.toml: an unreadable file leaves the group usable", async () => {
    settings.state = "unparseable";
    const row = await openCli();
    expect(q('[data-ui="cli-install"]', row)!.hasAttribute("disabled")).toBe(false);
  });

  it("a host run from an AppImage offers no tool: no install button, the reason and what to use instead", async () => {
    cli = { status: 404, body: { code: "cli_unavailable", detail: "x", reason: "appimage" } };
    const row = await openCli();
    expect(q('[data-ui="cli-status"]')!.getAttribute("data-state")).toBe("appimage");
    expect(q('[data-ui="cli-install"]', row)).toBeNull();
    expect(q('[data-ui="cli-uninstall"]', row)).toBeNull();
    expect(q('[data-ui="cli-status-unknown"]')).toBeNull();
    const note = q('[data-ui="cli-appimage"]', row)!;
    expect(note.textContent).toContain("AppImage");
    expect(note.textContent).toContain(".deb");
    expect(note.textContent).toContain("npm");
    // The skills folder stays.
    expect(q('[data-ui="show-skills-folder"]')).not.toBeNull();
    await i18n.changeLanguage("zh-CN");
    await waitFor(() => expect(q('[data-ui="cli-appimage"]')!.textContent).toContain("AppImage"));
    expect(q('[data-ui="cli-appimage"]')!.textContent).toMatch(/命令行工具/);
  });

  it("no usable status: said, and nothing can be installed", async () => {
    cli = 500;
    await openCli();
    expect(q('[data-ui="cli-status"]')!.getAttribute("data-state")).toBe("unknown");
    expect(q('[data-ui="cli-status-unknown"]')!.textContent).toBe("The command-line tool's state could not be read.");
    expect(q('[data-ui="cli-install"]')!.hasAttribute("disabled")).toBe(true);
  });
});
