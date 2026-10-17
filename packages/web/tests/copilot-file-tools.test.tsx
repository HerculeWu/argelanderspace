/**
 * Copilot's file and command tools in the panel (ticket 57, approved prototype `prototype-tools`) at the component
 * seam: the real Copilot component against a scripted HTTP API. The confirmation card has three decisions (deny, allow
 * this class for the session, allow once) and sits in place of its call; the same place then shows the tool card with
 * its states. Layout is proven in the real browser, not here (happy-dom).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSnapshot, CopilotConfirmation, CopilotMessage, CopilotOperation, CopilotProvider, FileToolRecord, PageContext, WsCopilotEvent } from "@argelanderspace/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Copilot } from "../src/copilot/Copilot";
import i18n from "../src/i18n";

const callbacks = vi.hoisted(() => ({ subscription: null as null | { event: (event: WsCopilotEvent) => void; ready: () => void; connection: (value: boolean) => void } }));
vi.mock("../src/api/ws", () => ({ subscribeCopilot: (subscription: NonNullable<typeof callbacks.subscription>) => { callbacks.subscription = subscription; queueMicrotask(subscription.ready); return () => { callbacks.subscription = null; }; } }));
const ID = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-0000000000aa";
const CARD = "00000000-0000-4000-8000-0000000000cc";
const context: PageContext = { version: 1, viewId: "00000000-0000-4000-8000-000000000001", paneId: 1, revision: 1, view: "plan", status: "unavailable", otherPanes: [], plan: null };
const conversation = (status: "waiting-for-user" | "completed") => ({ version: 1 as const, id: ID, sessionId: "00000000-0000-4000-8000-000000000003", title: "Test conversation", createdAt: "2026-10-16", updatedAt: "2026-10-16", model: { provider: "openai", model: "test", thinking: null }, run: { id: RUN, status, error: null } });
const CWD = "~/projects/dark-matter-review";
const COMMAND = "ls -la literatures/inbox && wc -l literatures/inbox/*.bib";
const commandCard = (over: Record<string, unknown> = {}): CopilotConfirmation => ({ id: CARD, runId: RUN, toolCallId: "call_1", baseRev: 0, action: "run_command", object: { kind: "command", id: "call_1" }, shell: "bash", command: COMMAND, cwd: CWD, ...over }) as CopilotConfirmation;
const diff = [
  { k: "hunk" as const, s: "@@ notes/outline.md · 14–14 @@" },
  { k: "del" as const, s: "old line" },
  { k: "add" as const, s: "new line" },
  { k: "add" as const, s: "more" },
];
const editCard = (): CopilotConfirmation => ({ id: CARD, runId: RUN, toolCallId: "call_1", baseRev: 0, action: "edit_file", object: { kind: "file", id: "call_1" }, cwd: CWD, path: "notes/outline.md", resolved: `${CWD}/notes/outline.md`, change: { edits: 1, added: 2, removed: 1, unchanged: 187, diff } }) as CopilotConfirmation;
const writeCard = (overwrite: boolean): CopilotConfirmation => ({ id: CARD, runId: RUN, toolCallId: "call_1", baseRev: 0, action: "write_file", object: { kind: "file", id: "call_1" }, cwd: CWD, path: "scripts/import.sh", resolved: `${CWD}/../elsewhere/scripts/import.sh`, change: { bytes: 2457, lines: 58, overwrite, ...(overwrite ? { oldBytes: 1126 } : {}), preview: ["#!/usr/bin/env bash", "set -e"], previewMore: 56 } }) as CopilotConfirmation;
const operation = (over: Partial<CopilotOperation> & { fileTool: FileToolRecord }): CopilotOperation => ({ id: "call_1", tool: "bash", action: "command", status: "ok", ...over });
const bashRecord = (over: Partial<FileToolRecord> = {}): FileToolRecord => ({ kind: "command", shell: "bash", target: COMMAND, command: COMMAND, cwd: CWD, ...over });
const message = (operations: CopilotOperation[]): CopilotMessage => ({ id: "m1", role: "assistant", text: "", operations });
const snap = (messages: CopilotMessage[], confirmations: CopilotConfirmation[] = [], status: "waiting-for-user" | "completed" = "completed"): ConversationSnapshot => ({ version: 1, conversation: conversation(status), messages, confirmations, stream: "", eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 1 } });
const provider: CopilotProvider = { id: "openai", name: "OpenAI", method: "api_key", credential: { configured: true, stored: true, source: "stored" }, catalogStatus: "ready", models: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", contextWindow: 10000, maxTokens: 1000, tools: true, image: false, thinkingLevels: ["off", "low", "high"], capabilitiesKnown: true, defaultThinking: "high", defaultThinkingValid: true }] };
let fetchMock: ReturnType<typeof vi.fn>;
let current: ConversationSnapshot;
let decisionStatus = 200;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part));
const memory = new Map<string, string>();
beforeEach(async () => {
  await i18n.changeLanguage("en"); callbacks.subscription = null; memory.clear(); decisionStatus = 200;
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } });
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/providers")) return json({ version: 1, providers: [provider] });
    if (url.endsWith("/conversations")) return options?.method === "POST" ? json(current, 201) : json({ version: 1, conversations: [current.conversation], unreadable: [] });
    if (url.includes("/confirmations/")) return decisionStatus === 200 ? json({ status: "approved" }) : json({ code: decisionStatus === 409 ? "stale" : "storage" }, decisionStatus);
    if (url.includes("/views/")) return json({ saved: true });
    return json(current);
  }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async () => { const view = render(<Copilot open context={context} onClose={vi.fn()} />); await screen.findByText("Copilot"); return view; };
const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`) as HTMLElement | null;
const uis = (name: string) => [...document.querySelectorAll(`[data-ui="${name}"]`)] as HTMLElement[];
const decisionBody = () => JSON.parse(String((calls("/confirmations/")[0] as [string, RequestInit])[1].body));

test("the command card shows where it runs and the whole command, with three decisions", async () => {
  current = snap([message([operation({ status: "confirmation_required", fileTool: bashRecord() })])], [commandCard()], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  const shown = ui("copilot-confirmation") as HTMLElement;
  expect(shown.getAttribute("data-action")).toBe("run_command");
  expect(ui("copilot-confirmation-title")?.textContent).toBe("Copilot wants to run a command");
  expect(ui("copilot-confirmation-cwd")?.textContent).toBe(CWD);
  expect(ui("copilot-confirmation-command")?.textContent).toBe(COMMAND);
  expect(ui("copilot-confirmation-scope")?.textContent).toContain("account permissions");
  expect(ui("copilot-confirmation-deny")?.textContent).toBe("Deny");
  expect(ui("copilot-confirmation-allow-session")?.textContent).toBe("Allow commands this session");
  expect(ui("copilot-confirmation-allow-once")?.textContent).toBe("Allow once");
  expect(ui("copilot-confirmation-allow-once")?.className).toContain("primary");
  // the card takes the place of its call inside the message, not a second card at the end
  expect(uis("copilot-confirmation")).toHaveLength(1);
  expect(shown.closest('[data-ui="copilot-message"]')).not.toBeNull();
  expect(ui("copilot-tool-card")).toBeNull();
});

test("the decisions post the card's own action, object and version; only 'allow for the session' carries remember", async () => {
  current = snap([message([operation({ status: "confirmation_required", fileTool: bashRecord() })])], [commandCard()], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-allow-once")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-allow-once")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect((calls("/confirmations/")[0] as [string])[0]).toBe(`/api/copilot/confirmations/${CARD}`);
  expect(decisionBody()).toEqual({ decision: "approve", viewId: context.viewId, action: "run_command", objectId: "call_1", baseRev: 0 });
  cleanup(); fetchMock.mockClear();
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-allow-session")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-allow-session")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect(decisionBody()).toEqual({ decision: "approve", viewId: context.viewId, action: "run_command", objectId: "call_1", baseRev: 0, remember: true });
  cleanup(); fetchMock.mockClear();
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-deny")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-deny")!);
  await waitFor(() => expect(calls("/confirmations/")).toHaveLength(1));
  expect(decisionBody()).toEqual({ decision: "decline", viewId: context.viewId, action: "run_command", objectId: "call_1", baseRev: 0 });
});

test("after the decision the same place shows the tool card (the card does not leave a gap or move to the end)", async () => {
  current = snap([message([operation({ status: "confirmation_required", fileTool: bashRecord() })])], [commandCard()], "waiting-for-user");
  const view = await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  current = snap([message([operation({ status: "ok", fileTool: bashRecord({ exitCode: 0, durationMs: 340, approval: "once", output: { head: ["total 52"], tail: [], omitted: 0 } }) })])]);
  callbacks.subscription?.event({ type: "copilot.event", conversationId: ID, runId: RUN, eventCursor: { instanceId: "00000000-0000-4000-8000-000000000004", seq: 2 }, kind: "changed" });
  await waitFor(() => expect(ui("copilot-tool-card")).not.toBeNull());
  expect(ui("copilot-confirmation")).toBeNull();
  expect(ui("copilot-tool-meta")?.textContent).toBe("exit 0 · 340 ms");
  view.unmount();
});

test("an edit card shows the diff with + and − marks and a count; a write card says when it overwrites", async () => {
  current = snap([message([operation({ tool: "edit", action: "edit", status: "confirmation_required", fileTool: { kind: "edit", target: "notes/outline.md", path: "notes/outline.md", cwd: CWD } })])], [editCard()], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation-title")?.textContent).toBe("Copilot wants to edit a file");
  expect(ui("copilot-confirmation-path")?.textContent).toBe("notes/outline.md");
  expect(ui("copilot-confirmation-resolved")?.textContent).toBe(`${CWD}/notes/outline.md`);
  expect(ui("copilot-confirmation")?.textContent).toContain("1 replacement(s) · +2 −1 lines · other 187 lines unchanged");
  const lines = [...document.querySelectorAll('[data-ui="copilot-tool-diff"] .copilot-tool-dl')].map((el) => `${el.className.replace("copilot-tool-dl ", "")}:${el.textContent}`);
  expect(lines).toEqual(["hunk:@@ notes/outline.md · 14–14 @@", "del:−old line", "add:+new line", "add:+more"]);
  expect(ui("copilot-confirmation-allow-session")?.textContent).toBe("Allow file writes this session");
  cleanup();
  current = snap([message([operation({ tool: "write", action: "write", status: "confirmation_required", fileTool: { kind: "write", target: "scripts/import.sh", path: "scripts/import.sh", cwd: CWD } })])], [writeCard(true)], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation-title")?.textContent).toBe("Copilot wants to overwrite a file");
  expect(ui("copilot-confirmation-scope")?.textContent).toBe("The file already exists; its content will be replaced and not backed up.");
  expect(ui("copilot-confirmation")?.textContent).toContain("Overwrites an existing file · 1.1 KB → 2.4 KB · 58 lines");
  cleanup();
  current = snap([message([operation({ tool: "write", action: "write", status: "confirmation_required", fileTool: { kind: "write", target: "scripts/import.sh", path: "scripts/import.sh", cwd: CWD } })])], [writeCard(false)], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation")).not.toBeNull());
  expect(ui("copilot-confirmation-title")?.textContent).toBe("Copilot wants to create a file");
});

test("a PowerShell command says so in the title", async () => {
  current = snap([message([operation({ tool: "powershell", status: "confirmation_required", fileTool: bashRecord({ shell: "powershell" }) })])], [commandCard({ shell: "powershell" })], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-title")).not.toBeNull());
  expect(ui("copilot-confirmation-title")?.textContent).toBe("Copilot wants to run a PowerShell command");
});

test("a decision refused as stale says nothing ran", async () => {
  decisionStatus = 409;
  current = snap([message([operation({ status: "confirmation_required", fileTool: bashRecord() })])], [commandCard()], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-allow-once")).not.toBeNull());
  fireEvent.click(ui("copilot-confirmation-allow-once")!);
  await waitFor(() => expect(ui("copilot-confirmation-problem")?.textContent).toContain(i18n.t("copilot.confirmation.expiredFile")));
});

const head = (n: number) => Array.from({ length: n }, (_, at) => `line ${at + 1}`);
test("tool cards: one collapsed line per call (category, target, result, time); opening shows the command, where it ran, how it was allowed and the output", async () => {
  current = snap([message([
    operation({ id: "a", tool: "read", action: "read", fileTool: { kind: "read", target: "inbox/lensing.bib", path: "inbox/lensing.bib", cwd: CWD, durationMs: 12, result: { unit: "lines", n: 214 }, output: { head: ["@article{x,"], tail: ["}"], omitted: 0 } } }),
    operation({ id: "b", tool: "grep", action: "grep", fileTool: { kind: "grep", target: "bibcode  inbox/", path: "inbox/", cwd: CWD, result: { unit: "matches", n: 55 }, durationMs: 30 } }),
    operation({ id: "c", fileTool: bashRecord({ exitCode: 0, durationMs: 2100, approval: "session", output: { head: head(40), tail: ["last"], omitted: 118 } }) }),
  ])]);
  await open();
  await waitFor(() => expect(uis("copilot-tool-card")).toHaveLength(3));
  const [read, grep, bash] = uis("copilot-tool-card") as [HTMLElement, HTMLElement, HTMLElement];
  expect(read.getAttribute("data-tool")).toBe("read");
  expect(read.querySelector('[data-ui="copilot-tool-meta"]')?.textContent).toBe("214 lines · 10 ms");
  expect(grep.querySelector('[data-ui="copilot-tool-meta"]')?.textContent).toBe("55 matches · 30 ms");
  expect(bash.getAttribute("data-tool")).toBe("bash");
  expect(bash.getAttribute("data-state")).toBe("ok");
  expect(bash.querySelector('[data-ui="copilot-tool-target"]')?.textContent).toBe(COMMAND);
  expect(bash.querySelector('[data-ui="copilot-tool-meta"]')?.textContent).toBe("exit 0 · 2.1 s");
  expect(bash.querySelector("details, summary")).not.toBeNull();
  expect((bash as HTMLDetailsElement).open).toBe(false);
  fireEvent.click(bash.querySelector("summary")!);
  expect((bash as HTMLDetailsElement).open).toBe(true);
  expect(bash.textContent).toContain(CWD);
  expect(bash.textContent).toContain("Allowed for this session (no more asking)");
  expect(bash.querySelector('[data-ui="copilot-tool-output"]')?.textContent).toContain("… 118 lines omitted …");
  expect(bash.querySelector('[data-ui="copilot-tool-output"]')?.textContent).toContain("line 40");
  expect(bash.querySelector('[data-ui="copilot-tool-truncated"]')?.textContent).toBe("Output truncated: first 40 and last 1 lines of 159. The full output goes to the model only, not stored here.");
  // the category icon comes from the icon resource, not from a library import
  expect(bash.querySelector('[data-ui="copilot-tool-category"] svg')).not.toBeNull();
});

test("tool cards: every end state has its own mark, wording and body", async () => {
  current = snap([message([
    operation({ id: "run", status: "pending", fileTool: bashRecord({ startedAt: new Date(Date.now() - 4000).toISOString(), approval: "auto" }) }),
    operation({ id: "fail", status: "error", fileTool: bashRecord({ exitCode: 1, durationMs: 1800, approval: "once", output: { head: ["error: ADS token is not set"], tail: [], omitted: 0 } }) }),
    operation({ id: "deny", status: "declined", fileTool: bashRecord() }),
    operation({ id: "stopped", status: "interrupted", fileTool: bashRecord({ durationMs: 4300, approval: "once" }) }),
    operation({ id: "before", status: "interrupted", fileTool: bashRecord({ beforeRun: true }) }),
    operation({ id: "guard", tool: "write", action: "write", status: "rejected", fileTool: { kind: "write", target: "literatures/works/x.json", path: "literatures/works/x.json", cwd: CWD, guard: { inside: "data_dir", via: "direct", folder: `${CWD}/literatures`, resolved: `${CWD}/literatures/works/x.json` } } }),
    operation({ id: "link", tool: "edit", action: "edit", status: "rejected", fileTool: { kind: "edit", target: "notes/s.json", path: "notes/s.json", cwd: CWD, guard: { inside: "data_dir", via: "symlink", folder: `${CWD}/literatures`, resolved: `${CWD}/literatures/index.json` } } }),
    operation({ id: "cfg", tool: "write", action: "write", status: "rejected", fileTool: { kind: "write", target: "cfg/config.toml", path: "cfg/config.toml", cwd: CWD, guard: { inside: "config_dir", via: "direct", folder: "~/.config/argelanderspace", resolved: "~/.config/argelanderspace/config.toml" } } }),
    operation({ id: "readfail", tool: "read", action: "read", status: "error", fileTool: { kind: "read", target: "missing.txt", path: "missing.txt", cwd: CWD, error: "ENOENT: no such file" } }),
    operation({ id: "dots", tool: "write", action: "write", status: "rejected", fileTool: { kind: "write", target: "a/../literatures/x", path: "a/../literatures/x", cwd: CWD, guard: { inside: "global_dir", via: "parent_ref", folder: "~/.local/share/argelanderspace", resolved: "~/.local/share/argelanderspace/x" } } }),
  ])]);
  await open();
  await waitFor(() => expect(uis("copilot-tool-card")).toHaveLength(10));
  const by = (id: string) => document.querySelector(`[data-ui="copilot-tool-card"][data-ui-key="${id}"]`) as HTMLElement;
  const meta = (id: string) => by(id).querySelector('[data-ui="copilot-tool-meta"]')?.textContent;
  expect(by("run").getAttribute("data-state")).toBe("running");
  expect(meta("run")).toMatch(/^Running · [34]\.\d s$/);
  expect(by("fail").getAttribute("data-state")).toBe("fail");
  expect(meta("fail")).toBe("exit 1 · 1.8 s");
  expect(by("fail").textContent).toContain("The command ended with non-zero exit code 1.");
  expect(meta("deny")).toBe("Denied");
  expect(by("deny").textContent).toContain("You denied this call and it did not run.");
  expect(meta("stopped")).toBe("Interrupted · 4.3 s");
  expect(by("stopped").textContent).toContain("the command and its child processes were terminated");
  expect(meta("before")).toBe("Interrupted");
  expect(by("before").textContent).toContain("Stopped while waiting for confirmation: nothing ran.");
  expect(meta("guard")).toBe("Blocked by guard");
  expect(by("guard").querySelector('[data-ui="copilot-tool-guard"]')?.getAttribute("role")).toBe("alert");
  expect(by("guard").textContent).toContain("The resolved path is inside the data folder");
  expect(by("cfg").textContent).toContain("the config folder");
  expect(by("cfg").textContent).toContain("settings page");
  expect(meta("readfail")).toBe("Failed"); // a failed call says so in words, not only by its icon
  expect(by("readfail").textContent).toContain("ENOENT: no such file");
  expect(by("link").textContent).toContain("is a symbolic link to");
  expect(by("dots").textContent).toContain("resolves through .. into the global data folder");
  // the marks differ by state, and not only by colour
  const marks = ["run", "fail", "deny", "stopped", "guard"].map((id) => by(id).querySelector(".copilot-operation-mark")?.innerHTML);
  expect(new Set(marks).size).toBe(4); // clock, warning (failed and blocked share it, as in the prototype), stop, ban
});

test("file tool calls stay one card each while the other operations of a message stay one grouped record", async () => {
  current = snap([message([
    { id: "p1", tool: "plan", action: "read", status: "ok" },
    operation({ id: "t1", fileTool: bashRecord({ exitCode: 0 }) }),
    { id: "p2", tool: "plan", action: "read", status: "ok" },
  ])]);
  await open();
  await waitFor(() => expect(ui("copilot-tool-card")).not.toBeNull());
  expect(uis("copilot-operation")).toHaveLength(2);
  expect(uis("copilot-tool-card")).toHaveLength(1);
});

test("the cards read in Chinese too", async () => {
  await i18n.changeLanguage("zh-CN");
  current = snap([message([operation({ status: "confirmation_required", fileTool: bashRecord() })])], [commandCard()], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-deny")).not.toBeNull());
  expect(ui("copilot-confirmation-title")?.textContent).toBe("Copilot 要运行一条命令");
  expect(ui("copilot-confirmation-deny")?.textContent).toBe("拒绝");
  expect(ui("copilot-confirmation-allow-session")?.textContent).toBe("本会话内允许命令");
  expect(ui("copilot-confirmation-allow-once")?.textContent).toBe("允许一次");
});

test("bidirectional and zero-width characters in a command, a path or a diff are shown as marks, not drawn", async () => {
  const tricky = "echo safe‮; rm -rf x​⁦";
  current = snap([message([operation({ status: "confirmation_required", fileTool: bashRecord() })])], [commandCard({ command: tricky }), ], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-command")).not.toBeNull());
  const shown = ui("copilot-confirmation-command") as HTMLElement;
  expect(shown.textContent).toBe("echo safe⟨U+202E⟩; rm -rf x⟨U+200B⟩⟨U+2066⟩");
  expect(shown.textContent).not.toContain("‮");
  expect([...shown.querySelectorAll('[data-ui="copilot-tool-control"]')].map((el) => el.className)).toEqual(["copilot-tool-ctl", "copilot-tool-ctl", "copilot-tool-ctl"]);
  cleanup();
  const edit = { ...(editCard() as object), path: "a‮b.md", resolved: "x﻿y", change: { edits: 1, added: 1, removed: 1, diff: [{ k: "del", s: "old‍" }, { k: "add", s: "new⁩" }] } } as CopilotConfirmation;
  current = snap([message([operation({ tool: "edit", action: "edit", status: "confirmation_required", fileTool: { kind: "edit", target: "a", path: "a", cwd: CWD } })])], [edit], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-path")).not.toBeNull());
  expect(ui("copilot-confirmation-path")?.textContent).toBe("a⟨U+202E⟩b.md");
  expect(ui("copilot-confirmation-resolved")?.textContent).toBe("x⟨U+FEFF⟩y");
  expect(ui("copilot-tool-diff")?.textContent).toContain("old⟨U+200D⟩");
  expect(ui("copilot-tool-diff")?.textContent).not.toMatch(/[​-‍⁦-⁩‪-‮﻿]/);
});

test("a change to a file too big to read says its context is left out; the tool card shows the helper-program folder guard", async () => {
  const edit = { ...(editCard() as object), change: { edits: 1, added: 2, removed: 1, contextOmitted: true, diff: diff } } as CopilotConfirmation;
  current = snap([message([operation({ tool: "edit", action: "edit", status: "confirmation_required", fileTool: { kind: "edit", target: "a", path: "a", cwd: CWD } })])], [edit], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-tool-context-omitted")).not.toBeNull());
  expect(ui("copilot-tool-context-omitted")?.textContent).toContain("too large");
  expect(ui("copilot-confirmation")?.textContent).toContain("+2 −1 lines");
  cleanup();
  current = snap([message([operation({ id: "g", tool: "write", action: "write", status: "rejected", fileTool: { kind: "write", target: "bin/rg", path: "bin/rg", cwd: CWD, guard: { inside: "tools_dir", via: "direct", folder: "~/.pi/agent/bin", resolved: "~/.pi/agent/bin/rg" } } })])]);
  await open();
  await waitFor(() => expect(ui("copilot-tool-guard")).not.toBeNull());
  expect(ui("copilot-tool-guard")?.textContent).toContain("the helper-program folder");
});

test("every invisible character is a mark, in the confirmation, the guard text and the error of a tool card; tag characters by code point", async () => {
  const chars: [string, string][] = [["‎", "200E"], ["‏", "200F"], ["؜", "061C"], ["⁠", "2060"], ["⁤", "2064"], ["­", "00AD"], ["ㅤ", "3164"], [String.fromCodePoint(0xe0041), "E0041"], [String.fromCodePoint(0xe007f), "E007F"]];
  const raw = chars.map(([c]) => `a${c}`).join("");
  const marked = chars.map(([, code]) => `a⟨U+${code}⟩`).join("");
  current = snap([message([operation({ status: "confirmation_required", fileTool: bashRecord() })])], [commandCard({ command: raw })], "waiting-for-user");
  await open();
  await waitFor(() => expect(ui("copilot-confirmation-command")).not.toBeNull());
  expect(ui("copilot-confirmation-command")?.textContent).toBe(marked);
  cleanup();
  current = snap([message([
    operation({ id: "g", tool: "write", action: "write", status: "rejected", fileTool: { kind: "write", target: "t", path: `x${raw}`, cwd: CWD, guard: { inside: "data_dir", via: "direct", folder: `f${raw}`, resolved: `r${raw}` } } }),
    operation({ id: "e", tool: "read", action: "read", status: "error", fileTool: { kind: "read", target: "t", path: "t", cwd: CWD, error: `bad${raw}` } }),
  ])]);
  await open();
  await waitFor(() => expect(uis("copilot-tool-card")).toHaveLength(2));
  const guard = ui("copilot-tool-guard") as HTMLElement;
  expect(guard.textContent).toContain(`f${marked}`);
  expect(guard.textContent).not.toMatch(/[‎‏؜⁠-⁤­ㅤ]|[\u{E0000}-\u{E007F}]/u);
  const card = document.querySelector('[data-ui="copilot-tool-card"][data-ui-key="e"]') as HTMLElement;
  expect(card.textContent).toContain(`bad${marked}`);
  expect(card.querySelectorAll('[data-ui="copilot-tool-control"]').length).toBe(chars.length);
});
