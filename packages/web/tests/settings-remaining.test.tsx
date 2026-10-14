/**
 * The settings page's remaining groups (desktop-app ticket 11): Project, Services (the contact email), Copilot and
 * Mail entries, Advanced; restart-only keys and "still in use"; the legacy ads_dev_key notice. The settings endpoint is
 * the in-memory fake (`settings-fake.ts`); the real server and a real browser are covered elsewhere.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import i18n from "../src/i18n";
import { type FakeSettings, fakeSettings } from "./settings-fake";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
// The Copilot panel as the Shell drives it: whether it is open, and how many times its provider dialog was asked for.
vi.mock("../src/copilot/Copilot", () => ({
  Copilot: ({ open, settingsAsked }: { open: boolean; settingsAsked?: number }) => (
    <div data-ui="stub-copilot" data-open={String(open)} data-settings-asked={String(settingsAsked ?? 0)} />
  ),
}));
vi.mock("../src/plan/PlanView", () => ({ PlanView: () => <div data-ui="stub-plan" /> }));
vi.mock("../src/writer/WriterView", () => ({ WriterView: () => <div data-ui="stub-write" /> }));
vi.mock("../src/library/LibraryView", () => ({ LibraryView: () => <div data-ui="stub-library" /> }));
vi.mock("../src/doc/DocPane", () => ({ DocPane: () => <div data-ui="stub-doc" /> }));
vi.mock("../src/mail/MailView", () => ({ MailView: () => <div data-ui="stub-mail" /> }));

let settings: FakeSettings;
const EN = { "ui.language": "en" } as const;
const root = document.documentElement;
const BOOT_ATTRIBUTES = ["data-theme", "data-density", "data-accent", "data-labels", "data-ui-from", "lang", "style"];

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const name of BOOT_ATTRIBUTES) root.removeAttribute(name);
  // The tests read the page in English; a page takes its language from config.toml, so the file says so.
  settings = fakeSettings(EN);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = settings.handle(input, init);
      if (answer) return answer;
      if (String(input) === "/api/papers") return { ok: true, status: 200, json: async () => ({ papers: [] }) } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    })
  );
  window.history.replaceState(null, "", "/");
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of BOOT_ATTRIBUTES) root.removeAttribute(name);
  await i18n.changeLanguage("zh-CN");
});

const q = (selector: string, within_: ParentNode = document) => within_.querySelector<HTMLElement>(selector);
const qa = (selector: string, within_: ParentNode = document) => [...within_.querySelectorAll<HTMLElement>(selector)];
const row = (key: string) => q(`[data-ui="setting-row"][data-ui-key="${key}"]`)!;
const failed = (key: string) => q(`[data-ui="settings-save-failed"][data-ui-key="${key}"]`);

/** The Shell, with the settings page open and the settings read. */
async function open(): Promise<void> {
  render(<Shell />);
  await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="settings"]')!);
  await waitFor(() => expect(q('[data-ui="settings-page"]')).not.toBeNull());
  if (!settings.down) await waitFor(() => expect(row("ui.theme")).not.toBeNull());
}


const input = (ui: string) => q(`[data-ui="settings-page"] [data-ui="${ui}"]`) as HTMLInputElement;
async function group(key: string): Promise<void> {
  fireEvent.click(q(`[data-ui="settings-group"][data-ui-key="${key}"]`)!);
  await waitFor(() => expect(q('[data-ui="settings-group-body"]')!.getAttribute("data-group")).toBe(key));
}
function type(ui: string, text: string, key = "Enter"): void {
  const field = input(ui);
  fireEvent.change(field, { target: { value: text } });
  fireEvent.keyDown(field, { key });
}

describe("Project", () => {
  it("data_dir: the path written in the file in the field, where the process keeps its data beside it; restart needed", async () => {
    settings = fakeSettings({ ...EN, data_dir: "papers" });
    await open();
    await group("project");
    expect(qa('[data-ui="setting-row"]').map((el) => el.getAttribute("data-ui-key"))).toEqual(["project-root", "data_dir", "auto_ingest_arxiv"]);
    // The project root: shown (with ~ as the server wrote it), not stored in the file, nothing to change here.
    expect(q('[data-ui="project-root-path"]')!.textContent).toBe("~/project");
    expect(row("project-root").textContent).toContain("Not stored in the config file");
    expect(row("project-root").querySelector("input, button")).toBeNull();
    expect(input("data-dir-input").value).toBe("papers");
    expect(input("data-dir-input").getAttribute("aria-label")).toBe("Project data directory");
    expect(q('[data-ui="data-dir-in-use"]')!.textContent).toBe("In use: ~/project/literatures");
    expect(q('[data-ui="data-dir-in-use"] code')!.getAttribute("title")).toBe("/home/someone/project/literatures");
    expect(row("data_dir").textContent).toContain("Restart needed");
    expect(row("data_dir").textContent).toContain("data_dir");
  });

  it("data_dir: an absolute path is not sent and is explained under the field; Escape goes back", async () => {
    await open();
    await group("project");
    type("data-dir-input", "/abs/lit");
    expect(settings.puts).toEqual([]);
    expect(q('[data-ui="setting-field-error"][data-ui-key="data_dir"]')!.textContent).toBe("only relative paths are accepted");
    fireEvent.keyDown(input("data-dir-input"), { key: "Escape" });
    expect(input("data-dir-input").value).toBe("./literatures");
    expect(q('[data-ui="setting-field-error"]')).toBeNull();
  });

  it("data_dir changed: written, and the row says it applies after a restart and what is still in use", async () => {
    await open();
    await group("project");
    type("data-dir-input", "papers");
    await waitFor(() => expect(settings.file.data_dir).toBe("papers"));
    await waitFor(() => expect(q('[data-ui="setting-pending-restart"][data-ui-key="data_dir"]')).not.toBeNull());
    expect(q('[data-ui="setting-pending-restart"]')!.textContent).toBe("Saved; applies after restart");
    expect(q('[data-ui="setting-still-in-use"][data-ui-key="data_dir"]')!.textContent).toBe("Still in use: ~/project/literatures");
    expect(row("data_dir").textContent).not.toContain("Restart needed");
  });

  it("the automatic arXiv fetch: a switch with its name, written as the boolean key", async () => {
    await open();
    await group("project");
    const sw = q('[data-ui="auto-ingest-switch"]')!;
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-label")).toBe("Auto-ingest arXiv source when adding a work");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => expect(settings.file.auto_ingest_arxiv).toBe(false));
    await waitFor(() => expect(q('[data-ui="auto-ingest-switch"]')!.getAttribute("aria-checked")).toBe("false"));
    expect(settings.puts[settings.puts.length - 1]).toEqual({ key: "auto_ingest_arxiv", body: { set: false } });
  });
});

describe("Services: the contact email", () => {
  it("saved on Enter, cleared by restoring the default; a malformed address is not sent", async () => {
    await open();
    await group("services");
    const field = input("contact-email-input");
    expect(field.getAttribute("type")).toBe("email");
    expect(field.getAttribute("placeholder")).toBe("name@example.org");
    expect(row("contact_email").textContent).toContain("Crossref and OpenAlex");
    type("contact-email-input", "not an address");
    expect(settings.puts).toEqual([]);
    expect(q('[data-ui="setting-field-error"][data-ui-key="contact_email"]')!.textContent).toBe("not written like an email address");
    type("contact-email-input", "  reader@example.org ");
    await waitFor(() => expect(settings.file.contact_email).toBe("reader@example.org"));
    await waitFor(() => expect(row("contact_email").textContent).toContain("From file"));
    expect(q('[data-ui="setting-field-error"]')).toBeNull();
    type("contact-email-input", "");
    await waitFor(() => expect("contact_email" in settings.file).toBe(false));
    expect(settings.puts.map((p) => p.body)).toEqual([{ set: "reader@example.org" }, { reset: true }]);
    expect(input("contact-email-input").value).toBe("");
  });

  it("refused by the server: the floating alert names the key; the typed text stays", async () => {
    settings.refuse.contact_email = "busy";
    await open();
    await group("services");
    type("contact-email-input", "reader@example.org");
    await waitFor(() => expect(failed("contact_email")).not.toBeNull());
    expect(input("contact-email-input").value).toBe("reader@example.org");
  });

  it("a malformed address in the file: named as a faulty key, the field empty", async () => {
    settings = fakeSettings({ ...EN, contact_email: "x" });
    settings.problems = [{ key: "contact_email", reason: "must_be_email" }];
    await open();
    expect(q('[data-ui="config-bad-key"][data-ui-key="contact_email"]')!.textContent).toBe("contact_email · is not written like an email address");
    await group("services");
    expect(input("contact-email-input").value).toBe("");
    expect(q('[data-ui="setting-invalid"]')).not.toBeNull();
  });

  it("the legacy ads_dev_key: a notice that does not say the key stopped working", async () => {
    await open();
    await group("services");
    expect(q('[data-ui="ads-legacy-key"]')).toBeNull();
    settings.legacy = ["ads_dev_key"];
    cleanup();
    await open();
    await group("services");
    const notice = q('[data-ui="ads-legacy-key"]')!;
    expect(notice.textContent).toContain("ads_dev_key");
    expect(notice.textContent).toContain("still read");
    expect(notice.textContent).not.toMatch(/no longer has any effect/);
  });
});

describe("Copilot and Mail entries", () => {
  it("Copilot: opens the panel and asks for its provider settings dialog; not stored in the config file", async () => {
    await open();
    await group("copilot");
    expect(q('[data-ui="stub-copilot"]')!.getAttribute("data-open")).toBe("false");
    expect(row("copilot-provider").textContent).toContain("Not stored in the config file");
    fireEvent.click(q('[data-ui="open-provider-settings"]')!);
    await waitFor(() => expect(q('[data-ui="stub-copilot"]')!.getAttribute("data-open")).toBe("true"));
    expect(q('[data-ui="stub-copilot"]')!.getAttribute("data-settings-asked")).toBe("1");
  });

  it("Mail: switches the pane to Mail, where the accounts are managed", async () => {
    await open();
    await group("mail");
    expect(row("mail-accounts").textContent).toContain("Mail accounts");
    fireEvent.click(q('[data-ui="open-mail-accounts"]')!);
    await waitFor(() => expect(q('[data-ui="stub-mail"]')).not.toBeNull());
    expect(q('[data-ui="navigate-view"][data-ui-key="mail"]')!.getAttribute("aria-current")).toBe("page");
  });
});

describe("Advanced", () => {
  it("port: written as a number; out of range is not sent; after a change, the port still in use is shown", async () => {
    await open();
    await group("advanced");
    expect(row("port").textContent).toContain("Restart needed");
    type("port-input", "70000");
    expect(settings.puts).toEqual([]);
    expect(q('[data-ui="setting-field-error"][data-ui-key="port"]')!.textContent).toBe("must be a whole number from 0 to 65535");
    type("port-input", "1860");
    await waitFor(() => expect(settings.file.port).toBe(1860));
    await waitFor(() => expect(q('[data-ui="setting-still-in-use"][data-ui-key="port"]')!.textContent).toBe("Still in use: 1859"));
  });

  it("the global directories: the directory in use, shown and not editable, with the real key name", async () => {
    await open();
    await group("advanced");
    for (const [key, shown] of [["global_dir", "~/.local/share/argelanderspace"], ["global_cache_dir", "~/.cache/argelanderspace"]] as const) {
      const r = row(key);
      expect(r.querySelector("input, button[data-ui='restore-default']")).toBeNull();
      expect(q(`[data-ui="global-dir-path"][data-ui-key="${key}"]`)!.textContent).toBe(shown);
      expect(r.textContent).toContain("Editable in the file only");
      expect(r.textContent).toContain("Restart needed");
      expect(r.querySelector(".st-key")!.textContent).toBe(key);
    }
  });
});

describe("the config file's path", () => {
  it("is the server's display form (the page does not guess the home), copied whole", async () => {
    settings.snapshot = ((original) => () => ({ ...original(), path: "/srv/x/config.toml", pathDisplay: "/srv/x/config.toml" }))(settings.snapshot);
    await open();
    expect(q('[data-ui="config-file-path"]')!.textContent).toBe("/srv/x/config.toml");
    expect(q('[data-ui="open-config-file"]')).toBeNull();
  });
});
