/**
 * The Copilot `writer` tool's cell, comment, reference, figure and Render operations, end to end on the real seam
 * (copilot ticket 23): real Pi session, real HTTP routes, real Writer lock/store/disk, real
 * latexmk for Render. Only the model provider is scripted.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConversationSnapshot,
  PageContext,
  WriterManuscript,
  WsServerMessage,
} from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import {
  __setWriterSandboxForTests,
  createLogger,
  ensureWriterSandboxProbe,
  haveLatexmk,
} from "@argelanderspace/infra";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { JobRunner } from "../src/jobs.js";
import { SERVER_LOG_EVENTS } from "../src/log.js";
import { ProviderSettings } from "../src/providers.js";
import { __setNumberingComputeForTests, computeWriterNumbering } from "../src/writer-numbering.js";
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
let logLines: string[] = [];
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };
const M = "m_0000000a";
const _PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("png-body"),
]);

const manuscriptFile = () => join(dataDir, "manuscripts", M, "manuscript.json");
const disk = (): WriterManuscript => JSON.parse(readFileSync(manuscriptFile(), "utf8"));
const seedManuscript = () => ({
  version: 1,
  id: M,
  rev: 3,
  template: "report",
  title: "Alpha manuscript",
  authors: [{ name: "A. Author", aff: "1" }],
  affiliations: ["Somewhere"],
  userPreamble: "",
  infoValues: {},
  cells: [
    {
      id: "c_00000001",
      type: "latex",
      data: { source: "\\section{Intro}\nFirst cell.", x_data: "keep-data" },
      x_cell: "keep-cell",
    },
    {
      id: "c_00000002",
      type: "figure",
      data: { caption: "A figure", label: "", placement: "center", width: 80, image: null },
    },
  ],
  comments: [],
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  x_top: { future: true },
});
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
const operations = (snapshot: ConversationSnapshot) =>
  snapshot.messages.flatMap((m) => m.operations ?? []).map((o) => `${o.action}:${o.status}`);

beforeEach(async () => {
  await ensureWriterSandboxProbe();
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-writer-cells-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  dataDir = join(root, "data");
  mkdirSync(join(root, "status"), { recursive: true });
  mkdirSync(join(dataDir, "manuscripts", M), { recursive: true });
  writeFileSync(manuscriptFile(), JSON.stringify(seedManuscript(), null, 2));
  const paths = libraryPaths(dataDir);
  mkdirSync(paths.libraryDir, { recursive: true });
  writeFileSync(
    paths.libraryJson,
    JSON.stringify({
      version: 1,
      project: { name: "S", short: "S", field: "" },
      works: [
        {
          id: "doi:10.1000/w1",
          title: "Work one",
          authors: ["Smith"],
          year: 2020,
          venue: "MNRAS",
          type: "article",
          doi: "10.1000/w1",
          cite_key: "smith2020",
          doc_ids: [],
        },
      ],
    })
  );
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
  logLines = [];
  host = new CopilotHost(dataDir, settings, () => {});
  app = createApp({
    paths,
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot: host,
    log: createLogger({
      events: SERVER_LOG_EVENTS,
      sink: { write: (line) => logLines.push(line) },
      level: "debug",
    }),
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
  draft: object | null = null
): PageContext {
  const saved = disk();
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
        draft: draft as never,
        template: {
          id: "report",
          label: "Report",
          found: true,
          types: ["latex", "figure", "table", "code", "ack", "appendix"],
        },
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
async function start(context: PageContext) {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "Work on the manuscript",
    viewId: context.viewId,
    contextRevision: context.revision,
  });
  expect(sent.status).toBe(202);
  return { id };
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
const run = async (context: PageContext) => {
  const { id } = await start(context);
  return { id, snapshot: await settled(id) };
};
const call =
  (c: Record<string, unknown>): Step =>
  () => ({ call: c });

test("a chain of cell operations: each uses the rev of the previous result; one rev bump each, unknown keys and the user's comments stay, saving never compiles", async () => {
  const before = disk();
  script = [
    call({
      action: "insert_cell",
      manuscriptId: M,
      expectedRev: 3,
      cellType: "latex",
      index: 1,
      fields: { source: "\\section{Methods}\nWe measure." },
    }),
    (ctx) => ({
      call: {
        action: "update_cell",
        manuscriptId: M,
        expectedRev: lastResult(ctx).rev,
        cellId: "c_00000001",
        fields: { source: "\\section{Intro}\nRewritten." },
      },
    }),
    (ctx) => ({
      call: {
        action: "add_comment",
        manuscriptId: M,
        expectedRev: lastResult(ctx).rev,
        cellId: "c_00000002",
        body: "Check the caption",
      },
    }),
    (ctx) => ({
      call: {
        action: "convert_cell",
        manuscriptId: M,
        expectedRev: lastResult(ctx).rev,
        cellId: "c_00000002",
        cellType: "latex",
      },
    }),
    (ctx) => ({
      call: {
        action: "delete_cell",
        manuscriptId: M,
        expectedRev: lastResult(ctx).rev,
        cellId: "c_00000002",
      },
    }),
    (ctx) => ({ text: `rev ${lastResult(ctx).rev}` }),
  ];
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual([
    "insert_cell:ok",
    "update_cell:ok",
    "add_comment:ok",
    "convert_cell:ok",
    "delete_cell:ok",
  ]);
  const after = disk();
  expect(after.rev).toBe(8);
  expect(after.cells.map((c) => c.id).filter((id) => id !== "c_00000001")).toHaveLength(1);
  expect(
    (after.cells[0] as unknown as { data: { source: string; x_data: string }; x_cell: string }).data
  ).toEqual({ source: "\\section{Intro}\nRewritten.", x_data: "keep-data" });
  expect((after.cells[0] as unknown as { x_cell: string }).x_cell).toBe("keep-cell");
  expect(after.x_top).toEqual({ future: true });
  expect(after.comments).toHaveLength(1); // the comment of the deleted cell stays, as in the page
  expect(before.comments).toHaveLength(0);
  // one writer.changed per accepted write, no compile (no numbering broadcast, no build dir)
  expect(
    broadcasts
      .filter((m) => m.type === "writer.changed")
      .map((m) => (m as { cause?: string }).cause)
  ).toEqual(["put", "put", "put", "put", "put"]);
  expect(existsSync(join(dataDir, "manuscripts", M, "build"))).toBe(false);
});

test("A06: a user save between the agent's read and its write makes the agent's cell edit stale; after rereading it lands on top of the user's text", async () => {
  script = [
    async () => {
      // the user's autosave lands first (whole-document PUT at the rev the page holds)
      const doc = disk();
      (doc.cells[0] as unknown as { data: { source: string } }).data.source = "USER TEXT";
      const res = await app.request(`/api/writer/manuscripts/${M}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });
      expect(res.status).toBe(200);
      return {
        call: {
          action: "update_cell",
          manuscriptId: M,
          expectedRev: 3,
          cellId: "c_00000002",
          fields: { caption: "Agent caption" },
        },
      };
    },
    (ctx) => {
      const result = lastResult(ctx);
      expect(result).toMatchObject({ ok: false, status: "conflict", currentRev: 4 });
      return { call: { action: "read", manuscriptId: M } };
    },
    (ctx) => ({
      call: {
        action: "update_cell",
        manuscriptId: M,
        expectedRev: lastResult(ctx).manuscript.rev,
        cellId: "c_00000002",
        fields: { caption: "Agent caption" },
      },
    }),
  ];
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual(["update_cell:conflict", "read:ok", "update_cell:ok"]);
  const after = disk();
  expect((after.cells[0] as unknown as { data: { source: string } }).data.source).toBe("USER TEXT");
  expect((after.cells[1] as unknown as { data: { caption: string } }).data.caption).toBe(
    "Agent caption"
  );
});

test("insert_reference: a cite key of the real library goes in bare; an unknown key is refused; read lists labels and figure files", async () => {
  script = [
    call({
      action: "insert_reference",
      manuscriptId: M,
      expectedRev: 3,
      cellId: "c_00000001",
      field: "source",
      offset: 27,
      kind: "cite",
      text: "smith2020",
    }),
    (ctx) => ({
      call: {
        action: "insert_reference",
        manuscriptId: M,
        expectedRev: lastResult(ctx).rev,
        cellId: "c_00000001",
        field: "source",
        offset: 0,
        kind: "cite",
        text: "ghost1999",
      },
    }),
    (_ctx) => ({
      call: {
        action: "insert_reference",
        manuscriptId: M,
        expectedRev: 4,
        cellId: "c_00000001",
        field: "source",
        offset: 0,
        kind: "label",
        text: "fig:one",
        target: { cellId: "c_00000002" },
      },
    }),
    call({ action: "read", manuscriptId: M }),
    (ctx) => ({
      text: JSON.stringify({ labels: lastResult(ctx).labels, assets: lastResult(ctx).assets }),
    }),
  ];
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual([
    "insert_reference:ok",
    "insert_reference:invalid",
    "insert_reference:ok",
    "read:ok",
  ]);
  const after = disk();
  expect((after.cells[0] as unknown as { data: { source: string } }).data.source).toBe(
    "fig:one\\section{Intro}\nFirst cell.smith2020"
  );
  expect((after.cells[1] as unknown as { data: { label: string } }).data.label).toBe("fig:one");
  const final = snapshot.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
  expect(JSON.parse(final)).toEqual({
    labels: [{ label: "fig:one", cell: "c_00000002" }],
    assets: [],
  });
});

test("spec 14.1: agent text that reads files, runs programs or hides control words is refused through the tool and writes nothing", async () => {
  const bytes = readFileSync(manuscriptFile(), "utf8");
  script = [
    call({
      action: "update_cell",
      manuscriptId: M,
      expectedRev: 3,
      cellId: "c_00000001",
      fields: { source: "\\input{/etc/passwd}" },
    }),
    call({
      action: "insert_cell",
      manuscriptId: M,
      expectedRev: 3,
      cellType: "code",
      fields: { code: "x\n\\end{lstlisting}\\immediate\\write18{id}" },
    }),
    call({
      action: "update_manuscript",
      manuscriptId: M,
      expectedRev: 3,
      userPreamble: "\\usepackage{catchfile}\\CatchFileDef\\x{/etc/hostname}{}",
    }),
    call({
      action: "update_manuscript",
      manuscriptId: M,
      expectedRev: 3,
      title: "\\csname input\\endcsname",
    }),
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual([
    "update_cell:invalid",
    "insert_cell:invalid",
    "update_manuscript:invalid",
    "update_manuscript:invalid",
  ]);
  expect(readFileSync(manuscriptFile(), "utf8")).toBe(bytes);
});

test("a cell operation on a malformed call, a template-unlisted type and a missing cell is refused without writing", async () => {
  const bytes = readFileSync(manuscriptFile(), "utf8");
  script = [
    call({ action: "insert_cell", manuscriptId: M, expectedRev: 3, cellType: "poster" }),
    call({ action: "insert_cell", manuscriptId: M, expectedRev: 3, cellType: "recipient" }),
    call({
      action: "update_cell",
      manuscriptId: M,
      expectedRev: 3,
      cellId: "c_000000ff",
      fields: { source: "x" },
    }),
    call({ action: "update_cell", manuscriptId: M, cellId: "c_00000001", fields: { source: "x" } }),
    () => ({ text: "done" }),
  ];
  const { snapshot } = await run(editorPage());
  expect(operations(snapshot)).toEqual([
    "insert_cell:unsupported",
    "insert_cell:invalid",
    "update_cell:not_found",
    "update_cell:unsupported",
  ]);
  expect(readFileSync(manuscriptFile(), "utf8")).toBe(bytes);
});

test.skipIf(!haveLatexmk())(
  "without the OS sandbox the Copilot's render_manuscript still compiles (no 'not available' rejection), and edits work too",
  async () => {
    __setWriterSandboxForTests(false);
    let compiled = 0;
    const restore = __setNumberingComputeForTests(
      async (dir, manuscriptId, signal, observer, failed) => {
        compiled++;
        return computeWriterNumbering(dir, manuscriptId, signal, observer, failed);
      }
    );
    try {
      script = [
        call({
          action: "update_cell",
          manuscriptId: M,
          expectedRev: 3,
          cellId: "c_00000001",
          fields: { source: "Edited without a sandbox" },
        }),
        call({ action: "render_manuscript", manuscriptId: M }),
        () => ({ text: "done" }),
      ];
      const { snapshot } = await run(editorPage());
      expect(operations(snapshot)).toEqual(["update_cell:ok", "render_manuscript:ok"]);
      expect(compiled).toBe(1);
      const numbering = JSON.parse(
        readFileSync(join(dataDir, "manuscripts", M, "build", "numbering.json"), "utf8")
      );
      expect(numbering.lastError).toBeNull();
      expect(numbering.preview).not.toBeNull();
      const ran = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((r) => r.event === "external_program.exited" && r.program === "latexmk");
      expect(ran.length).toBeGreaterThan(0);
      expect(ran.every((r) => r.sandboxed === "no")).toBe(true);
    } finally {
      restore();
      __setWriterSandboxForTests(null);
    }
  },
  120_000
);

// Whether bubblewrap really works here (the real probe, nothing forced): without it this test is skipped, not passed.
const SANDBOX = haveLatexmk() && (await ensureWriterSandboxProbe());

test.skipIf(!SANDBOX)(
  "with the OS sandbox the Copilot's render_manuscript runs latexmk inside it (the log says sandboxed: yes)",
  async () => {
    script = [call({ action: "render_manuscript", manuscriptId: M }), () => ({ text: "done" })];
    const { snapshot } = await run(editorPage());
    expect(operations(snapshot)).toEqual(["render_manuscript:ok"]);
    const runs = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((r) => r.event === "external_program.exited" && r.program === "latexmk");
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.sandboxed === "yes")).toBe(true);
  },
  120_000
);

test.skipIf(!haveLatexmk())(
  "render_manuscript compiles the saved manuscript only: the unsaved page draft is not in the preview, and the result names the rev compiled",
  async () => {
    const draft = {
      unsaved: true,
      fields: {},
      cells: {
        changed: [{ id: "c_00000001", type: "latex", data: { source: "UNSAVED-DRAFT-MARKER-77" } }],
        removed: [],
        order: null,
      },
      comments: { added: [], removed: [] },
    };
    let result: Record<string, unknown> = {};
    script = [
      call({ action: "render_manuscript", manuscriptId: M }),
      (ctx) => {
        result = lastResult(ctx);
        return { text: "done" };
      },
    ];
    const { snapshot } = await run(editorPage(1, randomUUID(), draft));
    expect(operations(snapshot)).toEqual(["render_manuscript:ok"]);
    expect(result).toMatchObject({ ok: true, rev: 3, compiledRev: 3, stale: false });
    const numbering = readFileSync(
      join(dataDir, "manuscripts", M, "build", "numbering.json"),
      "utf8"
    );
    expect(numbering).not.toContain("UNSAVED-DRAFT-MARKER-77");
    expect(numbering).toContain("First cell");
    expect(disk().rev).toBe(3);
  },
  120_000
);

test.skipIf(!haveLatexmk())(
  "Stop during a Render: the submitted compile finishes and commits its preview, the run ends stopped only after it, and nothing new starts",
  async () => {
    let open!: () => void;
    const hold = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered = false;
    const restore = __setNumberingComputeForTests(async (dir, manuscriptId, signal) => {
      entered = true;
      await hold;
      return computeWriterNumbering(dir, manuscriptId, signal);
    });
    try {
      script = [
        call({ action: "render_manuscript", manuscriptId: M }),
        () => ({ text: "should never be asked" }),
      ];
      const { id } = await start(editorPage());
      // the compile is running (held), the model is waiting for its result
      await vi.waitFor(() => expect(entered).toBe(true));
      expect((await host.snapshot(id)).conversation.run?.status).toBe("running");
      const stopped = await request(`/conversations/${id}/stop`, "POST");
      expect(stopped.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // not terminal while the submitted compile is in flight; the manuscript is untouched
      expect((await host.snapshot(id)).conversation.run?.status).toBe("stopping");
      expect(existsSync(join(dataDir, "manuscripts", M, "build", "numbering.json"))).toBe(false);
      open();
      await vi.waitFor(
        async () => expect((await host.snapshot(id)).conversation.run?.status).toBe("stopped"),
        { timeout: 60_000 }
      );
      // the compile that was already submitted completed and committed a real preview
      const numbering = JSON.parse(
        readFileSync(join(dataDir, "manuscripts", M, "build", "numbering.json"), "utf8")
      );
      expect(numbering.lastError).toBeNull();
      expect(numbering.preview).not.toBeNull();
      expect(operations(await host.snapshot(id))).toEqual(["render_manuscript:ok"]);
      expect(seen).toHaveLength(1); // no further model step after Stop
      expect(disk().rev).toBe(3);
    } finally {
      restore();
    }
  },
  120_000
);

test.skipIf(!haveLatexmk())(
  "render_manuscript is the only thing that compiles: the real compile produces a preview of the saved manuscript, a failing source is reported as a failure and the last good preview stays",
  async () => {
    script = [
      call({
        action: "update_cell",
        manuscriptId: M,
        expectedRev: 3,
        cellId: "c_00000001",
        fields: { source: "\\section{Intro}\nRendered text $x^2$." },
      }),
      (_ctx) => ({ call: { action: "render_manuscript", manuscriptId: M } }),
      (_ctx) => ({
        call: {
          action: "update_cell",
          manuscriptId: M,
          expectedRev: 4,
          cellId: "c_00000001",
          fields: { source: "\\section{Intro}\n\\undefinedcommandxyz" },
        },
      }),
      (_ctx) => ({ call: { action: "render_manuscript", manuscriptId: M } }),
      () => ({ text: "done" }),
    ];
    const id = (await start(editorPage())).id;
    const snapshot = await settled(id);
    expect(operations(snapshot)).toEqual([
      "update_cell:ok",
      "render_manuscript:ok",
      "update_cell:ok",
      "render_manuscript:error",
    ]);
    const numbering = JSON.parse(
      readFileSync(join(dataDir, "manuscripts", M, "build", "numbering.json"), "utf8")
    );
    // the failure keeps the last good preview and records the error
    expect(numbering.lastError).toMatch(/Undefined|undefined/);
    expect(numbering.preview).not.toBeNull();
    // the manuscript itself was never touched by a render
    expect(disk().rev).toBe(5);
    expect(
      broadcasts.some(
        (m) => m.type === "writer.changed" && (m as { cause?: string }).cause === "numbering"
      )
    ).toBe(true);
  },
  120_000
);
