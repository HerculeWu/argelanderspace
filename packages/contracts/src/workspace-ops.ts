/**
 * Workbench (Shell) operations the Copilot may ask the bound browser view to perform (copilot ticket 12).
 *
 * Every action here mirrors a control the Shell already has: the activity-bar and pane-header view
 * switches, split / close / activate pane, the divider drag, and the Tweaks popover. The browser view
 * executes them through the same callbacks as the user's click, so the pane limit and the leave-draft
 * protection are the UI's own. Nothing here takes a path, a URL, a selector or a credential.
 */
import { z } from "zod";

/** The Shell never shows more than this many panes. */
export const MAX_PANES = 3;
/** The divider drag never lets a pane shrink below this share of the total width. */
export const MIN_PANE_SHARE = 0.16;

/** Views a pane can show. `ext` (extensions) is a stub page, so it is deliberately absent. */
export const WORKSPACE_VIEWS = ["plan", "library", "doc", "write"] as const;
export const WORKSPACE_STUB_VIEWS = ["ext"] as const;
export const APPEARANCE_THEMES = ["dark", "light"] as const;
export const APPEARANCE_ACCENTS = ["azure", "teal", "violet", "amber", "neutral"] as const;
export const APPEARANCE_DENSITIES = ["compact", "regular", "comfy"] as const;
export const APPEARANCE_LANGUAGES = ["zh-CN", "en"] as const;

const PaneId = z.number().int().positive();

export const WorkspaceViewActionSchema = z.discriminatedUnion("action", [
  /** Without `paneId` this is the activity-bar button for the active pane; with it, the pane header menu. */
  z
    .object({
      action: z.literal("switch_view"),
      view: z.enum(WORKSPACE_VIEWS),
      paneId: PaneId.optional(),
    })
    .strict(),
  /** Without `paneId` it splits the active pane (title-bar button); the new pane becomes active. */
  z.object({ action: z.literal("split_pane"), paneId: PaneId.optional() }).strict(),
  z.object({ action: z.literal("close_pane"), paneId: PaneId }).strict(),
  z.object({ action: z.literal("select_pane"), paneId: PaneId }).strict(),
  /** Moves the divider after the pane (before it for the last pane); the neighbour gives or takes the space. */
  z
    .object({
      action: z.literal("resize_pane"),
      paneId: PaneId,
      share: z
        .number()
        .min(MIN_PANE_SHARE)
        .max(1 - MIN_PANE_SHARE),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_appearance"),
      theme: z.enum(APPEARANCE_THEMES).optional(),
      accent: z.enum(APPEARANCE_ACCENTS).optional(),
      density: z.enum(APPEARANCE_DENSITIES).optional(),
      language: z.enum(APPEARANCE_LANGUAGES).optional(),
    })
    .strict()
    .refine(
      (value) =>
        [value.theme, value.accent, value.density, value.language].some(
          (item) => item !== undefined
        ),
      { message: "nothing to set" }
    ),
  /** Opens the Copilot panel and its provider settings dialog. Only opens it: the user enters any secret. */
  z.object({ action: z.literal("open_copilot_settings") }).strict(),
  /** The toolbar's Copilot toggle: show or collapse the panel (the conversation keeps running either way). */
  z.object({ action: z.literal("open_copilot") }).strict(),
  z.object({ action: z.literal("close_copilot") }).strict(),
  /**
   * Show a library Doc in the Reader through the Shell's own openDoc: the pane that already shows a Doc,
   * else the active pane. Only a Doc the library has can be opened.
   */
  z.object({ action: z.literal("open_doc"), docId: z.string().min(1).max(200) }).strict(),
]);
export type WorkspaceViewAction = z.infer<typeof WorkspaceViewActionSchema>;

/** The layout and appearance the bound view last published, so the model knows what it is operating on. */
export const WorkspaceSnapshotSchema = z
  .object({
    maxPanes: z.number().int().positive(),
    activePaneId: PaneId,
    panes: z
      .array(
        z
          .object({
            paneId: PaneId,
            view: z.string().min(1).max(100),
            /** This pane's share of the total pane width (0–1, rounded). */
            share: z.number().min(0).max(1),
          })
          .strict()
      )
      .min(1)
      .max(MAX_PANES),
    appearance: z
      .object({
        theme: z.enum(APPEARANCE_THEMES),
        accent: z.string().min(1).max(40),
        density: z.enum(APPEARANCE_DENSITIES),
        language: z.enum(APPEARANCE_LANGUAGES),
      })
      .strict(),
    copilotOpen: z.boolean(),
  })
  .strict();
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export const WorkspaceReadOperationSchema = z
  .object({ action: z.literal("capabilities") })
  .strict();
export const WorkspaceProviderStatusSchema = z
  .object({ action: z.literal("provider_status") })
  .strict();
/** Thinking choices of the composer's selector; "default" means "the model's default" (stored as null). */
export const WORKSPACE_THINKING_CHOICES = [
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
/** Choose the model (and thinking level) of the current conversation, like the composer's selectors. */
export const WorkspaceSelectModelSchema = z
  .object({
    action: z.literal("select_model"),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    thinking: z.enum(WORKSPACE_THINKING_CHOICES).optional(),
  })
  .strict();
export const WORKSPACE_OPERATION_ACTIONS = [
  "capabilities",
  "provider_status",
  "select_model",
  "switch_view",
  "split_pane",
  "close_pane",
  "select_pane",
  "resize_pane",
  "set_appearance",
  "open_copilot_settings",
  "open_copilot",
  "close_copilot",
  "open_doc",
] as const;
/** Actions the service answers itself: they need no browser view. */
export const WORKSPACE_SERVICE_ACTIONS = [
  "capabilities",
  "provider_status",
  "select_model",
] as const;

export interface WorkspaceCapability {
  action: (typeof WORKSPACE_OPERATION_ACTIONS)[number];
  available: boolean;
  /** Why a control is disabled (the same reason the UI shows it disabled). The Shell has no busy state. */
  reason?: "pane_limit" | "last_pane" | "no_view";
}

/** What each Shell control would do right now, from the snapshot the bound view last published. */
export function workspaceCapabilities(
  snapshot: WorkspaceSnapshot | undefined
): WorkspaceCapability[] {
  const service = WORKSPACE_SERVICE_ACTIONS.map(
    (action): WorkspaceCapability => ({ action, available: true })
  );
  const viewActions = WORKSPACE_OPERATION_ACTIONS.filter(
    (action) => !(WORKSPACE_SERVICE_ACTIONS as readonly string[]).includes(action)
  );
  if (!snapshot)
    return [
      ...service,
      ...viewActions.map(
        (action): WorkspaceCapability => ({ action, available: false, reason: "no_view" })
      ),
    ];
  const paneCount = snapshot.panes.length;
  const flags: Record<string, WorkspaceCapability["reason"] | undefined> = {
    split_pane: paneCount >= snapshot.maxPanes ? "pane_limit" : undefined,
    close_pane: paneCount <= 1 ? "last_pane" : undefined,
    resize_pane: paneCount <= 1 ? "last_pane" : undefined,
  };
  return [
    ...service,
    ...viewActions.map((action): WorkspaceCapability => {
      const reason = flags[action];
      return reason ? { action, available: false, reason } : { action, available: true };
    }),
  ];
}

/**
 * What a browser's platform boundary lets the agent do. Every entry here is a user-gesture or
 * permission-gated browser capability: the agent cannot perform it, whatever it asks for. The agent
 * works only with material the application already admitted (library, attachments, app assets); a
 * file chooser or a local path never becomes a way to read an arbitrary file.
 */
export const PLATFORM_BOUNDARIES = [
  { capability: "clipboard", agent: "user_only", reason: "browser_permission" },
  // Ticket 33 follow-up: a download is the user's, with exactly these named exceptions, each a page control the
  // agent presses through its own tool (the same handler as the user's button). Clipboard copying stays user-only.
  {
    capability: "download",
    agent: "limited",
    reason: "user_gesture",
    agent_actions: ["reader.download_original", "writer.export_manuscript"],
  },
  { capability: "file_picker", agent: "user_only", reason: "user_gesture" },
  { capability: "external_link", agent: "user_only", reason: "user_gesture" },
  { capability: "local_path", agent: "never", reason: "not_an_application_object" },
] as const;
