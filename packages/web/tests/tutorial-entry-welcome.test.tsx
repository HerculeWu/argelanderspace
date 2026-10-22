/**
 * The tutorial's entry on the welcome page (in-app-tutorial ticket 25): a secondary button beside "Open folder…" whose
 * label follows `GET /api/tutorial` (start / resume; disabled with a note when this installation has no sample), the
 * older-sample warning, "Restart…" with its confirmation, and a failure the host announces (`host.tutorial-result`)
 * shown below the hero until the next click. Every request goes to `/api/host/tutorial/*` without a body; the entry
 * mark is written before. Fakes for the endpoints; the host is `packages/server/tests/desktop-tutorial*.test.ts`, the
 * layout a real browser (ticket evidence).
 */
import type { HostInfo, TutorialState } from "@argelanderspace/contracts";
import { HOST_REQUEST_KINDS } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { resetHostInfoForTests } from "../src/host";
import i18n from "../src/i18n";
import { ENTRY_MARK_KEY } from "../src/tutorial/entry";
import { resetTutorialEntryForTests } from "../src/tutorial/TutorialEntry";
import { fakeBus } from "./fake-ws";
import { type FakeSettings, fakeSettings } from "./settings-fake";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/argelander/Shell", () => ({ Shell: () => <div data-ui="stub-workbench" /> }));

const WELCOME: HostInfo = { version: 1, app: "argelanderspace", mode: "desktop", requests: [...HOST_REQUEST_KINDS], portFallback: null, project: "none" };
const FOLDER = "/home/someone/ArgelanderSpace-Tutorial";
/** FOLDER as the server shows it (its home directory written as `~`). */
const SHOWN = "~/ArgelanderSpace-Tutorial";

const NONE: TutorialState = { progress: null, project: null, sample: { bundled: 3, project: null } };
const READY: TutorialState = {
  progress: {
    version: 1,
    project: { path: FOLDER },
    startedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    position: "tour.split",
    steps: {},
    appVersion: "0.1.1",
  },
  project: { path: FOLDER, display: SHOWN, state: "ready" },
  sample: { bundled: 3, project: 3 },
};

let settings: FakeSettings;
let tutorial: TutorialState;
/** What the next `/api/host/tutorial/*` answers. */
let reply: { status: number; body: unknown };
let calls: Array<{ url: string; method: string | undefined; body: unknown }>;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetHostInfoForTests();
  resetTutorialEntryForTests();
  settings = fakeSettings({ "ui.language": "en" });
  tutorial = NONE;
  reply = { status: 202, body: { ok: true } };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = settings.handle(input, init);
      if (answer) return answer;
      const url = String(input);
      const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => structuredClone(body) }) as Response;
      if (url === "/api/host") return ok(WELCOME);
      if (url === "/api/host/recent-projects") return ok({ version: 1, projects: [], lastMissing: null });
      if (url === "/api/tutorial") return ok(tutorial);
      calls.push({ url, method: init?.method, body: init?.body });
      if (url.startsWith("/api/host/tutorial/")) return ok(reply.body, reply.status);
      if (url.startsWith("/api/host/requests/")) return ok({ ok: true }, 202);
      return ok({ code: "no_project" }, 409);
    })
  );
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.changeLanguage("zh-CN");
});

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const button = (ui: string) => q(`[data-ui="${ui}"]`) as HTMLButtonElement | null;
const settled = () => act(() => new Promise((r) => setTimeout(r, 20)));

async function welcome(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(q('[data-ui="welcome-page"]')).not.toBeNull());
  await waitFor(() => expect(q('[data-ui="tutorial-entry"]')).not.toBeNull());
  await settled();
}

describe("the button's three states", () => {
  it("nothing bound: “Start tutorial” beside “Open folder…”; the host is asked to pick (no body), the entry mark written first", async () => {
    await welcome();
    const start = button("welcome-start-tutorial")!;
    expect(start.textContent).toBe("Start tutorial");
    expect(start.disabled).toBe(false);
    expect(start.closest(".wl-actions")?.querySelector('[data-ui="welcome-open-folder"]')).not.toBeNull();
    expect(q('[data-ui="welcome-restart-tutorial"]')).toBeNull();
    fireEvent.click(start);
    await settled();
    expect(calls).toEqual([{ url: "/api/host/tutorial/pick", method: "POST", body: undefined }]);
    expect(JSON.parse(window.sessionStorage.getItem(ENTRY_MARK_KEY)!)).toMatchObject({ v: 1 });
    // The dialog is the shell's: the button stays usable.
    expect(start.disabled).toBe(false);
  });

  it("a bound folder that is there: “Resume tutorial” and “Restart…”; resuming asks the host to continue and says it is preparing", async () => {
    tutorial = READY;
    await welcome();
    const resume = button("welcome-start-tutorial")!;
    expect(resume.textContent).toBe("Resume tutorial");
    expect(button("welcome-restart-tutorial")?.textContent).toBe("Restart…");
    expect(q('[data-ui="tutorial-outdated-sample"]')).toBeNull();
    fireEvent.click(resume);
    await settled();
    expect(calls.map((c) => c.url)).toEqual(["/api/host/tutorial/continue"]);
    expect(q('[data-ui="tutorial-entry-starting"]')?.textContent).toBe("Preparing the tutorial folder…");
    expect(resume.disabled).toBe(true);
    expect(window.sessionStorage.getItem(ENTRY_MARK_KEY)).not.toBeNull();
  });

  it("a bound folder that is gone or unmarked: “Start tutorial” again", async () => {
    tutorial = { ...READY, project: { path: FOLDER, display: SHOWN, state: "missing" }, sample: { bundled: 3, project: null } };
    await welcome();
    expect(button("welcome-start-tutorial")?.textContent).toBe("Start tutorial");
    expect(q('[data-ui="welcome-restart-tutorial"]')).toBeNull();
  });

  it("no sample in this installation: the button disabled with the reason beside it", async () => {
    tutorial = { ...NONE, sample: { bundled: null, project: null } };
    await welcome();
    const start = button("welcome-start-tutorial")!;
    expect(start.textContent).toBe("Start tutorial");
    expect(start.disabled).toBe(true);
    expect(q('[data-ui="tutorial-sample-missing"]')?.textContent).toBe("This installation does not include the tutorial sample");
    fireEvent.click(start);
    expect(calls).toEqual([]);
  });

  it("a continue the host refuses (the folder went away meanwhile): the state is read again", async () => {
    tutorial = READY;
    await welcome();
    reply = { status: 409, body: { code: "tutorial_missing" } };
    tutorial = { ...READY, project: { path: FOLDER, display: SHOWN, state: "missing" } };
    fireEvent.click(button("welcome-start-tutorial")!);
    await waitFor(() => expect(button("welcome-start-tutorial")?.textContent).toBe("Start tutorial"));
    expect(q('[data-ui="tutorial-entry-starting"]')).toBeNull();
  });
});

describe("messages", () => {
  it("an older sample: a warning beside “Resume tutorial”; both ways stay open", async () => {
    tutorial = { ...READY, sample: { bundled: 3, project: 2 } };
    await welcome();
    const warning = q('[data-ui="tutorial-outdated-sample"]')!;
    expect(warning.className).toContain("warning");
    expect(warning.textContent).toContain("made from an older sample");
    expect(button("welcome-start-tutorial")?.disabled).toBe(false);
    expect(button("welcome-restart-tutorial")?.disabled).toBe(false);
  });

  it("a failure the host announces: a danger message below the hero naming the folder; a click tries again and clears it", async () => {
    await welcome();
    fireEvent.click(button("welcome-start-tutorial")!);
    await settled();
    act(() => fakeBus.emit("host.tutorial-result", { reason: "target_conflict", path: { path: FOLDER, display: "~/ArgelanderSpace-Tutorial" } }));
    const failed = q('[data-ui="tutorial-entry-failed"]')!;
    expect(failed.className).toContain("danger");
    expect(failed.textContent).toBe(
      "The tutorial did not start: ~/ArgelanderSpace-Tutorial already exists and is not a tutorial folder. Pick another parent folder, or rename it."
    );
    // Below the hero, where "the last project folder no longer exists" goes.
    expect(q(".wl-hero")?.contains(failed)).toBe(false);
    fireEvent.click(button("welcome-start-tutorial")!);
    await settled();
    expect(q('[data-ui="tutorial-entry-failed"]')).toBeNull();
    expect(calls.map((c) => c.url)).toEqual(["/api/host/tutorial/pick", "/api/host/tutorial/pick"]);
  });

  for (const [reason, text] of [
    ["copy_failed", "the sample was not copied to ~/T. Check the free disk space"],
    ["not_a_folder", "~/T is not a folder."],
    ["shutting_down", "the workbench is closing. Try again later."],
  ] as const) {
    it(`${reason}: said with its own words`, async () => {
      await welcome();
      act(() => fakeBus.emit("host.tutorial-result", { reason, path: { path: "/home/someone/T", display: "~/T" } }));
      expect(q('[data-ui="tutorial-entry-failed"]')?.textContent).toContain(text);
    });
  }
});

describe("“Restart…”", () => {
  async function ask(): Promise<HTMLElement> {
    tutorial = READY;
    await welcome();
    fireEvent.click(button("welcome-restart-tutorial")!);
    await waitFor(() => expect(q('[data-ui="restart-tutorial"]')).not.toBeNull());
    return q('[data-ui="restart-tutorial"]')!;
  }

  it("the confirmation names the folder and what is deleted, the safe action has the focus; cancel sends nothing", async () => {
    const dialog = await ask();
    expect(dialog.textContent).toContain("Restart the tutorial?");
    // The folder as everywhere else on the page: the server's display form, not the raw path.
    expect(dialog.textContent).toContain(`${SHOWN} will be emptied and the sample copied again`);
    expect(dialog.textContent).not.toContain(FOLDER);
    expect(dialog.textContent).toContain("annotations, arguments, tasks and manuscripts");
    expect(document.activeElement).toBe(button("restart-tutorial-cancel"));
    expect(button("restart-tutorial-confirm")?.className).toContain("danger");
    fireEvent.click(button("restart-tutorial-cancel")!);
    expect(q('[data-ui="restart-tutorial"]')).toBeNull();
    expect(calls).toEqual([]);
  });

  it("confirmed: the host is asked (no body); while it prepares the dialog cannot be closed; a failure it announces stays in the dialog to retry", async () => {
    await ask();
    fireEvent.click(button("restart-tutorial-confirm")!);
    await settled();
    expect(calls).toEqual([{ url: "/api/host/tutorial/restart", method: "POST", body: undefined }]);
    expect(window.sessionStorage.getItem(ENTRY_MARK_KEY)).not.toBeNull();
    expect(button("restart-tutorial-cancel")?.disabled).toBe(true);
    expect(button("restart-tutorial-confirm")?.getAttribute("aria-busy")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(q('[data-ui="restart-tutorial"]')).not.toBeNull();

    act(() => fakeBus.emit("host.tutorial-result", { reason: "copy_failed", path: { path: FOLDER, display: "~/ArgelanderSpace-Tutorial" } }));
    await settled();
    const dialog = q('[data-ui="restart-tutorial"]')!;
    expect(dialog.querySelector('[data-ui="tutorial-entry-failed"]')?.textContent).toContain("the sample was not copied");
    // Shown in the dialog, not twice.
    expect(document.querySelectorAll('[data-ui="tutorial-entry-failed"]')).toHaveLength(1);
    expect(button("restart-tutorial-confirm")?.disabled).toBe(false);
    fireEvent.click(button("restart-tutorial-confirm")!);
    await settled();
    expect(calls.map((c) => c.url)).toEqual(["/api/host/tutorial/restart", "/api/host/tutorial/restart"]);
    expect(dialog.querySelector('[data-ui="tutorial-entry-failed"]')).toBeNull();
  });

  it("no answer from the host: said in the dialog, which stays open to retry", async () => {
    await ask();
    reply = { status: 500, body: {} };
    fireEvent.click(button("restart-tutorial-confirm")!);
    await waitFor(() => expect(q('[data-ui="restart-tutorial-failed"]')).not.toBeNull());
    expect(button("restart-tutorial-confirm")?.disabled).toBe(false);
  });

  it("refused (the folder lost its marker meanwhile): the dialog closes and the state is read again", async () => {
    await ask();
    reply = { status: 409, body: { code: "tutorial_missing" } };
    tutorial = { ...READY, project: { path: FOLDER, display: SHOWN, state: "unmarked" } };
    fireEvent.click(button("restart-tutorial-confirm")!);
    await waitFor(() => expect(q('[data-ui="restart-tutorial"]')).toBeNull());
    await waitFor(() => expect(button("welcome-start-tutorial")?.textContent).toBe("Start tutorial"));
  });
});
