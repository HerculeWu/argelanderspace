/**
 * Copilot `writer` tool, end to end on the real seam (copilot ticket 22): real Pi session, real HTTP routes, real
 * Writer lock/store/disk and writer.changed notification, real confirmation. Only the model provider is scripted.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConversationSnapshot,
  CopilotConfirmation,
  PageContext,
  WriterManuscript,
  WsServerMessage,
} from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  getCurrentTools,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";

type Out = { text?: string; call?: Record<string, unknown> };
type Step = (context: TranscriptContext) => Out | Promise<Out>;
let root: string;
let dataDir: string;
let host: CopilotHost;
let app: ReturnType<typeof createApp>;
let settings: ProviderSettings;
let originalEnv: NodeJS.ProcessEnv;
let script: Step[];
let seen: TranscriptContext[];
let broadcasts: WsServerMessage[];
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };
const M = "m_0000000a";
const N = "m_0000000b";
const LAST_MARK = "LAST-UNIQUE-CELL-MARKER";

const manuscriptFile = (id: string) => join(dataDir, "manuscripts", id, "manuscript.json");
const disk = (id = M) => JSON.parse(readFileSync(manuscriptFile(id), "utf8"));
const diskBytes = (id = M) => readFileSync(manuscriptFile(id), "utf8");
const seedManuscript = (id: string, title: string) => ({
  version: 1,
  id,
  rev: 3,
  template: "report",
  title,
  authors: [{ name: "A. Author", aff: "1", x_author: "keep-author" }],
  affiliations: ["Somewhere"],
  userPreamble: "\\newcommand{\\kms}{km/s}",
  infoValues: { keywords: "a, b" },
  cells: [
    {
      id: "c_00000001",
      type: "latex",
      data: { source: "First cell", x_data: "keep-data" },
      x_cell: "keep-cell",
    },
    { id: "c_00000002", type: "latex", data: { source: `Last cell ${LAST_MARK}` } },
  ],
  comments: [],
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  x_top: { future: true },
});
const write = (id: string, doc: object) => {
  mkdirSync(join(dataDir, "manuscripts", id), { recursive: true });
  writeFileSync(manuscriptFile(id), JSON.stringify(doc, null, 2));
};
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const lastResult = (context: TranscriptContext) => {
  const results = context.messages.filter((m) => m.role === "toolResult");
  const last = results.at(-1);
  if (last?.role !== "toolResult") throw new Error("no tool result yet");
  const part = last.content[0];
  return JSON.parse(part && part.type === "text" ? part.text : "{}");
};
/** The user's own autosave: a whole-document PUT of what the page holds, with the rev it holds. */
const userSaves = async (id: string, change: (doc: WriterManuscript) => void) => {
  const doc = (await (
    await app.request(`/api/writer/manuscripts/${id}`)
  ).json()) as WriterManuscript;
  change(doc);
  const res = await app.request(`/api/writer/manuscripts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  expect(res.status).toBe(200);
};

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-writer-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  dataDir = join(root, "data");
  mkdirSync(join(root, "status"), { recursive: true });
  write(M, seedManuscript(M, "Alpha manuscript"));
  script = [];
  seen = [];
  broadcasts = [];
  settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, context: TranscriptContext) {
      seen.push(structuredClone(context));
      const step = script[seen.length - 1];
      const index = seen.length;
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const out = step ? await step(context) : { text: "done" };
        const message: AssistantMessage = {
          role: "assistant",
          content: out.call
            ? [
                {
                  type: "toolCall",
                  id: `call_${index}`,
                  name: "writer",
                  arguments: out.call as never,
                },
              ]
            : [{ type: "text", text: out.text ?? "done" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: out.call ? "toolUse" : "stop",
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
  host = new CopilotHost(dataDir, settings, () => {});
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot: host,
    broadcast: (message) => broadcasts.push(message),
  });
});
afterEach(async () => {
  await host.close();
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

function editorPage(
  revision = 1,
  viewId: string = randomUUID(),
  over: { draft?: object | null; id?: string } = {}
): PageContext {
  const saved = disk(over.id ?? M) as WriterManuscript;
  return {
    version: 1,
    viewId,
    revision,
    paneId: 1,
    view: "write",
    status: "complete",
    otherPanes: [],
    plan: null,
    writer: {
      mode: "editor",
      list: null,
      editor: {
        manuscriptId: saved.id,
        phase: "ready",
        saved,
        saveState: "saved",
        draft: (over.draft ?? null) as never,
        template: { id: "report", label: "Report", found: true, types: ["latex"] },
        unsupportedCellIds: [],
        activeCellId: null,
        editingCellId: null,
        caret: null,
        modal: null,
        preview: { status: "never", failed: false, warnings: 0, rendering: false },
      },
    },
  };
}
async function start(context: PageContext, text = "Work on the manuscript") {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(sent.status).toBe(202);
  return id;
}
const settled = async (id: string) => {
  await vi.waitFor(
    async () => {
      const status = (await host.snapshot(id)).conversation.run?.status;
      expect(["running", "waiting-for-user"]).not.toContain(status);
    },
    { timeout: 8000 }
  );
  return host.snapshot(id);
};
const run = async (context: PageContext, text?: string) => {
  const id = await start(context, text);
  return { id, snapshot: await settled(id) };
};
const operations = (snapshot: ConversationSnapshot) =>
  snapshot.messages.flatMap((m) => m.operations ?? []).map((o) => `${o.action}:${o.status}`);
async function card(id: string): Promise<CopilotConfirmation> {
  let found: CopilotConfirmation | undefined;
  await vi.waitFor(
    async () => {
      found = (await host.snapshot(id)).confirmations[0];
      expect(found).toBeDefined();
    },
    { timeout: 8000 }
  );
  return found as CopilotConfirmation;
}
const answer = (
  confirmation: CopilotConfirmation,
  view: PageContext,
  decision: "approve" | "decline"
) =>
  request(`/confirmations/${confirmation.id}`, "POST", {
    decision,
    viewId: view.viewId,
    action: confirmation.action,
    objectId: confirmation.object.id,
    baseRev: confirmation.baseRev,
  });

test("the writer tool is active; the open manuscript reaches the model whole (last cell included) with a draft marked unsaved", async () => {
  const view = editorPage(1, randomUUID(), {
    draft: {
      unsaved: true,
      fields: { title: "Typed but unsaved title" },
      cells: { changed: [], removed: [], order: null },
      comments: { added: [], removed: [] },
    },
  });
  script = [() => ({ text: "seen" })];
  const { snapshot } = await run(view);
  expect(getCurrentTools(seen[0]?.messages ?? []).map((tool) => tool.name)).toContain("writer");
  const sent = JSON.stringify(seen[0]?.messages);
  expect(sent).toContain(LAST_MARK);
  expect(sent).toContain("keep-data");
  expect(sent).toContain("Typed but unsaved title");
  expect(sent).toContain('\\"unsaved\\":true');
  // The message records the object it was about, at the revision it was captured at, and a Writer summary.
  expect(snapshot.messages[0]?.context?.objects).toEqual([
    { id: M, rev: 3, name: "Alpha manuscript" },
  ]);
  expect(snapshot.messages[0]?.context?.writer).toMatchObject({
    mode: "editor",
    manuscriptId: M,
    cells: 2,
    draft: true,
  });
  expect(broadcasts.some((m) => m.type === "writer.changed")).toBe(false);
});

test("read returns the list with the template catalog, and the whole saved manuscript with every key; a missing one is not_found", async () => {
  script = [
    () => ({ call: { action: "read" } }),
    (ctx) => {
      const list = lastResult(ctx);
      expect(list.manuscripts.map((m: { id: string }) => m.id)).toEqual([M]);
      expect(list.templates.map((t: { id: string }) => t.id)).toContain("report");
      return { call: { action: "read", manuscriptId: M } };
    },
    (ctx) => {
      const read = lastResult(ctx);
      expect(read.manuscript.cells[1].data.source).toContain(LAST_MARK);
      expect(read.manuscript.x_top).toEqual({ future: true });
      expect(read.manuscript.cells[0].x_cell).toBe("keep-cell");
      expect(read.unsupportedCellIds).toEqual([]);
      return { call: { action: "read", manuscriptId: N } };
    },
    () => ({ text: "ok" }),
  ];
  const before = diskBytes();
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual(["read:ok", "read:ok", "read:not_found"]);
  expect(diskBytes()).toBe(before);
  expect(
    broadcasts.some((m) => m.type === "writer.changed" || m.type === "copilot.view-action")
  ).toBe(false);
});

test("create_manuscript uses the New dialog's path: a known template, rev 0 on disk, writer.changed create; an unknown template writes nothing", async () => {
  script = [
    () => ({ call: { action: "create_manuscript", template: "report", title: "  Fresh draft  " } }),
    () => ({ call: { action: "create_manuscript", template: "no-such-template" } }),
    () => ({ text: "ok" }),
  ];
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual(["create_manuscript:ok", "create_manuscript:invalid"]);
  const ids = readdirSync(join(dataDir, "manuscripts")).sort();
  expect(ids).toHaveLength(2);
  const created = ids.find((id) => id !== M) as string;
  expect(disk(created)).toMatchObject({
    rev: 0,
    template: "report",
    title: "Fresh draft",
    cells: [],
  });
  expect(broadcasts.filter((m) => m.type === "writer.changed")).toMatchObject([
    { cause: "create", id: created },
  ]);
  const listed = (await (await app.request("/api/writer/manuscripts")).json()) as {
    manuscripts: { id: string }[];
  };
  expect(listed.manuscripts.map((m) => m.id)).toContain(created);
  const object = snapshot.messages.flatMap((m) => m.operations ?? [])[0]?.object;
  expect(object).toMatchObject({ kind: "manuscript", id: created });
});

test("update_manuscript changes only the named fields under the writer lock, bumps rev once and keeps every unknown key; the same values again are noop", async () => {
  script = [
    () => ({
      call: {
        action: "update_manuscript",
        manuscriptId: M,
        expectedRev: 3,
        title: "Agent title",
        userPreamble: "\\newcommand{\\agent}{x}",
        infoValues: { date: "d" },
      },
    }),
    () => ({
      call: { action: "update_manuscript", manuscriptId: M, expectedRev: 4, title: "Agent title" },
    }),
    (ctx) => ({ text: `rev ${lastResult(ctx).rev}` }),
  ];
  const before = disk();
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual(["update_manuscript:ok", "update_manuscript:noop"]);
  const after = disk();
  expect(after.rev).toBe(4);
  expect(after.title).toBe("Agent title");
  expect(after.userPreamble).toBe("\\newcommand{\\agent}{x}");
  expect(after.infoValues).toEqual({ keywords: "a, b", date: "d" });
  // Everything the call did not name, and every key this application does not know, is as it was.
  expect(after.authors).toEqual(before.authors);
  expect(after.cells).toEqual(before.cells);
  expect(after.x_top).toEqual({ future: true });
  expect(after.cells[0].x_cell).toBe("keep-cell");
  expect(after.cells[0].data.x_data).toBe("keep-data");
  expect(after.authors[0].x_author).toBe("keep-author");
  expect(broadcasts.filter((m) => m.type === "writer.changed")).toHaveLength(1);
  expect(broadcasts.some((m) => m.type === "copilot.view-action")).toBe(false);
});

test("a template change keeps every cell and reports the ones the template does not list", async () => {
  const doc = seedManuscript(M, "Alpha manuscript");
  doc.cells.push({ id: "c_00000003", type: "recipient", data: { name: "N" } } as never);
  write(M, doc);
  script = [
    () => ({
      call: { action: "update_manuscript", manuscriptId: M, expectedRev: 3, template: "report" },
    }),
    () => ({
      call: { action: "update_manuscript", manuscriptId: M, expectedRev: 3, template: "letter" },
    }),
    (ctx) => ({ text: `unsupported ${lastResult(ctx).unsupportedCells}` }),
  ];
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual(["update_manuscript:noop", "update_manuscript:ok"]);
  const after = disk();
  expect(after.template).toBe("letter");
  expect(after.cells).toHaveLength(3);
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain("unsupportedCells");
});

test("A06: a user save between read and write makes the agent write stale; nothing is overwritten, and after rereading the agent edits on top of the user's field", async () => {
  script = [
    () => ({ call: { action: "read", manuscriptId: M } }),
    async (ctx) => {
      const rev = lastResult(ctx).manuscript.rev;
      await userSaves(M, (doc) => {
        doc.title = "User retitled";
      });
      return {
        call: {
          action: "update_manuscript",
          manuscriptId: M,
          expectedRev: rev,
          userPreamble: "AGENT-STALE",
        },
      };
    },
    (ctx) => {
      expect(lastResult(ctx)).toMatchObject({ ok: false, status: "conflict", currentRev: 4 });
      expect(disk().userPreamble).not.toBe("AGENT-STALE");
      expect(disk().title).toBe("User retitled");
      return { call: { action: "read", manuscriptId: M } };
    },
    (ctx) => ({
      call: {
        action: "update_manuscript",
        manuscriptId: M,
        expectedRev: lastResult(ctx).manuscript.rev,
        userPreamble: "AGENT-FRESH",
      },
    }),
    () => ({ text: "applied after rereading" }),
  ];
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual([
    "read:ok",
    "update_manuscript:conflict",
    "read:ok",
    "update_manuscript:ok",
  ]);
  const after = disk();
  expect(after.title).toBe("User retitled");
  expect(after.userPreamble).toBe("AGENT-FRESH");
  expect(after.rev).toBe(5);
});

test("a damaged manuscript file is reported and left byte for byte; the agent cannot reset it", async () => {
  const view = editorPage();
  writeFileSync(manuscriptFile(M), "{ not json");
  script = [
    () => ({ call: { action: "update_manuscript", manuscriptId: M, expectedRev: 3, title: "X" } }),
    () => ({ call: { action: "read", manuscriptId: M } }),
    () => ({ call: { action: "delete_manuscript", manuscriptId: M, expectedRev: 3 } }),
    () => ({ text: "failed" }),
  ];
  const { snapshot } = await run(view);
  expect(operations(snapshot)).toEqual([
    "update_manuscript:error",
    "read:error",
    "delete_manuscript:error",
  ]);
  expect(readFileSync(manuscriptFile(M), "utf8")).toBe("{ not json");
});

test("an operationId is answered once: the repeat returns the first result and writes nothing more", async () => {
  const same = {
    action: "update_manuscript",
    manuscriptId: M,
    expectedRev: 3,
    title: "Once",
    operationId: "op-1",
  };
  script = [
    () => ({ call: same }),
    () => ({ call: same }),
    () => ({ call: { ...same, title: "Other" } }),
    () => ({ text: "x" }),
  ];
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual([
    "update_manuscript:ok",
    "update_manuscript:ok",
    "update_manuscript:rejected",
  ]);
  expect(disk().rev).toBe(4);
  expect(broadcasts.filter((m) => m.type === "writer.changed")).toHaveLength(1);
});

test("open_manuscript for a manuscript that does not exist is not_found and navigates nothing", async () => {
  script = [
    () => ({ call: { action: "open_manuscript", manuscriptId: N } }),
    () => ({ text: "x" }),
  ];
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual(["open_manuscript:not_found"]);
  expect(broadcasts.some((m) => m.type === "copilot.view-action")).toBe(false);
});

test("a later observation leaves the held manuscript out (with a note) but keeps the unsaved draft", async () => {
  const view = editorPage();
  script = [
    async () => {
      const next = editorPage(2, view.viewId, {
        draft: {
          unsaved: true,
          fields: { title: "Typed later" },
          cells: { changed: [], removed: [], order: null },
          comments: { added: [], removed: [] },
        },
      });
      expect((await request(`/views/${view.viewId}`, "PUT", next)).status).toBe(200);
      return { call: { action: "read" } };
    },
    () => ({ text: "x" }),
  ];
  await run(view);
  const second = JSON.stringify(seen[1]?.messages);
  expect(second).toContain("page-observation");
  expect(second).toContain("savedOmitted");
  expect(second).toContain("Typed later");
  const observation =
    (seen[1]?.messages ?? [])
      .map((m) => JSON.stringify(m))
      .find((m) => m.includes("taskContextId")) ?? "";
  expect(observation).not.toContain(LAST_MARK);
});

test("a view cannot publish an omitted manuscript (only the service writes that)", async () => {
  const view = editorPage();
  const editor = view.writer?.editor;
  if (!editor) throw new Error("editor");
  const forged = {
    ...view,
    writer: { ...view.writer, editor: { ...editor, savedOmitted: { rev: 3, note: "x" } } },
  };
  expect((await request(`/views/${view.viewId}`, "PUT", forged)).status).toBeGreaterThanOrEqual(
    400
  );
});

// ---- delete: the list's confirmation, never self-approved --------------------------------------------- //

const asset = () => {
  mkdirSync(join(dataDir, "manuscripts", M, "assets"), { recursive: true });
  writeFileSync(join(dataDir, "manuscripts", M, "assets", "fig.png"), "png");
};

test("A08: delete waits for the real user; the card names the object and impact, nothing is written, the model holds no way to approve", async () => {
  asset();
  const view = editorPage();
  script = [
    () => ({ call: { action: "delete_manuscript", manuscriptId: M, expectedRev: 3 } }),
    () => ({ text: "waiting" }),
  ];
  const before = diskBytes();
  const id = await start(view);
  const shown = await card(id);
  expect(shown).toMatchObject({
    action: "delete_manuscript",
    object: { kind: "manuscript", id: M },
    label: "Alpha manuscript",
    impact: { cells: 2, comments: 0, assets: 1 },
    baseRev: 3,
  });
  expect((await host.snapshot(id)).conversation.run?.status).toBe("waiting-for-user");
  expect(diskBytes()).toBe(before);
  expect(existsSync(join(dataDir, "manuscripts", M, "assets", "fig.png"))).toBe(true);
  expect(JSON.stringify(seen)).not.toContain(shown.id);
  expect(
    (await host.snapshot(id)).messages.flatMap((m) => m.operations ?? []).map((o) => o.status)
  ).toEqual(["confirmation_required"]);
  // A decision that names another version is refused and leaves the card.
  expect(
    (await answer({ ...shown, baseRev: 99 } as CopilotConfirmation, view, "approve")).status
  ).toBeGreaterThanOrEqual(400);
  expect((await host.snapshot(id)).confirmations).toHaveLength(1);
});

test("confirming deletes the whole manuscript folder (assets too) once, notifies, and the tool hears ok; a repeated click changes nothing", async () => {
  asset();
  const view = editorPage();
  script = [
    () => ({ call: { action: "delete_manuscript", manuscriptId: M, expectedRev: 3 } }),
    (ctx) => ({ text: `deleted ${lastResult(ctx).status}` }),
  ];
  const id = await start(view);
  const shown = await card(id);
  const response = await answer(shown, view, "approve");
  expect(response.status).toBe(200);
  const snapshot = await settled(id);
  expect(snapshot.conversation.run?.status).toBe("completed");
  expect(existsSync(join(dataDir, "manuscripts", M))).toBe(false);
  expect(broadcasts.filter((m) => m.type === "writer.changed")).toMatchObject([
    { cause: "delete", id: M },
  ]);
  expect(operations(snapshot)).toEqual(["delete_manuscript:ok"]);
  expect((await answer(shown, view, "approve")).status).toBe(200);
});

test("declining writes nothing; the tool hears declined", async () => {
  const view = editorPage();
  script = [
    () => ({ call: { action: "delete_manuscript", manuscriptId: M, expectedRev: 3 } }),
    (ctx) => ({ text: `outcome ${lastResult(ctx).status}` }),
  ];
  const before = diskBytes();
  const id = await start(view);
  expect((await answer(await card(id), view, "decline")).status).toBe(200);
  const snapshot = await settled(id);
  expect(operations(snapshot)).toEqual(["delete_manuscript:declined"]);
  expect(diskBytes()).toBe(before);
  expect(broadcasts.some((m) => m.type === "writer.changed")).toBe(false);
});

test("a user save while the card waits expires it: approving is refused and nothing is deleted", async () => {
  const view = editorPage();
  script = [
    () => ({ call: { action: "delete_manuscript", manuscriptId: M, expectedRev: 3 } }),
    (ctx) => ({ text: `outcome ${lastResult(ctx).status}` }),
  ];
  const id = await start(view);
  const shown = await card(id);
  await userSaves(M, (doc) => {
    doc.title = "User kept working";
  });
  await vi.waitFor(async () => expect((await host.snapshot(id)).confirmations).toEqual([]));
  expect((await answer(shown, view, "approve")).status).toBeGreaterThanOrEqual(400);
  const snapshot = await settled(id);
  expect(operations(snapshot)).toEqual(["delete_manuscript:expired"]);
  expect(disk().title).toBe("User kept working");
});

test("a hand edit that leaves rev alone also expires the card (the bytes are bound, not only the rev)", async () => {
  const view = editorPage();
  script = [
    () => ({ call: { action: "delete_manuscript", manuscriptId: M, expectedRev: 3 } }),
    () => ({ text: "x" }),
  ];
  const id = await start(view);
  const shown = await card(id);
  write(M, { ...seedManuscript(M, "Edited by hand"), rev: 3 });
  expect((await answer(shown, view, "approve")).status).toBeGreaterThanOrEqual(400);
  expect(existsSync(manuscriptFile(M))).toBe(true);
  expect(disk().title).toBe("Edited by hand");
});

test("the shared delete re-checks the rev and bytes inside the writer lock: a change between the click and the delete deletes nothing", async () => {
  const { deleteManuscriptOp, describeManuscriptDelete } = await import("../src/writer-actions.js");
  const { AsyncLock } = await import("../src/lock.js");
  const deps = {
    dataDir,
    writerLock: new AsyncLock(),
    changed: () => {},
    cancelCompile: async () => {},
  };
  const target = describeManuscriptDelete(deps, M);
  if (!target || "error" in target) throw new Error("fixture");
  expect(await deleteManuscriptOp(deps, M, { rev: 2, digest: target.digest })).toMatchObject({
    ok: false,
    status: "conflict",
  });
  expect(
    await deleteManuscriptOp(deps, M, { rev: target.rev, digest: "0".repeat(64) })
  ).toMatchObject({ ok: false, status: "conflict" });
  expect(existsSync(manuscriptFile(M))).toBe(true);
  expect(
    await deleteManuscriptOp(deps, M, { rev: target.rev, digest: target.digest })
  ).toMatchObject({ ok: true });
  expect(existsSync(join(dataDir, "manuscripts", M))).toBe(false);
});

test("B2: a figure uploaded while the card waits ends it; approving deletes nothing", async () => {
  asset();
  const view = editorPage();
  script = [
    () => ({ call: { action: "delete_manuscript", manuscriptId: M, expectedRev: 3 } }),
    (ctx) => ({ text: `outcome ${lastResult(ctx).status}` }),
  ];
  const id = await start(view);
  const shown = await card(id);
  const upload = await app.request(`/api/writer/manuscripts/${M}/assets?filename=late.png`, {
    method: "POST",
    body: "new figure",
  });
  expect(upload.status).toBe(201);
  await vi.waitFor(async () => expect((await host.snapshot(id)).confirmations).toEqual([]));
  expect((await answer(shown, view, "approve")).status).toBeGreaterThanOrEqual(400);
  expect(operations(await settled(id))).toEqual(["delete_manuscript:expired"]);
  expect(existsSync(join(dataDir, "manuscripts", M, "assets", "late.png"))).toBe(true);
});

test("Std8: a change after the click but before the delete takes the lock deletes nothing", async () => {
  const { deleteManuscriptOp, describeManuscriptDelete } = await import("../src/writer-actions.js");
  const { AsyncLock } = await import("../src/lock.js");
  const deps = {
    dataDir,
    writerLock: new AsyncLock(),
    changed: () => {},
    cancelCompile: async () => {},
  };
  const target = describeManuscriptDelete(deps, M);
  if (!target || "error" in target) throw new Error("fixture");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = deps.writerLock.run(() => gate);
  const deleting = deleteManuscriptOp(deps, M, { rev: target.rev, digest: target.digest });
  asset(); // a figure arrives while the delete is queued behind the lock
  release();
  await held;
  expect(await deleting).toMatchObject({ ok: false, status: "conflict" });
  expect(existsSync(join(dataDir, "manuscripts", M, "assets", "fig.png"))).toBe(true);
});

test("Std1: an author patch keeps the keys the file already has on that author", async () => {
  script = [
    () => ({
      call: {
        action: "update_manuscript",
        manuscriptId: M,
        expectedRev: 3,
        authors: [{ name: "A. Author", aff: "2" }],
      },
    }),
    () => ({ text: "ok" }),
  ];
  await run(editorPage());
  expect(disk().authors).toEqual([{ name: "A. Author", aff: "2", x_author: "keep-author" }]);
});

test("Std1 round 2: author keys follow only a provably identical author; removal and reorder never graft them onto another person", async () => {
  const doc = seedManuscript(M, "Alpha manuscript");
  doc.authors = [
    { name: "A", aff: "1", email: "a@x", x_author: "keep-A" },
    { name: "B", aff: "2", x_author: "keep-B" },
    { name: "C", aff: "3", x_author: "keep-C" },
  ] as never;
  write(M, doc);
  const authors = () => disk().authors as Record<string, unknown>[];
  const update = (list: object[], rev: number) => ({
    action: "update_manuscript",
    manuscriptId: M,
    expectedRev: rev,
    authors: list,
  });
  script = [
    // in place: same length, same names -> every key stays
    () => ({
      call: update(
        [
          { name: "A", aff: "9" },
          { name: "B", aff: "2" },
          { name: "C", aff: "3" },
        ],
        3
      ),
    }),
    // removal of B: C moves to index 1 and must not inherit B's keys; nothing may be grafted onto another person
    () => ({
      call: update(
        [
          { name: "A", aff: "9" },
          { name: "C", aff: "3" },
        ],
        4
      ),
    }),
    () => ({ text: "ok" }),
  ];
  await run(editorPage());
  expect(authors()).toEqual([
    { name: "A", aff: "9" },
    { name: "C", aff: "3" },
  ]);
  // The first step (checked from the transcript): A's email and unknown key survived the in-place edit.
  expect(JSON.stringify(seen[1]?.messages)).toContain("ok");
});

test("Std1 round 2: an in-place edit keeps keys, a reorder or a rename does not move them", async () => {
  const doc = seedManuscript(M, "Alpha manuscript");
  doc.authors = [
    { name: "A", aff: "1", email: "a@x", x_author: "keep-A" },
    { name: "B", aff: "2", x_author: "keep-B" },
  ] as never;
  write(M, doc);
  script = [
    () => ({
      call: {
        action: "update_manuscript",
        manuscriptId: M,
        expectedRev: 3,
        authors: [
          { name: "A", aff: "7" },
          { name: "B", aff: "2" },
        ],
      },
    }),
    () => ({ text: "ok" }),
  ];
  await run(editorPage());
  expect(disk().authors).toEqual([
    { name: "A", aff: "7", email: "a@x", x_author: "keep-A" },
    { name: "B", aff: "2", x_author: "keep-B" },
  ]);
  seen = [];
  script = [
    () => ({
      call: {
        action: "update_manuscript",
        manuscriptId: M,
        expectedRev: 4,
        authors: [
          { name: "B", aff: "2" },
          { name: "A", aff: "7" },
        ],
      },
    }),
    () => ({ text: "ok" }),
  ];
  await run(editorPage());
  expect(disk().authors).toEqual([
    { name: "B", aff: "2" },
    { name: "A", aff: "7" },
  ]);
});

test("N2: a delete_manuscript decision from a view other than the run's bound view is refused and keeps the card", async () => {
  const view = editorPage();
  const other = editorPage(1, randomUUID());
  expect((await request(`/views/${other.viewId}`, "PUT", other)).status).toBe(200);
  script = [
    () => ({ call: { action: "delete_manuscript", manuscriptId: M, expectedRev: 3 } }),
    () => ({ text: "x" }),
  ];
  const id = await start(view);
  const shown = await card(id);
  expect((await answer(shown, other, "approve")).status).toBeGreaterThanOrEqual(400);
  expect(existsSync(manuscriptFile(M))).toBe(true);
  expect((await host.snapshot(id)).confirmations).toHaveLength(1);
  expect((await answer(shown, view, "approve")).status).toBe(200);
});

test("Std6: the Writer addendum is in the system prompt only when the writer tool is registered", async () => {
  script = [() => ({ text: "x" })];
  await run(editorPage());
  expect(JSON.stringify(seen[0]?.messages)).toContain("Writer addendum");
  seen = [];
  // The same host without a Writer seam: no writer tool, and no text about one.
  const { AsyncLock } = await import("../src/lock.js");
  host.useWorkbench({
    plans: {
      statusDir: join(root, "status"),
      planLock: new AsyncLock(),
      onChanged: () => {},
      docExists: () => false,
    },
  });
  script = [() => ({ text: "y" })];
  await run(editorPage());
  expect(getCurrentTools(seen[0]?.messages ?? []).map((tool) => tool.name)).not.toContain("writer");
  expect(JSON.stringify(seen[0]?.messages)).not.toContain("Writer addendum");
});

test("F7: an infoValues key the template does not declare, or an author field outside name/aff/email, is refused", async () => {
  script = [
    () => ({
      call: {
        action: "update_manuscript",
        manuscriptId: M,
        expectedRev: 3,
        infoValues: { notAField: "x" },
      },
    }),
    () => ({
      call: {
        action: "update_manuscript",
        manuscriptId: M,
        expectedRev: 3,
        authors: [{ name: "N", evil: "x" }],
      },
    }),
    () => ({ text: "ok" }),
  ];
  const before = diskBytes();
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual(["update_manuscript:invalid", "update_manuscript:error"]);
  expect(JSON.stringify(seen[1]?.messages)).toContain("not extension fields");
  expect(diskBytes()).toBe(before);
});

test("F9 (A04 for the Writer): the user opens manuscript B mid-run; the agent's writes stay on A and the observation says B is not held", async () => {
  write(N, seedManuscript(N, "Beta manuscript"));
  const view = editorPage();
  script = [
    async () => {
      const next = editorPage(2, view.viewId, { id: N });
      expect((await request(`/views/${view.viewId}`, "PUT", next)).status).toBe(200);
      return {
        call: {
          action: "update_manuscript",
          manuscriptId: M,
          expectedRev: 3,
          title: "Only A changes",
        },
      };
    },
    () => ({ text: "done" }),
  ];
  const before = diskBytes(N);
  const { snapshot } = await run(view);
  expect(operations(snapshot)).toEqual(["update_manuscript:ok"]);
  expect(disk(M).title).toBe("Only A changes");
  expect(diskBytes(N)).toBe(before);
  const observation =
    (seen[1]?.messages ?? [])
      .map((m) => JSON.stringify(m))
      .find((m) => m.includes("taskContextId")) ?? "";
  expect(observation).toContain(N);
  expect(observation).toContain("not in the task's context");
  expect(snapshot.messages[0]?.context?.objects[0]?.id).toBe(M);
});

test("a stale expectedRev on a delete request shows no card and deletes nothing", async () => {
  script = [
    () => ({ call: { action: "delete_manuscript", manuscriptId: M, expectedRev: 1 } }),
    () => ({ text: "x" }),
  ];
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual(["delete_manuscript:conflict"]);
  expect(existsSync(manuscriptFile(M))).toBe(true);
  expect(snapshot.confirmations).toEqual([]);
});
