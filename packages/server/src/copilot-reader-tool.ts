import {
  type CopilotOperation,
  READER_OPERATION_ACTIONS,
  READER_PANELS,
  READER_RIGHT_TABS,
  type ReaderReading,
  ReaderReadOperationSchema,
  type ReaderViewAction,
  ReaderViewActionSchema,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";

export const READER_TOOL_NAME = "reader";

/**
 * What a background read of one Doc found. `stale` annotations belong to older content and were left out (they are
 * archived by the next normal access, never by this read).
 */
export type ReaderReadOutcome =
  | { kind: "ok"; reading: ReaderReading }
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "pdf" }
  | { kind: "error"; detail: string };

/** The Reader's data seam: one read-only pass over the Doc's IR, assets and current annotations. */
export interface ReaderOpDeps {
  read: (docId: string) => Promise<ReaderReadOutcome>;
}

export interface ReaderToolContext {
  reader: ReaderOpDeps;
  /** Resolves only after the bound browser view reports the outcome. */
  viewAction: (action: ReaderViewAction) => Promise<ViewActionOutcome>;
  /** False once the host stopped admitting operations (Stop, shutdown). */
  admitting: () => boolean;
  /**
   * Bytes this conversation can still take in one tool result (the model's window less what is already in it).
   * A reading larger than that is refused whole, with its size, instead of being cut or poisoning the history.
   */
  budget?: () => number;
}

const lit = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>({ type: "string", enum: [...values] });

const parameters = Type.Object(
  {
    action: lit(READER_OPERATION_ACTIONS),
    docId: Type.String({
      description: "The Doc id (for example arxiv-2601.00001). Every action names its own Doc.",
    }),
    anchor: Type.Optional(
      Type.String({
        description:
          "navigate: a deep-link anchor of the Doc: a section, block or float id from the reading (sec-3, p-12, fig-2, tab-1, eq-4), a reference id, or ann-<annotation id>.",
      })
    ),
    panel: Type.Optional(lit(READER_PANELS)),
    collapsed: Type.Optional(Type.Boolean({ description: "set_panel: true folds the panel." })),
    tab: Type.Optional(lit(READER_RIGHT_TABS)),
  },
  { additionalProperties: false }
);

const description = [
  "Read and navigate the LaTeX Reader. read returns the WHOLE document of a Doc from disk, in the background, without opening or moving anything: every section, paragraph, list, equation, figure, full table body, code/algorithm body, the whole bibliography, cite/xref identities and the Doc's current annotations with their full bodies, plus the content fingerprint and annotation revision they belong together under. Text is the canonical annotation text: a selection's start/end are UTF-16 offsets into it, math/cite/xref are atomic marks. Saved annotations of older content are left out and the archive is never read. A document too large for the room left in this model's window is refused with its size, never cut.",
  "navigate/jump_back/set_panel/set_right_tab/retry_sync act on the user's visible Reader like the outline, reference cards, chips, the undo-navigation button, the panel folds, the tabs and Retry: call them only when asked to show something, never to read. navigate and jump_back stop at a Reader that is syncing or showing an error (nothing moves, not_displayed); set_panel, set_right_tab and retry_sync are folds, tabs and Retry and work in any state.",
].join(" ");

function record(id: string, action: string, partial: Partial<CopilotOperation>): CopilotOperation {
  return { id, tool: READER_TOOL_NAME, action, status: "error", ...partial };
}

export function createReaderTool(context: ReaderToolContext) {
  return defineTool({
    name: READER_TOOL_NAME,
    label: "Reader",
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
        const read = ReaderReadOperationSchema.safeParse(params);
        if (read.success) {
          const object = { kind: "doc" as const, id: read.data.docId };
          const outcome = await context.reader.read(read.data.docId);
          if (outcome.kind === "not_found")
            return done(record(toolCallId, "read", { status: "not_found", object }), {
              ok: false,
              status: "not_found",
              detail: "no such Doc",
            });
          if (outcome.kind === "busy")
            return done(record(toolCallId, "read", { status: "rejected", object }), {
              ok: false,
              status: "rejected",
              detail:
                "the Doc is being replaced or deleted right now; nothing was read. Try again when the job has finished",
            });
          if (outcome.kind === "pdf")
            return done(record(toolCallId, "read", { status: "unsupported", object }), {
              ok: false,
              status: "unsupported",
              detail:
                "this is a PDF Doc; the Reader tool reads LaTeX Docs only (workspace open_doc shows it to the user)",
            });
          if (outcome.kind === "error")
            return done(record(toolCallId, "read", { status: "error", object }), {
              ok: false,
              status: "error",
              detail: outcome.detail,
            });
          const payload = {
            ok: true,
            status: "ok",
            observed:
              "the Doc as stored right now (one coherent read); the user may change annotations afterwards, so read again before relying on them",
            reading: outcome.reading,
          };
          const text = JSON.stringify(payload);
          const room = context.budget?.();
          if (room !== undefined && Buffer.byteLength(text) > room)
            return done(record(toolCallId, "read", { status: "rejected", object }), {
              ok: false,
              status: "rejected",
              detail: `capacity: the complete reading is ${outcome.reading.coverage.characters} characters of text (${Buffer.byteLength(text)} bytes encoded) in ${outcome.reading.coverage.sections} sections, more than the ${Math.max(0, room)} bytes left in this model's window. It was not cut or partly returned; reading it in parts is not available yet`,
              coverage: outcome.reading.coverage,
            });
          return done(record(toolCallId, "read", { status: "ok", object }), payload);
        }
        const parsed = ReaderViewActionSchema.safeParse(params);
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
        return done(
          record(toolCallId, action, {
            status: outcome.status,
            object: { kind: "doc", id: parsed.data.docId },
          }),
          outcome.payload
        );
      } catch {
        return done(record(toolCallId, action, { status: "unknown" }), {
          ok: false,
          status: "unknown",
          detail: "unexpected failure; read the Doc again to see what is stored now",
        });
      }
    },
  });
}
