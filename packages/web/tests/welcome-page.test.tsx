/**
 * The welcome page (desktop-app ticket 18): the page shows it — and only it — when the desktop host has no project
 * open (`GET /api/host` → `project: "none"`); the workbench otherwise, and in the browser form always. "Open folder…"
 * asks the host to pick one; the recent projects are listed, a folder that is gone is marked, cannot be opened and can
 * be removed; opening one asks the host to leave for it. Fakes for the endpoints; the host itself is covered in
 * `packages/server/tests/desktop-welcome.test.ts`, the layout in a real browser (ticket evidence).
 */
import type { HostInfo, HostRecentProjects } from "@argelanderspace/contracts";
import { HOST_REQUEST_KINDS } from "@argelanderspace/contracts";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { resetHostInfoForTests } from "../src/host";
import i18n from "../src/i18n";
import { openedAtText } from "../src/welcome/opened-at";
import { type FakeSettings, fakeSettings } from "./settings-fake";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/argelander/Shell", () => ({ Shell: () => <div data-ui="stub-workbench" /> }));

const WELCOME: HostInfo = { version: 1, app: "argelanderspace", mode: "desktop", requests: [...HOST_REQUEST_KINDS], portFallback: null, project: "none" };

const A = { path: "/home/someone/research/m31-halo", display: "~/research/m31-halo", name: "m31-halo" };
const GONE = { path: "/home/someone/archive/old-thesis", display: "~/archive/old-thesis", name: "old-thesis" };

let settings: FakeSettings;
let host: HostInfo | number;
let recent: HostRecentProjects | number;
let openStatus: { status: number; code?: string };
let calls: Array<{ url: string; method: string | undefined; body: unknown }>;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  resetHostInfoForTests();
  settings = fakeSettings({ "ui.language": "en" });
  host = WELCOME;
  recent = {
    version: 1,
    projects: [
      { ...A, openedAt: new Date().toISOString(), missing: false, current: false },
      { ...GONE, openedAt: "2025-01-01T00:00:00.000Z", missing: true, current: false },
    ],
    lastMissing: null,
  };
  openStatus = { status: 202 };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = settings.handle(input, init);
      if (answer) return answer;
      const url = String(input);
      const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => structuredClone(body) }) as Response;
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/host") return typeof host === "number" ? ok({ detail: "x" }, host) : ok(host);
      if (url === "/api/host/recent-projects") return typeof recent === "number" ? ok({ code: "x" }, recent) : ok(recent);
      if (url === "/api/host/recent-projects/open") return ok(openStatus.status < 300 ? { ok: true } : { code: openStatus.code }, openStatus.status);
      if (url === "/api/host/recent-projects/remove") {
        const path = (JSON.parse(String(init?.body)) as { path: string }).path;
        if (typeof recent !== "number") recent = { ...recent, projects: recent.projects.filter((p) => p.path !== path), lastMissing: recent.lastMissing?.path === path ? null : recent.lastMissing };
        return ok(recent);
      }
      if (url.startsWith("/api/host/requests/")) return ok({ ok: true }, 202);
      return { ok: false, status: 409, json: async () => ({ code: "no_project" }) } as unknown as Response;
    })
  );
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.changeLanguage("zh-CN");
});

const q = (selector: string, root: ParentNode = document) => root.querySelector<HTMLElement>(selector);
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const business = () => calls.filter((c) => !c.url.startsWith("/api/host") && !c.url.startsWith("/api/settings"));

async function welcome() {
  render(<App />);
  await waitFor(() => expect(q('[data-ui="welcome-page"]')).not.toBeNull());
  await waitFor(() => expect(q('[data-ui="welcome-recent-list"]')).not.toBeNull());
}

describe("which page", () => {
  it("no project open in the desktop app: the welcome page, with no settings entry, no workbench and no business request", async () => {
    await welcome();
    expect(q('[data-ui="stub-workbench"]')).toBeNull();
    expect(q('[data-ui="navigate-view"]')).toBeNull();
    expect(q('[data-ui="copilot-toggle"]')).toBeNull();
    // The title bar keeps the theme switch and the appearance quick settings.
    expect(q('[data-ui="toggle-theme"]')).not.toBeNull();
    expect(q('[data-ui="open-tweaks"]')).not.toBeNull();
    // No page name in the middle of the title bar (user decision 2026-10-15): there is no page to name.
    const titlebar = q('[data-ui="app-titlebar"]');
    expect(titlebar?.querySelector(".tb-center")).toBeNull();
    expect(titlebar?.textContent).not.toContain("Literature");
    expect(business()).toEqual([]);
  });

  it.each([
    ["a project open", { ...WELCOME, project: "open" } as HostInfo],
    ["the browser form", { ...WELCOME, mode: "browser", requests: [], project: "open" } as HostInfo],
    ["no usable answer", 500],
  ])("%s: the workbench", async (_name, answer) => {
    host = answer;
    render(<App />);
    await waitFor(() => expect(q('[data-ui="stub-workbench"]')).not.toBeNull());
    expect(q('[data-ui="welcome-page"]')).toBeNull();
  });

  it("nothing is shown until the host has answered", async () => {
    let answer!: () => void;
    const held = new Promise<void>((r) => {
      answer = r;
    });
    const plain = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/host") await held;
      return plain?.(input, init) as Promise<Response>;
    });
    render(<App />);
    await new Promise((r) => setTimeout(r, 30));
    expect(q('[data-ui="welcome-page"]')).toBeNull();
    expect(q('[data-ui="stub-workbench"]')).toBeNull();
    answer();
    await waitFor(() => expect(q('[data-ui="welcome-page"]')).not.toBeNull());
  });
});

describe("the welcome page", () => {
  it("open folder: a text button that asks the host to pick a folder, with no body", async () => {
    await welcome();
    const button = q('[data-ui="welcome-open-folder"]') as HTMLButtonElement;
    expect(button.textContent).toBe("Open folder…");
    fireEvent.click(button);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/host/requests/pick_folder")).toBe(true));
    expect(calls.find((c) => c.url === "/api/host/requests/pick_folder")).toMatchObject({ method: "POST", body: undefined });
  });

  it("the list: name, path as shown, when; a missing folder is marked, cannot be opened, and can be removed", async () => {
    await welcome();
    const rows = all('[data-ui="recent-project"]');
    expect(rows.map((r) => [r.getAttribute("data-ui-key"), r.getAttribute("data-missing")])).toEqual([
      [A.path, "0"],
      [GONE.path, "1"],
    ]);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(first.textContent).toContain("m31-halo");
    expect(first.textContent).toContain("~/research/m31-halo");
    expect(first.textContent).toContain("Last opened: today");
    expect(second.textContent).toContain("Folder missing");
    const openGone = q('[data-ui="recent-project-open"]', second) as HTMLButtonElement;
    expect(openGone.disabled).toBe(true);
    const remove = q('[data-ui="recent-project-remove"]', second) as HTMLButtonElement;
    // An icon button: no visible text, its name says what and which.
    expect(remove.textContent).toBe("");
    expect(remove.getAttribute("aria-label")).toBe("Remove old-thesis from recent projects");
    expect(remove.querySelector("svg")).not.toBeNull();
    fireEvent.click(remove);
    await waitFor(() => expect(all('[data-ui="recent-project"]')).toHaveLength(1));
    expect(calls.find((c) => c.url === "/api/host/recent-projects/remove")?.body).toEqual({ path: GONE.path });
  });

  it("opening a recent project asks the host to leave for it; then nothing else can be asked", async () => {
    await welcome();
    fireEvent.click(q(`[data-ui="recent-project-open"][data-ui-key="${A.path}"]`) as HTMLElement);
    await waitFor(() => expect((q('[data-ui="welcome-open-folder"]') as HTMLButtonElement).disabled).toBe(true));
    expect(calls.find((c) => c.url === "/api/host/recent-projects/open")?.body).toEqual({ path: A.path });
    expect((q('[data-ui="recent-project-remove"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("a folder gone since the list was read: said, and the list read again", async () => {
    await welcome();
    openStatus = { status: 409, code: "folder_missing" };
    const before = calls.filter((c) => c.url === "/api/host/recent-projects").length;
    fireEvent.click(q(`[data-ui="recent-project-open"][data-ui-key="${A.path}"]`) as HTMLElement);
    await waitFor(() => expect(document.body.textContent).toContain("This folder no longer exists."));
    expect(calls.filter((c) => c.url === "/api/host/recent-projects").length).toBe(before + 1);
  });

  it("the last project's folder gone: a warning naming it, until it is removed", async () => {
    if (typeof recent !== "number") recent = { ...recent, lastMissing: { path: GONE.path, display: GONE.display } };
    await welcome();
    const warning = q('[data-ui="welcome-last-missing"]') as HTMLElement;
    expect(warning.textContent).toContain("The last project folder no longer exists");
    expect(warning.textContent).toContain(GONE.display);
    fireEvent.click(q(`[data-ui="recent-project-remove"][data-ui-key="${GONE.path}"]`) as HTMLElement);
    await waitFor(() => expect(q('[data-ui="welcome-last-missing"]')).toBeNull());
  });

  it("no recent project: the empty state", async () => {
    recent = { version: 1, projects: [], lastMissing: null };
    render(<App />);
    await waitFor(() => expect(q('[data-ui="welcome-recent-empty"]')?.textContent).toBe("No project opened yet"));
  });

  it("the list cannot be read: said, not shown as empty", async () => {
    recent = 500;
    render(<App />);
    await waitFor(() => expect(q('[data-ui="welcome-recent-failed"]')).not.toBeNull());
    expect(q('[data-ui="welcome-recent-empty"]')).toBeNull();
  });
});

describe("when it was opened", () => {
  const now = new Date(2026, 9, 15, 12, 0);
  it.each([
    ["en", new Date(2026, 9, 15, 9, 12), "today 09:12"],
    ["en", new Date(2026, 9, 14, 23, 0), "yesterday"],
    ["en", new Date(2026, 9, 1), "2 weeks ago"],
    ["en", new Date(2026, 7, 10), "2 months ago"],
    ["en", new Date(2025, 2, 1), "last year"],
    ["zh-CN", new Date(2026, 9, 14), "昨天"],
  ])("%s %s → %s", (language, at, text) => {
    expect(openedAtText(at.toISOString(), language, now)).toBe(text);
  });
});
