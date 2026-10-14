/**
 * The settings page's "Diagnostics" group and its export dialog (desktop-app ticket 14), and the log location in the
 * page's error boundary. The settings endpoint is the in-memory fake (`settings-fake.ts`); the diagnostics endpoints
 * are fakes here. The real server, the real bundle and a real browser are covered elsewhere.
 */
import type { DiagnosticsInfo } from "@argelanderspace/contracts";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
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
let settings: FakeSettings;
let diagnostics: DiagnosticsInfo | null;
let exports: unknown[];
/** The export answers 500 while set. */
let exportFails: boolean;
/** Set to hold the export answer until released. */
let exportHold: Promise<void> | null;

const JOB = "compile-failures/jobs/ingest-11111111-2222-4333-8444-555555555555.compile.log";
const MS = "compile-failures/manuscripts/m_0a1b2c3d/build/compile-failure.log";
const OLD = "compile-failures/jobs/ingest-66666666-7777-4888-8999-aaaaaaaaaaaa.compile.log";

function info(compileLogs: DiagnosticsInfo["compileLogs"] = []): DiagnosticsInfo {
  return {
    version: 1,
    logDir: { path: "/home/someone/.local/share/argelanderspace/logs", display: "~/.local/share/argelanderspace/logs" },
    logFiles: { count: 3, bytes: 4096 },
    compileLogs,
    compileLogsLimitBytes: 32 * 1024 * 1024,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  settings = fakeSettings(EN);
  diagnostics = info();
  exports = [];
  exportFails = false;
  exportHold = null;
  Reflect.deleteProperty(window, "showSaveFilePicker");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = settings.handle(input, init);
      if (answer) return answer;
      const url = String(input);
      if (url === "/api/diagnostics") {
        if (diagnostics === null) throw new TypeError("Failed to fetch");
        const body = structuredClone(diagnostics);
        return { ok: true, status: 200, json: async () => body } as Response;
      }
      if (url === "/api/diagnostics/export") {
        exports.push(JSON.parse(String(init?.body)));
        if (exportHold) await exportHold;
        if (exportFails) return new Response(JSON.stringify({ detail: "x" }), { status: 500, headers: { "Content-Type": "application/json" } });
        return new Response(new Uint8Array([0x50, 0x4b, 5, 6]), {
          status: 200,
          headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="argelanderspace-diagnostics-20261014-101112.zip"' },
        });
      }
      if (url === "/api/papers") return { ok: true, status: 200, json: async () => ({ papers: [] }) } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    })
  );
  // jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => "blob:diagnostics");
  URL.revokeObjectURL = vi.fn();
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.changeLanguage("zh-CN");
});

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

async function openDiagnostics(): Promise<void> {
  render(<Shell />);
  await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="settings"]')!);
  await waitFor(() => expect(q('[data-ui="setting-row"][data-ui-key="ui.theme"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="settings-group"][data-ui-key="diagnostics"]')!);
  await waitFor(() => expect(q('[data-ui="setting-row"][data-ui-key="log-folder"]')).not.toBeNull());
}

async function openDialog(): Promise<HTMLElement> {
  await openDiagnostics();
  fireEvent.click(q('[data-ui="export-diagnostics-open"]')!);
  await waitFor(() => expect(q('[data-ui="export-diagnostics"]')).not.toBeNull());
  return q('[data-ui="export-diagnostics"]')!;
}

describe("the Diagnostics group", () => {
  it("has the log location, the log level and the export, as in the prototype; no placeholder", async () => {
    await openDiagnostics();
    expect(q('[data-ui="settings-group-empty"]')).toBeNull();
    expect(qa('[data-ui="setting-row"]').map((el) => el.getAttribute("data-ui-key"))).toEqual(["log-folder", "log_level", "export-diagnostics"]);
    await waitFor(() => expect(q('[data-ui="log-folder-path"]')!.textContent).toBe("~/.local/share/argelanderspace/logs"));
    expect(q('[data-ui="log-folder-path"]')!.getAttribute("title")).toBe("/home/someone/.local/share/argelanderspace/logs");
    // In the browser the path is copied; showing the folder belongs to the desktop host.
    expect(q('[data-ui="copy-log-path"]')).not.toBeNull();
    expect(q('[data-ui="show-log-folder"]')).toBeNull();
    expect(q('[data-ui="export-diagnostics-open"]')!.textContent).toBe("Export diagnostics…");
  });

  it("copying the log path copies the full path", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await openDiagnostics();
    await waitFor(() => expect(q('[data-ui="copy-log-path"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="copy-log-path"]')!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/home/someone/.local/share/argelanderspace/logs"));
  });

  it("the log level is a select of the four levels; a change is one PUT of log_level", async () => {
    await openDiagnostics();
    const select = q('[data-ui="log-level-select"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["debug", "info", "warn", "error"]);
    expect(select.value).toBe("info");
    fireEvent.change(select, { target: { value: "debug" } });
    await waitFor(() => expect(settings.puts).toEqual([{ key: "log_level", body: { set: "debug" } }]));
    await waitFor(() => expect((q('[data-ui="log-level-select"]') as HTMLSelectElement).value).toBe("debug"));
  });

  it("when the location cannot be fetched, the log location says it is not known", async () => {
    diagnostics = null;
    await openDiagnostics();
    await waitFor(() => expect(q('[data-ui="log-folder-path"]')!.getAttribute("data-state")).toBe("unknown"));
    expect(q('[data-ui="copy-log-path"]')).toBeNull();
  });
});

describe("the export dialog", () => {
  it("says what the bundle holds; the compile-log box is not ticked, and names the source snippets", async () => {
    diagnostics = info([{ name: JOB, bytes: 2048, included: true }]);
    const dialog = await openDialog();
    expect(dialog.textContent).toContain("Creates a zip with the log files and a one-page environment report. Nothing is uploaded");
    const box = q('[data-ui="export-include-compile"]') as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    expect(q('[data-ui="export-include-compile-label"]')!.textContent).toBe(
      "Include the latest compile-failure logs (contains paper or manuscript source snippets)"
    );
    expect(q('[data-ui="export-compile-list"]')).toBeNull();
    // The safe action has the focus, as in the prototype.
    expect(document.activeElement).toBe(q('[data-ui="export-diagnostics-cancel"]'));
  });

  it("ticked, it lists the files that will go in and their size together; older ones over the limit are named as left out", async () => {
    diagnostics = info([
      { name: JOB, bytes: 2048, included: true },
      { name: MS, bytes: 1024, included: true },
      { name: OLD, bytes: 40 * 1024 * 1024, included: false },
    ]);
    await openDialog();
    const box = q('[data-ui="export-include-compile"]') as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(qa('[data-ui="export-compile-file"]').map((el) => el.getAttribute("data-ui-key"))).toEqual([JOB, MS]);
    expect(qa('[data-ui="export-compile-file"]')[0]!.textContent).toBe("jobs/ingest-11111111-2222-4333-8444-555555555555.compile.log2.0 KB");
    expect(q('[data-ui="export-compile-list"]')!.textContent).toContain("2 files will be added (3.0 KB together):");
    expect(q('[data-ui="export-compile-over-limit"]')!.textContent).toBe("1 older file is left out: the logs added stay within 32.0 MB and 40 files.");
  });

  it("with no compile-failure log the box cannot be ticked and says there is nothing to include", async () => {
    await openDialog();
    await waitFor(() => expect(q('[data-ui="export-no-compile-logs"]')).not.toBeNull());
    expect(q('[data-ui="export-no-compile-logs"]')!.textContent).toBe("This project has no compile-failure log to include.");
    const box = q('[data-ui="export-include-compile"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
  });

  it("Export asks for the bundle (not ticked: without compile logs), saves it, and says what was made", async () => {
    diagnostics = info([{ name: JOB, bytes: 2048, included: true }]);
    await openDialog();
    fireEvent.click(q('[data-ui="export-diagnostics-run"]')!);
    await waitFor(() => expect(q('[data-ui="export-diagnostics-result"]')).not.toBeNull());
    expect(exports).toEqual([{ includeCompileLogs: false, client: navigator.userAgent.slice(0, 512) }]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(q('[data-ui="export-diagnostics-result"]')!.textContent).toContain("Created argelanderspace-diagnostics-20261014-101112.zip (4 B).");
    expect(q('[data-ui="export-diagnostics-done"]')).not.toBeNull();
    expect(q('[data-ui="export-diagnostics-run"]')).toBeNull();
  });

  it("ticked, Export asks for the compile logs too", async () => {
    diagnostics = info([{ name: JOB, bytes: 2048, included: true }]);
    await openDialog();
    const box = q('[data-ui="export-include-compile"]') as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    fireEvent.click(q('[data-ui="export-diagnostics-run"]')!);
    await waitFor(() => expect(exports).toHaveLength(1));
    // The request names exactly what the dialog listed as going in.
    expect(exports[0]).toMatchObject({ includeCompileLogs: true, compileLogs: [JOB] });
  });

  it("while the list is being fetched the box cannot be ticked", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((ok) => (release = ok));
    const plain = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/diagnostics" && q('[data-ui="export-diagnostics"]')) await gate;
        return plain(input, init);
      })
    );
    diagnostics = info([{ name: JOB, bytes: 2048, included: true }]);
    await openDiagnostics();
    fireEvent.click(q('[data-ui="export-diagnostics-open"]')!);
    await waitFor(() => expect(q('[data-ui="export-diagnostics"]')).not.toBeNull());
    const box = q('[data-ui="export-include-compile"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    release();
    await waitFor(() => expect(box.disabled).toBe(false));
  });

  it("a failed export says so, and the keyboard goes back to Cancel", async () => {
    exportFails = true;
    await openDialog();
    fireEvent.click(q('[data-ui="export-diagnostics-run"]')!);
    await waitFor(() => expect(q('[data-ui="export-diagnostics-failed"]')).not.toBeNull());
    expect(q('[data-ui="export-diagnostics-failed"]')!.textContent).toBe("The bundle could not be created. Try again.");
    expect(document.activeElement).toBe(q('[data-ui="export-diagnostics-cancel"]'));
    expect(q('[data-ui="export-diagnostics-run"]')).not.toBeNull();
  });

  it("while exporting, the box, Cancel and the close button are not available; after it, Done has the keyboard", async () => {
    diagnostics = info([{ name: JOB, bytes: 2048, included: true }]);
    let release: () => void = () => {};
    exportHold = new Promise<void>((ok) => (release = ok));
    await openDialog();
    await waitFor(() => expect((q('[data-ui="export-include-compile"]') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(q('[data-ui="export-diagnostics-run"]')!);
    await waitFor(() => expect(exports).toHaveLength(1));
    expect((q('[data-ui="export-include-compile"]') as HTMLInputElement).disabled).toBe(true);
    expect((q('[data-ui="export-diagnostics-cancel"]') as HTMLButtonElement).disabled).toBe(true);
    const dialog = q('[data-ui="export-diagnostics"]')!;
    const close = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Close");
    expect(close?.disabled ?? true).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(q('[data-ui="export-diagnostics"]')).not.toBeNull();
    release();
    await waitFor(() => expect(q('[data-ui="export-diagnostics-done"]')).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(q('[data-ui="export-diagnostics-done"]')));
  });

  it("the object URL of a download is released afterwards", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openDialog();
      fireEvent.click(q('[data-ui="export-diagnostics-run"]')!);
      await waitFor(() => expect(q('[data-ui="export-diagnostics-result"]')).not.toBeNull());
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:diagnostics");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("saving in the system's save window (showSaveFilePicker)", () => {
  function fakePicker(behaviour: "save" | "cancel") {
    const order: string[] = [];
    const written: Blob[] = [];
    const picker = vi.fn(async (options: { suggestedName?: string }) => {
      order.push(`picker:${exports.length}`);
      if (behaviour === "cancel") throw new DOMException("The user aborted a request.", "AbortError");
      return {
        name: options.suggestedName ?? "x.zip",
        createWritable: async () => ({
          write: async (blob: Blob) => {
            order.push("write");
            written.push(blob);
          },
          close: async () => {
            order.push("close");
          },
        }),
      };
    });
    Object.defineProperty(window, "showSaveFilePicker", { value: picker, configurable: true, writable: true });
    return { picker, order, written };
  }

  it("the window opens first, in the click; then the bundle is asked for and written to the chosen file", async () => {
    const { picker, order, written } = fakePicker("save");
    await openDialog();
    fireEvent.click(q('[data-ui="export-diagnostics-run"]')!);
    // Opened in the click itself, before any request.
    expect(picker).toHaveBeenCalledTimes(1);
    expect(exports).toHaveLength(0);
    await waitFor(() => expect(q('[data-ui="export-diagnostics-result"]')).not.toBeNull());
    expect(order).toEqual(["picker:0", "write", "close"]);
    expect(picker.mock.calls[0]![0].suggestedName).toMatch(/^argelanderspace-diagnostics-\d{8}-\d{6}\.zip$/);
    expect(written[0]!.size).toBe(4);
    expect(exports).toHaveLength(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(q('[data-ui="export-diagnostics-result"]')!.textContent).toMatch(/^Saved argelanderspace-diagnostics-\d{8}-\d{6}\.zip \(4 B\) to the location you chose\.$/);
  });

  it("cancelled: nothing is asked for, nothing is said, and Export can be pressed again", async () => {
    const { picker } = fakePicker("cancel");
    await openDialog();
    fireEvent.click(q('[data-ui="export-diagnostics-run"]')!);
    await waitFor(() => expect((q('[data-ui="export-diagnostics-run"]') as HTMLButtonElement).getAttribute("aria-busy") !== "true").toBe(true));
    await new Promise((ok) => setTimeout(ok, 20));
    expect(picker).toHaveBeenCalledTimes(1);
    expect(exports).toHaveLength(0);
    expect(q('[data-ui="export-diagnostics-failed"]')).toBeNull();
    expect(q('[data-ui="export-diagnostics-result"]')).toBeNull();
    expect((q('[data-ui="export-diagnostics-run"]') as HTMLButtonElement).disabled).toBe(false);
    expect((q('[data-ui="export-diagnostics-cancel"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it("without the window, the bundle goes to the browser's downloads, said as such", async () => {
    await openDialog();
    fireEvent.click(q('[data-ui="export-diagnostics-run"]')!);
    await waitFor(() => expect(q('[data-ui="export-diagnostics-result"]')).not.toBeNull());
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(q('[data-ui="export-diagnostics-result"]')!.textContent).toContain("where it is saved follows the browser’s settings");
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

  it("shows the log location, home written as ~, as the third fact", async () => {
    render(<PageErrorBoundary><Boom /></PageErrorBoundary>);
    await waitFor(() => expect(q('[data-ui="page-error-log-dir"]')!.getAttribute("data-state")).toBe("known"));
    expect(q('[data-ui="page-error-log-dir"]')!.textContent).toBe("~/.local/share/argelanderspace/logs");
    expect([...document.querySelectorAll(".page-error-facts dt")].map((el) => el.textContent)).toEqual(["Error", "Pane", "Log location"]);
  });

  it("says the location is not known when it cannot be fetched", async () => {
    diagnostics = null;
    render(<PageErrorBoundary><Boom /></PageErrorBoundary>);
    await waitFor(() => expect(q('[data-ui="page-error-log-dir"]')!.getAttribute("data-state")).toBe("unknown"));
    expect(q('[data-ui="page-error-log-dir"]')!.textContent).toBe("not known (could not be fetched)");
  });
});
