/**
 * The world of the project-intake acceptance (project-intake ticket 08): a real Copilot host over `createApp` in a
 * temporary Project folder, real Pi session with Pi's own file and command tools, the real `library` and `plan`
 * business tools, the real job runner and PDFium. Only two things are stand-ins, and both are outside the program: the
 * MODEL (a scripted agent, below) and the NETWORK (the offline ADS of `intake-fixture.ts`; every other fetch throws).
 *
 * The scripted agent is a generator: each `yield` is one model turn (a tool call, or text that ends the turn and waits
 * for the user), and what the real tool or the real user answered comes back as the value of the `yield`. So the agent
 * decides from real results, the way the skill tells a model to, instead of replaying a fixed list of calls.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConversationSnapshot,
  CopilotConfirmation,
  CopilotFileToolsSetting,
  CopilotOperation,
  PageContext,
} from "@argelanderspace/contracts";
import { libraryPaths, plansPath } from "@argelanderspace/core";
import { AdsClient, AdsLibrariesClient, bundledSkillsDir } from "@argelanderspace/infra";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  getSystemMessageText,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { vi } from "vitest";
import { createApp } from "../src/app.js";
import { CopilotHost } from "../src/copilot.js";
import { fileToolsDefault } from "../src/file-tools-default.js";
import { JobRunner } from "../src/jobs.js";
import { ProviderSettings } from "../src/providers.js";
import { stubPipelines, stubSources } from "./helpers.js";
import { ADS_TOKEN, type AdsStub, adsStub } from "./intake-fixture.js";

// ---- the scripted agent -------------------------------------------------------------------------------- //

export type Act = { call: { name: string; args: Record<string, unknown> } } | { say: string };
/** What came back: the tool's text, or what the user typed. */
export interface Feed {
  text: string;
  /** the session's system prompt (the Project folder and the skill's location are in it) */
  system: string;
}
// biome-ignore lint/suspicious/noExplicitAny: the tools answer parsed JSON, and the script reads it by field
export type Json = any;
export type Gen<T> = Generator<Act, T, Feed>;

/** One tool call; the tool's own text comes back. */
export function* call(name: string, args: Record<string, unknown>): Gen<string> {
  return (yield { call: { name, args } }).text;
}
/** A `library` or `plan` call; the parsed JSON comes back. */
export function* tool(name: "library" | "plan", args: Record<string, unknown>): Gen<Json> {
  const text = yield* call(name, args);
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error(
      `${name} ${JSON.stringify(args).slice(0, 200)} did not answer JSON: ${text.slice(0, 300)}`
    );
  }
}
/** Text that ends the turn: the user's next message comes back. */
export function* say(text: string): Gen<string> {
  return (yield { say: text }).text;
}

// ---- the world ----------------------------------------------------------------------------------------- //

export interface World {
  root: string;
  project: string;
  dataDir: string;
  statusDir: string;
  app: ReturnType<typeof createApp>;
  host: CopilotHost;
  runner: JobRunner;
  ads: AdsStub;
  /** every arXiv PDF download the program attempted */
  arxivFetches: string[];
  /** every arXiv source ingest the program attempted */
  arxivIngests: string[];
  seen: TranscriptContext[];
  /** every tool call the scripted model made, with the session (1, 2, …) it belongs to */
  calls: { session: number; name: string; args: Record<string, unknown> }[];
  /** what the scripted model threw (a step it could not take on what the tools answered) */
  scriptErrors: Error[];
  /** the agent the next model turn belongs to */
  agent(gen: Gen<void>): void;
  close(): Promise<void>;
}

const choice = { provider: "openai", model: "gpt-4.1", thinking: null };
const VIEW = randomUUID();
const here = dirname(fileURLToPath(import.meta.url));
export const SKILLS = bundledSkillsDir(join(here, "..", "..", "app", "dist", "bin.js"));

export async function openWorld(
  permission: CopilotFileToolsSetting = "ask",
  libraries?: Parameters<typeof adsStub>[0]
): Promise<World> {
  const originalEnv = process.env;
  const root = mkdtempSync(join(tmpdir(), "intake-acceptance-"));
  const project = join(root, "project");
  const dataDir = join(project, "literatures");
  const statusDir = join(root, "status");
  const configPath = join(root, "cfg", "config.toml");
  const globalDir = join(root, "global");
  const cacheDir = join(root, "cache-global");
  for (const dir of [project, dataDir, statusDir, join(root, "cfg"), globalDir, cacheDir])
    mkdirSync(dir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }));
  writeFileSync(
    configPath,
    `copilot_file_tools = "${permission}"\nglobal_dir = ${JSON.stringify(globalDir)}\nglobal_cache_dir = ${JSON.stringify(cacheDir)}\n`
  );
  // the shell the scripted agent runs commands in inherits this: everything it could reach is under the temporary root
  // (a keychain or session bus found through HOME-less defaults would be the user's own), see docs/engineering.md
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(join(root, "run"), { recursive: true });
  process.env = {
    PATH: originalEnv.PATH,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "xdg"),
    XDG_RUNTIME_DIR: join(root, "run"),
    TMPDIR: join(root, "tmp"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "no-bus")}`,
    LANG: "C.UTF-8",
  };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });

  let current: Gen<void> | null = null;
  let session = 0;
  const calls: World["calls"] = [];
  const scriptErrors: Error[] = [];
  let primed = false;
  const seen: TranscriptContext[] = [];
  const settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: Model<Api>, context: TranscriptContext) {
      seen.push(structuredClone(context));
      const index = seen.length;
      const stream = createAssistantMessageEventStream();
      let act: Act;
      if (current === null) act = { say: "(no agent is scripted for this turn)" };
      else {
        if (!primed) {
          primed = true;
          current.next(); // runs to the first `yield`, which waits for the first user message
        }
        try {
          const step = current.next(feedOf(context));
          act = step.done ? { say: "(the script has ended)" } : step.value;
        } catch (error) {
          scriptErrors.push(error instanceof Error ? error : new Error(String(error)));
          act = { say: `(the script failed: ${String(error)})` };
        }
      }
      const call = "call" in act ? act.call : null;
      if (call) calls.push({ session, ...call });
      const message: AssistantMessage = {
        role: "assistant",
        content: call
          ? [
              {
                type: "toolCall",
                id: `call_${index}`,
                name: call.name,
                arguments: call.args as never,
              },
            ]
          : [{ type: "text", text: (act as { say: string }).say }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: call ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      });
      return stream;
    },
  });

  const ads = adsStub(libraries);
  const arxivFetches: string[] = [];
  const arxivIngests: string[] = [];
  const runner = new JobRunner({ dir: join(root, "jobs") });
  const host = new CopilotHost(dataDir, settings, () => {});
  host.useSkillsDir(SKILLS);
  const pipelines = stubPipelines();
  const app = createApp({
    paths: libraryPaths(dataDir),
    statusDir,
    makeSources: () => ({
      ...stubSources(),
      ads: new AdsClient({
        token: ADS_TOKEN,
        delay: 0,
        cacheDir: join(root, "ads-cache"),
        fetchImpl: ads.fetchImpl as never,
      }),
    }),
    makeAdsLibraries: () =>
      new AdsLibrariesClient({ token: ADS_TOKEN, fetchImpl: ads.fetchImpl as never }),
    pipelines: {
      ...pipelines,
      ingestArxivEprint: async (id, opts) => {
        arxivIngests.push(id);
        return pipelines.ingestArxivEprint(id, opts);
      },
    },
    // the user's own setting is ON, the worst case for a migration: nothing may be queued unasked
    autoIngestArxiv: () => true,
    fetchArxivPdf: async (id) => {
      arxivFetches.push(id);
      return (await import("./intake-fixture.js")).textPdf([
        [`arXiv:${id}`, "Synthetic arXiv copy."],
      ]);
    },
    runner,
    providerSettings: settings,
    copilot: host,
    configPath,
    projectRoot: project,
    broadcast: () => {},
  });
  const hosts = [host];
  return {
    root,
    project,
    dataDir,
    statusDir,
    app,
    host,
    runner,
    ads,
    arxivFetches,
    arxivIngests,
    seen,
    calls,
    scriptErrors,
    agent(gen) {
      session++;
      current = gen;
      primed = false;
    },
    async close() {
      fileToolsDefault.value = "off";
      for (const created of hosts) await created.close().catch(() => {});
      process.env = originalEnv;
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** What the model's last turn got back: the user's text (envelope unwrapped) or the last tool's text. */
function feedOf(context: TranscriptContext): Feed {
  const feed = bareFeed(context);
  const system = context.messages.find((m) => m.role === "system");
  return {
    ...feed,
    system: system && system.role === "system" ? getSystemMessageText(system) : "",
  };
}
function bareFeed(context: TranscriptContext): Pick<Feed, "text"> {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult")
    return { text: last.content.map((p) => (p.type === "text" ? p.text : "")).join("") };
  if (last?.role === "user") {
    const raw =
      typeof last.content === "string"
        ? last.content
        : last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    try {
      const envelope = JSON.parse(raw) as { text?: string };
      if (typeof envelope.text === "string") return { text: envelope.text };
    } catch {
      // not an envelope
    }
    return { text: raw };
  }
  return { text: "" };
}

// ---- driving conversations ----------------------------------------------------------------------------- //

const planPage = (): PageContext => ({
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

export const request = (w: World, path: string, method = "GET", body?: unknown) =>
  w.app.request(`/api/copilot${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export async function newConversation(w: World): Promise<string> {
  const created = (await (
    await request(w, "/conversations", "POST", { model: choice })
  ).json()) as ConversationSnapshot;
  const put = await request(w, `/views/${VIEW}`, "PUT", planPage());
  if (put.status !== 200) throw new Error(`page context refused: ${put.status}`);
  return created.conversation.id;
}

/** A card the user was shown and what they answered. */
export interface CardLog {
  action: string;
  /** the command, or the path to write */
  detail: string;
  decision: "approve" | "decline";
}

export type Policy = (card: CopilotConfirmation) => "approve" | "decline" | { allowSession: true };

/**
 * The user's turn: send a message, then answer every confirmation card by `policy` until the run ends.
 * Returns the cards shown and the assistant's last text.
 */
export async function userTurn(
  w: World,
  id: string,
  text: string,
  policy: Policy = () => "approve"
): Promise<{ cards: CardLog[]; reply: string; status: string }> {
  const before = (await w.host.snapshot(id)).conversation.run?.id ?? null;
  const sent = await request(w, `/conversations/${id}/messages`, "POST", {
    clientMessageId: randomUUID(),
    text,
    viewId: VIEW,
    contextRevision: 1,
  });
  if (sent.status !== 202) throw new Error(`message refused: ${sent.status} ${await sent.text()}`);
  const cards: CardLog[] = [];
  const answered = new Set<string>();
  const end = Date.now() + 120_000;
  for (;;) {
    const snap = await w.host.snapshot(id);
    const run = snap.conversation.run;
    const status = run === null || run === undefined || run.id === before ? "pending" : run.status;
    for (const card of snap.confirmations) {
      if (answered.has(card.id)) continue;
      answered.add(card.id);
      const verdict = policy(card);
      const decision = verdict === "decline" ? "decline" : "approve";
      const detail =
        card.action === "run_command"
          ? (card as { command: string }).command
          : ((card as unknown as { path?: string }).path ?? card.action);
      cards.push({ action: card.action, detail, decision });
      const res = await request(w, `/confirmations/${card.id}`, "POST", {
        decision,
        viewId: VIEW,
        action: card.action,
        objectId: card.object.id,
        baseRev: card.baseRev,
        ...(typeof verdict === "object" ? { remember: true } : {}),
      });
      if (res.status !== 200)
        throw new Error(`card answer refused: ${res.status} ${await res.text()}`);
    }
    if (["completed", "failed", "stopped", "interrupted"].includes(status)) {
      if (w.scriptErrors[0]) throw w.scriptErrors[0];
      const assistant = snap.messages.filter((m) => m.role === "assistant").at(-1);
      return { cards, reply: assistant?.text ?? "", status };
    }
    if (Date.now() > end) throw new Error(`the run did not end (status ${status})`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Every operation the Copilot recorded in a conversation (business tools and file tools alike). */
export async function operationsOf(w: World, id: string): Promise<CopilotOperation[]> {
  return (await w.host.snapshot(id)).messages.flatMap((m) => m.operations ?? []);
}
