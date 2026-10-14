/**
 * The ADS token row of the settings page (desktop-app ticket 12), against an in-memory fake of the ADS credential
 * endpoints (the real server, keychain and browser are covered elsewhere). The value is never shown: after a save the
 * input is gone and nothing on the page holds the token.
 */
import type { AdsCredentialStatus } from "@argelanderspace/contracts";
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

const TOKEN = "zqxWebTokenMARK0123456789";

let settings: FakeSettings;
/** The fake server's credential: where it is, whether the keychain answers, whether ~/.ads/dev_key is there. */
let ads: { saved: AdsCredentialStatus["saved"]; keychain: boolean; devKey: boolean; testResult: string };
let calls: Array<{ method: string; url: string; body: unknown }>;

const json = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const status = (): AdsCredentialStatus => ({
  version: 1,
  saved: ads.saved,
  keychain: ads.keychain ? "available" : "unavailable",
  devKey: { exists: ads.devKey, path: { path: "/home/someone/.ads/dev_key", display: "~/.ads/dev_key" } },
});

function handleAds(url: string, init?: RequestInit): Response | null {
  if (!url.startsWith("/api/credentials/ads")) return null;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body });
  const store = (consent: boolean) => {
    if (!ads.keychain && !consent) return json({ ok: false, reason: "keychain_unavailable" }, 422);
    ads.saved = ads.keychain ? "keychain" : "file";
    return json({ ok: true, status: status() });
  };
  if (url === "/api/credentials/ads" && method === "GET") return json(status());
  if (url === "/api/credentials/ads" && method === "PUT") return store(body?.fileFallbackConsent === true);
  if (url === "/api/credentials/ads" && method === "DELETE") {
    ads.saved = "none";
    return json({ ok: true, status: status() });
  }
  if (url === "/api/credentials/ads/import") return store(body?.fileFallbackConsent === true);
  if (url === "/api/credentials/ads/test") return json({ ok: true, result: ads.testResult });
  return json({}, 404);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  settings = fakeSettings({ "ui.language": "en" });
  ads = { saved: "none", keychain: true, devKey: false, testResult: "valid" };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = settings.handle(input, init) ?? handleAds(String(input), init);
      if (answer) return answer;
      if (String(input) === "/api/papers") return json({ papers: [] });
      return json({}, 404);
    })
  );
});
afterEach(async () => {
  // Nothing the page shows holds the token, whatever happened.
  expect(document.body.innerHTML).not.toContain(TOKEN);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.changeLanguage("zh-CN");
});

const q = (selector: string) => document.querySelector<HTMLElement>(selector);

async function openServices(): Promise<void> {
  render(<Shell />);
  await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="settings"]')!);
  await waitFor(() => expect(q('[data-ui="settings-page"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="settings-group"][data-ui-key="services"]')!);
  await waitFor(() => expect(q('[data-ui="ads-credential-status"]')).not.toBeNull());
}

const input = () => q('[data-ui="ads-token-input"]') as HTMLInputElement | null;

describe("the ADS token row", () => {
  it("not saved: a password field; saved: the field is gone, the state and its protection shown, never the value", async () => {
    await openServices();
    expect(q('[data-ui="ads-credential-status"]')!.getAttribute("data-state")).toBe("none");
    expect(q('[data-ui="ads-credential-status"]')!.textContent).toContain("Not saved");
    expect(input()!.type).toBe("password");
    expect(input()!.autocomplete).toBe("off");
    expect((q('[data-ui="ads-token-save"]') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input()!, { target: { value: `  ${TOKEN} ` } });
    fireEvent.click(q('[data-ui="ads-token-save"]')!);
    await waitFor(() => expect(q('[data-ui="ads-credential-status"]')!.getAttribute("data-state")).toBe("keychain"));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ token: TOKEN });
    expect(input()).toBeNull();
    expect(q('[data-ui="ads-protection"]')!.textContent).toBe("Protected by the system keychain");
    expect(q('[data-ui="ads-credential"]')!.textContent).toContain("Not stored in the config file");
    expect(q('[data-ui="ads-token-test"]')).not.toBeNull();
    expect(q('[data-ui="ads-token-replace"]')).not.toBeNull();
  });

  it("no keychain: the consent card first, Save disabled until it is ticked; then the file warning stays", async () => {
    ads.keychain = false;
    await openServices();
    expect(q('[data-ui="ads-keychain-unavailable"]')).not.toBeNull();
    fireEvent.change(input()!, { target: { value: TOKEN } });
    expect((q('[data-ui="ads-token-save"]') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(q('[data-ui="ads-keychain-consent"]')!);
    expect((q('[data-ui="ads-token-save"]') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(q('[data-ui="ads-token-save"]')!);
    await waitFor(() => expect(q('[data-ui="ads-credential-status"]')!.getAttribute("data-state")).toBe("file"));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ token: TOKEN, fileFallbackConsent: true });
    expect(q('[data-ui="ads-protection"]')!.textContent).toBe("Not protected by the keychain");
    expect(q('[data-ui="ads-file-store-note"]')).not.toBeNull();
  });

  it.each([
    ["valid", "Works"],
    ["rejected", "Rejected"],
    ["unreachable", "Cannot reach ADS"],
    ["rate_limited", "Rate limited"],
  ])("test: %s", async (result, title) => {
    ads.saved = "keychain";
    ads.testResult = result;
    await openServices();
    fireEvent.click(q('[data-ui="ads-token-test"]')!);
    await waitFor(() => expect(q('[data-ui="ads-test-result"]')).not.toBeNull());
    expect(q('[data-ui="ads-test-result"]')!.textContent).toContain(title);
    expect(calls.find((c) => c.url.endsWith("/test"))?.body).toEqual({});
  });

  it("remove: a dialog with the focus on Cancel; confirmed, back to not saved", async () => {
    ads.saved = "file";
    await openServices();
    fireEvent.click(q('[data-ui="ads-token-remove"]')!);
    await waitFor(() => expect(q('[data-ui="remove-ads-token"]')).not.toBeNull());
    expect(document.activeElement?.getAttribute("data-ui")).toBe("remove-ads-token-cancel");
    expect(q('[data-ui="remove-ads-token"]')!.textContent).toContain("restricted local file");
    fireEvent.click(q('[data-ui="remove-ads-token-confirm"]')!);
    await waitFor(() => expect(q('[data-ui="ads-credential-status"]')!.getAttribute("data-state")).toBe("none"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(q('[data-ui="remove-ads-token"]')).toBeNull();
  });

  it("~/.ads/dev_key there: the import, also when a token is saved (it says it replaces it)", async () => {
    ads.devKey = true;
    ads.saved = "keychain";
    await openServices();
    expect(q('[data-ui="ads-devkey-import"]')!.textContent).toContain("~/.ads/dev_key");
    expect(q('[data-ui="ads-devkey-import"]')!.textContent).toContain("Importing replaces the saved token.");
    expect(q('[data-ui="ads-devkey-import"]')!.textContent).toContain("Importing does not delete the original file.");
    fireEvent.click(q('[data-ui="ads-devkey-import-button"]')!);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/import"))).toBe(true));
  });

  // Last: "Got it" holds for the rest of the page session (the module stays loaded across the tests of this file).
  it("the leftover ads_dev_key: says it no longer has any effect, in the ADS row; Got it hides it", async () => {
    settings.legacy = ["ads_dev_key"];
    await openServices();
    const notice = q('[data-ui="ads-credential"] [data-ui="ads-legacy-key"]')!;
    expect(notice.textContent).toContain("no longer has any effect");
    fireEvent.click(q('[data-ui="ads-legacy-dismiss"]')!);
    expect(q('[data-ui="ads-legacy-key"]')).toBeNull();
    cleanup();
    await openServices();
    expect(q('[data-ui="ads-legacy-key"]')).toBeNull();
  });
});
