/**
 * The page's capability flag and the desktop app's own controls (desktop-app ticket 17). `GET /api/host` says which
 * form the page runs in; in the browser form (and when the server gives no usable answer) every desktop-only control
 * is absent and the paths are shown with a copy action; in the desktop form "Open config file", "Show the log folder"
 * (settings and the error boundary) ask the host by `POST /api/host/requests/<kind>` with no body. The port fallback
 * banner says the CLI's links will not open this time. Fakes for the endpoints; the real host is covered in
 * `packages/server/tests/desktop-host.test.ts`, the layout in a real browser (ticket evidence).
 */
import type { DiagnosticsInfo, HostInfo } from "@argelanderspace/contracts";
import { HOST_REQUEST_KINDS } from "@argelanderspace/contracts";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import { resetHostInfoForTests } from "../src/host";
import i18n from "../src/i18n";
import { PageErrorBoundary } from "../src/PageErrorBoundary";
import { resetPageErrorReportingForTests } from "../src/page-errors";
import { type FakeSettings, fakeSettings } from "./settings-fake";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/copilot/Copilot", () => ({ Copilot: () => <div data-ui="stub-copilot" /> }));
vi.mock("../src/plan/PlanView", () => ({ PlanView: () => <div data-ui="stub-plan" /> }));
vi.mock("../src/writer/WriterView", () => ({ WriterView: () => <div data-ui="stub-write" /> }));
vi.mock("../src/library/LibraryView", () => ({ LibraryView: () => <div data-ui="stub-library" /> }));
vi.mock("../src/doc/DocPane", () => ({ DocPane: () => <div data-ui="stub-doc" /> }));
vi.mock("../src/mail/MailView", () => ({ MailView: () => <div data-ui="stub-mail" /> }));

const EN = { "ui.language": "en" } as const;
const DESKTOP: HostInfo = { version: 1, app: "argelanderspace", mode: "desktop", requests: [...HOST_REQUEST_KINDS], portFallback: null, project: "open" };
const BROWSER: HostInfo = { version: 1, app: "argelanderspace", mode: "browser", requests: [], portFallback: null, project: "open" };
const DIAGNOSTICS: DiagnosticsInfo = {
  version: 1,
  logDir: { path: "/home/someone/.local/share/argelanderspace/logs", display: "~/.local/share/argelanderspace/logs" },
  logFiles: { count: 1, bytes: 10 },
  compileLogs: [],
  compileLogsLimitBytes: 32 * 1024 * 1024,
};

let settings: FakeSettings;
/** The answer of `GET /api/host`: an object, or a status without a usable body. */
let host: HostInfo | number;
/** Status of the native requests. */
let requestStatus: number;
let requests: Array<{ url: string; method: string | undefined; body: unknown }>;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  resetHostInfoForTests();
  settings = fakeSettings(EN);
  host = DESKTOP;
  requestStatus = 202;
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = settings.handle(input, init);
      if (answer) return answer;
      const url = String(input);
      const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => structuredClone(body) }) as Response;
      if (url === "/api/host") return typeof host === "number" ? ok({ detail: "x" }, host) : ok(host);
      if (url.startsWith("/api/host/requests/")) {
        requests.push({ url, method: init?.method, body: init?.body });
        return ok(requestStatus < 300 ? { ok: true } : { code: "shutting_down" }, requestStatus);
      }
      if (url === "/api/diagnostics") return ok(DIAGNOSTICS);
      if (url === "/api/papers") return ok({ papers: [] });
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
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
const settled = () => new Promise((r) => setTimeout(r, 30));

async function openSettings(group?: string): Promise<void> {
  render(<Shell />);
  await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="settings"]')!);
  await waitFor(() => expect(q('[data-ui="setting-row"][data-ui-key="ui.theme"]')).not.toBeNull());
  await settled();
  if (group) {
    fireEvent.click(q(`[data-ui="settings-group"][data-ui-key="${group}"]`)!);
    await waitFor(() => expect(q('[data-ui="settings-group-body"]')!.getAttribute("data-group")).toBe(group));
  }
}

describe("the browser form", () => {
  for (const [what, answer] of [
    ["the server says browser", BROWSER],
    ["the server gives no usable answer", 404],
  ] as const) {
    it(`${what}: no desktop-only control, paths with a copy action, no port banner`, async () => {
      host = answer;
      await openSettings();
      const head = q('[data-ui="config-file"]')!;
      expect(q('[data-ui="config-file-path"]', head)!.textContent).toBe("~/.config/argelanderspace/config.toml");
      expect(q('[data-ui="copy-config-path"]', head)).not.toBeNull();
      expect(q('[data-ui="open-config-file"]')).toBeNull();
      expect(q('[data-ui="port-fallback-banner"]')).toBeNull();
      fireEvent.click(q('[data-ui="settings-group"][data-ui-key="diagnostics"]')!);
      await waitFor(() => expect(q('[data-ui="copy-log-path"]')).not.toBeNull());
      expect(q('[data-ui="show-log-folder"]')).toBeNull();
      // The command-line group stays the desktop app's (ticket 24); not listed in either form yet.
      expect(q('[data-ui="settings-group"][data-ui-key="cli"]')).toBeNull();
      expect(requests).toEqual([]);
    });
  }
});

describe("the desktop form", () => {
  it("the head of the settings: the path and Open config file, which asks the host with no body", async () => {
    await openSettings();
    const head = q('[data-ui="config-file"]')!;
    await waitFor(() => expect(q('[data-ui="open-config-file"]', head)).not.toBeNull());
    expect(q('[data-ui="config-file-path"]', head)!.textContent).toBe("~/.config/argelanderspace/config.toml");
    expect(q('[data-ui="copy-config-path"]', head)).toBeNull();
    const button = q('[data-ui="open-config-file"]', head)!;
    expect(button.textContent).toBe("Open config file");
    fireEvent.click(button);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({ url: "/api/host/requests/open_config_file", method: "POST", body: undefined });
  });

  it("a row the page cannot change: the button alone, for that key", async () => {
    settings.uneditable = { "ui.theme": "dotted_key" };
    await openSettings();
    const message = await waitFor(() => {
      const el = q('[data-ui="setting-row"][data-ui-key="ui.theme"] [data-ui="setting-unsafe"]');
      expect(q('[data-ui="open-config-file"]', el!)).not.toBeNull();
      return el!;
    });
    expect(q('[data-ui="open-config-file"]', message)!.getAttribute("data-ui-key")).toBe("ui.theme");
    expect(q('[data-ui="config-file-path"]', message)).toBeNull();
    expect(q('[data-ui="copy-config-path"]', message)).toBeNull();
    fireEvent.click(q('[data-ui="open-config-file"]', message)!);
    await waitFor(() => expect(requests.map((r) => r.url)).toEqual(["/api/host/requests/open_config_file"]));
  });

  it("a refused save: its notice offers Open config file", async () => {
    settings.refuse["ui.density"] = "busy";
    await openSettings();
    await waitFor(() => expect(q('[data-ui="open-config-file"]')).not.toBeNull());
    const densities = [...document.querySelectorAll<HTMLElement>('[data-ui="density-option"]')];
    fireEvent.click(densities[densities.length - 1]!);
    const notice = await waitFor(() => {
      const el = q('[data-ui="settings-save-failed"][data-ui-key="ui.density"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const open = q('[data-ui="settings-save-failed-open-config"]', notice)!;
    expect(open.textContent).toBe("Open config file");
    fireEvent.click(open);
    await waitFor(() => expect(requests.map((r) => r.url)).toEqual(["/api/host/requests/open_config_file"]));
  });

  it("Diagnostics: the log folder's path and Show the log folder, which asks the host", async () => {
    await openSettings("diagnostics");
    await waitFor(() => expect(q('[data-ui="show-log-folder"]')).not.toBeNull());
    expect(q('[data-ui="log-folder-path"]')!.textContent).toBe("~/.local/share/argelanderspace/logs");
    expect(q('[data-ui="copy-log-path"]')).toBeNull();
    fireEvent.click(q('[data-ui="show-log-folder"]')!);
    await waitFor(() => expect(requests).toEqual([{ url: "/api/host/requests/open_log_folder", method: "POST", body: undefined }]));
  });

  it("a request the host does not take is said in a notice", async () => {
    requestStatus = 409;
    await openSettings("diagnostics");
    await waitFor(() => expect(q('[data-ui="show-log-folder"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="show-log-folder"]')!);
    await waitFor(() => expect(document.body.textContent).toContain("The desktop app did not take this request."));
  });
});

describe("the port fallback banner", () => {
  it("absent without a fallback", async () => {
    await openSettings();
    expect(q('[data-ui="port-fallback-banner"]')).toBeNull();
  });

  it("another program held the port: the CLI's links do not open this time, said with both ports", async () => {
    host = { ...DESKTOP, portFallback: { configured: 1859, actual: 40123, occupant: "other" } };
    render(<Shell />);
    // The page's language comes from the settings, which may answer after the host: wait for English.
    const banner = await waitFor(() => {
      const el = q('[data-ui="port-fallback-banner"]');
      expect(el?.textContent).toContain("Links from the CLI will not open this time");
      return el!;
    });
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("Links from the CLI will not open this time");
    expect(banner.textContent).toContain("The configured port 1859 was taken, so this run uses port 40123");
    expect(q('[data-ui="port-fallback-own"]')).toBeNull();
    // Nothing to dismiss it with.
    expect(banner.querySelector("button")).toBeNull();
  });

  it("another ArgelanderSpace held it: the banner says the links open that one", async () => {
    host = { ...DESKTOP, portFallback: { configured: 1859, actual: 40123, occupant: "argelanderspace" } };
    render(<Shell />);
    await waitFor(() =>
      expect(q('[data-ui="port-fallback-own"]')?.textContent).toBe(
        "Another ArgelanderSpace is running on port 1859; those links open it, not this window."
      )
    );
  });

  it("a browser page is never told about a fallback, even if an answer had one", async () => {
    host = { ...BROWSER, portFallback: { configured: 1859, actual: 40123, occupant: "other" } };
    render(<Shell />);
    await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
    await settled();
    expect(q('[data-ui="port-fallback-banner"]')).toBeNull();
  });
});

describe("the error boundary", () => {
  function Boom(): never {
    throw new TypeError("render failed");
  }
  beforeEach(() => {
    resetPageErrorReportingForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("the desktop app: Show the log folder beside Reload, asking the host", async () => {
    render(<PageErrorBoundary><Boom /></PageErrorBoundary>);
    const button = await waitFor(() => {
      const el = q('[data-ui="page-error-show-logs"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(button.textContent).toBe("Show the log folder");
    expect(button.previousElementSibling?.getAttribute("data-ui")).toBe("page-error-reload");
    fireEvent.click(button);
    await waitFor(() => expect(requests.map((r) => r.url)).toEqual(["/api/host/requests/open_log_folder"]));
  });

  it("a browser: Reload only", async () => {
    host = BROWSER;
    render(<PageErrorBoundary><Boom /></PageErrorBoundary>);
    await waitFor(() => expect(q('[data-ui="page-error-log-dir"]')!.getAttribute("data-state")).not.toBe("pending"));
    await settled();
    expect(q('[data-ui="page-error-reload"]')).not.toBeNull();
    expect(q('[data-ui="page-error-show-logs"]')).toBeNull();
  });
});
