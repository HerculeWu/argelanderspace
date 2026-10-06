import { describe, expect, it } from "vitest";
import {
  APPEARANCE_ACCENTS,
  MAX_PANES,
  PageContextSchema,
  PLATFORM_BOUNDARIES,
  PlanViewActionSchema,
  WORKSPACE_OPERATION_ACTIONS,
  WORKSPACE_VIEWS,
  WorkspaceProviderStatusSchema,
  WorkspaceSelectModelSchema,
  WorkspaceViewActionSchema,
  WsCopilotViewActionSchema,
  workspaceCapabilities,
} from "../src/index.js";

const id = "6b6f5a9e-3c1d-4a8e-9f10-2a1f2b3c4d5e";
const snapshot = (panes: number) => ({
  maxPanes: MAX_PANES,
  activePaneId: 1,
  panes: Array.from({ length: panes }, (_, i) => ({
    paneId: i + 1,
    view: "plan",
    share: 1 / panes,
  })),
  appearance: {
    theme: "dark" as const,
    accent: "azure",
    density: "regular" as const,
    language: "en" as const,
  },
  copilotOpen: true,
});

describe("closed Shell action union", () => {
  it("accepts the Shell's own controls", () => {
    for (const ok of [
      { action: "switch_view", view: "library" },
      { action: "switch_view", view: "doc", paneId: 2 },
      { action: "split_pane" },
      { action: "split_pane", paneId: 2 },
      { action: "close_pane", paneId: 2 },
      { action: "select_pane", paneId: 1 },
      { action: "resize_pane", paneId: 1, share: 0.5 },
      { action: "set_appearance", theme: "light", density: "compact" },
      { action: "open_copilot_settings" },
      { action: "open_copilot" },
      { action: "close_copilot" },
      { action: "open_doc", docId: "demo" },
    ])
      expect(WorkspaceViewActionSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
  });

  it("rejects stubs, paths, urls, selectors, secrets and out-of-range layout", () => {
    for (const bad of [
      { action: "switch_view", view: "ext" }, // the extensions page is a stub, not a capability
      { action: "switch_view", view: "plan", selector: "#nav" },
      { action: "switch_view", view: "plan", url: "http://x" },
      { action: "set_appearance" },
      { action: "set_appearance", theme: "sepia" },
      { action: "set_appearance", accent: "red" },
      { action: "set_appearance", token: "abc" },
      { action: "resize_pane", paneId: 1, share: 0.05 },
      { action: "resize_pane", paneId: 1, share: 0.95 },
      { action: "close_pane" },
      { action: "open_copilot_settings", apiKey: "k" },
      { action: "download", path: "/etc/passwd" },
      { action: "click", selector: "button" },
      { action: "open_doc" },
      { action: "open_doc", docId: "d", path: "/etc/passwd" },
      { action: "open_copilot", apiKey: "k" },
    ])
      expect(WorkspaceViewActionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("travels with the Plan view actions on one targeted WS message and never mixes the two", () => {
    for (const action of [
      { action: "show", view: "board" },
      { action: "set_completed", expanded: true },
      { action: "open_task_doc", taskId: "t_00000001", docId: "d1" },
      { action: "split_pane" },
    ])
      expect(
        WsCopilotViewActionSchema.safeParse({
          type: "copilot.view-action",
          viewId: id,
          actionId: id,
          action,
        }).success
      ).toBe(true);
    expect(PlanViewActionSchema.safeParse({ action: "split_pane" }).success).toBe(false);
    expect(WorkspaceViewActionSchema.safeParse({ action: "show", view: "board" }).success).toBe(
      false
    );
  });

  it("keeps the shared lists in step with the enums the tool offers", () => {
    expect(WORKSPACE_VIEWS).not.toContain("ext");
    expect(APPEARANCE_ACCENTS).toContain("azure");
    expect(WORKSPACE_OPERATION_ACTIONS).toContain("capabilities");
  });
});

describe("workspace snapshot in the page context", () => {
  const base = {
    version: 1,
    viewId: id,
    revision: 1,
    paneId: 1,
    view: "library",
    otherPanes: [],
    status: "unavailable",
    plan: null,
  };
  it("is optional and strictly validated", () => {
    expect(PageContextSchema.safeParse(base).success).toBe(true);
    expect(PageContextSchema.safeParse({ ...base, workspace: snapshot(2) }).success).toBe(true);
    expect(
      PageContextSchema.safeParse({ ...base, workspace: { ...snapshot(2), secret: "x" } }).success
    ).toBe(false);
    expect(PageContextSchema.safeParse({ ...base, workspace: snapshot(4) }).success).toBe(false);
  });
});

describe("what each Shell control can do right now", () => {
  const byAction = (caps: ReturnType<typeof workspaceCapabilities>) =>
    Object.fromEntries(caps.map((c) => [c.action, c]));
  it("disables split at the pane limit and close/resize on the last pane, with the reason", () => {
    expect(byAction(workspaceCapabilities(snapshot(3)))).toMatchObject({
      split_pane: { available: false, reason: "pane_limit" },
      close_pane: { available: true },
    });
    expect(byAction(workspaceCapabilities(snapshot(1)))).toMatchObject({
      split_pane: { available: true },
      close_pane: { available: false, reason: "last_pane" },
      resize_pane: { available: false, reason: "last_pane" },
    });
  });
  it("offers nothing but the read when no view has published", () => {
    const caps = byAction(workspaceCapabilities(undefined));
    expect(caps.capabilities?.available).toBe(true);
    expect(caps.switch_view).toMatchObject({ available: false, reason: "no_view" });
  });
});

describe("platform boundary", () => {
  it("names every browser-gated capability as user-only (a download only through its two named actions) and local paths as never", () => {
    const by = Object.fromEntries(PLATFORM_BOUNDARIES.map((p) => [p.capability, p.agent]));
    expect(by).toEqual({
      clipboard: "user_only",
      download: "limited",
      file_picker: "user_only",
      external_link: "user_only",
      local_path: "never",
    });
    expect(PLATFORM_BOUNDARIES.find((p) => p.capability === "download")).toMatchObject({
      agent_actions: ["reader.download_original", "writer.export_manuscript"],
    });
  });
});

describe("Copilot settings parity actions", () => {
  it("select_model/provider_status are closed, secret-free shapes", () => {
    expect(
      WorkspaceSelectModelSchema.safeParse({
        action: "select_model",
        provider: "openai",
        model: "gpt-4.1",
        thinking: "high",
      }).success
    ).toBe(true);
    expect(
      WorkspaceSelectModelSchema.safeParse({
        action: "select_model",
        provider: "openai",
        model: "m",
        thinking: "default",
      }).success
    ).toBe(true);
    for (const bad of [
      { action: "select_model", provider: "openai", model: "m", thinking: "ludicrous" },
      { action: "select_model", provider: "openai", model: "m", apiKey: "k" },
      { action: "select_model", provider: "openai" },
    ])
      expect(WorkspaceSelectModelSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(WorkspaceProviderStatusSchema.safeParse({ action: "provider_status" }).success).toBe(
      true
    );
    expect(
      WorkspaceProviderStatusSchema.safeParse({ action: "provider_status", key: "x" }).success
    ).toBe(false);
  });
  it("service actions stay available without any browser view", () => {
    const caps = Object.fromEntries(workspaceCapabilities(undefined).map((c) => [c.action, c]));
    expect(caps.provider_status?.available).toBe(true);
    expect(caps.select_model?.available).toBe(true);
    expect(caps.open_copilot).toMatchObject({ available: false, reason: "no_view" });
  });
});
