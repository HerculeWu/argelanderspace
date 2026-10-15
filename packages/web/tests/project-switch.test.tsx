/**
 * Switching projects with one open (desktop-app ticket 19). The settings page's Project group in the desktop app:
 * "Open another folder…" asks the host to pick one, and the recent projects (without the open one) can be opened. When
 * the switch would interrupt work the confirmation names the target, the tasks and the mail in its undo window; Cancel
 * changes nothing (only the host's hold of a picked folder ends); "Switch anyway" sends back the ids shown, and a
 * changed impact is shown and asked again. Fakes for the endpoints; the host itself is covered in
 * `packages/server/tests/desktop-switch.test.ts`, the layout in a real browser (ticket evidence).
 */
import type { HostInfo, HostRecentProjects, HostSwitchImpact } from "@argelanderspace/contracts";
import { HOST_REQUEST_KINDS } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import { resetHostInfoForTests } from "../src/host";
import i18n from "../src/i18n";
import { resetProjectSwitchForTests } from "../src/welcome/ProjectSwitch";
import { fakeBus } from "./fake-ws";
import { type FakeSettings, fakeSettings } from "./settings-fake";

vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/copilot/Copilot", () => ({ Copilot: () => <div data-ui="stub-copilot" /> }));
vi.mock("../src/plan/PlanView", () => ({ PlanView: () => <div data-ui="stub-plan" /> }));
vi.mock("../src/writer/WriterView", () => ({ WriterView: () => <div data-ui="stub-write" /> }));
vi.mock("../src/library/LibraryView", () => ({ LibraryView: () => <div data-ui="stub-library" /> }));
vi.mock("../src/doc/DocPane", () => ({ DocPane: () => <div data-ui="stub-doc" /> }));
vi.mock("../src/mail/MailView", () => ({ MailView: () => <div data-ui="stub-mail" /> }));

const DESKTOP: HostInfo = { version: 1, app: "argelanderspace", mode: "desktop", requests: [...HOST_REQUEST_KINDS], portFallback: null, project: "open" };
const BROWSER: HostInfo = { ...DESKTOP, mode: "browser", requests: [] };

const CURRENT = { path: "/home/someone/research/m31-halo", display: "~/research/m31-halo", name: "m31-halo" };
const OTHER = { path: "/home/someone/research/globular", display: "~/research/globular", name: "globular" };
const GONE = { path: "/home/someone/archive/old", display: "~/archive/old", name: "old" };

const IMPACT: HostSwitchImpact = {
  jobs: [
    { id: "job-1", kind: "ingest", status: "running", workId: "w-1", format: null, arxivId: "2412.03418" },
    { id: "job-2", kind: "upload", status: "queued", workId: "w-2", format: "pdf", arxivId: null },
  ],
  conversations: [{ id: "conv-1", title: "Halo masses" }],
  mail: [{ sendId: "send-1", subject: "Re: catalogue", endsAt: Date.now() + 6500 }],
};

let settings: FakeSettings;
let host: HostInfo;
let recent: HostRecentProjects;
/** What the next `open` / `confirm` answers (after `wait`, when given). */
let answers: Array<{ status: number; body: unknown; wait?: Promise<void> }>;
let calls: Array<{ url: string; body: unknown }>;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  resetHostInfoForTests();
  resetProjectSwitchForTests();
  settings = fakeSettings({ "ui.language": "en" });
  host = DESKTOP;
  recent = {
    version: 1,
    projects: [
      { ...CURRENT, openedAt: new Date().toISOString(), missing: false, current: true },
      { ...OTHER, openedAt: "2026-01-01T00:00:00.000Z", missing: false, current: false },
      { ...GONE, openedAt: "2025-01-01T00:00:00.000Z", missing: true, current: false },
    ],
    lastMissing: null,
  };
  answers = [];
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = settings.handle(input, init);
      if (answer) return answer;
      const url = String(input);
      const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => structuredClone(body) }) as Response;
      if (url === "/api/host") return ok(host);
      if (url === "/api/host/recent-projects") return ok(recent);
      if (!url.startsWith("/api/host")) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/host/recent-projects/open" || url === "/api/host/switch/confirm") {
        const next = answers.shift() ?? { status: 202, body: { ok: true } };
        if (next.wait) await next.wait;
        return ok(next.body, next.status);
      }
      if (url === "/api/host/switch/cancel") return ok({ ok: true });
      if (url.startsWith("/api/host/requests/")) return ok({ ok: true }, 202);
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
const all = (selector: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(selector)];
const confirmation = (impact: HostSwitchImpact) => ({
  status: 409,
  body: { code: "confirmation_required", detail: "x", target: { ...OTHER }, impact },
});

/** The Shell (which holds the switch prompt), with the settings page's Project group open. */
async function projectGroup() {
  render(<Shell />);
  await waitFor(() => expect(q('[data-ui="stub-plan"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="navigate-view"][data-ui-key="settings"]') as HTMLElement);
  await waitFor(() => expect(q('[data-ui="settings-group"][data-ui-key="project"]')).not.toBeNull());
  fireEvent.click(q('[data-ui="settings-group"][data-ui-key="project"]') as HTMLElement);
  await waitFor(() => expect(q('[data-ui="setting-row"][data-ui-key="project-root"]')).not.toBeNull());
}
const toasts = () => all('[data-ui="toast"]').map((el) => el.textContent ?? "");

describe("the Project group of the settings page", () => {
  it("desktop: Open another folder… asks the host to pick a folder (no body); the browser's hint is gone", async () => {
    await projectGroup();
    const row = q('[data-ui="setting-row"][data-ui-key="project-root"]') as HTMLElement;
    await waitFor(() => expect(q('[data-ui="open-other-folder"]', row)).not.toBeNull());
    const button = q('[data-ui="open-other-folder"]', row) as HTMLButtonElement;
    expect(button.textContent).toBe("Open another folder…");
    expect(row.textContent).not.toContain("Decided by the directory serve was started in");
    fireEvent.click(button);
    await waitFor(() => expect(calls).toEqual([{ url: "/api/host/requests/pick_folder", body: undefined }]));
  });

  it("desktop: the recent projects without the open one; a missing folder cannot be opened", async () => {
    await projectGroup();
    await waitFor(() => expect(q('[data-ui="settings-recent-list"]')).not.toBeNull());
    const items = all('[data-ui="settings-recent-list"] [data-ui="recent-project"]');
    expect(items.map((li) => li.dataset.uiKey)).toEqual([OTHER.path, GONE.path]);
    expect((q('[data-ui="recent-project-open"]', items[1] as HTMLElement) as HTMLButtonElement).disabled).toBe(true);
  });

  it("browser: no Open another folder…, no recent projects, the hint stays", async () => {
    host = BROWSER;
    await projectGroup();
    await new Promise((r) => setTimeout(r, 30));
    expect(q('[data-ui="open-other-folder"]')).toBeNull();
    expect(q('[data-ui="setting-row"][data-ui-key="recent-projects"]')).toBeNull();
    expect(q('[data-ui="setting-row"][data-ui-key="project-root"]')?.textContent).toContain("Decided by the directory serve was started in");
  });

  it("opening a recent project with nothing to interrupt: one request, no prompt, the list is disabled", async () => {
    await projectGroup();
    await waitFor(() => expect(q('[data-ui="settings-recent-list"]')).not.toBeNull());
    fireEvent.click(q(`[data-ui="recent-project-open"][data-ui-key="${OTHER.path}"]`) as HTMLElement);
    await waitFor(() => expect((q('[data-ui="open-other-folder"]') as HTMLButtonElement).disabled).toBe(true));
    expect(calls).toEqual([{ url: "/api/host/recent-projects/open", body: { path: OTHER.path } }]);
    expect(q('[data-ui="switch-project"]')).toBeNull();
    expect((q(`[data-ui="recent-project-open"][data-ui-key="${OTHER.path}"]`) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the confirmation before a switch", () => {
  it("a recent project: the server's impact is shown — target, tasks, mail — with the focus on Cancel", async () => {
    answers = [confirmation(IMPACT)];
    await projectGroup();
    await waitFor(() => expect(q('[data-ui="settings-recent-list"]')).not.toBeNull());
    fireEvent.click(q(`[data-ui="recent-project-open"][data-ui-key="${OTHER.path}"]`) as HTMLElement);
    await waitFor(() => expect(q('[data-ui="switch-project"]')).not.toBeNull());
    const dialog = q('[data-ui="switch-project"]') as HTMLElement;
    expect(dialog.textContent).toContain("Switch to “globular”?");
    expect(dialog.textContent).toContain("The current project will close and ~/research/globular will open.");
    const tasks = q('[data-ui="switch-busy-tasks"]', dialog) as HTMLElement;
    expect(tasks.textContent).toContain("3 tasks are running or queued; switching interrupts them:");
    expect(all("li", tasks).map((li) => li.textContent)).toEqual([
      "arXiv source ingest · 2412.03418",
      "Uploaded PDF processing · w-2 · queued",
      "Copilot conversation · Halo masses",
    ]);
    const mail = q('[data-ui="switch-busy-mail"]', dialog) as HTMLElement;
    expect(mail.textContent).toContain("1 email is still in its undo window. After switching it stays in Drafts and is not sent:");
    expect(q('[data-ui="switch-busy-mail-item"]', mail)?.textContent).toMatch(/^“Re: catalogue” · [67] s left$/);
    expect(document.activeElement).toBe(q('[data-ui="switch-project-cancel"]'));
    const confirm = q('[data-ui="switch-project-confirm"]') as HTMLButtonElement;
    expect(confirm.textContent).toBe("Switch anyway");
    expect(confirm.className).toContain("danger");
  });

  it("Cancel changes nothing: the dialog closes and no further request is made", async () => {
    answers = [confirmation(IMPACT)];
    await projectGroup();
    await waitFor(() => expect(q('[data-ui="settings-recent-list"]')).not.toBeNull());
    fireEvent.click(q(`[data-ui="recent-project-open"][data-ui-key="${OTHER.path}"]`) as HTMLElement);
    await waitFor(() => expect(q('[data-ui="switch-project"]')).not.toBeNull());
    const before = calls.length;
    fireEvent.click(q('[data-ui="switch-project-cancel"]') as HTMLElement);
    await waitFor(() => expect(q('[data-ui="switch-project"]')).toBeNull());
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(before);
    // The page is as it was: nothing disabled.
    expect((q('[data-ui="open-other-folder"]') as HTMLButtonElement).disabled).toBe(false);
    expect((q(`[data-ui="recent-project-open"][data-ui-key="${OTHER.path}"]`) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Switch anyway sends the ids shown; a changed impact is shown and asked again; then the host leaves", async () => {
    const more: HostSwitchImpact = { ...IMPACT, jobs: [...IMPACT.jobs, { id: "job-3", kind: "refresh", status: "queued", workId: null, format: null, arxivId: null }] };
    answers = [confirmation(IMPACT), confirmation(more), { status: 202, body: { ok: true } }];
    await projectGroup();
    await waitFor(() => expect(q('[data-ui="settings-recent-list"]')).not.toBeNull());
    fireEvent.click(q(`[data-ui="recent-project-open"][data-ui-key="${OTHER.path}"]`) as HTMLElement);
    await waitFor(() => expect(q('[data-ui="switch-project"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="switch-project-confirm"]') as HTMLElement);
    await waitFor(() => expect(q('[data-ui="switch-project-changed"]')).not.toBeNull());
    expect(calls[1]).toEqual({
      url: "/api/host/recent-projects/open",
      body: { path: OTHER.path, acknowledged: { jobs: ["job-1", "job-2"], conversations: ["conv-1"], mail: ["send-1"] } },
    });
    expect(all('[data-ui="switch-busy-job"]').map((li) => li.dataset.uiKey)).toEqual(["job-1", "job-2", "job-3"]);
    fireEvent.click(q('[data-ui="switch-project-confirm"]') as HTMLElement);
    await waitFor(() => expect((q('[data-ui="switch-project-cancel"]') as HTMLButtonElement).disabled).toBe(true));
    expect(calls[2]?.body).toEqual({
      path: OTHER.path,
      acknowledged: { jobs: ["job-1", "job-2", "job-3"], conversations: ["conv-1"], mail: ["send-1"] },
    });
    // Leaving: the dialog stays, busy, until the next project's page arrives.
    expect(q('[data-ui="switch-project"]')).not.toBeNull();
  });

  it("a folder the shell picked: the host's message puts up the prompt; Cancel ends the hold and nothing else", async () => {
    await projectGroup();
    act(() => fakeBus.emit("host.switch-confirmation", { id: "hold-1", target: { ...OTHER }, impact: { jobs: [], conversations: [], mail: IMPACT.mail } }));
    await waitFor(() => expect(q('[data-ui="switch-project"]')).not.toBeNull());
    expect(q('[data-ui="switch-busy-tasks"]')).toBeNull();
    expect(q('[data-ui="switch-busy-mail"]')).not.toBeNull();
    fireEvent.click(q('[data-ui="switch-project-cancel"]') as HTMLElement);
    await waitFor(() => expect(q('[data-ui="switch-project"]')).toBeNull());
    await waitFor(() => expect(calls).toEqual([{ url: "/api/host/switch/cancel", body: { id: "hold-1" } }]));
  });

  it("a folder the shell picked: Switch anyway confirms that hold with the ids shown; a gone hold is said so", async () => {
    answers = [{ status: 404, body: { code: "unknown_switch" } }];
    await projectGroup();
    act(() => fakeBus.emit("host.switch-confirmation", { id: "hold-2", target: { ...OTHER }, impact: IMPACT }));
    await waitFor(() => expect(q('[data-ui="switch-project"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="switch-project-confirm"]') as HTMLElement);
    await waitFor(() => expect(q('[data-ui="switch-project"]')).toBeNull());
    expect(calls).toEqual([
      {
        url: "/api/host/switch/confirm",
        body: { id: "hold-2", acknowledged: { jobs: ["job-1", "job-2"], conversations: ["conv-1"], mail: ["send-1"] } },
      },
    ]);
    await waitFor(() => expect(toasts().some((text) => text.includes("This switch is no longer waiting for confirmation; nothing was switched."))).toBe(true));
  });

  it("the host accepted a switch while another prompt replaced the dialog: the page is still leaving, entries disabled", async () => {
    let answer!: () => void;
    const wait = new Promise<void>((resolve) => {
      answer = resolve;
    });
    answers = [confirmation(IMPACT), { status: 202, body: { ok: true }, wait }];
    await projectGroup();
    await waitFor(() => expect(q('[data-ui="settings-recent-list"]')).not.toBeNull());
    fireEvent.click(q(`[data-ui="recent-project-open"][data-ui-key="${OTHER.path}"]`) as HTMLElement);
    await waitFor(() => expect(q('[data-ui="switch-project"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="switch-project-confirm"]') as HTMLElement);
    await waitFor(() => expect(calls).toHaveLength(2));
    // Meanwhile the shell picked another folder: its prompt replaces this one before the host's answer arrives.
    act(() => fakeBus.emit("host.switch-confirmation", { id: "hold-3", target: { ...GONE }, impact: IMPACT }));
    await waitFor(() => expect(q('[data-ui="switch-project"]')?.textContent).toContain("Switch to “old”?"));
    await act(async () => {
      answer();
      await wait;
    });
    await waitFor(() => expect((q('[data-ui="open-other-folder"]') as HTMLButtonElement).disabled).toBe(true));
    expect((q(`[data-ui="recent-project-open"][data-ui-key="${OTHER.path}"]`) as HTMLButtonElement).disabled).toBe(true);
    // The host is stopping: the remaining dialog cannot be confirmed or cancelled any more.
    expect((q('[data-ui="switch-project-confirm"]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[data-ui="switch-project-cancel"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("a host message that is not a well-formed switch confirmation shows nothing", async () => {
    await projectGroup();
    const bad = [
      { id: "hold-4", target: { ...OTHER } },
      { id: "hold-5", target: { path: OTHER.path }, impact: IMPACT },
      { id: "hold-6", target: { ...OTHER }, impact: { ...IMPACT, jobs: [{ id: "job-x", kind: "compile", status: "running", workId: null, format: null, arxivId: null }] } },
    ];
    for (const message of bad) act(() => fakeBus.emit("host.switch-confirmation", message as never));
    await new Promise((r) => setTimeout(r, 30));
    expect(q('[data-ui="switch-project"]')).toBeNull();
    // A well-formed one is shown.
    act(() => fakeBus.emit("host.switch-confirmation", { id: "hold-7", target: { ...OTHER }, impact: IMPACT }));
    await waitFor(() => expect(q('[data-ui="switch-project"]')).not.toBeNull());
  });
});
