import {
  APPEARANCE_ACCENTS,
  APPEARANCE_DENSITIES,
  APPEARANCE_LANGUAGES,
  APPEARANCE_THEMES,
  type CopilotOperation,
  type CopilotViewActionResult,
  type PageContext,
  PLATFORM_BOUNDARIES,
  WORKSPACE_OPERATION_ACTIONS,
  WORKSPACE_STUB_VIEWS,
  WORKSPACE_THINKING_CHOICES,
  WORKSPACE_VIEWS,
  WorkspaceProviderStatusSchema,
  WorkspaceReadOperationSchema,
  WorkspaceSelectModelSchema,
  type WorkspaceViewAction,
  WorkspaceViewActionSchema,
  workspaceCapabilities,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const WORKSPACE_TOOL_NAME = "workspace";

/** What came back from the bound browser view, with the reason when it was not displayed. */
export interface ViewActionOutcome {
  status: "displayed" | "not_displayed" | "not_found" | "failed";
  /** With `failed`: the HTTP status the exploration request got (0 = network failure). */
  http?: number;
  /** A Reader `set_panel` unfold folded this other panel to keep the article's minimum width. */
  folded?: "outline" | "right";
  /** Why it was not displayed: `offline` (no browser came back in time), `no_report`, or the view's own reason. */
  detail?: "offline" | "no_report" | "stopped" | NonNullable<CopilotViewActionResult["detail"]>;
}

/** How a view action's outcome reads as an operation record and as the model's tool result. */
export function viewOutcomeResult(outcome: ViewActionOutcome): {
  status: CopilotOperation["status"];
  payload: Record<string, unknown>;
} {
  if (outcome.status === "displayed")
    return {
      status: "ok",
      payload: { ok: true, status: "ok", ...(outcome.folded ? { folded: outcome.folded } : {}) },
    };
  if (outcome.status === "not_found")
    return { status: "not_found", payload: { ok: false, status: "not_found" } };
  if (outcome.status === "failed")
    return {
      status: "error",
      payload: {
        ok: false,
        status: "error",
        ...(outcome.http !== undefined ? { http: outcome.http } : {}),
        detail: `the exploration request failed (${outcome.http ? `HTTP ${outcome.http}` : "network failure"}); the user's page shows the error, nothing was saved and nothing else was started. read_discovery shows the page; retry_exploration is the user's Retry button`,
      },
    };
  if (outcome.detail === "disabled")
    return {
      status: "rejected",
      payload: {
        ok: false,
        status: "rejected",
        detail: "disabled: the control is disabled right now (read capabilities for the reason)",
      },
    };
  const reasons: Record<string, string> = {
    offline:
      "the user's browser was not connected in time, so nothing was shown; do not report it as displayed",
    no_report: "the browser did not confirm the action, so it may not have been shown",
    leave_blocked:
      "the user kept unsaved work open, so the view did not change; ask the user to save or discard first",
    unavailable: "the page that can do this is not available right now",
    stopped: "the run was stopped before the browser was asked, so nothing was shown",
    cancelled:
      "the user cancelled the exploration request before it finished; no new exploration was opened and nothing was saved",
  };
  return {
    status: "not_displayed",
    payload: {
      ok: false,
      status: "not_displayed",
      ...(outcome.detail && reasons[outcome.detail] ? { detail: reasons[outcome.detail] } : {}),
    },
  };
}

export interface WorkspaceToolContext {
  /** The page the bound view last published; the tool reports exactly this, never a guess. */
  page: () => PageContext | undefined;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: WorkspaceViewAction) => Promise<ViewActionOutcome>;
  /** Redacted provider state: never a key, token, sign-in code or endpoint. */
  providerStatus: () => Promise<unknown>;
  /** The conversation's model choice, validated by the same rules as the composer's selectors. */
  selectModel: (choice: {
    provider: string;
    model: string;
    thinking: string | null;
  }) => Promise<{ provider: string; model: string; thinking: string | null }>;
  /** False once the host stopped admitting operations (Stop, shutdown). */
  admitting: () => boolean;
}

// A plain string enum keeps the provider schema small: tool schemas count against the model's window.
const lit = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>({ type: "string", enum: [...values] });

const parameters = Type.Object(
  {
    action: lit(WORKSPACE_OPERATION_ACTIONS),
    view: Type.Optional(lit(WORKSPACE_VIEWS)),
    paneId: Type.Optional(Type.Integer({ minimum: 1, description: "Omit for the active pane." })),
    share: Type.Optional(Type.Number({ description: "resize_pane: width share 0.16-0.84." })),
    provider: Type.Optional(
      Type.String({ description: "select_model: provider id from provider_status." })
    ),
    model: Type.Optional(
      Type.String({ description: "select_model: model id from provider_status." })
    ),
    thinking: Type.Optional(lit(WORKSPACE_THINKING_CHOICES)),
    docId: Type.Optional(Type.String({ description: "open_doc: a library Doc id." })),
    theme: Type.Optional(lit(APPEARANCE_THEMES)),
    accent: Type.Optional(lit(APPEARANCE_ACCENTS)),
    density: Type.Optional(lit(APPEARANCE_DENSITIES)),
    language: Type.Optional(lit(APPEARANCE_LANGUAGES)),
  },
  { additionalProperties: false }
);

const description = [
  "Operate the shell like the user's controls: switch a pane's view, open a Doc, split/close/select/resize panes (max 3), set theme/accent/density/language, show or hide the Copilot panel, open its settings dialog (it only opens; you never see keys).",
  "capabilities reports layout, appearance, disabled controls and why, and what the browser platform does not allow you (clipboard, downloads, file choosers, links, local paths). provider_status reads redacted provider state; select_model sets this conversation's model and thinking from it.",
].join(" ");

function record(id: string, action: string, partial: Partial<CopilotOperation>): CopilotOperation {
  return { id, tool: WORKSPACE_TOOL_NAME, action, status: "error", ...partial };
}

export function createWorkspaceTool(context: WorkspaceToolContext) {
  return defineTool({
    name: WORKSPACE_TOOL_NAME,
    label: "Workspace",
    description,
    executionMode: "sequential",
    parameters,
    async execute(toolCallId, params) {
      const action = typeof params.action === "string" ? params.action : "unknown";
      const done = (operation: CopilotOperation, payload: object) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        details: operation,
      });
      if (!context.admitting())
        return done(record(toolCallId, action, { status: "error" }), {
          ok: false,
          status: "closed",
        });
      try {
        if (WorkspaceReadOperationSchema.safeParse(params).success) {
          const page = context.page();
          const snapshot = page?.workspace;
          return done(record(toolCallId, "capabilities", { status: "ok" }), {
            ok: true,
            observed: page
              ? "the bound view's last report; the user may have changed it since"
              : "no browser view has reported yet",
            workspace: snapshot ?? null,
            actions: workspaceCapabilities(snapshot),
            views: {
              available: WORKSPACE_VIEWS,
              unavailable: WORKSPACE_STUB_VIEWS.map((view) => ({ view, reason: "stub_page" })),
            },
            appearance: {
              themes: APPEARANCE_THEMES,
              accents: APPEARANCE_ACCENTS,
              densities: APPEARANCE_DENSITIES,
              languages: APPEARANCE_LANGUAGES,
            },
            platform: PLATFORM_BOUNDARIES,
          });
        }
        if (WorkspaceProviderStatusSchema.safeParse(params).success)
          return done(record(toolCallId, "provider_status", { status: "ok" }), {
            ok: true,
            ...((await context.providerStatus()) as object),
          });
        const selection = WorkspaceSelectModelSchema.safeParse(params);
        if (selection.success) {
          try {
            const chosen = await context.selectModel({
              provider: selection.data.provider,
              model: selection.data.model,
              thinking:
                selection.data.thinking === undefined || selection.data.thinking === "default"
                  ? null
                  : selection.data.thinking,
            });
            return done(record(toolCallId, "select_model", { status: "ok" }), {
              ok: true,
              status: "ok",
              model: chosen,
              detail: "applies from the next model request; the one in flight keeps its choice",
            });
          } catch {
            // Unknown provider/model or a thinking level the model does not offer: nothing changed.
            return done(record(toolCallId, "select_model", { status: "rejected" }), {
              ok: false,
              status: "rejected",
              detail:
                "that model or thinking level is not available (read provider_status); the choice is unchanged",
            });
          }
        }
        const parsed = WorkspaceViewActionSchema.safeParse(params);
        if (!parsed.success)
          return done(record(toolCallId, action, { status: "unsupported" }), {
            ok: false,
            status: "unsupported",
            detail: "unknown action or invalid parameters",
            issues: parsed.error.issues
              .slice(0, 5)
              .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
        const outcome = viewOutcomeResult(await context.viewAction(parsed.data));
        return done(record(toolCallId, action, { status: outcome.status }), outcome.payload);
      } catch {
        return done(record(toolCallId, action, { status: "unknown" }), {
          ok: false,
          status: "unknown",
          detail: "unexpected failure; read capabilities to see what the user's page shows now",
        });
      }
    },
  });
}
