// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MailHeader } from "@argelanderspace/contracts";
import i18n from "../src/i18n";
import { MessageActions } from "../src/mail/MessageActions";

const lookups: [string, string | undefined][] = [];
vi.mock("../src/ui/icon-resource", async (original) => {
  const real = await original<typeof import("../src/ui/icon-resource")>();
  return { ...real, getConfiguredIcon: (name: string, uiId?: string) => {
      lookups.push([name, uiId]);
      return real.getConfiguredIcon(name, uiId);
    },
  };
});

const header = (over: Partial<MailHeader> = {}): MailHeader => ({
  uid: 1,
  date: "2026-10-01T10:00:00.000Z",
  from: { name: "S", address: "s@example.test" },
  to: [{ name: "", address: "me@example.test" }],
  subject: "Subject",
  unread: false,
  starred: false,
  hasAttachments: false,
  size: 1,
  ...over,
});
const folders = [
  { path: "INBOX", name: "INBOX", role: "inbox", depth: 0, selectable: true, unread: 0, total: 1 },
  { path: "Trash", name: "Trash", role: "trash", depth: 0, selectable: true, unread: 0, total: 1 },
] as never;
const bar = (h: MailHeader, role: "inbox" | "trash" = "inbox") => (
  <MessageActions
    header={h}
    role={role}
    folders={folders}
    currentPath={role === "trash" ? "Trash" : "INBOX"}
    folderLabel={(f) => f.name}
    busy={false}
    restoreTo={role === "trash" ? "INBOX" : null}
    onBack={() => undefined}
    onToggleRead={() => undefined}
    onToggleStar={() => undefined}
    onMove={() => undefined}
    onDelete={() => undefined}
  />
);
const ui = (id: string) => document.querySelector<HTMLElement>(`[data-ui="${id}"]`);

beforeEach(async () => {
  await i18n.changeLanguage("en");
  lookups.length = 0;
});
afterEach(cleanup);

test("every reader action button renders an svg icon, not fallback text", () => {
  render(bar(header(), "trash"));
  for (const id of ["mail-reader-back", "mail-star", "mail-mark-unread", "mail-move", "mail-restore", "mail-delete-forever"]) {
    const b = ui(id)!;
    expect(b, id).toBeTruthy();
    expect(b.querySelector("svg"), id).toBeTruthy();
    expect(b.textContent, id).toBe("");
    expect(b.getAttribute("aria-label"), id).toBeTruthy();
  }
});

test("star and read/unread pick their icon variant from the message state", () => {
  const { rerender } = render(bar(header({ starred: false, unread: false })));
  expect(ui("mail-star")!.getAttribute("data-starred")).toBe("false");
  expect(lookups).toContainEqual(["star", "mail-star"]);
  expect(lookups).toContainEqual(["mail", "mail-mark-unread"]);
  lookups.length = 0;
  rerender(bar(header({ starred: true, unread: true })));
  expect(ui("mail-star")!.getAttribute("data-starred")).toBe("true");
  expect(ui("mail-star")!.getAttribute("aria-label")).toBe("Remove star");
  expect(lookups).toContainEqual(["starred", "mail-star"]);
  expect(lookups).toContainEqual(["mail-open", "mail-mark-unread"]);
  expect(ui("mail-star")!.querySelector("svg")).toBeTruthy();
  expect(ui("mail-mark-unread")!.querySelector("svg")).toBeTruthy();
});

test("only Trash gets the permanent-delete button, and only it carries the danger colour rule", () => {
  const { rerender } = render(bar(header(), "inbox"));
  expect(ui("mail-delete")).toBeTruthy();
  expect(ui("mail-delete-forever")).toBeNull();
  expect(ui("mail-restore")).toBeNull();
  rerender(bar(header(), "trash"));
  expect(ui("mail-delete")).toBeNull();
  expect(ui("mail-delete-forever")).toBeTruthy();
  expect(lookups).toContainEqual(["trash-xmark", "mail-delete-forever"]);
  const css = readFileSync(resolve(process.cwd(), "src/mail/mail-manage.css"), "utf8");
  expect(css).toMatch(/\[data-ui="mail-delete-forever"\] svg \{ color: var\(--danger\); \}/);
});
