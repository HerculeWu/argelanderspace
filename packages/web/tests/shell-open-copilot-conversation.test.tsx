/**
 * `open_copilot` with a `conversationId` through the Shell (project-intake ticket 07): the tutorial replay's "take me
 * there". The panel opens and is handed a counted request to show that conversation; without an id it only opens, as
 * before. What the panel does with the request is copilot-open-conversation.test.tsx.
 */
import { waitFor } from "@testing-library/react";
import type { CopilotViewAction } from "@argelanderspace/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotProps } from "./shell-stubs";
import { installShellHarness, renderShell, stubShellFetch } from "./shell-harness";

const h = vi.hoisted(() => ({ props: null as CopilotProps | null, viewAction: null as unknown }));
vi.mock("../src/api/ws", async () => (await import("./shell-stubs")).quietWs());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe({ get props() { return h.props; }, set props(value) { h.props = value ?? null; }, get viewAction() { return h.viewAction; }, set viewAction(value) { h.viewAction = value; } }));
vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).workspaceProbe({ ws: null }));

installShellHarness();
beforeEach(() => { h.props = null; h.viewAction = null; });
const run = (action: CopilotViewAction) => (h.viewAction as (a: CopilotViewAction) => Promise<{ ok: boolean }>)(action);
const ID = "85b4af77-56d0-4684-8a1c-b8926dec17d0";

describe("open_copilot with a conversation id", () => {
  it("opens the closed panel and asks it, once per action, to show that conversation", async () => {
    stubShellFetch({ papers: () => ["d1"] });
    renderShell("/doc/d1");
    await waitFor(() => expect(h.viewAction).toBeTypeOf("function"));
    expect(h.props?.open).toBe(false);
    expect(h.props?.conversationAsked).toEqual({ seq: 0, id: "" });
    expect((await run({ action: "open_copilot", conversationId: ID })).ok).toBe(true);
    await waitFor(() => expect(h.props?.open).toBe(true));
    expect(h.props?.conversationAsked).toEqual({ seq: 1, id: ID });
    await run({ action: "open_copilot", conversationId: ID });
    await waitFor(() => expect(h.props?.conversationAsked).toEqual({ seq: 2, id: ID }));
  });
  it("without an id it only opens the panel: no request", async () => {
    stubShellFetch({ papers: () => ["d1"] });
    renderShell("/doc/d1");
    await waitFor(() => expect(h.viewAction).toBeTypeOf("function"));
    await run({ action: "open_copilot" });
    await waitFor(() => expect(h.props?.open).toBe(true));
    expect(h.props?.conversationAsked?.seq).toBe(0);
  });
});
