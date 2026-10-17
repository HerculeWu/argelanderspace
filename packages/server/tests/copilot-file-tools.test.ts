/**
 * Copilot's file and command tools (copilot ticket 57, ADR 0011), end to end on the real seam: a real Pi session with
 * Pi's own read / bash / edit / write / grep / find / ls, the real HTTP routes (the confirmation and stop endpoints),
 * a real child process and real files in a temporary Project folder. Only the model is scripted: it can ask for a
 * command or a write but has no way to answer its own request.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConversationSnapshot,
  CopilotConfirmation,
  CopilotOperation,
  PageContext,
} from "@argelanderspace/contracts";
import { libraryPaths, plansPath } from "@argelanderspace/core";
import { createLogger } from "@argelanderspace/infra";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  getCurrentTools,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMemorySink } from "../../infra/tests/log-memory-sink.js";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import {
  fileToolNames,
  isInside,
  LineSampler,
  piBinDir,
  piResolve,
  resolveReal,
  searchCommand,
  settledFileToolCall,
  windowsPathRefusal,
} from "../src/copilot-file-tools.js";
import { fileToolsDefault } from "../src/file-tools-default.js";
import { JobRunner } from "../src/jobs.js";
import { SERVER_LOG_EVENTS } from "../src/log.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";

type Call = { name: string; args: Record<string, unknown> };
type Out = { text?: string; calls?: Call[] };
type Step = (context: TranscriptContext) => Out | Promise<Out>;

let root: string;
let project: string;
let dataDir: string;
let globalDir: string;
let configPath: string;
let cacheDir: string;
let statusDir: string;
let hosts: CopilotHost[];
let host: CopilotHost;
let app: ReturnType<typeof createApp>;
let settings: ProviderSettings;
let originalEnv: NodeJS.ProcessEnv;
let script: Step[];
let seen: TranscriptContext[];
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };
const VIEW = randomUUID();

const setPermission = (value: string | null) =>
  writeFileSync(
    configPath,
    `${value === null ? "" : `copilot_file_tools = "${value}"\n`}global_dir = ${JSON.stringify(globalDir)}\nglobal_cache_dir = ${JSON.stringify(cacheDir)}\n`
  );

function boot(log?: ReturnType<typeof createLogger>) {
  const created = new CopilotHost(dataDir, settings, () => {});
  if (log) created.useLog(log as never);
  hosts.push(created);
  host = created;
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir,
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot: created,
    configPath,
    projectRoot: project,
    broadcast: () => {},
  });
}

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-file-tools-"));
  project = join(root, "project");
  dataDir = join(project, "literatures");
  globalDir = join(root, "global");
  configPath = join(root, "cfg", "config.toml");
  cacheDir = join(root, "cache-global");
  statusDir = join(root, "status");
  for (const dir of [project, dataDir, globalDir, statusDir, join(root, "cfg"), cacheDir])
    mkdirSync(dir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }));
  setPermission("ask");
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "xdg") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  script = [];
  seen = [];
  hosts = [];
  settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, context: TranscriptContext) {
      seen.push(structuredClone(context));
      const index = seen.length;
      const step = script[index - 1];
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const out = step ? await step(context) : { text: "done" };
        const message: AssistantMessage = {
          role: "assistant",
          content: out.calls?.length
            ? out.calls.map((call, at) => ({
                type: "toolCall" as const,
                id: `call_${index}_${at}`,
                name: call.name,
                arguments: call.args as never,
              }))
            : [{ type: "text", text: out.text ?? "done" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: out.calls?.length ? "toolUse" : "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      })();
      return stream;
    },
  });
  boot();
});
afterEach(async () => {
  fileToolsDefault.value = "off";
  for (const created of hosts) await created.close().catch(() => {});
  process.env = originalEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const page = (): PageContext => ({
  version: 1,
  viewId: VIEW,
  revision: 1,
  paneId: 1,
  view: "plan",
  status: "complete",
  otherPanes: [],
  plan: {
    rev: 1,
    mode: "list",
    selectedPlanId: null,
    saveState: "saved",
    groups: [],
    detail: null,
    plans: [],
  },
});
async function conversation(): Promise<string> {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  expect((await request(`/views/${VIEW}`, "PUT", page())).status).toBe(200);
  return created.conversation.id;
}
async function say(id: string, text = "Please work on the files"): Promise<void> {
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: VIEW,
    contextRevision: 1,
  });
  expect(sent.status).toBe(202);
}
const start = async (text?: string) => {
  const id = await conversation();
  await say(id, text);
  return id;
};
const runStatus = async (id: string) => (await host.snapshot(id)).conversation.run?.status;
async function until(id: string, wanted: string[]) {
  await vi.waitFor(async () => expect(wanted).toContain(await runStatus(id)), { timeout: 15_000 });
}
async function card(id: string, index = 0): Promise<CopilotConfirmation> {
  let found: CopilotConfirmation | undefined;
  await vi.waitFor(
    async () => {
      found = (await host.snapshot(id)).confirmations[index];
      expect(found).toBeDefined();
    },
    { timeout: 15_000 }
  );
  return found as CopilotConfirmation;
}
const answer = (
  confirmation: CopilotConfirmation,
  decision: "approve" | "decline",
  over: Record<string, unknown> = {}
) =>
  request(`/confirmations/${confirmation.id}`, "POST", {
    decision,
    viewId: VIEW,
    action: confirmation.action,
    objectId: confirmation.object.id,
    baseRev: confirmation.baseRev,
    ...over,
  });
const operations = async (id: string, target = host): Promise<CopilotOperation[]> =>
  (await target.snapshot(id)).messages.flatMap((m) => m.operations ?? []);
const bash = (command: string, extra: Record<string, unknown> = {}): Out => ({
  calls: [{ name: "bash", args: { command, ...extra } }],
});
const toolNamesOf = (context: TranscriptContext) =>
  getCurrentTools(context.messages).map((tool) => tool.name);
const lastToolText = (context: TranscriptContext): string => {
  const last = context.messages.filter((m) => m.role === "toolResult").at(-1);
  if (last?.role !== "toolResult") throw new Error("no tool result yet");
  return last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------- //
// The three settings
// ---------------------------------------------------------------------------------------------- //

test("off: the file and command tools are not registered at all", async () => {
  setPermission("off");
  script = [() => ({ text: "hello" })];
  const id = await start();
  await until(id, ["completed"]);
  expect(toolNamesOf(seen[0] as TranscriptContext)).not.toEqual(expect.arrayContaining(["bash"]));
  expect(toolNamesOf(seen[0] as TranscriptContext)).toEqual(
    expect.not.arrayContaining(["read", "edit", "write", "grep", "find", "ls"])
  );
});

test("ask is the default when the file does not set the key, and registers all seven tools", async () => {
  fileToolsDefault.value = undefined;
  setPermission(null);
  script = [() => ({ text: "hello" })];
  const id = await start();
  await until(id, ["completed"]);
  const names = toolNamesOf(seen[0] as TranscriptContext);
  for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"])
    expect(names).toContain(name);
  expect(names).toEqual(expect.arrayContaining(["plan", "workspace"]));
});

test("an invalid value is read as the default, not as a permission", async () => {
  fileToolsDefault.value = undefined;
  writeFileSync(
    configPath,
    `copilot_file_tools = "yolo"\nglobal_dir = ${JSON.stringify(globalDir)}\nglobal_cache_dir = ${JSON.stringify(cacheDir)}\n`
  );
  script = [() => bash("echo ran > should-wait.txt"), () => ({ text: "x" })];
  const id = await start();
  const shown = await card(id);
  expect(shown.action).toBe("run_command");
  expect(existsSync(join(project, "should-wait.txt"))).toBe(false);
  await answer(shown, "decline");
  await until(id, ["completed"]);
});

test("ask: a command waits for the real user; nothing runs until the click; the card shows the whole command and where it runs", async () => {
  script = [
    () => bash("echo hello > made.txt && echo done-output"),
    (ctx) => ({ text: `saw ${lastToolText(ctx).includes("done-output")}` }),
  ];
  const id = await start();
  const shown = await card(id);
  expect(shown).toMatchObject({
    action: "run_command",
    shell: "bash",
    command: "echo hello > made.txt && echo done-output",
    object: { kind: "command" },
  });
  expect((shown as { cwd: string }).cwd).toContain("project");
  expect(await runStatus(id)).toBe("waiting-for-user");
  expect(existsSync(join(project, "made.txt"))).toBe(false);
  const waiting = (await operations(id))[0];
  expect(waiting).toMatchObject({ tool: "bash", status: "confirmation_required" });
  expect(waiting?.fileTool).toMatchObject({
    kind: "command",
    command: "echo hello > made.txt && echo done-output",
  });
  // the model's transcript holds no way to approve: the card id is never in it
  expect(JSON.stringify(seen)).not.toContain(shown.id);

  const res = await answer(shown, "approve");
  expect(res.status).toBe(200);
  await until(id, ["completed"]);
  expect(readFileSync(join(project, "made.txt"), "utf8")).toBe("hello\n");
  const [done] = await operations(id);
  expect(done).toMatchObject({ tool: "bash", status: "ok" });
  expect(done?.fileTool).toMatchObject({ kind: "command", exitCode: 0, approval: "once" });
  expect(done?.fileTool?.output?.head).toEqual(["done-output"]);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
  expect((await host.snapshot(id)).messages.at(-1)?.text).toBe("saw true");
});

test("ask: declining runs nothing and the model is told", async () => {
  script = [() => bash("echo nope > declined.txt"), (ctx) => ({ text: lastToolText(ctx) })];
  const id = await start();
  const shown = await card(id);
  expect((await answer(shown, "decline")).status).toBe(200);
  await until(id, ["completed"]);
  expect(existsSync(join(project, "declined.txt"))).toBe(false);
  const [op] = await operations(id);
  expect(op).toMatchObject({ status: "declined" });
  expect(op?.fileTool?.beforeRun).toBeUndefined();
  expect((await host.snapshot(id)).messages.at(-1)?.text).toContain("declined");
});

test("ask: read, grep, find and ls never ask", async () => {
  writeFileSync(join(project, "a.txt"), "needle one\nsecond\n");
  script = [
    () => ({
      calls: [
        { name: "read", args: { path: "a.txt" } },
        { name: "ls", args: { path: "." } },
      ],
    }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  await until(id, ["completed"]);
  const ops = await operations(id);
  expect(ops.map((o) => `${o.tool}:${o.status}`)).toEqual(["read:ok", "ls:ok"]);
  expect(ops[0]?.fileTool).toMatchObject({ kind: "read", cwd: expect.stringContaining("project") });
  expect(ops[0]?.fileTool?.approval).toBeUndefined();
  expect(ops[0]?.fileTool?.output?.head).toContain("needle one");
  expect((await host.snapshot(id)).confirmations).toEqual([]);
});

test("auto: no card, every call is still a tool card with its output and 'auto' as its approval", async () => {
  setPermission("auto");
  script = [() => bash("echo automatic"), () => ({ text: "x" })];
  const id = await start();
  await until(id, ["completed"]);
  const [op] = await operations(id);
  expect(op?.status).toBe("ok");
  expect(op?.fileTool).toMatchObject({ approval: "auto", exitCode: 0 });
  expect(op?.fileTool?.output?.head).toEqual(["automatic"]);
});

test("a non-zero exit is an error row with the exit code and the output, and the model reads it", async () => {
  setPermission("auto");
  script = [() => bash("echo partial; exit 3"), (ctx) => ({ text: lastToolText(ctx) })];
  const id = await start();
  await until(id, ["completed"]);
  const [op] = await operations(id);
  expect(op).toMatchObject({ status: "error" });
  expect(op?.fileTool).toMatchObject({ exitCode: 3 });
  expect(op?.fileTool?.output?.head).toEqual(["partial"]);
  expect((await host.snapshot(id)).messages.at(-1)?.text).toContain("exited with code 3");
});

test("a long output keeps its head and tail; the model gets Pi's own result", async () => {
  setPermission("auto");
  script = [() => bash("seq 1 300"), () => ({ text: "x" })];
  const id = await start();
  await until(id, ["completed"]);
  const [op] = await operations(id);
  const output = op?.fileTool?.output;
  expect(output?.head[0]).toBe("1");
  expect(output?.head).toHaveLength(40);
  expect(output?.tail.at(-1)).toBe("300");
  expect(output?.tail).toHaveLength(20);
  expect(output?.omitted).toBe(300 - 60);
});

// ---------------------------------------------------------------------------------------------- //
// "Allow for this session"
// ---------------------------------------------------------------------------------------------- //

test("allow for this session: commands and writes are separate classes; the allowance does not cross conversations", async () => {
  script = [
    () => bash("echo one"),
    () => bash("echo two"),
    () => ({ calls: [{ name: "write", args: { path: "w1.txt", content: "w\n" } }] }),
    () => ({ text: "done" }),
  ];
  const id = await start();
  const first = await card(id);
  expect((await answer(first, "approve", { remember: true })).status).toBe(200);
  // the second command does not ask; the write is another class and does
  const second = await card(id);
  expect(second.action).toBe("write_file");
  expect(existsSync(join(project, "w1.txt"))).toBe(false);
  expect((await answer(second, "approve")).status).toBe(200);
  await until(id, ["completed"]);
  const ops = await operations(id);
  expect(ops.map((o) => o.fileTool?.approval)).toEqual(["session", "session", "once"]);
  expect(ops.map((o) => o.status)).toEqual(["ok", "ok", "ok"]);

  // another conversation asks again
  script = [() => bash("echo three"), () => ({ text: "x" })];
  seen = [];
  const other = await start();
  const asked = await card(other);
  expect(asked.action).toBe("run_command");
  await answer(asked, "decline");
  await until(other, ["completed"]);
});

test("allow for this session for writes covers edit and write, and a later command still asks", async () => {
  writeFileSync(join(project, "e.txt"), "alpha\nbeta\n");
  script = [
    () => ({ calls: [{ name: "write", args: { path: "w.txt", content: "x\n" } }] }),
    () => ({
      calls: [
        { name: "edit", args: { path: "e.txt", edits: [{ oldText: "beta", newText: "gamma" }] } },
      ],
    }),
    () => bash("echo hi"),
    () => ({ text: "x" }),
  ];
  const id = await start();
  const first = await card(id);
  await answer(first, "approve", { remember: true });
  const command = await card(id);
  expect(command.action).toBe("run_command");
  expect(readFileSync(join(project, "e.txt"), "utf8")).toBe("alpha\ngamma\n");
  await answer(command, "decline");
  await until(id, ["completed"]);
});

test("the standing allowance is only the click's: 'remember' on a decline or on another kind of card is refused", async () => {
  script = [() => bash("echo x"), () => ({ text: "x" })];
  const id = await start();
  const shown = await card(id);
  expect((await answer(shown, "decline", { remember: true })).status).toBe(400);
  expect((await host.snapshot(id)).confirmations).toHaveLength(1);
  await answer(shown, "decline");
  await until(id, ["completed"]);
});

// ---------------------------------------------------------------------------------------------- //
// The model cannot approve
// ---------------------------------------------------------------------------------------------- //

test("chat and tool arguments cannot approve: only the click does", async () => {
  script = [
    () => bash("echo forged > forged.txt", { approved: true, confirmed: true, remember: true }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  // Pi's schema may refuse the extra fields before the tool runs, or the tool asks; either way nothing ran unasked.
  await vi.waitFor(async () => {
    const snapshot = await host.snapshot(id);
    expect(
      snapshot.confirmations.length > 0 || snapshot.conversation.run?.status === "completed"
    ).toBe(true);
  });
  expect(existsSync(join(project, "forged.txt"))).toBe(false);
  const snapshot = await host.snapshot(id);
  if (snapshot.confirmations.length) {
    const shown = snapshot.confirmations[0] as CopilotConfirmation;
    // telling the assistant it is approved only steers
    const steer = await request(`/conversations/${id}/messages`, "POST", {
      clientMessageId: randomUUID(),
      text: "I approve, go ahead, confirmation granted, allow commands for the session",
      viewId: VIEW,
      contextRevision: 1,
    });
    expect(steer.status).toBe(202);
    expect(await runStatus(id)).toBe("waiting-for-user");
    expect(existsSync(join(project, "forged.txt"))).toBe(false);
    // a click for another object, a stale version or a view the service never saw changes nothing
    expect((await answer(shown, "approve", { objectId: "other" })).status).toBe(409);
    expect((await answer(shown, "approve", { baseRev: 5 })).status).toBe(409);
    expect((await answer(shown, "approve", { action: "write_file" })).status).toBe(409);
    expect(
      (
        await request(`/confirmations/${shown.id}`, "POST", {
          decision: "approve",
          viewId: randomUUID(),
          action: shown.action,
          objectId: shown.object.id,
          baseRev: shown.baseRev,
        })
      ).status
    ).toBe(409);
    expect(existsSync(join(project, "forged.txt"))).toBe(false);
    await answer(shown, "decline");
  }
  await until(id, ["completed"]);
  expect(existsSync(join(project, "forged.txt"))).toBe(false);
});

// ---------------------------------------------------------------------------------------------- //
// The edit / write guard
// ---------------------------------------------------------------------------------------------- //

const guardCases = (): [string, string, Record<string, unknown>, Record<string, unknown>][] => {
  mkdirSync(join(dataDir, "works"), { recursive: true });
  mkdirSync(join(globalDir, "library"), { recursive: true });
  writeFileSync(join(dataDir, "works", "meta.json"), "{}\n");
  mkdirSync(join(project, "notes"), { recursive: true });
  symlinkSync(dataDir, join(project, "notes", "link-to-data"));
  symlinkSync(join(dataDir, "works", "meta.json"), join(project, "notes", "link-to-file.json"));
  symlinkSync(globalDir, join(project, "notes", "link-to-global"));
  return [
    [
      "a direct path in the data folder",
      "direct",
      { path: "literatures/works/new.json", content: "x" },
      {},
    ],
    [
      "an absolute path in the data folder",
      "direct",
      { path: join(dataDir, "abs.json"), content: "x" },
      {},
    ],
    [
      "a path through .. into the data folder",
      "parent_ref",
      { path: "notes/../literatures/works/dots.json", content: "x" },
      {},
    ],
    [
      "a symbolic link to the data folder",
      "symlink",
      { path: "notes/link-to-data/via-link.json", content: "x" },
      {},
    ],
    [
      "a symbolic link to a file inside it",
      "symlink",
      { path: "notes/link-to-file.json", content: "x" },
      {},
    ],
    [
      "a file that does not exist in a folder that does not exist yet",
      "direct",
      { path: "literatures/not/yet/there.json", content: "x" },
      {},
    ],
    [
      "the global data folder",
      "direct",
      { path: join(globalDir, "library", "g.json"), content: "x" },
      {},
    ],
    [
      "a symbolic link to the global data folder",
      "symlink",
      { path: "notes/link-to-global/g2.json", content: "x" },
      {},
    ],
  ];
};

for (const mode of ["ask", "auto"] as const)
  test(`${mode}: write and edit refuse targets inside the data folders (links, .., not-yet-existing files), before any card`, async () => {
    setPermission(mode);
    const cases = guardCases();
    const unchanged = readFileSync(join(dataDir, "works", "meta.json"), "utf8");
    script = [
      ...cases.map(
        ([, , args]) =>
          (): Out => ({ calls: [{ name: "write", args }] })
      ),
      () => ({
        calls: [
          {
            name: "edit",
            args: {
              path: "literatures/works/meta.json",
              edits: [{ oldText: "{}", newText: '{"x":1}' }],
            },
          },
        ],
      }),
      () => ({ text: "x" }),
    ];
    const id = await start();
    await until(id, ["completed"]);
    expect((await host.snapshot(id)).confirmations).toEqual([]);
    const ops = await operations(id);
    expect(ops).toHaveLength(cases.length + 1);
    cases.forEach(([label, via], at) => {
      const op = ops[at] as CopilotOperation;
      expect(op.status, label).toBe("rejected");
      expect(op.fileTool?.guard, label).toMatchObject({
        inside: label.includes("global") ? "global_dir" : "data_dir",
        via,
      });
    });
    expect(ops.at(-1)).toMatchObject({ tool: "edit", status: "rejected" });
    expect(readFileSync(join(dataDir, "works", "meta.json"), "utf8")).toBe(unchanged);
    expect(existsSync(join(dataDir, "works", "new.json"))).toBe(false);
    expect(existsSync(join(dataDir, "not"))).toBe(false);
    expect(existsSync(join(globalDir, "library", "g.json"))).toBe(false);
    // the model is told which tools to use instead
    expect(JSON.stringify(seen.at(-1))).toContain("business tools");
  });

test("a write outside the data folders works, creates parent folders, and a project folder that merely shares a prefix is not protected", async () => {
  setPermission("auto");
  mkdirSync(join(project, "literatures-notes"), { recursive: true });
  script = [
    () => ({
      calls: [{ name: "write", args: { path: "out/deep/file.txt", content: "line1\nline2\n" } }],
    }),
    () => ({
      calls: [{ name: "write", args: { path: "literatures-notes/ok.txt", content: "ok\n" } }],
    }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  await until(id, ["completed"]);
  expect(readFileSync(join(project, "out/deep/file.txt"), "utf8")).toBe("line1\nline2\n");
  expect(readFileSync(join(project, "literatures-notes/ok.txt"), "utf8")).toBe("ok\n");
  const ops = await operations(id);
  expect(ops.map((o) => o.status)).toEqual(["ok", "ok"]);
  expect(ops[0]?.fileTool?.change).toMatchObject({
    lines: 2,
    overwrite: false,
    preview: ["line1", "line2"],
  });
});

test("the edit card shows the diff it would make, and the write card says when it overwrites", async () => {
  writeFileSync(join(project, "outline.md"), "# One\n\nold line\n\n# Two\n");
  writeFileSync(join(project, "old.txt"), "previous\n");
  script = [
    () => ({
      calls: [
        {
          name: "edit",
          args: { path: "outline.md", edits: [{ oldText: "old line", newText: "new line\nmore" }] },
        },
      ],
    }),
    () => ({ calls: [{ name: "write", args: { path: "old.txt", content: "fresh\n" } }] }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  const edit = await card(id);
  expect(edit).toMatchObject({ action: "edit_file", path: "outline.md" });
  const change = (
    edit as { change: { diff: { k: string; s: string }[]; added: number; removed: number } }
  ).change;
  expect(change).toMatchObject({ added: 2, removed: 1 });
  expect(change.diff.filter((l) => l.k === "del").map((l) => l.s)).toEqual(["old line"]);
  expect(change.diff.filter((l) => l.k === "add").map((l) => l.s)).toEqual(["new line", "more"]);
  expect(readFileSync(join(project, "outline.md"), "utf8")).toContain("old line");
  await answer(edit, "approve");
  const overwrite = await card(id);
  expect(overwrite).toMatchObject({
    action: "write_file",
    change: { overwrite: true, oldBytes: 9, lines: 1 },
  });
  await answer(overwrite, "approve");
  await until(id, ["completed"]);
  expect(readFileSync(join(project, "outline.md"), "utf8")).toBe(
    "# One\n\nnew line\nmore\n\n# Two\n"
  );
  expect(readFileSync(join(project, "old.txt"), "utf8")).toBe("fresh\n");
});

// ---------------------------------------------------------------------------------------------- //
// Stop
// ---------------------------------------------------------------------------------------------- //

test("Stop while a command runs kills the command and the child it started, and reports it interrupted", async () => {
  setPermission("auto");
  script = [
    () => bash("sleep 300 & echo $! > child.pid; echo started; wait"),
    () => ({ text: "should not matter" }),
  ];
  const id = await start();
  const pidFile = join(project, "child.pid");
  await vi.waitFor(
    () => expect(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "").toBe(true),
    {
      timeout: 15_000,
    }
  );
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  expect(alive(pid)).toBe(true);
  // it shows as running, with its start time
  const running = (await operations(id)).find((o) => o.tool === "bash");
  expect(running?.status).toBe("pending");
  expect(running?.fileTool?.startedAt).toBeDefined();

  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  await until(id, ["stopped"]);
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
  const [op] = await operations(id);
  expect(op).toMatchObject({ tool: "bash", status: "interrupted" });
  expect(op?.fileTool?.beforeRun).toBeFalsy();
  expect(op?.fileTool?.durationMs).toBeGreaterThanOrEqual(0);
});

test("Stop while the card waits: nothing ran, the call is interrupted before it began", async () => {
  script = [() => bash("echo no > stopped-first.txt"), () => ({ text: "x" })];
  const id = await start();
  await card(id);
  expect((await request(`/conversations/${id}/stop`, "POST")).status).toBe(200);
  await until(id, ["stopped"]);
  expect(existsSync(join(project, "stopped-first.txt"))).toBe(false);
  const [op] = await operations(id);
  expect(op).toMatchObject({ status: "interrupted" });
  expect(op?.fileTool?.beforeRun).toBe(true);
  expect((await host.snapshot(id)).confirmations).toEqual([]);
});

test("closing the host ends a running command and its children; after a restart the call stays interrupted and is not rerun", async () => {
  setPermission("auto");
  const marker = join(project, "runs.txt");
  script = [
    () => bash(`echo run >> runs.txt; sleep 300 & echo $! > child.pid; wait`),
    () => ({ text: "x" }),
  ];
  const id = await start();
  const pidFile = join(project, "child.pid");
  await vi.waitFor(
    () => expect(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "").toBe(true),
    {
      timeout: 15_000,
    }
  );
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await host.close();
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
  // a new service over the same data
  boot();
  const snapshot = await host.snapshot(id);
  expect(snapshot.conversation.run?.status).toBe("interrupted");
  const [op] = await operations(id);
  // settled when the conversation is loaded, not only at the next run
  expect(op?.status).toBe("interrupted");
  expect(op?.fileTool?.target).toContain("echo run");
  expect(readFileSync(marker, "utf8")).toBe("run\n");
  // resuming settles the orphan call as interrupted and does not run the command again
  script = [() => ({ text: "resumed" })];
  seen = [];
  expect((await request(`/views/${VIEW}`, "PUT", page())).status).toBe(200);
  const resumed = await request(`/conversations/${id}/resume`, "POST", {
    clientMessageId: randomUUID(),
    viewId: VIEW,
    contextRevision: 1,
  });
  expect(resumed.status).toBe(202);
  await until(id, ["completed"]);
  expect(readFileSync(marker, "utf8")).toBe("run\n");
  const [after] = await operations(id);
  expect(after).toMatchObject({ status: "interrupted" });
  expect(after?.fileTool?.beforeRun).toBeFalsy();
});

// ---------------------------------------------------------------------------------------------- //
// grep and find need programs the workbench does not download
// ---------------------------------------------------------------------------------------------- //

test("grep and find answer plainly when ripgrep / fd are not installed; they never download", async () => {
  setPermission("auto");
  const path = process.env.PATH;
  script = [
    () => ({ calls: [{ name: "grep", args: { pattern: "x" } }] }),
    () => ({ calls: [{ name: "find", args: { pattern: "*.txt" } }] }),
    (ctx) => ({ text: lastToolText(ctx) }),
  ];
  let id: string;
  try {
    process.env = { ...process.env, PATH: "/nonexistent-bin" };
    id = await start();
    await until(id, ["completed"]);
  } finally {
    process.env = { ...process.env, PATH: path };
  }
  const ops = await operations(id);
  expect(ops.map((o) => `${o.tool}:${o.status}`)).toEqual(["grep:error", "find:error"]);
  expect((await host.snapshot(id)).messages.at(-1)?.text).toContain("shell tool");
});

// ---------------------------------------------------------------------------------------------- //
// What the card shows is what runs; where a write lands is what the guard judges (review round)
// ---------------------------------------------------------------------------------------------- //

for (const mode of ["ask", "auto"] as const)
  test(`${mode}: a command or a path longer than the card can show whole is refused, never cut and then asked`, async () => {
    setPermission(mode);
    // 20,100 harmless characters, then the part that would be cut off the card
    const hidden = `echo ${"a".repeat(20_100)}; touch pwned.txt`;
    script = [
      () => bash(hidden),
      () => ({
        calls: [{ name: "write", args: { path: `${"d/".repeat(300)}x.txt`, content: "x" } }],
      }),
      (ctx) => ({ text: lastToolText(ctx) }),
    ];
    const id = await start();
    await until(id, ["completed"]);
    expect((await host.snapshot(id)).confirmations).toEqual([]);
    expect(existsSync(join(project, "pwned.txt"))).toBe(false);
    expect(existsSync(join(project, "d"))).toBe(false);
    const ops = await operations(id);
    expect(ops.map((o) => o.status)).toEqual(["rejected", "rejected"]);
    expect((await host.snapshot(id)).messages.at(-1)?.text).toContain("Use a shorter path");
    // a command right at the limit still goes through the card whole
  });

test("a command exactly at the limit is shown whole on the card", async () => {
  const command = `echo ${"b".repeat(19_990)}`;
  expect(command.length).toBeLessThanOrEqual(20_000);
  script = [() => bash(command), () => ({ text: "x" })];
  const id = await start();
  const shown = await card(id);
  expect((shown as { command: string }).command).toBe(command);
  await answer(shown, "decline");
  await until(id, ["completed"]);
});

test("the guard judges the path Pi acts on: Unicode spaces are normalised like Pi does, so a data folder with a space cannot be reached with a no-break space", async () => {
  await host.close();
  dataDir = join(project, "my data");
  mkdirSync(dataDir, { recursive: true });
  boot();
  setPermission("auto");
  script = [
    () => ({ calls: [{ name: "write", args: { path: "my\u00A0data/x.json", content: "x" } }] }),
    () => ({ calls: [{ name: "write", args: { path: "my\u202Fdata/y.json", content: "x" } }] }),
    () => ({ calls: [{ name: "write", args: { path: "@my data/z.json", content: "x" } }] }),
    () => ({
      calls: [{ name: "write", args: { path: `file://${join(dataDir, "f.json")}`, content: "x" } }],
    }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  await until(id, ["completed"]);
  expect((await operations(id)).map((o) => o.status)).toEqual([
    "rejected",
    "rejected",
    "rejected",
    "rejected",
  ]);
  expect(readdirSync(dataDir).filter((name) => name.endsWith(".json"))).toEqual([]);
});

test("the path rules the guard uses are Pi's: the same inputs land in the same place when Pi itself writes", async () => {
  const cwd = join(root, "pi-same");
  mkdirSync(cwd, { recursive: true });
  const inputs = [
    "plain.txt",
    "with\u00A0nbsp.txt",
    "narrow\u202Fspace.txt",
    "@at-prefix.txt",
    "sub/../dots.txt",
    "./dir/./file.txt",
    `file://${join(cwd, "url.txt")}`,
    "~/tilde.txt",
  ];
  const definition = createWriteToolDefinition(cwd);
  for (const raw of inputs) {
    const expected = piResolve(raw, cwd);
    mkdirSync(join(expected, ".."), { recursive: true });
    await definition.execute("c", { path: raw, content: "x" }, undefined, undefined, {
      cwd,
    } as never);
    expect(existsSync(expected), raw).toBe(true);
    rmSync(expected);
  }
});

test("a dangling symbolic link into the data folder, a loop of links and an unreadable chain are refused, ask and auto alike", async () => {
  setPermission("auto");
  mkdirSync(join(dataDir, "works"), { recursive: true });
  mkdirSync(join(project, "notes"), { recursive: true });
  symlinkSync(
    join(dataDir, "works", "not-there-yet.json"),
    join(project, "notes", "dangling.json")
  );
  symlinkSync(join(project, "notes", "b"), join(project, "notes", "a"));
  symlinkSync(join(project, "notes", "a"), join(project, "notes", "b"));
  // a chain of relative links that ends inside the data folder
  symlinkSync("../literatures/works", join(project, "notes", "hop1"));
  symlinkSync("hop1", join(project, "notes", "hop2"));
  script = [
    () => ({ calls: [{ name: "write", args: { path: "notes/dangling.json", content: "x" } }] }),
    () => ({ calls: [{ name: "write", args: { path: "notes/a", content: "x" } }] }),
    () => ({ calls: [{ name: "write", args: { path: "notes/hop2/chain.json", content: "x" } }] }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  await until(id, ["completed"]);
  const ops = await operations(id);
  expect(ops.map((o) => o.status)).toEqual(["rejected", "rejected", "rejected"]);
  expect(ops[0]?.fileTool?.guard).toMatchObject({ inside: "data_dir", via: "symlink" });
  expect(ops[1]?.fileTool?.guard).toBeUndefined(); // a loop: cannot be told where it lands
  expect(ops[2]?.fileTool?.guard).toMatchObject({ inside: "data_dir", via: "symlink" });
  expect(existsSync(join(dataDir, "works", "not-there-yet.json"))).toBe(false);
  expect(existsSync(join(dataDir, "works", "chain.json"))).toBe(false);
});

for (const mode of ["ask", "auto"] as const)
  test(`${mode}: edit and write refuse the folder of config.toml and the global cache folder, so a write permission cannot rewrite the settings`, async () => {
    setPermission(mode);
    const config = readFileSync(configPath, "utf8");
    writeFileSync(join(cacheDir, "c.bin"), "cache");
    script = [
      () => ({
        calls: [
          { name: "write", args: { path: configPath, content: 'copilot_file_tools = "auto"\n' } },
        ],
      }),
      () => ({
        calls: [
          {
            name: "edit",
            args: { path: configPath, edits: [{ oldText: "ask", newText: "auto" }] },
          },
        ],
      }),
      () => ({
        calls: [{ name: "write", args: { path: join(cacheDir, "new.bin"), content: "x" } }],
      }),
      () => ({ calls: [{ name: "write", args: { path: join(cacheDir, "c.bin"), content: "x" } }] }),
      () => ({ text: "x" }),
    ];
    const id = await start();
    await until(id, ["completed"]);
    expect((await host.snapshot(id)).confirmations).toEqual([]);
    const ops = await operations(id);
    expect(ops.map((o) => o.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(ops.map((o) => o.fileTool?.guard?.inside)).toEqual([
      "config_dir",
      "config_dir",
      "cache_dir",
      "cache_dir",
    ]);
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(readFileSync(join(cacheDir, "c.bin"), "utf8")).toBe("cache");
    expect(existsSync(join(cacheDir, "new.bin"))).toBe(false);
    expect(JSON.stringify(seen.at(-1))).toContain("not through edit or write");
  });

test("the card shows where the path really lands", async () => {
  mkdirSync(join(project, "real"), { recursive: true });
  symlinkSync(join(project, "real"), join(project, "alias"));
  script = [
    () => ({ calls: [{ name: "write", args: { path: "alias/f.txt", content: "x" } }] }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  const shown = await card(id);
  expect(shown).toMatchObject({ action: "write_file", path: "alias/f.txt" });
  expect((shown as { resolved: string }).resolved).toMatch(/real\/f\.txt$/);
  await answer(shown, "decline");
  await until(id, ["completed"]);
});

test("the output sampler is bounded: a huge single line and split multi-byte characters", () => {
  const sampler = new LineSampler();
  const started = Date.now();
  const chunk = Buffer.alloc(1024 * 1024, "x");
  for (let at = 0; at < 40; at++) sampler.feed(chunk);
  sampler.feed(Buffer.from("\nlast\n"));
  const out = sampler.result();
  expect(Date.now() - started).toBeLessThan(3000);
  expect(sampler.totalBytes).toBe(40 * 1024 * 1024 + 6);
  expect(out?.head[0]?.length).toBe(500);
  expect(out?.head[0]?.endsWith("…")).toBe(true);
  expect(out?.head[1]).toBe("last");
  const split = new LineSampler();
  const bytes = Buffer.from("中文字符\n");
  split.feed(bytes.subarray(0, 2));
  split.feed(bytes.subarray(2, 5));
  split.feed(bytes.subarray(5));
  expect(split.result()?.head).toEqual(["中文字符"]);
  const crlf = new LineSampler();
  crlf.feed(Buffer.from("a\r"));
  crlf.feed(Buffer.from("\nb\r\nc"));
  expect(crlf.result()?.head).toEqual(["a", "b", "c"]);
});

// ---------------------------------------------------------------------------------------------- //
// Second review round
// ---------------------------------------------------------------------------------------------- //

test("a symbolic link whose target has .. is walked the way the kernel does: the links before it are followed first", async () => {
  setPermission("auto");
  mkdirSync(join(dataDir, "sub"), { recursive: true });
  mkdirSync(join(project, "notes"), { recursive: true });
  symlinkSync(join(dataDir, "sub"), join(project, "notes", "z"));
  symlinkSync("z/../x.txt", join(project, "notes", "a"));
  expect(await resolveReal(join(project, "notes", "a"))).toBe(join(dataDir, "x.txt"));
  script = [
    () => ({ calls: [{ name: "write", args: { path: "notes/a", content: "x" } }] }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  await until(id, ["completed"]);
  expect((await operations(id)).map((o) => o.status)).toEqual(["rejected"]);
  expect(existsSync(join(dataDir, "x.txt"))).toBe(false);
});

test("a project folder whose name has a no-break space: relative writes land inside it, not in a sibling made by normalising the folder name", async () => {
  await host.close();
  project = join(root, "pro\u00A0ject\u3000x");
  dataDir = join(project, "literatures");
  mkdirSync(dataDir, { recursive: true });
  boot();
  setPermission("auto");
  script = [
    () => ({ calls: [{ name: "write", args: { path: "out.txt", content: "x" } }] }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  await until(id, ["completed"]);
  expect((await operations(id)).map((o) => o.status)).toEqual(["ok"]);
  expect(existsSync(join(project, "out.txt"))).toBe(true);
  expect(readdirSync(root).filter((name) => name.startsWith("pro") && name !== "project")).toEqual([
    "pro\u00A0ject\u3000x",
  ]);
});

test("Pi's path rules, with a working directory that has Unicode spaces, and the pinned Pi version", async () => {
  const cwd = join(root, "pi\u00A0cwd\u3000dir");
  mkdirSync(cwd, { recursive: true });
  const definition = createWriteToolDefinition(cwd);
  for (const raw of ["rel.txt", "a\u00A0b.txt", "./x/../y.txt"]) {
    const expected = piResolve(raw, cwd);
    mkdirSync(join(expected, ".."), { recursive: true });
    await definition.execute("c", { path: raw, content: "x" }, undefined, undefined, {
      cwd,
    } as never);
    expect(existsSync(expected), raw).toBe(true);
    rmSync(expected);
  }
  // `piResolve` copies rules of this exact Pi version; a new version must be read again (utils/paths.js resolveToCwd)
  const pkg = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
        "..",
        "package.json"
      ),
      "utf8"
    )
  );
  expect(pkg.version).toBe("1.0.0");
});

test("grep and find start a program, so they are command-class: a card with the program and its arguments, the session's command allowance, none in auto", async () => {
  const bin = join(root, "bin-stub");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(project, "inbox"), { recursive: true });
  const marker = join(root, "rg-ran.txt");
  writeFileSync(
    join(bin, "rg"),
    `#!/bin/sh\ncase "$*" in *--json*) echo ran >> ${JSON.stringify(marker)};; esac\nexit 1\n`,
    { mode: 0o755 }
  );
  const path = process.env.PATH;
  try {
    process.env = { ...process.env, PATH: `${bin}:${path}` };
    script = [
      () => ({
        calls: [{ name: "grep", args: { pattern: "needle", path: "inbox", ignoreCase: true } }],
      }),
      () => ({ calls: [{ name: "ls", args: { path: "." } }] }),
      () => ({ calls: [{ name: "grep", args: { pattern: "second" } }] }),
      () => ({ text: "x" }),
    ];
    const id = await start();
    const shown = await card(id);
    expect(shown.action).toBe("run_command");
    const command = (shown as { command: string }).command;
    expect(command).toContain(join(bin, "rg"));
    expect(command).toContain("--ignore-case");
    expect(command).toContain("needle");
    expect(existsSync(marker)).toBe(false);
    await answer(shown, "approve", { remember: true });
    await until(id, ["completed"]);
    // the first ran after the click; the second needed no card (the command allowance) and ls never asked
    expect(readFileSync(marker, "utf8")).toBe("ran\nran\n");
    const ops = await operations(id);
    expect(ops.map((o) => `${o.tool}:${o.fileTool?.approval ?? "-"}`)).toEqual([
      "grep:session",
      "ls:-",
      "grep:session",
    ]);
    // auto: no card at all
    setPermission("auto");
    script = [
      () => ({ calls: [{ name: "find", args: { pattern: "*.txt" } }] }),
      () => ({ text: "x" }),
    ];
    seen = [];
    writeFileSync(
      join(bin, "fd"),
      `#!/bin/sh\ncase "$*" in *--glob*) echo fd >> ${JSON.stringify(marker)};; esac\nexit 0\n`,
      { mode: 0o755 }
    );
    const other = await start();
    await until(other, ["completed"]);
    expect((await host.snapshot(other)).confirmations).toEqual([]);
    expect(readFileSync(marker, "utf8")).toContain("fd");
  } finally {
    process.env = { ...process.env, PATH: path };
  }
});

test("a write permission cannot plant the program grep would run: edit and write refuse Pi's bin folder", async () => {
  setPermission("auto");
  const piBin = join(homedir(), ".pi", "agent", "bin"); // the isolated HOME of the test run, never the real one
  mkdirSync(piBin, { recursive: true });
  script = [
    () => ({
      calls: [
        { name: "write", args: { path: join(piBin, "rg"), content: "#!/bin/sh\necho pwned\n" } },
      ],
    }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  await until(id, ["completed"]);
  const [op] = await operations(id);
  expect(op).toMatchObject({ status: "rejected" });
  expect(op?.fileTool?.guard).toMatchObject({ inside: "tools_dir" });
  expect(existsSync(join(piBin, "rg"))).toBe(false);
  rmSync(join(homedir(), ".pi"), { recursive: true, force: true }); // later tests count on no rg/fd there
});

test("an edit of a file too big to read for the card still shows what it adds and removes, and says the context is left out", async () => {
  writeFileSync(join(project, "big.txt"), `needle\n${"y".repeat(4_100_000)}\n`);
  script = [
    () => ({
      calls: [
        {
          name: "edit",
          args: { path: "big.txt", edits: [{ oldText: "needle", newText: "thread\nsecond" }] },
        },
      ],
    }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  const shown = await card(id);
  const change = (
    shown as {
      change: {
        added: number;
        removed: number;
        contextOmitted?: boolean;
        diff: { k: string; s: string }[];
      };
    }
  ).change;
  expect(change).toMatchObject({ added: 2, removed: 1, contextOmitted: true });
  expect(change.diff.filter((l) => l.k === "add").map((l) => l.s)).toEqual(["thread", "second"]);
  await answer(shown, "approve");
  await until(id, ["completed"]);
  // and the finished card keeps the numbers (not +0 -0)
  expect((await operations(id))[0]?.fileTool?.result).toMatchObject({
    unit: "diff",
    added: 2,
    removed: 1,
  });
});

test("an edit's finished card carries its real +/- numbers", async () => {
  setPermission("auto");
  writeFileSync(join(project, "e2.txt"), "one\ntwo\nthree\n");
  script = [
    () => ({
      calls: [
        {
          name: "edit",
          args: { path: "e2.txt", edits: [{ oldText: "two", newText: "2\n2b\n2c" }] },
        },
      ],
    }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  await until(id, ["completed"]);
  expect((await operations(id))[0]?.fileTool?.result).toMatchObject({
    unit: "diff",
    added: 3,
    removed: 1,
  });
});

test("the sampler counts lines the same however the chunks are cut (CR, LF, CR LF, CR CR, multi-byte)", () => {
  const alphabet = ["a", "b", "\n", "\r", "\r\n", "\r\r", "中", "é", "😀"];
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 300; round++) {
    let text = "";
    for (let at = 0, n = 1 + rnd(40); at < n; at++) text += alphabet[rnd(alphabet.length)];
    const bytes = Buffer.from(text);
    const whole = new LineSampler();
    whole.feed(bytes);
    const expected = whole.result();
    const cut = new LineSampler();
    for (let at = 0; at < bytes.length; ) {
      const size = 1 + rnd(5);
      cut.feed(bytes.subarray(at, at + size));
      at += size;
    }
    expect(cut.result(), JSON.stringify(text)).toEqual(expected);
    // and against the plain definition: every CR, LF or CR LF ends a line
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const got = expected ? expected.head.length + expected.tail.length + expected.omitted : 0;
    expect(got, JSON.stringify(text)).toBe(lines.length);
  }
});

test("the card shows the changed lines whole and refuses a change it cannot show whole; long lines (a .bib) are fine, a big total is not", async () => {
  setPermission("ask");
  const longLine = `  abstract = {${"w".repeat(9000)}},`;
  writeFileSync(join(project, "refs.bib"), `@article{k,\n  title = {T},\n}\n`);
  script = [
    () => ({
      calls: [
        {
          name: "edit",
          args: { path: "refs.bib", edits: [{ oldText: "  title = {T},", newText: longLine }] },
        },
      ],
    }),
    () => ({
      calls: [
        { name: "write", args: { path: "w.bib", content: `${longLine}\n${"x\n".repeat(10)}` } },
      ],
    }),
    () => ({
      calls: [{ name: "write", args: { path: "huge.txt", content: "z".repeat(300_000) } }],
    }),
    () => ({
      calls: [
        {
          name: "edit",
          args: { path: "refs.bib", edits: [{ oldText: "T", newText: "q".repeat(300_000) }] },
        },
      ],
    }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  const edit = await card(id);
  const added = (edit as { change: { diff: { k: string; s: string }[] } }).change.diff.find(
    (l) => l.k === "add"
  );
  expect(added?.s).toBe(longLine); // whole, not cut at 500
  await answer(edit, "approve");
  const write = await card(id);
  const preview = (write as { change: { preview: string[]; previewMore: number } }).change;
  expect(preview.preview[0]).toBe(longLine);
  expect(preview.previewMore).toBeGreaterThan(0);
  await answer(write, "decline");
  await until(id, ["completed"]);
  const ops = await operations(id);
  expect(ops.map((o) => o.status)).toEqual(["ok", "declined", "rejected", "rejected"]);
  expect(existsSync(join(project, "huge.txt"))).toBe(false);
});

test("the approval's re-check also compares where the path lands: a link re-pointed while the card was open is refused", async () => {
  mkdirSync(join(project, "ok1"), { recursive: true });
  mkdirSync(join(project, "ok2"), { recursive: true });
  symlinkSync(join(project, "ok1"), join(project, "swap"));
  script = [
    () => ({ calls: [{ name: "write", args: { path: "swap/f.txt", content: "x" } }] }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  const shown = await card(id);
  rmSync(join(project, "swap"));
  symlinkSync(join(project, "ok2"), join(project, "swap"));
  await answer(shown, "approve");
  await until(id, ["completed"]);
  expect((await operations(id)).map((o) => o.status)).toEqual(["rejected"]);
  expect(existsSync(join(project, "ok1", "f.txt"))).toBe(false);
  expect(existsSync(join(project, "ok2", "f.txt"))).toBe(false);
});

test("Windows paths that name the same place another way are refused, and containment is by path.win32 rules; macOS names compare after NFC", () => {
  for (const raw of [
    "\\\\?\\C:\\data\\x",
    "\\\\.\\C:\\data\\x",
    "\\\\localhost\\C$\\data\\x",
    "\\\\127.0.0.1\\c$\\x",
    "//?/C:/data/x",
    "\\\\SERVER\\Admin$\\x",
  ])
    expect(windowsPathRefusal(raw, "SERVER"), raw).toBe(true);
  for (const raw of ["C:\\data\\x", "out\\x.txt", "\\\\fileserver\\share\\x"])
    expect(windowsPathRefusal(raw, "SERVER"), raw).toBe(false);
  expect(isInside("C:\\Data\\X\\f", "c:\\data", "win32")).toBe(true);
  expect(isInside("C:/data/x", "C:\\data", "win32")).toBe(true);
  expect(isInside("C:\\data2\\x", "C:\\data", "win32")).toBe(false);
  expect(isInside("C:\\data\\..\\other", "C:\\data", "win32")).toBe(false);
  expect(isInside("/Users/x/Cafe\u0301/f", "/Users/x/Caf\u00e9", "darwin")).toBe(true);
  expect(isInside("/Users/x/Cafe\u0301/f", "/Users/x/Caf\u00e9", "linux")).toBe(false);
});

// ---------------------------------------------------------------------------------------------- //
// The user log
// ---------------------------------------------------------------------------------------------- //

test("the user log records the event, the tool, how it ended, the exit code and the time — never the command, the path or the output", async () => {
  setPermission("auto");
  const sink = createMemorySink();
  const log = createLogger({ events: SERVER_LOG_EVENTS, sink, level: "debug" });
  await host.close();
  boot(log);
  const COMMAND = "ZqxMarkCommand_secret-token-42";
  script = [
    () => bash(`echo ZqxMarkOutput_${"abc"}; echo ${COMMAND} > ZqxMarkFileName.txt; exit 5`),
    () => ({
      calls: [{ name: "write", args: { path: "ZqxMarkWritten.txt", content: "ZqxMarkContent" } }],
    }),
    () => ({ text: "x" }),
  ];
  const id = await start();
  await until(id, ["completed"]);
  const calls = sink.records().filter((r) => r.event === "copilot.tool_called");
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ tool: "bash", result: "error", exit_code: 5 });
  expect(calls[1]).toMatchObject({ tool: "write", result: "ok" });
  expect(calls[1]).not.toHaveProperty("exit_code");
  for (const call of calls) expect(call).toHaveProperty("duration_ms");
  const text = sink.lines.join("\n");
  for (const marker of [
    "ZqxMarkOutput",
    COMMAND,
    "ZqxMarkFileName",
    "ZqxMarkWritten",
    "ZqxMarkContent",
    "secret-token",
  ])
    expect(text).not.toContain(marker);
});

test("a call with no result after a crash is settled as interrupted, never rerun; Windows gets powershell instead of bash", () => {
  const cwd = join(root, "project");
  const command = settledFileToolCall("c1", "bash", { command: "rm -rf x" }, cwd, "interrupted");
  expect(command?.operation).toMatchObject({
    tool: "bash",
    status: "interrupted",
    fileTool: { kind: "command", beforeRun: false },
  });
  expect(JSON.stringify(command?.payload)).toContain("NOT rerun");
  expect(
    settledFileToolCall("c2", "bash", { command: "x" }, cwd, "not_started")?.operation.fileTool
      ?.beforeRun
  ).toBe(true);
  expect(settledFileToolCall("c3", "write", { path: "a" }, cwd, "declined")?.operation.status).toBe(
    "declined"
  );
  expect(settledFileToolCall("c4", "plan", {}, cwd, "interrupted")).toBeNull();
  expect(fileToolNames("ask", "linux")).toEqual([
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
  ]);
  expect(fileToolNames("auto", "win32")).toEqual([
    "read",
    "powershell",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
  ]);
  expect(fileToolNames("off", "linux")).toEqual([]);
});

test("the grep and find command card shows exactly the argv Pi runs (a fake rg and fd record it), and the Pi version is pinned", async () => {
  const bin = join(root, "argv-bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "argv.log");
  for (const name of ["rg", "fd"])
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nprintf '%s\\0' "$@" > ${JSON.stringify(log)}\nexit 0\n`,
      { mode: 0o755 }
    );
  // a folder inside a git repository and one outside any
  const repo = join(root, "argv-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "sub"), { recursive: true });
  const plain = join(project, "argv-plain");
  mkdirSync(plain, { recursive: true });
  const cases: ["grep" | "find", Record<string, unknown>, string][] = [
    ["grep", { pattern: "needle" }, plain],
    [
      "grep",
      { pattern: "needle", ignoreCase: true, literal: true, glob: "*.bib", context: 3 },
      plain,
    ],
    ["grep", { pattern: "a b'c", path: ".", context: 2 }, repo],
    ["find", { pattern: "*.bib" }, plain],
    ["find", { pattern: "*.bib", limit: 5, path: "." }, repo],
    ["find", { pattern: "src/**/*.ts" }, plain],
    ["find", { pattern: "**/x.ts", limit: 7 }, plain],
    ["find", { pattern: "/abs/*.ts" }, repo],
    ["find", { pattern: "**" }, plain],
    ["find", { pattern: "a/b", path: "sub" }, repo],
  ];
  const path = process.env.PATH;
  try {
    process.env = { ...process.env, PATH: `${bin}:${path}` };
    for (const [kind, params, cwd] of cases) {
      rmSync(log, { force: true });
      const definition = (kind === "grep" ? createGrepToolDefinition : createFindToolDefinition)(
        cwd
      );
      await definition.execute("c", params as never, undefined, undefined, { cwd } as never);
      const real = readFileSync(log, "utf8").split("\0").slice(0, -1);
      const card = searchCommand(kind, join(bin, kind === "grep" ? "rg" : "fd"), params, cwd);
      // what the shell makes of the card's text is what would run
      const shown = execFileSync("sh", ["-c", `for a in ${card}; do printf '%s\\0' "$a"; done`], {
        encoding: "utf8",
      })
        .split("\0")
        .slice(0, -1);
      expect(shown, `${kind} ${JSON.stringify(params)} in ${cwd}`).toEqual([
        join(bin, kind === "grep" ? "rg" : "fd"),
        ...real,
      ]);
    }
  } finally {
    process.env = { ...process.env, PATH: path };
  }
  // the Windows pattern rewrite is Pi's `String.raw`[/\\]` (find.js); Pi reads process.platform, so this part is static
  expect(searchCommand("find", "fd", { pattern: "a/b" }, plain, "win32")).toContain(
    "**[/\\\\]a[/\\\\]b"
  );
  // searchCommand copies Pi 1.0.0's grep.js and find.js argument building: a new version must be read again
  const pkg = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
        "..",
        "package.json"
      ),
      "utf8"
    )
  );
  expect(pkg.version).toBe("1.0.0");
});

test("piBinDir expands a leading ~ in PI_CODING_AGENT_DIR the way Pi's getAgentDir does", () => {
  const before = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
    expect(piBinDir()).toBe(join(homedir(), "custom-agent", "bin"));
    process.env.PI_CODING_AGENT_DIR = "~";
    expect(piBinDir()).toBe(join(homedir(), "bin"));
    process.env.PI_CODING_AGENT_DIR = join(root, "plain-agent");
    expect(piBinDir()).toBe(join(root, "plain-agent", "bin"));
    process.env.PI_CODING_AGENT_DIR = "";
    expect(piBinDir()).toBe(join(homedir(), ".pi", "agent", "bin"));
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  }
});
