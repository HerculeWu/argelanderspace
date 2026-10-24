/**
 * The tutorial's entry on the settings page and in the chapter rail (in-app-tutorial ticket 25): the "Tutorial" row of
 * the "Project" group, after "Recent projects" — in the desktop app the same buttons as the welcome page with what goes
 * wrong said in the row; in the browser form no button, the command `argelanderspace tutorial` to copy. In the
 * tutorial project itself "Resume tutorial" reloads the page with the entry mark (there is nothing to switch to). The
 * chapter rail's "Restart…" opens the same confirmation, or in the browser form the `--reset` command.
 */
import type { HostInfo, TutorialState } from "@argelanderspace/contracts";
import { HOST_REQUEST_KINDS } from "@argelanderspace/contracts";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Preferences, PreferencesProvider } from "../src/argelander/preferences";
import { Shell } from "../src/argelander/Shell";
import { resetHostInfoForTests } from "../src/host";
import { ENTRY_MARK_KEY } from "../src/tutorial/entry";
import { TutorialRunner } from "../src/tutorial/TutorialLayer";
import { resetTutorialEntryForTests, useTutorialEntry } from "../src/tutorial/TutorialEntry";
import { fakeBus } from "./fake-ws";
import { type FakeSettings, fakeSettings } from "./settings-fake";
import { installShellHarness } from "./shell-harness";
import { fakePage, fakeProgress } from "./tutorial-fixtures";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotStub("stub-copilot"));
vi.mock("../src/plan/PlanView", async () => (await import("./shell-stubs")).pageStub("plan"));
vi.mock("../src/writer/WriterView", async () => (await import("./shell-stubs")).pageStub("write"));
vi.mock("../src/library/LibraryView", async () => (await import("./shell-stubs")).pageStub("library"));
vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).pageStub("doc"));
vi.mock("../src/mail/MailView", async () => (await import("./shell-stubs")).pageStub("mail"));

const DESKTOP: HostInfo = { version: 1, app: "argelanderspace", mode: "desktop", requests: [...HOST_REQUEST_KINDS], portFallback: null, project: "open" };
const BROWSER: HostInfo = { version: 1, app: "argelanderspace", mode: "browser", requests: [], portFallback: null, project: "open" };
const FOLDER = "/home/someone/ArgelanderSpace-Tutorial";
/** FOLDER as the server shows it (its home directory written as `~`). */
const SHOWN = "~/ArgelanderSpace-Tutorial";
const READY: TutorialState = {
  progress: fakeProgress({ project: { path: FOLDER } }),
  project: { path: FOLDER, display: SHOWN, state: "ready" },
  sample: { bundled: 3, project: 3 },
};

let settings: FakeSettings;
let host: HostInfo;
let tutorial: TutorialState;
let calls: string[];

const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => structuredClone(body) }) as Response;
installShellHarness({
  settings: () => settings,
  routes: (url) => {
    if (url === "/api/host") return ok(host);
    if (url === "/api/host/recent-projects") return ok({ version: 1, projects: [], lastMissing: null });
    if (url === "/api/tutorial") return ok(tutorial);
    if (url.startsWith("/api/host/tutorial/")) {
      calls.push(url);
      return ok({ ok: true }, 202);
    }
    return null;
  },
});
beforeEach(() => {
  resetHostInfoForTests();
  resetTutorialEntryForTests();
  settings = fakeSettings({ "ui.language": "en" });
  host = DESKTOP;
  tutorial = { progress: null, project: null, sample: { bundled: 3, project: null } };
  calls = [];
});

/** Outside the Shell: only the passing notices of the preferences are used. */
const withPreferences = (node: React.ReactNode) => (
  <PreferencesProvider value={{ notify: vi.fn() } as unknown as Preferences}>{node}</PreferencesProvider>
);

const q = (selector: string, root: ParentNode = document) => root.querySelector<HTMLElement>(selector);
const settled = () => act(() => new Promise((r) => setTimeout(r, 30)));
const row = () => q('[data-ui="setting-row"][data-ui-key="tutorial"]');

async function openProjectGroup(): Promise<HTMLElement> {
  render(<Shell />);
  await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="settings"]')!);
  await waitFor(() => expect(q('[data-ui="settings-group"][data-ui-key="project"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="settings-group"][data-ui-key="project"]')!);
  await waitFor(() => expect(row()).not.toBeNull());
  await settled();
  return row()!;
}

describe("the settings page's “Tutorial” row", () => {
  it("desktop: right after “Recent projects”, with the same button; a failure is said in the row", async () => {
    const tutorialRow = await openProjectGroup();
    const keys = [...document.querySelectorAll('[data-ui="setting-row"]')].map((el) => el.getAttribute("data-ui-key"));
    expect(keys.slice(0, 3)).toEqual(["project-root", "recent-projects", "tutorial"]);
    expect(tutorialRow.textContent).toContain("Tutorial");
    expect(tutorialRow.textContent).toContain("Your own projects are not changed.");
    const start = q('[data-ui="settings-start-tutorial"]', tutorialRow) as HTMLButtonElement;
    expect(start.textContent).toBe("Start tutorial");
    fireEvent.click(start);
    await settled();
    expect(calls).toEqual(["/api/host/tutorial/pick"]);
    act(() => fakeBus.emit("host.tutorial-result", { reason: "copy_failed", path: { path: FOLDER, display: "~/ArgelanderSpace-Tutorial" } }));
    expect(q('[data-ui="tutorial-entry-failed"]', tutorialRow)?.textContent).toContain("the sample was not copied to ~/ArgelanderSpace-Tutorial");
  });

  it("the browser form: no button, the command to copy", async () => {
    host = BROWSER;
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const tutorialRow = await openProjectGroup();
    expect(tutorialRow.querySelector("button:not([data-ui='copy-tutorial-command'])")).toBeNull();
    expect(tutorialRow.textContent).toContain("Run this command in a terminal to start the tutorial:");
    expect(q('[data-ui="tutorial-command"]', tutorialRow)?.textContent).toBe("argelanderspace tutorial");
    const copy = q('[data-ui="copy-tutorial-command"]', tutorialRow)!;
    expect(copy.getAttribute("aria-label")).toBe("Copy");
    fireEvent.click(copy);
    await settled();
    expect(writeText).toHaveBeenCalledWith("argelanderspace tutorial");
    expect(tutorialRow.textContent).toContain("Copied");
  });

  it("a refused copy is said as such", async () => {
    host = BROWSER;
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) }, configurable: true });
    const tutorialRow = await openProjectGroup();
    fireEvent.click(q('[data-ui="copy-tutorial-command"]', tutorialRow)!);
    await settled();
    expect(q('[data-ui="tutorial-command-copy-failed"]', tutorialRow)).not.toBeNull();
  });
});

describe("in the tutorial project itself", () => {
  function Probe({ reloadPage }: { reloadPage: () => void }) {
    const entry = useTutorialEntry(FOLDER, { reloadPage });
    return (
      <button type="button" data-ui="probe" data-ready={String(entry.ready)} onClick={() => entry.resume()}>
        resume
      </button>
    );
  }

  it("“Resume tutorial” writes the mark and reloads the page instead of asking the host to switch", async () => {
    tutorial = READY;
    const reloadPage = vi.fn();
    render(withPreferences(<Probe reloadPage={reloadPage} />));
    await waitFor(() => expect(q('[data-ui="probe"]')?.getAttribute("data-ready")).toBe("true"));
    fireEvent.click(q('[data-ui="probe"]')!);
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(ENTRY_MARK_KEY)).not.toBeNull();
    await settled();
    expect(calls).toEqual([]);
  });
});

describe("the chapter rail's “Restart…”", () => {
  function rail(desktop: boolean, projectDisplay?: string) {
    tutorial = READY;
    render(withPreferences(
      <TutorialRunner
        initial={fakeProgress({ project: { path: FOLDER }, position: "tour.library" })}
        projectDisplay={projectDisplay}
        context={fakePage("plan")}
        onViewAction={async () => ({ ok: true })}
        desktop={desktop}
        entered
        deps={{ put: async () => ({}), checkTex: async () => true, now: () => "2026-10-21T00:00:00.000Z", measure: () => ({ rect: new DOMRect(10, 10, 40, 20), visible: true }) }}
      />
    ));
  }

  it("the rail head's icon-only buttons both use the small preset (shelf follow-up 10, Q1)", () => {
    rail(true);
    for (const ui of ["tutorial-rail-more", "toggle-tutorial-chapters"]) expect(q(`[data-ui="${ui}"] svg`)?.getAttribute("class")).toBe("ui-icon ui-icon-size--small");
    expect(q('[data-ui="tutorial-rail-more"] svg [stroke-width]')).toBeNull();
  });
  it("the confirmation names the folder in its display form from its first frame (the layer's own state), not the raw path", async () => {
    rail(true, SHOWN);
    fireEvent.click(q('[data-ui="tutorial-rail-more"]')!);
    fireEvent.click(q('[data-ui="tutorial-restart"]')!);
    const dialog = q('[data-ui="restart-tutorial"]');
    expect(dialog?.textContent).toContain(SHOWN);
    expect(dialog?.textContent).not.toContain(FOLDER);
  });
  it("desktop: the overflow menu's item opens the same confirmation; confirmed, the host restarts the open tutorial", async () => {
    rail(true);
    fireEvent.click(q('[data-ui="tutorial-rail-more"]')!);
    const item = q('[data-ui="tutorial-restart"]') as HTMLButtonElement;
    expect(item.disabled).toBe(false);
    fireEvent.click(item);
    await waitFor(() => expect(q('[data-ui="restart-tutorial"]')).not.toBeNull());
    await waitFor(() => expect(q('[data-ui="restart-tutorial"]')?.textContent).toContain(SHOWN));
    expect(q('[data-ui="restart-tutorial"]')?.textContent).not.toContain(FOLDER);
    // The card yields to the dialog (the modal signal).
    await waitFor(() => expect(q('[data-ui="tutorial-step-card"]')?.getAttribute("data-state")).toBe("modal"));
    fireEvent.click(q('[data-ui="restart-tutorial-confirm"]')!);
    await settled();
    expect(calls).toEqual(["/api/host/tutorial/restart"]);
  });

  it("the browser form: the command to run in a terminal, with --reset", async () => {
    rail(false);
    fireEvent.click(q('[data-ui="tutorial-rail-more"]')!);
    fireEvent.click(q('[data-ui="tutorial-restart"]')!);
    await waitFor(() => expect(q('[data-ui="restart-tutorial-browser"]')).not.toBeNull());
    const dialog = q('[data-ui="restart-tutorial-browser"]')!;
    expect(q('[data-ui="tutorial-reset-command"]', dialog)?.textContent).toBe("argelanderspace tutorial --reset");
    expect(q('[data-ui="restart-tutorial-confirm"]')).toBeNull();
    fireEvent.click(q('[data-ui="restart-tutorial-close"]')!);
    expect(q('[data-ui="restart-tutorial-browser"]')).toBeNull();
    expect(calls).toEqual([]);
  });
});
