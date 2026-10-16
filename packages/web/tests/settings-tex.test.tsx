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
/** Answers queued per call (taken in order) instead of `report`, each released by its own promise. */
let queued: { report: EnvironmentReport; until: Promise<void> }[] = [];

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
    writerSandboxTex: { state: "same", path: null, fromTexDir: false, reach: null },
  } as EnvironmentReport;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  settings = fakeSettings(EN);
  report = allFound();
  environmentCalls = 0;
  hold = null;
  queued = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = settings.handle(input, init);
      if (answer) return answer;
      if (String(input) === "/api/environment") {
        environmentCalls += 1;
        const next = queued.shift();
        if (next) {
          await next.until;
          const body = structuredClone(next.report);
          return { ok: true, status: 200, json: async () => body } as Response;
        }
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
const toolRow = (key: string) => q(`[data-ui="environment-tool"][data-ui-key="${key}"]`) as HTMLElement;

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
    expect(toolRow("bwrap").textContent).toContain("Sandboxed Writer compilation");
    expect(q('[data-ui="env-no-tex"]')!.textContent).toContain("TeX was not found");
    expect(q('[data-ui="env-no-sandbox"]')!.textContent).toContain("including the ones Copilot starts");
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

  it("a read-out table: table, row and cell roles as in the prototype", async () => {
    await openTex();
    expect(q('[data-ui="environment-check"] [role="table"]')).not.toBeNull();
    expect(toolRow("latexmk").getAttribute("role")).toBe("row");
    expect(toolRow("keychain").getAttribute("role")).toBe("row");
    expect([...toolRow("latexmk").children].map((cell) => cell.getAttribute("role"))).toEqual(["cell", "cell", "cell"]);
  });

  it("an engine missing names the other one only when that one was found", async () => {
    const missing = (t: EnvironmentReport["tools"][number]) => ({ ...t, found: false, source: null, path: null, version: null, affects: [t.tool] as never });
    report.tools = report.tools.map((t) => (t.tool === "pdflatex" ? missing(t) : t));
    await openTex();
    expect(toolRow("pdflatex").querySelector('[data-ui="environment-affects"]')!.textContent).toBe(
      "Unavailable without it: Compiling with pdflatex (xelatex is used instead)"
    );
    cleanup();
    report.tools = report.tools.map((t) => (t.tool === "xelatex" ? missing(t) : t));
    await openTex();
    expect(toolRow("pdflatex").querySelector('[data-ui="environment-affects"]')!.textContent).toBe(
      "Unavailable without it: Compiling with pdflatex"
    );
    expect(toolRow("xelatex").querySelector('[data-ui="environment-affects"]')!.textContent).toBe(
      "Unavailable without it: Compiling with xelatex"
    );
  });

  it("the Writer sandbox does not see the TeX of the directory: said; another TeX: said with its path; none without a sandbox", async () => {
    report.writerSandboxTex = { state: "not_found", path: null, fromTexDir: true, reach: "bindable" };
    await openTex();
    expect(q('[data-ui="env-sandbox-tex"]')!.textContent).toContain("Writer rendering cannot find TeX in the sandbox");
    expect(q('[data-ui="env-sandbox-tex"]')!.textContent).toContain("never falls back to compiling outside the sandbox");
    cleanup();
    report.writerSandboxTex = { state: "different", path: { path: "/usr/bin/latexmk", display: "/usr/bin/latexmk" }, fromTexDir: true, reach: "bindable" };
    await openTex();
    expect(q('[data-ui="env-sandbox-tex"]')!.textContent).toContain("Writer rendering uses another TeX in the sandbox");
    expect(q('[data-ui="env-sandbox-tex-path"]')!.textContent).toBe("/usr/bin/latexmk");
    // the system directories come first in the sandbox: no advice that PATH or a restart would change it
    expect(q('[data-ui="env-sandbox-tex-reach"]')).toBeNull();
    expect(q('[data-ui="env-sandbox-tex-why"]')!.textContent).toContain("system directories first");
    expect(q('[data-ui="env-sandbox-tex"]')!.textContent).not.toMatch(/restart|Add the directory/i);
    cleanup();
    report.sandbox = "unavailable";
    await openTex();
    expect(q('[data-ui="env-sandbox-tex"]')).toBeNull();
  });

  // ticket 13, second revision: the reason and the advice follow where that TeX is
  const reachText = () => q('[data-ui="env-sandbox-tex-reach"]')?.textContent ?? "";
  it("(tex_dir, bindable) the advice to put the directory on PATH and restart", async () => {
    report.writerSandboxTex = { state: "not_found", path: null, fromTexDir: true, reach: "bindable" };
    await openTex();
    expect(reachText()).toContain("Add the directory of this TeX to the PATH the workbench is started with");
    expect(q('[data-ui="env-sandbox-tex"]')!.textContent).toContain("/usr/bin/latexmk");
  });

  it("(1) TeX Live under /usr/local/texlive, found on PATH, no tex_dir: no PATH advice; under /usr, nothing to do here", async () => {
    report.writerSandboxTex = { state: "not_found", path: null, fromTexDir: false, reach: "under_usr" };
    await openTex();
    expect(reachText()).toContain("under /usr");
    expect(reachText()).toContain("Nothing on this page can change that");
    expect(q('[data-ui="env-sandbox-tex"]')!.textContent).not.toContain("Add the directory");
    expect(q('[data-ui="env-sandbox-tex"]')!.textContent).not.toContain("directory set above");
  });

  it("(2) TeX in the home directory or /tmp: never bound; putting it on PATH does not help", async () => {
    report.writerSandboxTex = { state: "not_found", path: null, fromTexDir: true, reach: "not_bindable" };
    await openTex();
    expect(reachText()).toContain("never put into the sandbox");
    expect(q('[data-ui="env-sandbox-tex"]')!.textContent).not.toContain("Add the directory");
  });

  it("(3)/(4) found on PATH without tex_dir: neither the not-found nor the other-TeX note speaks of a configured directory", async () => {
    report.writerSandboxTex = { state: "not_found", path: null, fromTexDir: false, reach: "bindable" };
    await openTex();
    expect(q('[data-ui="env-sandbox-tex"]')!.textContent).not.toMatch(/set above|configured/);
    expect(reachText()).toContain("already on the PATH");
    cleanup();
    report.writerSandboxTex = { state: "different", path: { path: "/usr/bin/latexmk", display: "/usr/bin/latexmk" }, fromTexDir: false, reach: "bindable" };
    await openTex();
    expect(q('[data-ui="env-sandbox-tex"]')!.textContent).not.toMatch(/set above|configured|that directory/);
    expect(q('[data-ui="env-sandbox-tex"]')!.textContent).toContain("LaTeX ingest uses the TeX the workbench found (/usr/bin/latexmk)");
  });

  it("an answer that comes after a later check's answer is dropped", async () => {
    let releaseOld: () => void = () => {};
    const old = allFound();
    old.tools = old.tools.map((t) => (t.tool === "biber" ? { ...t, version: "OLD ANSWER" } : t));
    const fresh = allFound();
    fresh.tools = fresh.tools.map((t) => (t.tool === "biber" ? { ...t, version: "NEW ANSWER" } : t));
    queued = [
      { report: old, until: new Promise((r) => { releaseOld = r; }) },
      { report: fresh, until: Promise.resolve() },
    ];
    // the group opens (check 1, held); the TeX directory is saved before it answers (check 2, answers at once)
    render(<Shell />);
    await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="settings"]')!);
    await waitFor(() => expect(q('[data-ui="setting-row"][data-ui-key="ui.theme"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="settings-group"][data-ui-key="tex"]')!);
    await waitFor(() => expect(q('[data-ui="tex-dir-input"]')).not.toBeNull());
    fireEvent.change(q('[data-ui="tex-dir-input"]')!, { target: { value: "/opt/tex/bin" } });
    fireEvent.keyDown(q('[data-ui="tex-dir-input"]')!, { key: "Enter" });
    await waitFor(() => expect(toolRow("biber")?.textContent).toContain("NEW ANSWER"));
    releaseOld();
    await new Promise((r) => setTimeout(r, 50));
    expect(environmentCalls).toBe(2);
    expect(toolRow("biber").textContent).toContain("NEW ANSWER");
    expect(toolRow("biber").textContent).not.toContain("OLD ANSWER");
  });
});
