/**
 * What switching projects would interrupt, the Copilot part (desktop-app ticket 19): a conversation whose run is
 * working or waiting for the user is among `CopilotHost.liveRuns()`, and the server hands it to its desktop host, so the
 * 409 `confirmation_required` of a switch lists it under `impact.conversations`. A finished run is not listed.
 *
 * Real Copilot host, real Pi session, real routes of `createApp` (the host's routes included); only the model provider
 * is scripted, and the desktop host is a stand-in bridge that decides the way `desktop-host.ts` does (leave only when
 * everything interrupted now was acknowledged). The real desktop host is `desktop-switch.test.ts`; a real provider
 * cannot run there, so the Copilot part of its impact is covered here.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationSnapshot,
  type HostSwitchImpact,
  type PageContext,
  type PlansFile,
  switchAcknowledged,
} from "@argelanderspace/contracts";
import { libraryPaths, plansPath } from "@argelanderspace/core";
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
import type { HostBridge, HostWorkbench } from "../src/host-routes.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";

type Out = { text?: string; call?: Record<string, unknown> };
type Step = () => Out | Promise<Out>;

const PLAN = "p_0000000a";
const ELSEWHERE = "/elsewhere/next-project";
const choice = { provider: "openai", model: "gpt-4.1", thinking: null };

let root: string;
let originalEnv: NodeJS.ProcessEnv;
let copilot: CopilotHost;
let app: ReturnType<typeof createApp>;
let script: Step[];
let calls: number;
let workbench: HostWorkbench | null;

const seed = () => ({
  version: 1,
  rev: 7,
  plans: [
    {
      id: PLAN,
      name: "Alpha",
      due: "2026-12-31",
      icon: "target",
      created_at: "2026-10-02T00:00:00.000Z",
      tasks: [],
    },
  ],
});

/** A stand-in for the desktop host: leaves when everything interrupted now was acknowledged, else asks. */
function bridge(): HostBridge {
  return {
    portFallback: null,
    project: "open",
    request: () => true,
    recent: {
      list: () => ({ version: 1, projects: [], lastMissing: null }),
      open: (path, acknowledged) => {
        const impact = workbench?.impact() ?? { jobs: [], conversations: [], mail: [] };
        return switchAcknowledged(impact, acknowledged)
          ? "leaving"
          : { confirm: { target: { path, display: path, name: "next-project" }, impact } };
      },
      remove: () => ({ version: 1, projects: [], lastMissing: null }),
    },
    switching: { confirm: () => "unknown_switch", cancel: () => {} },
    useWorkbench(given) {
      workbench = given;
    },
  };
}

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-switch-"));
  const dataDir = join(root, "data");
  const statusDir = join(root, "status");
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify(seed(), null, 2));
  script = [];
  calls = 0;
  workbench = null;
  const settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, _context: TranscriptContext) {
      calls += 1;
      const index = calls;
      const step = script[index - 1];
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const out = step ? await step() : { text: "done" };
        const message: AssistantMessage = {
          role: "assistant",
          content: out.call
            ? [
                {
                  type: "toolCall",
                  id: `call_${index}`,
                  name: "plan",
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
  copilot = new CopilotHost(dataDir, settings, () => {});
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir,
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    providerSettings: settings,
    copilot,
    broadcast: () => {},
    host: bridge(),
  });
});

afterEach(async () => {
  await copilot.close().catch(() => {});
  process.env = originalEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const request = (path: string, method = "GET", body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function page(): PageContext {
  const file = seed() as unknown as PlansFile;
  return {
    version: 1,
    viewId: randomUUID(),
    revision: 1,
    paneId: 1,
    view: "plan",
    status: "complete",
    otherPanes: [],
    plan: {
      rev: 7,
      mode: "list",
      selectedPlanId: PLAN,
      saveState: "saved",
      groups: [],
      detail: null,
      plans: file.plans,
    },
  };
}

/** A conversation with one message sent: its run starts. */
async function start(text: string): Promise<string> {
  const created = (await (
    await request("/api/copilot/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const id = created.conversation.id;
  const view = page();
  expect((await request(`/api/copilot/views/${view.viewId}`, "PUT", view)).status).toBe(200);
  const sent = await request(`/api/copilot/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  expect(sent.status).toBe(202);
  return id;
}

const runStatus = async (id: string) => (await copilot.snapshot(id)).conversation.run?.status;
async function until(id: string, wanted: string[]) {
  await vi.waitFor(async () => expect(wanted).toContain(await runStatus(id)), { timeout: 8000 });
}

/** The switch the page asks for: the answer's status and, for a 409, what it would interrupt. */
async function openElsewhere(
  acknowledged?: unknown
): Promise<{ status: number; impact?: HostSwitchImpact; code?: string }> {
  const res = await request(
    "/api/host/recent-projects/open",
    "POST",
    acknowledged === undefined ? { path: ELSEWHERE } : { path: ELSEWHERE, acknowledged }
  );
  const body = (await res.json()) as { code?: string; impact?: HostSwitchImpact };
  return { status: res.status, ...body };
}

test("a run that is working is a live run, and the switch's 409 lists the conversation; once it ends the switch goes ahead", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  script = [
    async () => {
      await gate;
      return { text: "finished" };
    },
  ];
  const id = await start("Summarise the plan");
  await until(id, ["running"]);
  const { title } = (await copilot.snapshot(id)).conversation;

  expect(copilot.liveRuns()).toEqual([{ id, title }]);
  const asked = await openElsewhere();
  expect(asked).toMatchObject({ status: 409, code: "confirmation_required" });
  expect(asked.impact).toEqual({ jobs: [], conversations: [{ id, title }], mail: [] });
  // Without the conversation among what was acknowledged, nothing is left for.
  expect((await openElsewhere({ jobs: [], conversations: [], mail: [] })).status).toBe(409);

  release();
  await until(id, ["completed"]);
  expect(copilot.liveRuns()).toEqual([]);
  expect((await openElsewhere()).status).toBe(202);
});

test("a run waiting for the user's confirmation is a live run too; acknowledging it lets the switch go ahead", async () => {
  script = [
    () => ({ call: { action: "delete_plan", expectedRev: 7, planId: PLAN } }),
    () => ({ text: "waiting" }),
  ];
  const id = await start("Delete the Alpha plan");
  await until(id, ["waiting-for-user"]);
  const { title } = (await copilot.snapshot(id)).conversation;

  expect(copilot.liveRuns()).toEqual([{ id, title }]);
  const asked = await openElsewhere();
  expect(asked.status).toBe(409);
  expect(asked.impact?.conversations).toEqual([{ id, title }]);
  expect((await openElsewhere({ jobs: [], conversations: [id], mail: [] })).status).toBe(202);
});
