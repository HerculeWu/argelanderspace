/**
 * The settings page and the appearance preferences (desktop-app ticket 10): the real Shell with its real navigation,
 * a stand-in for the server's settings endpoints (settings-fake.ts) and the real routing of server messages
 * (fake-ws.ts). What is looked at is what the page shows, what it asks the server for, and what `<html>` carries.
 */
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import { SAVED_NOTICE_MS } from "../src/argelander/preferences";
import i18n, { initialLanguage } from "../src/i18n";
import { fakeBus } from "./fake-ws";
import { type FakeSettings, fakeSettings } from "./settings-fake";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/copilot/Copilot", () => ({ Copilot: () => null }));
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
const option = (ui: string, key: string) => q(`[data-ui="settings-page"] [data-ui="${ui}"][data-ui-key="${key}"]`)!;
const pressed = (ui: string) => qa(`[data-ui="settings-page"] [data-ui="${ui}"][aria-pressed="true"]`).map((el) => el.getAttribute("data-ui-key"));
const failed = (key: string) => q(`[data-ui="settings-save-failed"][data-ui-key="${key}"]`);
const saved = () => q('[data-ui="toast"][data-ui-key="settings-saved"]');

/** The Shell, with the settings page open and the settings read. */
async function open(): Promise<void> {
  render(<Shell />);
  await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="settings"]')!);
  await waitFor(() => expect(q('[data-ui="settings-page"]')).not.toBeNull());
  if (!settings.down) await waitFor(() => expect(row("ui.theme")).not.toBeNull());
}

describe("the entry and the skeleton", () => {
  it("the gear at the foot of the rail opens the page in the pane, selected like a view", async () => {
    render(<Shell />);
    await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
    const rail = q('[data-ui="primary-navigation"]')!;
    const entries = qa('[data-ui="navigate-view"]', rail).map((el) => el.getAttribute("data-ui-key"));
    expect(entries).toEqual(["plan", "library", "doc", "write", "mail", "settings"]);
    const gear = q('[data-ui="navigate-view"][data-ui-key="settings"]', rail)!;
    // After the five views comes the spacer that pushes the gear to the foot.
    const children = [...rail.children];
    const at = children.findIndex((child) => child === gear || child.contains(gear));
    expect(at).toBe(children.length - 1);
    expect(children[at - 1]!.className).toBe("rail-spacer");
    // (The name is in the configured language once the settings are read.)
    await waitFor(() => expect(gear.getAttribute("aria-label")).toBe("Settings"));
    expect(gear.querySelector("svg")).not.toBeNull();
    expect(gear.textContent).toBe("");
    expect(gear.getAttribute("aria-current")).toBeNull();
    fireEvent.click(gear);
    await waitFor(() => expect(q('[data-ui="pane-content"] [data-ui="settings-page"]')).not.toBeNull());
    expect(gear.getAttribute("aria-current")).toBe("page");
    expect(gear.className).toContain("on");
    expect(q('[data-ui="navigate-view"][data-ui-key="plan"]')!.getAttribute("aria-current")).toBeNull();
  });

  it("lists the groups in the approved order (no command-line group in a browser); only Appearance has content", async () => {
    await open();
    const nav = q('[data-ui="settings-groups"]')!;
    expect(nav.tagName).toBe("NAV");
    expect(nav.getAttribute("aria-label")).toBe("Setting groups");
    const groups = qa('[data-ui="settings-group"]', nav);
    expect(groups.map((el) => el.getAttribute("data-ui-key"))).toEqual(["appearance", "project", "services", "tex", "copilot", "mail", "diagnostics", "advanced"]);
    expect(groups.map((el) => el.textContent)).toEqual(["Appearance", "Project", "Literature services & credentials", "TeX & environment", "Copilot", "Mail", "Diagnostics", "Advanced"]);
    expect(groups[0]!.getAttribute("aria-current")).toBe("page");
    expect(q('[data-ui="settings-group-body"]')!.getAttribute("data-group")).toBe("appearance");
    // "Show labels" (`ui.labels`) is not shown for now (user decision 2026-10-14); the key itself stays in the schema.
    expect(qa('[data-ui="setting-row"]').map((el) => el.getAttribute("data-ui-key"))).toEqual(["ui.language", "ui.theme", "ui.accent", "ui.density"]);
    expect(q('[data-ui="labels-switch"]')).toBeNull();

    fireEvent.click(groups[7]!);
    expect(q('[data-ui="settings-group-body"]')!.getAttribute("data-group")).toBe("advanced");
    expect(groups[7]!.getAttribute("aria-current")).toBe("page");
    expect(groups[0]!.getAttribute("aria-current")).toBeNull();
    expect(qa('[data-ui="setting-row"]')).toEqual([]);
    expect(q('[data-ui="settings-group-empty"]')!.textContent).toBe("Nothing in this group yet.");
  });

  it("shows the config file's path above every group, with a copy action that says whether it copied", async () => {
    await open();
    const file = q('[data-ui="config-file"]')!;
    expect(file.textContent).toContain("Config file");
    // Shown with the home directory as `~` (as in the prototype); copied whole.
    expect(q('[data-ui="config-file-path"]', file)!.textContent).toBe("~/.config/argelanderspace/config.toml");
    const copy = q('[data-ui="copy-config-path"]', file)!;
    expect(copy.getAttribute("aria-label")).toBe("Copy path");
    expect(copy.querySelector("svg")).not.toBeNull();

    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    fireEvent.click(copy);
    await waitFor(() => expect(qa('[data-ui="settings-notices"] [data-ui="toast"]').map((el) => el.textContent)).toEqual(["Path copied"]));
    expect(writeText).toHaveBeenCalledWith("/home/someone/.config/argelanderspace/config.toml");

    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(copy);
    await waitFor(() => expect(qa('[data-ui="settings-notices"] [data-ui="toast"]').map((el) => el.textContent)).toContain("Not copied: the browser does not allow writing to the clipboard"));
  });
});

describe("the Appearance group reads config.toml", () => {
  it("shows each key's value in effect, its key name, and whether it comes from the file", async () => {
    settings.file = { "ui.theme": "light", "ui.density": "compact", "ui.labels": false };
    await i18n.changeLanguage("zh-CN");
    await open();
    await i18n.changeLanguage("en");
    await waitFor(() => expect(q(".st-title")!.textContent).toBe("Settings"));
    expect(pressed("language-option")).toEqual(["zh-CN"]);
    expect(pressed("theme-option")).toEqual(["light"]);
    expect(pressed("accent-option")).toEqual(["azure"]);
    expect(pressed("density-option")).toEqual(["compact"]);
    expect(q('[data-ui="labels-switch"]')).toBeNull();

    expect(row("ui.theme").querySelector(".st-key")!.textContent).toBe("ui.theme");
    expect(row("ui.theme").querySelector(".st-label span")!.textContent).toBe("Theme");
    const badge = (key: string) => row(key).querySelector(".st-badges")!.textContent;
    expect(badge("ui.theme")).toBe("From file");
    expect(badge("ui.density")).toBe("From file");
    expect(badge("ui.language")).toBe("Default");
    expect(badge("ui.accent")).toBe("Default");
    // Restoring the default is offered where the file sets the key, and the slot for it is there in every row.
    expect(qa('[data-ui="restore-default"]').map((el) => el.getAttribute("data-ui-key"))).toEqual(["ui.theme", "ui.density"]);
    expect(qa(".st-restore-slot")).toHaveLength(4);
    expect(q('[data-ui="restore-default"][data-ui-key="ui.theme"]')!.getAttribute("aria-label")).toBe("Restore default: ui.theme");

    // The page itself has the configured appearance; `ui.labels` is still read and put on <html>.
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(root.getAttribute("data-density")).toBe("compact");
    expect(root.getAttribute("data-labels")).toBe("false");
  });

  it("every control has its name: groups are labelled, options say what they are", async () => {
    await open();
    for (const [key, label] of [["ui.language", "Language"], ["ui.theme", "Theme"], ["ui.accent", "Accent"], ["ui.density", "Density"]] as const) {
      expect(row(key).querySelector('[role="group"]')!.getAttribute("aria-label")).toBe(label);
    }
    expect(qa('[data-ui="settings-page"] [data-ui="language-option"]').map((el) => el.textContent)).toEqual(["中文", "English"]);
    expect(qa('[data-ui="settings-page"] [data-ui="theme-option"]').map((el) => el.textContent)).toEqual(["Dark", "Light"]);
    expect(qa('[data-ui="settings-page"] [data-ui="density-option"]').map((el) => el.textContent)).toEqual(["Compact", "Regular", "Comfy"]);
    const accents = qa('[data-ui="settings-page"] [data-ui="accent-option"]');
    expect(accents.map((el) => el.getAttribute("data-ui-key"))).toEqual(["azure", "teal", "violet", "amber", "neutral"]);
    expect(accents.map((el) => el.getAttribute("aria-label"))).toEqual(["Deep space blue", "Teal", "Violet", "Warm amber", "Neutral"]);
    expect(accents.map((el) => el.textContent)).toEqual(["", "", "", "", ""]);
  });
});

describe("a change is one key of config.toml and takes effect at once", () => {
  it("theme: the page turns light, the key is written, the row says it comes from the file, and a notice floats at the foot", async () => {
    await open();
    expect(root.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(option("theme-option", "light"));
    // At once, before the server has answered.
    expect(pressed("theme-option")).toEqual(["light"]);
    await waitFor(() => expect(root.getAttribute("data-theme")).toBe("light"));
    await waitFor(() => expect(settings.file).toEqual({ ...EN, "ui.theme": "light" }));
    expect(settings.puts).toEqual([{ key: "ui.theme", body: { set: "light" } }]);
    await waitFor(() => expect(row("ui.theme").querySelector(".st-badges")!.textContent).toBe("From file"));

    // The acknowledgement is not in the row: it is the one floating notice.
    await waitFor(() => expect(saved()).not.toBeNull());
    const notice = saved()!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe("Written to the config file");
    expect(notice.closest('[data-ui="settings-notices"]')).not.toBeNull();
    expect(notice.closest('[data-ui="settings-page"]')).toBeNull();
    expect(row("ui.theme").textContent).not.toContain("Written");

    // Restore default: the line is removed and the default is back.
    fireEvent.click(q('[data-ui="restore-default"][data-ui-key="ui.theme"]')!);
    await waitFor(() => expect(settings.file).toEqual(EN));
    expect(settings.puts[1]).toEqual({ key: "ui.theme", body: { reset: true } });
    await waitFor(() => expect(root.getAttribute("data-theme")).toBe("dark"));
    await waitFor(() => expect(row("ui.theme").querySelector(".st-badges")!.textContent).toBe("Default"));
    expect(q('[data-ui="restore-default"][data-ui-key="ui.theme"]')).toBeNull();
    // Repeated saves leave one notice.
    expect(qa('[data-ui="toast"][data-ui-key="settings-saved"]')).toHaveLength(1);
  });

  it("the written notice goes away by itself", async () => {
    await open();
    fireEvent.click(option("density-option", "comfy"));
    await waitFor(() => expect(saved()).not.toBeNull());
    await waitFor(() => expect(saved()).toBeNull(), { timeout: SAVED_NOTICE_MS + 2000 });
  });

  it("language: the page's text changes at once and <html lang> follows", async () => {
    await open();
    expect(q(".st-title")!.textContent).toBe("Settings");
    expect(root.lang).toBe("en");
    fireEvent.click(option("language-option", "zh-CN"));
    await waitFor(() => expect(root.lang).toBe("zh-CN"));
    await waitFor(() => expect(q(".st-title")!.textContent).toBe("设置"));
    expect(q('[data-ui="navigate-view"][data-ui-key="settings"]')!.getAttribute("aria-label")).toBe("设置");
    expect(qa('[data-ui="settings-group"]').map((el) => el.textContent).slice(0, 2)).toEqual(["外观", "项目"]);
    await waitFor(() => expect(settings.file).toEqual({ "ui.language": "zh-CN" }));

    fireEvent.click(option("language-option", "en"));
    await waitFor(() => expect(root.lang).toBe("en"));
    await waitFor(() => expect(q(".st-title")!.textContent).toBe("Settings"));
    await waitFor(() => expect(settings.file).toEqual({ "ui.language": "en" }));
    expect(i18n.language).toBe("en");
  });

  it("accent and density each write their key and show on <html>", async () => {
    await open();
    fireEvent.click(option("accent-option", "teal"));
    await waitFor(() => expect(root.style.getPropertyValue("--accent-h")).toBe("178"));
    expect(root.getAttribute("data-accent")).toBe("teal");
    fireEvent.click(option("density-option", "comfy"));
    await waitFor(() => expect(root.getAttribute("data-density")).toBe("comfy"));
    await waitFor(() => expect(settings.file).toEqual({ ...EN, "ui.accent": "teal", "ui.density": "comfy" }));
    expect(settings.puts).toEqual([
      { key: "ui.accent", body: { set: "teal" } },
      { key: "ui.density", body: { set: "comfy" } },
    ]);
    await waitFor(() => expect(pressed("accent-option")).toEqual(["teal"]));
    expect(pressed("density-option")).toEqual(["comfy"]);
  });

  it("the title bar's theme toggle and the quick appearance popover write the same keys", async () => {
    await open();
    fireEvent.click(q('[data-ui="toggle-theme"]')!);
    await waitFor(() => expect(settings.file).toEqual({ ...EN, "ui.theme": "light" }));
    expect(pressed("theme-option")).toEqual(["light"]);
    // The "written" notice is the settings page's own: a change made elsewhere does not raise it.
    await new Promise((r) => setTimeout(r, 30));
    expect(saved()).toBeNull();
    fireEvent.click(q('[data-ui="open-tweaks"]')!);
    expect(q('[data-ui="open-tweaks"]')!.getAttribute("aria-label")).toBe("Quick appearance");
    const popover = q('[data-ui="tweaks-popover"]')!;
    fireEvent.click(q('[data-ui="density-option"][data-ui-key="compact"]', popover)!);
    await waitFor(() => expect(settings.file).toEqual({ ...EN, "ui.theme": "light", "ui.density": "compact" }));
    await waitFor(() => expect(pressed("density-option")).toEqual(["compact"]));
  });
});

describe("a faulty config.toml", () => {
  it("faulty keys: a banner names each key and its reason and never a value; the group and the row are marked", async () => {
    settings.file = { ...EN, "ui.density": "zqxmarkVALUE", port: 70000, "ui.theme": "light" };
    settings.problems = [
      { key: "port", reason: "out_of_range" },
      { key: "ui.density", reason: "not_one_of" },
    ];
    await open();
    const banner = q('[data-ui="config-bad-keys"]')!;
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.querySelector("strong")!.textContent).toBe("2 keys in the config file are wrong; defaults are used");
    expect(qa('[data-ui="config-bad-key"]', banner).map((el) => [el.getAttribute("data-ui-key"), el.textContent])).toEqual([
      ["port", "port · out of range"],
      ["ui.density", "ui.density · not one of the allowed values"],
    ]);
    expect(document.body.textContent).not.toContain("zqxmarkVALUE");
    expect(document.body.textContent).not.toContain("70000");

    // The count sits on the group that has the key; the accessible name says it.
    const group = (key: string) => q(`[data-ui="settings-group"][data-ui-key="${key}"]`)!;
    expect(group("appearance").querySelector(".st-nav-count")!.textContent).toBe("1");
    expect(group("appearance").getAttribute("aria-label")).toBe("Appearance (1 keys with problems)");
    expect(group("advanced").querySelector(".st-nav-count")!.textContent).toBe("1");
    expect(group("project").querySelector(".st-nav-count")).toBeNull();

    // The row: marked invalid, the default in effect, and it can be put right from the page.
    const invalid = q('[data-ui="setting-invalid"]', row("ui.density"))!;
    expect(invalid.textContent).toBe("Invalid value in the file; default used");
    expect(pressed("density-option")).toEqual(["regular"]);
    expect(q('[data-ui="setting-invalid"]', row("ui.theme"))).toBeNull();
    expect(option("density-option", "comfy").hasAttribute("disabled")).toBe(false);
    fireEvent.click(q('[data-ui="restore-default"][data-ui-key="ui.density"]')!);
    await waitFor(() => expect(q('[data-ui="setting-invalid"]', row("ui.density"))).toBeNull());
    expect(q('[data-ui="config-bad-keys"] strong')!.textContent).toBe("1 key in the config file is wrong; its default is used");
  });

  it("a [ui] that is not a table counts against the group whose keys it holds", async () => {
    settings.problems = [{ key: "ui", reason: "not_a_table" }];
    await open();
    expect(q('[data-ui="config-bad-key"]')!.textContent).toBe("ui · must be a table but is written as a plain value");
    expect(q('[data-ui="settings-group"][data-ui-key="appearance"] .st-nav-count')!.textContent).toBe("1");
  });

  it.each([
    ["unparseable", "config-unparseable", "The config file cannot be parsed; settings are read-only for now"],
    ["unreadable", "config-unreadable", "The config file cannot be read; settings are read-only for now"],
  ] as const)("a file that is %s: the whole page is read-only and says why", async (state, ui, title) => {
    settings.file = { ...EN, "ui.theme": "light" };
    settings.state = state;
    // Nothing is taken from such a file, the language included: the page is in the default language.
    await open();
    await i18n.changeLanguage("en");
    await waitFor(() => expect(q(".st-title")!.textContent).toBe("Settings"));
    const banner = q(`[data-ui="${ui}"]`)!;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.querySelector("strong")!.textContent).toBe(title);
    expect(banner.textContent).toContain("The page does not rewrite this file");
    // What it says is true of this page: no promise about parts of the workbench that do not exist yet.
    expect(banner.textContent).not.toMatch(/credential|command-line|diagnostic/i);
    expect(q('[data-ui="config-bad-keys"]')).toBeNull();
    // Every default, nothing can be changed, nothing can be restored.
    expect(pressed("theme-option")).toEqual(["dark"]);
    const controls = qa('[data-ui="setting-row"] button');
    expect(controls.length).toBe(12);
    for (const control of controls) expect(control.hasAttribute("disabled")).toBe(true);
    expect(qa('[data-ui="restore-default"]')).toEqual([]);
    expect(qa('[data-ui="setting-unsafe"]')).toEqual([]);
    fireEvent.click(option("theme-option", "light"));
    fireEvent.click(option("accent-option", "teal"));
    await new Promise((r) => setTimeout(r, 30));
    expect(settings.puts).toEqual([]);
    // The path is still there to go and repair the file.
    expect(q('[data-ui="config-file-path"]')).not.toBeNull();
  });

  it("a key the page cannot change safely: its control is off and the row says to edit the file, with the path", async () => {
    settings.file = { ...EN, "ui.theme": "light" };
    settings.uneditable = { "ui.theme": "dotted_key", "ui.accent": "busy" };
    await open();
    for (const el of qa('[data-ui="theme-option"]', row("ui.theme"))) expect(el.hasAttribute("disabled")).toBe(true);
    expect(q('[data-ui="restore-default"][data-ui-key="ui.theme"]')).toBeNull();
    const message = q('[data-ui="setting-unsafe"]', row("ui.theme"))!;
    expect(message.querySelector("strong")!.textContent).toBe("The page cannot safely change ui.theme");
    expect(message.textContent).toContain("In the file it, or its table, is written with a dotted key. Edit the config file directly; the page will not touch that line.");
    expect(q('[data-ui="config-file-path"]', message)!.textContent).toBe("~/.config/argelanderspace/config.toml");
    expect(q('[data-ui="copy-config-path"]', message)).not.toBeNull();
    // A reason without a sentence of its own still says to edit the file.
    expect(q('[data-ui="setting-unsafe"]', row("ui.accent"))!.textContent).toContain("The page cannot safely change this key right now. Edit the config file directly");
    // The other rows are as usual.
    expect(option("density-option", "comfy").hasAttribute("disabled")).toBe(false);
    expect(q('[data-ui="setting-unsafe"]', row("ui.density"))).toBeNull();
    fireEvent.click(option("theme-option", "dark"));
    await new Promise((r) => setTimeout(r, 30));
    expect(settings.puts).toEqual([]);
  });
});

describe("a change that was not made", () => {
  it("is explained by a floating alert that names the key and stays; the control goes back and the row stays as it was", async () => {
    settings.refuse = { "ui.accent": "dotted_key" };
    await open();
    const before = row("ui.accent").querySelector(".st-row-main")!.textContent;
    fireEvent.click(option("accent-option", "teal"));
    await waitFor(() => expect(failed("ui.accent")).not.toBeNull());
    const alert = failed("ui.accent")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.closest('[data-ui="settings-notices"]')).not.toBeNull();
    expect(alert.closest('[data-ui="settings-page"]')).toBeNull();
    expect(alert.querySelector("strong")!.textContent).toBe("ui.accent was not saved");
    expect(alert.textContent).toContain("In the file it, or its table, is written with a dotted key. The file was not modified; edit it directly.");
    expect(saved()).toBeNull();
    // The value is what the file has, the row carries no error and no "from file".
    await waitFor(() => expect(pressed("accent-option")).toEqual(["azure"]));
    expect(row("ui.accent").querySelector(".st-row-main")!.textContent).toBe(before);
    expect(q('[data-ui="restore-default"][data-ui-key="ui.accent"]')).toBeNull();
    expect(settings.file).toEqual(EN);
    expect(root.getAttribute("data-accent")).toBe("azure");

    // It does not go away by itself.
    await new Promise((r) => setTimeout(r, SAVED_NOTICE_MS + 400));
    expect(failed("ui.accent")).not.toBeNull();

    // Another key that fails has its own; the same key failing again does not stack.
    settings.refuse["ui.density"] = "busy";
    fireEvent.click(option("density-option", "comfy"));
    await waitFor(() => expect(failed("ui.density")).not.toBeNull());
    expect(failed("ui.density")!.textContent).toContain("Another program is changing the config file. The file was not modified; try again.");
    fireEvent.click(option("accent-option", "teal"));
    await waitFor(() => expect(settings.puts.filter((put) => put.key === "ui.accent")).toHaveLength(2));
    await waitFor(() => expect(qa('[data-ui="settings-save-failed"]').map((el) => el.getAttribute("data-ui-key")).sort()).toEqual(["ui.accent", "ui.density"]));

    // Dismissed by its own button…
    const dismiss = within(failed("ui.density")!).getByRole("button", { name: "Dismiss" });
    expect(dismiss.getAttribute("data-ui")).toBe("settings-save-failed-dismiss");
    fireEvent.click(dismiss);
    expect(failed("ui.density")).toBeNull();
    // …or taken away when the same key is saved after all.
    settings.refuse = {};
    fireEvent.click(option("accent-option", "teal"));
    await waitFor(() => expect(failed("ui.accent")).toBeNull());
    expect(settings.file).toEqual({ ...EN, "ui.accent": "teal" });
  }, 15_000);

  it.each([
    ["not_writable", "The config file or its folder does not allow writing. The file was not modified."],
    ["write_failed", "The config file could not be written. The file was not modified."],
    ["unparseable", "The config file cannot be parsed right now. The file was not modified; try again once it is fixed."],
    ["invalid_value", "This value is not accepted. The file was not modified."],
    ["self_check_failed", "The page's trial edit did not check out, so it left the file alone. The file was not modified; edit it directly."],
  ] as const)("says why for %s", async (reason, text) => {
    settings.refuse = { "ui.theme": reason };
    await open();
    fireEvent.click(option("theme-option", "light"));
    await waitFor(() => expect(failed("ui.theme")).not.toBeNull());
    expect(failed("ui.theme")!.getAttribute("data-reason")).toBe(reason);
    expect(failed("ui.theme")!.querySelector(".ag-toast-text")!.textContent).toBe(`ui.theme was not saved${text}`);
    await waitFor(() => expect(root.getAttribute("data-theme")).toBe("dark"));
  });

  it("no answer from the server: said as such, and the appearance goes back", async () => {
    await open();
    settings.down = true;
    fireEvent.click(option("theme-option", "light"));
    await waitFor(() => expect(failed("ui.theme")).not.toBeNull());
    expect(failed("ui.theme")!.textContent).toContain("The workbench service did not answer");
    expect(failed("ui.theme")!.textContent).not.toContain("was not modified");
    await waitFor(() => expect(root.getAttribute("data-theme")).toBe("dark"));
    // The page now knows it cannot read the settings either.
    await waitFor(() => expect(q('[data-ui="settings-unreachable"]')).not.toBeNull());
    expect(option("theme-option", "light").hasAttribute("disabled")).toBe(true);
  });
});

describe("the page reads again when the server says the file changed", () => {
  it("an edit made outside the page shows without a reload: the values, the sources and the page's own look", async () => {
    await open();
    const reads = settings.gets;
    settings.file = { "ui.theme": "light", "ui.language": "zh-CN", "ui.accent": "violet" };
    fakeBus.emit("settings.changed", { cause: "external", at: "2026-10-14T00:00:00.000Z" });
    await waitFor(() => expect(root.getAttribute("data-theme")).toBe("light"));
    expect(settings.gets).toBe(reads + 1);
    await waitFor(() => expect(q(".st-title")!.textContent).toBe("设置"));
    expect(root.lang).toBe("zh-CN");
    expect(pressed("theme-option")).toEqual(["light"]);
    expect(pressed("accent-option")).toEqual(["violet"]);
    expect(row("ui.theme").querySelector(".st-badges")!.textContent).toBe("来自文件");
    expect(row("ui.density").querySelector(".st-badges")!.textContent).toBe("默认值");
    // No save happened, so nothing is announced.
    expect(saved()).toBeNull();
    expect(settings.puts).toEqual([]);
  });

  it("the file becoming unparseable, and being repaired, both show", async () => {
    settings.file = { ...EN, "ui.theme": "light" };
    await open();
    settings.state = "unparseable";
    fakeBus.emit("settings.changed", { cause: "external", at: "2026-10-14T00:00:00.000Z" });
    await waitFor(() => expect(q('[data-ui="config-unparseable"]')).not.toBeNull());
    await waitFor(() => expect(root.getAttribute("data-theme")).toBe("dark"));
    settings.state = "read";
    fakeBus.emit("settings.changed", { cause: "external", at: "2026-10-14T00:00:01.000Z" });
    await waitFor(() => expect(q('[data-ui="config-unparseable"]')).toBeNull());
    await waitFor(() => expect(root.getAttribute("data-theme")).toBe("light"));
    expect(option("theme-option", "dark").hasAttribute("disabled")).toBe(false);
  });

  it("a reconnect reads again too: a change may have been missed", async () => {
    await open();
    settings.file = { ...EN, "ui.density": "compact" };
    fakeBus.emit("hello", { jobs: [] });
    await waitFor(() => expect(root.getAttribute("data-density")).toBe("compact"));
  });
});

describe("the browser's own storage is not the authority", () => {
  it("where the browser's copy and config.toml differ, the page takes config.toml and corrects the copy", async () => {
    window.localStorage.setItem("argelander.ui", JSON.stringify({ theme: "light", accent: "amber", density: "comfy", labels: false, language: "zh-CN" }));
    settings.file = { "ui.theme": "dark", "ui.density": "compact" };
    await i18n.changeLanguage("zh-CN");
    await open();
    await waitFor(() => expect(root.getAttribute("data-theme")).toBe("dark"));
    expect(root.getAttribute("data-density")).toBe("compact");
    expect(root.getAttribute("data-accent")).toBe("azure");
    expect(root.lang).toBe("zh-CN");
    expect(pressed("theme-option")).toEqual(["dark"]);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem("argelander.ui")!)).toEqual({ theme: "dark", accent: "azure", density: "compact", labels: true, language: "zh-CN" }));
  });

  it("with the browser's storage emptied, a page opened again still has what config.toml says", async () => {
    settings.file = { "ui.theme": "light", "ui.accent": "teal", "ui.language": "en" };
    await open();
    await waitFor(() => expect(root.getAttribute("data-theme")).toBe("light"));
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
    for (const name of BOOT_ATTRIBUTES) root.removeAttribute(name);
    await open();
    await waitFor(() => expect(root.getAttribute("data-theme")).toBe("light"));
    expect(root.getAttribute("data-accent")).toBe("teal");
    expect(pressed("theme-option")).toEqual(["light"]);
    expect(pressed("accent-option")).toEqual(["teal"]);
  });

  it("what an older version stored in the browser is neither used nor moved into config.toml", async () => {
    window.localStorage.setItem("argelander.tweaks", JSON.stringify({ theme: "light", accent: "amber", density: "comfy", labels: false, language: "en" }));
    settings.file = {};
    await i18n.changeLanguage("zh-CN");
    expect(initialLanguage()).toBe("zh-CN");
    render(<Shell />);
    // From the first render on: the old store plays no part.
    expect(root.getAttribute("data-theme")).toBe("dark");
    await waitFor(() => expect(settings.gets).toBeGreaterThan(0));
    await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-density")).toBe("regular");
    expect(settings.puts).toEqual([]);
    expect(settings.file).toEqual({});
    // It is left where it was.
    expect(JSON.parse(window.localStorage.getItem("argelander.tweaks")!).theme).toBe("light");
  });

  it("the page starts from what the server put on <html>, before any answer and whatever the browser stored", async () => {
    window.localStorage.setItem("argelander.ui", JSON.stringify({ theme: "dark", accent: "amber", density: "regular", labels: true, language: "zh-CN" }));
    root.setAttribute("data-ui-from", "config");
    root.setAttribute("data-theme", "light");
    root.setAttribute("data-density", "comfy");
    root.setAttribute("data-accent", "teal");
    root.setAttribute("data-labels", "false");
    root.lang = "en";
    expect(initialLanguage()).toBe("en");
    settings.down = true;
    render(<Shell />);
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(root.getAttribute("data-density")).toBe("comfy");
    expect(root.style.getPropertyValue("--accent-h")).toBe("178");
    expect(root.lang).toBe("en");
    await waitFor(() => expect(settings.gets).toBeGreaterThan(0));
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("with no answer and nothing on <html>, the settings page says it cannot read the settings", async () => {
    settings.down = true;
    await open();
    await i18n.changeLanguage("en");
    await waitFor(() => expect(q('[data-ui="settings-unreachable"]')).not.toBeNull());
    expect(q('[data-ui="settings-unreachable"]')!.getAttribute("role")).toBe("alert");
    expect(qa('[data-ui="setting-row"]')).toEqual([]);
    expect(q('[data-ui="settings-loading"]')).toBeNull();
    // It recovers when the server is back and says so.
    settings.down = false;
    fakeBus.emit("hello", { jobs: [] });
    await waitFor(() => expect(row("ui.theme")).not.toBeNull());
    expect(q('[data-ui="settings-unreachable"]')).toBeNull();
  });
});

describe("the workbench's banner for a faulty config.toml", () => {
  const banner = () => q('[data-ui="config-problems-banner"]');
  const fine = { source: "default" as const, problem: null };
  const startup = (over: Partial<NonNullable<FakeSettings["startup"]>> = {}): FakeSettings["startup"] => ({ data_dir: fine, global_dir: fine, global_cache_dir: fine, ...over });

  it("a faulty key that is not about data: a quiet line above every view, naming the key and never a value", async () => {
    settings.file = { ...EN, "ui.theme": "light" };
    settings.problems = [{ key: "ui.theme", reason: "wrong_type" }];
    settings.startup = startup();
    render(<Shell />);
    await waitFor(() => expect(banner()).not.toBeNull());
    const b = banner()!;
    expect(b.getAttribute("data-severity")).toBe("keys");
    expect(b.getAttribute("role")).toBe("status");
    expect(b.textContent).toContain("1 key in config.toml is faulty and has its default: ui.theme");
    expect(b.textContent).not.toContain("light");
    // Between the title bar and the workspace, whatever the view.
    expect(b.previousElementSibling?.getAttribute("data-ui")).toBe("app-titlebar");
    expect(b.nextElementSibling?.getAttribute("data-ui")).toBe("app-workspace");
    fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="library"]')!);
    await waitFor(() => expect(q('[data-ui="stub-library"]')).not.toBeNull());
    expect(banner()).not.toBeNull();
    // Nothing hides it but repairing the file; its one control opens the settings page.
    expect(qa("button", banner()!).map((el) => el.getAttribute("data-ui"))).toEqual(["config-problems-open-settings"]);
    fireEvent.click(q('[data-ui="config-problems-open-settings"]')!);
    await waitFor(() => expect(q('[data-ui="settings-page"]')).not.toBeNull());
    expect(banner()).not.toBeNull();
    settings.problems = [];
    fakeBus.emit("settings.changed", { cause: "external", at: "2026-10-14T00:00:00.000Z" });
    await waitFor(() => expect(banner()).toBeNull());
  });

  it("project data in the default location since the start: a warning that says so, with the restart", async () => {
    settings.problems = [{ key: "data_dir", reason: "must_be_relative" }];
    settings.startup = startup({ data_dir: { source: "default", problem: "must_be_relative" } });
    render(<Shell />);
    await waitFor(() => expect(banner()?.getAttribute("data-severity")).toBe("data-location"));
    expect(banner()!.getAttribute("role")).toBe("alert");
    await waitFor(() => expect(banner()!.textContent).toContain("Project data is in the default location, not the one config.toml names"));
    expect(banner()!.textContent).toContain("Faulty when the workbench started: data_dir.");
    expect(banner()!.textContent).toContain("Restart the workbench");
    expect(banner()!.textContent).not.toContain("global");
    // No sentence starts with a stray space.
    expect(q('[data-ui="config-problems-location"]')!.textContent).not.toMatch(/^\s|\s{2}/);
  });

  it("repaired while running: the warning stays, because the process is on the default location until a restart", async () => {
    settings.problems = [];
    settings.startup = startup({ data_dir: { source: "default", problem: "must_be_relative" } });
    render(<Shell />);
    await waitFor(() => expect(banner()?.getAttribute("data-severity")).toBe("data-location"));
    expect(banner()!.textContent).toContain("Restart the workbench");
    expect(q('[data-ui="config-problems-now"]')).toBeNull();
  });

  it("(a) a file that broke while running: only the quiet line, the data stays where it was", async () => {
    settings.state = "unparseable";
    settings.startup = startup({ data_dir: { source: "file", problem: null } });
    render(<Shell />);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()!.getAttribute("data-severity")).toBe("keys");
    expect(q('[data-ui="config-problems-location"]')).toBeNull();
    await waitFor(() => expect(banner()!.textContent).toContain("正在运行的工作台仍用启动时的设置"));
    expect(banner()!.textContent).not.toContain("默认位置");
  });

  it("(b) data_dir faulty but --data-dir given: says the command line's location is in use, no default, no restart", async () => {
    settings.problems = [{ key: "data_dir", reason: "must_be_relative" }];
    settings.startup = startup({ data_dir: { source: "flag", problem: "must_be_relative" } });
    render(<Shell />);
    await waitFor(() => expect(banner()?.textContent).toContain("data_dir in config.toml is not valid; project data is in the location given by --data-dir."));
    expect(banner()!.getAttribute("data-severity")).toBe("keys");
    expect(banner()!.textContent).not.toMatch(/default|Restart/);
  });

  it("(c) a global directory on its default: the warning names the global directories, not project data", async () => {
    settings.problems = [{ key: "global_dir", reason: "must_be_absolute" }];
    settings.startup = startup({ global_dir: { source: "default", problem: "must_be_absolute" } });
    render(<Shell />);
    await waitFor(() => expect(banner()?.textContent).toContain("The global directories (Mail, credentials, log) are the default ones"));
    expect(banner()!.getAttribute("data-severity")).toBe("data-location");
    expect(banner()!.textContent).not.toContain("Project data");
    expect(banner()!.textContent).toContain("Faulty when the workbench started: global_dir.");
    // The key is not repeated in the quiet line.
    expect(q('[data-ui="config-problems-now"]')).toBeNull();
  });

  it("a whole file unparseable at the start: both kinds of location, and the file now", async () => {
    settings.state = "unparseable";
    const broken = { source: "default" as const, problem: "unparseable" as const };
    settings.startup = startup({ data_dir: broken, global_dir: broken, global_cache_dir: broken });
    render(<Shell />);
    await waitFor(() => expect(banner()?.textContent).toContain("项目数据和全局目录（邮件、凭据、日志）现在都用默认位置"));
    expect(banner()!.textContent).toContain("启动时配置文件无法解析或读不了。");
    expect(banner()!.textContent).toContain("配置文件现在无法解析或读不了，设置页只读");
  });

  it("is not there while the file is fine", async () => {
    settings.startup = startup();
    render(<Shell />);
    await waitFor(() => expect(settings.gets).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));
    expect(banner()).toBeNull();
  });
});

describe("the hidden labels key, when the file has it wrong", () => {
  it("shows a row with only a note and the restore action, which resets the key", async () => {
    settings.file = { ...EN, "ui.labels": "yes" as never };
    settings.problems = [{ key: "ui.labels", reason: "wrong_type" }];
    await open();
    const r = row("ui.labels");
    expect(q('[data-ui="labels-switch"]')).toBeNull();
    expect(q('[data-ui="labels-hidden-note"]', r)).not.toBeNull();
    fireEvent.click(q('[data-ui="restore-default"][data-ui-key="ui.labels"]', r)!);
    await waitFor(() => expect(settings.puts).toEqual([{ key: "ui.labels", body: { reset: true } }]));
    await waitFor(() => expect(q('[data-ui="setting-row"][data-ui-key="ui.labels"]')).toBeNull());
  });
});

describe("changes of one key in quick succession", () => {
  it("the file ends with the last click, even when the writes would finish out of order", async () => {
    await open();
    // Were the three sent at once, the first would reach the file last.
    settings.writeDelays = [120, 10, 40];
    fireEvent.click(option("theme-option", "light"));
    fireEvent.click(option("theme-option", "dark"));
    fireEvent.click(option("theme-option", "light"));
    expect(pressed("theme-option")).toEqual(["light"]);
    await new Promise((r) => setTimeout(r, 400));
    expect(settings.file["ui.theme"]).toBe("light");
    expect(pressed("theme-option")).toEqual(["light"]);
    expect(root.getAttribute("data-theme")).toBe("light");
    // The one in between was never sent: only the first and the last.
    expect(settings.puts.map((put) => put.body)).toEqual([{ set: "light" }, { set: "light" }]);
  });

  it("while a change is on its way, a settings answer does not move the control back", async () => {
    await open();
    settings.writeDelays = [250];
    fireEvent.click(option("theme-option", "light"));
    // The file still says dark: a read now answers dark.
    const reads = settings.gets;
    fakeBus.emit("settings.changed", { cause: "external", at: "2026-10-14T00:00:00.000Z" });
    await waitFor(() => expect(settings.gets).toBe(reads + 1));
    await new Promise((r) => setTimeout(r, 60));
    expect(pressed("theme-option")).toEqual(["light"]);
    expect(root.getAttribute("data-theme")).toBe("light");
    await waitFor(() => expect(settings.file["ui.theme"]).toBe("light"));
    await new Promise((r) => setTimeout(r, 30));
    expect(pressed("theme-option")).toEqual(["light"]);
  });

  it("a read that left before a change and answers after it is dropped", async () => {
    await open();
    // A read leaves now (the file says dark) and answers late.
    settings.getDelays = [200];
    fakeBus.emit("settings.changed", { cause: "external", at: "2026-10-14T00:00:00.000Z" });
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(option("theme-option", "light"));
    await waitFor(() => expect(settings.file["ui.theme"]).toBe("light"));
    await new Promise((r) => setTimeout(r, 300));
    expect(pressed("theme-option")).toEqual(["light"]);
    expect(root.getAttribute("data-theme")).toBe("light");
  });
});

describe("before and without an answer", () => {
  it("the browser's copy is checked before it is used: a value that is none of the choices is the default", async () => {
    settings.down = true;
    window.localStorage.setItem("argelander.ui", JSON.stringify({ theme: "sepia", accent: "red", density: "huge", labels: "yes", language: "fr" }));
    render(<Shell />);
    // What the page starts with, before (and without) any answer.
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-density")).toBe("regular");
    expect(root.getAttribute("data-accent")).toBe("azure");
    expect(root.getAttribute("data-labels")).toBe("true");
    expect(root.lang).toBe("zh-CN");
  });

  it("with settings never read, a change that is not made goes back to the value before it", async () => {
    settings.down = true;
    render(<Shell />);
    await waitFor(() => expect(settings.gets).toBeGreaterThan(0));
    expect(root.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(q('[data-ui="toggle-theme"]')!);
    await waitFor(() => expect(settings.puts).toHaveLength(1));
    await waitFor(() => expect(root.getAttribute("data-theme")).toBe("dark"));
  });

  it("the settings are read past the browser's cache", async () => {
    render(<Shell />);
    await waitFor(() => expect(settings.gets).toBeGreaterThan(0));
    const calls = (fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } }).mock.calls;
    const reads = calls.filter(([input, init]) => String(input) === "/api/settings" && (init?.method ?? "GET") === "GET");
    expect(reads.length).toBeGreaterThan(0);
    for (const [, init] of reads) expect(init?.cache).toBe("no-store");
  });
});
