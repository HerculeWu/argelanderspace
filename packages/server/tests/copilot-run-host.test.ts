/**
 * The host's side of the tool registry (architecture-deepening ticket 06): what one run hands the registry — its one
 * shared host context and its own dependencies — behaves as the run needs after a Stop. A real CopilotHost and a real
 * Pi session; only the model is scripted (it thinks until it is aborted), and the run's context and dependencies are
 * taken from the call that assembles its tools.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PageContext, WsCopilotViewAction } from "@argelanderspace/contracts";
import { plansPath } from "@argelanderspace/core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

type Registry = typeof import("../src/copilot-tool-registry.js");
type AssembleInput = Parameters<Registry["assembleRunTools"]>[0];
const captured = vi.hoisted(() => ({
  runs: [] as Array<{ host: unknown; deps: unknown }>,
}));
vi.mock("../src/copilot-tool-registry.js", async (importOriginal) => {
  const real = await importOriginal<Registry>();
  return {
    ...real,
    assembleRunTools: (input: AssembleInput) => {
      captured.runs.push({ host: input.host, deps: input.deps });
      return real.assembleRunTools(input);
    },
  };
});

const { CopilotHost } = await import("../src/copilot.js");
const { AsyncLock } = await import("../src/lock.js");
const { ProviderSettings } = await import("../src/providers.js");

let root: string;
let host: InstanceType<typeof CopilotHost>;
let delivered: WsCopilotViewAction[];
let originalEnv: NodeJS.ProcessEnv;
const VIEW = randomUUID();

beforeEach(async () => {
  originalEnv = process.env;
  root = mkdtempSync(join(tmpdir(), "copilot-run-host-"));
  process.env = { PATH: originalEnv.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected external fetch");
  });
  const statusDir = join(root, "status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(plansPath(statusDir), JSON.stringify({ version: 1, rev: 1, plans: [] }));
  captured.runs = [];
  delivered = [];
  const settings = new ProviderSettings();
  await settings.credential("openai", "SYNTHETIC_COPILOT_KEY");
  (await settings.getRuntime()).registerProvider("openai", {
    api: "openai-responses",
    // The model thinks until the run is aborted (Stop), then ends without a reply.
    streamSimple(model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "stop",
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
      const end = () =>
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...message, stopReason: "aborted", errorMessage: "aborted" },
        });
      if (options?.signal?.aborted) end();
      else options?.signal?.addEventListener("abort", end, { once: true });
      return stream;
    },
  });
  host = new CopilotHost(join(root, "data"), settings, () => {});
  host.useWorkbench({
    plans: {
      statusDir,
      planLock: new AsyncLock(),
      onChanged: () => {},
      docExists: () => true,
    } as never,
  });
  // A connected browser that receives every view action and answers none of them (the test answers for it).
  host.useViewDelivery((_viewId, message) => {
    delivered.push(message);
    return true;
  });
});
afterEach(async () => {
  await host.close().catch(() => {});
  process.env = originalEnv;
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
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
const status = async (id: string) => (await host.snapshot(id)).conversation.run?.status;

test("after Stop the run's navigation is cancelled and admits nothing, its state sync is still delivered, and the terminal state waits for tracked work", async () => {
  host.publish(page());
  const created = await host.create({ provider: "openai", model: "gpt-4.1", thinking: null });
  const id = created.conversation.id;
  await host.send(id, {
    clientMessageId: randomUUID(),
    text: "Hello",
    viewId: VIEW,
    contextRevision: 1,
  });
  await vi.waitFor(() => expect(captured.runs).toHaveLength(1));
  await vi.waitFor(async () => expect(await status(id)).toBe("running"));
  const shared = captured.runs[0]?.host as {
    admitting(): boolean;
    track<T>(work: Promise<T>): Promise<T>;
  };
  const deps = captured.runs[0]?.deps as {
    viewAction(action: unknown, options?: { reportMs?: number }): Promise<unknown>;
    shellSync(action: unknown): void;
  };
  expect(shared.admitting()).toBe(true);

  // navigation of the run and a state sync, both waiting for the browser's report
  const navigation = deps.viewAction({ action: "show_plan" });
  deps.shellSync({ action: "doc_deleted", docId: "doc-a", remaining: [] });
  await vi.waitFor(() => expect(delivered).toHaveLength(2));
  const [navMessage, syncMessage] = delivered;
  // a submitted write that has not finished yet
  let finish!: () => void;
  const tracked = shared.track(
    new Promise<void>((resolve) => {
      finish = resolve;
    })
  );

  await host.stop(id);
  expect(shared.admitting()).toBe(false);
  // Stop cancels the run's own navigation …
  await expect(navigation).resolves.toEqual({ status: "not_displayed", detail: "stopped" });
  expect(
    host.resolveViewAction(VIEW, { actionId: navMessage?.actionId ?? "", ok: true } as never)
  ).toBe(false);
  // … but not a state sync: it carries no run id, it is still waiting for the browser
  expect(
    host.resolveViewAction(VIEW, { actionId: syncMessage?.actionId ?? "", ok: true } as never)
  ).toBe(true);
  // and one sent after the Stop (the tail of a write the user already confirmed) is still delivered
  deps.shellSync({ action: "discovery_saved", bibcode: "2020MNRAS.499.1234X", workId: "w" });
  await vi.waitFor(() => expect(delivered).toHaveLength(3));
  expect(delivered[2]?.action).toEqual({
    action: "discovery_saved",
    bibcode: "2020MNRAS.499.1234X",
    workId: "w",
  });

  // the terminal state waits for the work the one shared track handed to state.inflight
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await status(id)).toBe("stopping");
  finish();
  await tracked;
  await vi.waitFor(async () => expect(await status(id)).toBe("stopped"));
});
