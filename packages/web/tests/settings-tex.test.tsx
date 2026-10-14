/**
 * The settings page's "TeX & environment" group (desktop-app ticket 13): the TeX directory (a text setting like the
 * others) and the environment check, as the approved prototype lists it. The settings endpoint is the in-memory fake
 * (`settings-fake.ts`); the environment endpoint is a fake report here. The real server and a real browser are
 * covered elsewhere.
 */
import type { EnvironmentReport } from "@argelanderspace/contracts";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import i18n from "../src/i18n";
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
let report: EnvironmentReport;
let environmentCalls = 0;
/** Set to hold the next environment answer until released. */
let hold: Promise<void> | null = null;

const found = (tool: EnvironmentReport["tools"][number]["tool"], version: string, source: "tex_dir" | "path" | "common" = "path") => ({
  tool,
  found: true,
  source,
  path: { path: `/usr/bin/${tool}`, display: `/usr/bin/${tool}` },
  version,
  affects: [],
});

function allFound(): EnvironmentReport {
  return {
    version: 1,
    platform: "linux",
    texDir: { state: "unset", path: null },
    tools: [
      found("latexmk", "Latexmk, John Collins, version 4.83"),
      found("pdflatex", "pdfTeX 3.141592653"),
      found("xelatex", "XeTeX 3.141592653"),
      found("bibtex", "BibTeX 0.99d"),
      found("biber", "biber version: 2.19"),
      found("pdftocairo", "pdftocairo version 24.02.0"),
      found("ghostscript", "Ghostscript 10.02.1"),
      found("bwrap", "bubblewrap 0.9.0"),
    ],
    keychain: { state: "available", reason: "secret_service" },
    sandbox: "available",
  } as EnvironmentReport;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  settings = fakeSettings(EN);
  report = allFound();
  environmentCalls = 0;
  hold = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = settings.handle(input, init);
      if (answer) return answer;
      if (String(input) === "/api/environment") {
        environmentCalls += 1;
        if (hold) await hold;
        const body = structuredClone(report);
        return { ok: true, status: 200, json: async () => body } as Response;
      }
      if (String(input) === "/api/papers") return { ok: true, status: 200, json: async () => ({ papers: [] }) } as Response;
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

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const toolRow = (key: string) => q(`[data-ui="environment-tool"][data-ui-key="${key}"]`)!;

async function openTex(): Promise<void> {
  render(<Shell />);
  await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="settings"]')!);
  await waitFor(() => expect(q('[data-ui="setting-row"][data-ui-key="ui.theme"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="settings-group"][data-ui-key="tex"]')!);
  await waitFor(() => expect(q('[data-ui="environment-tool"]')).not.toBeNull());
}

describe("TeX & environment", () => {
  it("lists every program with its version and location, and the keychain; no placeholder any more", async () => {
    await openTex();
    expect(q('[data-ui="settings-group-empty"]')).toBeNull();
    expect(qa('[data-ui="setting-row"]').map((el) => el.getAttribute("data-ui-key"))).toEqual(["tex_dir"]);
    expect(qa('[data-ui="environment-tool"]').map((el) => el.getAttribute("data-ui-key"))).toEqual([
      "latexmk", "pdflatex", "xelatex", "bibtex", "biber", "pdftocairo", "ghostscript", "bwrap", "keychain",
    ]);
    expect(toolRow("latexmk").textContent).toContain("Found");
    expect(toolRow("latexmk").textContent).toContain("Latexmk, John Collins, version 4.83");
    expect(toolRow("latexmk").querySelector('[data-ui="environment-location"]')!.textContent).toBe("Location · PATH: /usr/bin/latexmk");
    expect(toolRow("pdftocairo").textContent).toContain("optional");
    expect(toolRow("keychain").textContent).toContain("Available");
    expect(q('[data-ui="env-no-tex"]')).toBeNull();
    expect(q('[data-ui="env-no-sandbox"]')).toBeNull();
    // the recheck action: an icon button with a name
    const recheck = q('[data-ui="environment-recheck"]')!;
    expect(recheck.getAttribute("aria-label")).toBe("Check again");
    expect(recheck.querySelector("svg")).not.toBeNull();
  });

  it("missing programs say what is unavailable; no TeX and no sandbox have their notes", async () => {
    report.tools = report.tools.map((t) =>
      t.tool === "latexmk"
        ? { ...t, found: false, source: null, path: null, version: null, affects: ["latex_ingest", "writer_render"] }
        : t.tool === "bwrap"
          ? { ...t, found: false, source: null, path: null, version: null, affects: ["copilot_compile"] }
          : t
    );
    report.sandbox = "unavailable";
    report.keychain = { state: "unavailable", reason: "no_service" };
    await openTex();
    expect(toolRow("latexmk").textContent).toContain("Not found");
    expect(toolRow("latexmk").querySelector('[data-ui="environment-affects"]')!.textContent).toBe(
      "Unavailable without it: LaTeX ingest, Writer rendering"
    );
    expect(toolRow("bwrap").textContent).toContain("Copilot-triggered compilation (Writer sandbox)");
    expect(q('[data-ui="env-no-tex"]')!.textContent).toContain("TeX was not found");
    expect(q('[data-ui="env-no-sandbox"]')!.textContent).toContain("Pressing Render yourself still compiles");
    expect(toolRow("keychain").textContent).toContain("Unavailable");
    expect(toolRow("keychain").textContent).toContain("No Secret Service on the session bus");
  });

  it("check again: busy while it runs, then the new answer", async () => {
    await openTex();
    const before = environmentCalls;
    let release: () => void = () => {};
    hold = new Promise((r) => {
      release = r;
    });
    report.tools = report.tools.map((t) => (t.tool === "biber" ? { ...t, found: false, source: null, path: null, version: null, affects: ["biber"] } : t));
    fireEvent.click(q('[data-ui="environment-recheck"]')!);
    await waitFor(() => expect(q('[data-ui="environment-check"]')!.getAttribute("data-state")).toBe("checking"));
    expect((q('[data-ui="environment-recheck"]') as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(toolRow("biber").getAttribute("data-found")).toBe("false"));
    expect(environmentCalls).toBe(before + 1);
    expect(q('[data-ui="environment-check"]')!.getAttribute("data-state")).toBe("done");
  });

  it("the TeX directory: a relative path is not sent; saved, the check runs again and reports what is the matter", async () => {
    await openTex();
    const field = q('[data-ui="tex-dir-input"]') as HTMLInputElement;
    expect(field.placeholder).toBe("Empty means search automatically");
    fireEvent.change(field, { target: { value: "texlive/bin" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(q('[data-ui="setting-field-error"][data-ui-key="tex_dir"]')!.textContent).toContain("Enter an absolute path.");
    expect(settings.puts).toEqual([]);
    const calls = environmentCalls;
    report.texDir = { state: "missing", path: { path: "/opt/tex/bin", display: "/opt/tex/bin" } };
    fireEvent.change(field, { target: { value: "/opt/tex/bin" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(settings.puts).toEqual([{ key: "tex_dir", body: { set: "/opt/tex/bin" } }]));
    await waitFor(() => expect(environmentCalls).toBeGreaterThan(calls));
    await waitFor(() => expect(q('[data-ui="tex-dir-problem"]')!.textContent).toContain("This directory does not exist"));
  });
});
