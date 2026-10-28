/**
 * The Shell's side of the intake entries (project-intake ticket 06): the workspace's `startIntake` opens the Copilot
 * panel and hands it a counted request, so the same kind asked twice is two requests. What the panel does with a
 * request is copilot-intake.test.tsx.
 */
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../src/argelander/workspace";
import type { CopilotProps } from "./shell-stubs";
import { installShellHarness, renderShell, stubShellFetch } from "./shell-harness";

const h = vi.hoisted(() => ({ ws: null as Workspace | null, props: null as CopilotProps | null }));
vi.mock("../src/api/ws", async () => (await import("./shell-stubs")).quietWs());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe({ get props() { return h.props; }, set props(value) { h.props = value ?? null; }, viewAction: null }));
vi.mock("../src/doc/DocPane", async () => (await import("./shell-stubs")).workspaceProbe(h));

installShellHarness();
beforeEach(() => { h.ws = null; h.props = null; });

describe("workspace.startIntake", () => {
  it("opens the closed panel and counts each request", async () => {
    stubShellFetch({ papers: () => ["d1"] });
    renderShell("/doc/d1");
    await waitFor(() => expect(h.ws?.startIntake).toBeTypeOf("function"));
    expect(h.props?.open).toBe(false);
    expect(h.props?.intakeAsked?.seq).toBe(0);
    act(() => h.ws!.startIntake!("start"));
    await waitFor(() => expect(h.props?.open).toBe(true));
    expect(h.props?.intakeAsked).toEqual({ seq: 1, kind: "start" });
    act(() => h.ws!.startIntake!("resume"));
    await waitFor(() => expect(h.props?.intakeAsked).toEqual({ seq: 2, kind: "resume" }));
    act(() => h.ws!.startIntake!("resume"));
    await waitFor(() => expect(h.props?.intakeAsked).toEqual({ seq: 3, kind: "resume" }));
    expect(h.props?.open).toBe(true);
  });
});
