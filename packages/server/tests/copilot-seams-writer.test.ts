/**
 * Ticket 32, lane B: a truly concurrent user save and Copilot cell edit on one Writer manuscript, end to end on the
 * real seam (real Pi session, real HTTP routes, real Writer lock/store/disk). Only the model provider is scripted.
 * Cases are recorded in `.scratch/copilot/evidence/32/seams/README.md`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConversationSnapshot,
  PageContext,
  WriterManuscript,
  WsServerMessage,
} from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import { ensureWriterSandboxProbe } from "@argelanderspace/infra";
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
  host = new CopilotHost(dataDir, settings, () => {});
  app = createApp({
    paths,
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
async function start(context: PageContext, files: { name: string; bytes: Buffer }[] = []) {
  const created = (await (
    await request("/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  const ids: string[] = [];
  for (const file of files) {
    const res = await app.request(`/api/copilot/conversations/${id}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name),
      },
      body: file.bytes,
    });
    expect(res.status).toBe(201);
    ids.push(((await res.json()) as { id: string }).id);
  }
  expect((await request(`/views/${context.viewId}`, "PUT", context)).status).toBe(200);
  const sent = await request(`/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text: "Work on the manuscript",
    viewId: context.viewId,
    contextRevision: context.revision,
    ...(ids.length ? { attachmentIds: ids } : {}),
  });
  expect(sent.status).toBe(202);
  return { id, ids };
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
const run = async (context: PageContext, files: { name: string; bytes: Buffer }[] = []) => {
  const { id, ids } = await start(context, files);
  return { id, ids, snapshot: await settled(id) };
};

// ---- (a) the user's autosave and the agent's cell edit, truly concurrent ------------------------------------ //
test("(a) the user's whole-document PUT and the agent's update_cell on the same rev race at several offsets: exactly one wins each round, no field of either is lost to a blind overwrite", async () => {
  const winners: string[] = [];
  for (const [round, delay] of [null, 0, 1, 3, 8, 15].entries()) {
    const saved = disk();
    const rev = saved.rev;
    const edited = structuredClone(saved);
    (edited.cells[0] as unknown as { data: { source: string } }).data.source = `USER TEXT ${round}`;
    let userPut: Promise<Response> | Response | undefined;
    const send = () =>
      app.request(`/api/writer/manuscripts/${M}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(edited),
      });
    seen = [];
    script = [
      () => {
        userPut =
          delay === null
            ? send()
            : new Promise<void>((resolve) => setTimeout(resolve, delay)).then(send);
        return {
          call: {
            action: "update_cell",
            manuscriptId: M,
            expectedRev: rev,
            cellId: "c_00000002",
            fields: { caption: `Agent caption ${round}` },
          },
        };
      },
      () => ({ text: "done" }),
    ];
    const { snapshot } = await run(editorPage());
    const put = await userPut;
    const after = disk();
    const caption = (after.cells[1] as unknown as { data: { caption: string } }).data.caption;
    const source = (after.cells[0] as unknown as { data: { source: string } }).data.source;
    const status = operations(snapshot)[0];
    if (put?.status === 200) {
      // the user's save landed first: the agent's stale edit is refused, nothing of the agent is in the file
      expect(status, `round ${round}`).toBe("update_cell:conflict");
      expect(source).toBe(`USER TEXT ${round}`);
      expect(caption).not.toBe(`Agent caption ${round}`);
      winners.push("user");
    } else {
      // the agent landed first: the user's stale document is refused 409 and cannot erase the agent's caption
      expect(put?.status, `round ${round}`).toBe(409);
      expect(status, `round ${round}`).toBe("update_cell:ok");
      expect(caption).toBe(`Agent caption ${round}`);
      expect(source).not.toBe(`USER TEXT ${round}`);
      winners.push("agent");
    }
    expect(after.rev, `round ${round}`).toBe(rev + 1);
    expect(after.x_top).toEqual({ future: true });
    expect(after.cells).toHaveLength(2);
  }
  expect(winners[0]).toBe("user");
  expect(winners).toContain("agent");
});
