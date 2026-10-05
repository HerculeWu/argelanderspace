import { createHash } from "node:crypto";
import {
  type CopilotOperation,
  type PageContext,
  TEXT_OPERATION_ACTIONS,
  TEXT_PDF_IMAGE_LONG_EDGE,
  type TextAssetAdded,
  type TextGenerationResult,
  type TextOperation,
  TextOperationSchema,
  type TextReplacementImpact,
  type TextSourceDto,
  type TextValidationResult,
  type WorkspaceViewAction,
} from "@argelanderspace/contracts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { largestFit, RESULT_OVERHEAD_BYTES } from "./copilot-batching.js";
import { type ConfirmationPort, digest } from "./copilot-plan-tool.js";
import { type ViewActionOutcome, viewOutcomeResult } from "./copilot-workspace-tool.js";
import type { TextDocService } from "./text-docs.js";

export const TEXT_TOOL_NAME = "text";

/** The service seam: the very handlers of the text source panel's HTTP routes (same locks, checks and notifications). */
export type TextOpDeps = Pick<
  TextDocService,
  | "create"
  | "read"
  | "save"
  | "addAsset"
  | "addPdfImage"
  | "validate"
  | "generate"
  | "probeReplacement"
>;

export interface TextToolContext {
  text: TextOpDeps;
  /** A file the USER attached to this conversation (never a path). */
  attachment?: (id: string) => { meta: { filename: string; sha256: string }; bytes: Buffer } | null;
  /** The bound view's latest page (whether the user has unsaved text in the source panel). */
  page?: () => PageContext | undefined;
  /** Opening the source PDF is the workspace's open_doc. */
  viewAction: (action: WorkspaceViewAction) => Promise<ViewActionOutcome>;
  /** A replacement of annotated reading text waits here for the real user. Without it such a generate is refused. */
  confirm?: ConfirmationPort;
  admitting: () => boolean;
  /** Bytes this conversation can still take in one tool result. */
  budget?: () => number;
  reclaim?: () => number;
  runId?: string;
  track?: <T>(work: Promise<T>) => Promise<T>;
}

const lit = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>({ type: "string", enum: [...values] });

const parameters = Type.Object(
  {
    action: lit(TEXT_OPERATION_ACTIONS),
    docId: Type.Optional(Type.String({ description: "The text Doc id (text-<uuid>)." })),
    workId: Type.Optional(Type.String({ description: "create: the existing Work to attach to." })),
    sourcePdfDocId: Type.Optional(
      Type.String({ description: "create: a PDF Doc of that Work this text is made from." })
    ),
    operationId: Type.Optional(
      Type.String({
        minLength: 8,
        description:
          "create/generate: your own stable id; the same id finds the same result instead of a second Doc.",
      })
    ),
    expectedRev: Type.Optional(
      Type.Integer({ minimum: 0, description: "save_source/add_asset/add_pdf_image: read rev." })
    ),
    sourceRev: Type.Optional(
      Type.Integer({ minimum: 0, description: "validate/generate: the rev of the source." })
    ),
    markdown: Type.Optional(Type.String({ description: "save_source: the text." })),
    append: Type.Optional(
      Type.Boolean({ description: "save_source: add markdown after the saved text." })
    ),
    from: Type.Optional(
      Type.Integer({ minimum: 0, description: "read_source: continue at this character." })
    ),
    version: Type.Optional(
      Type.String({ description: "read_source with from: the version of the parts read." })
    ),
    attachmentId: Type.Optional(
      Type.String({ description: "add_asset: an image the user attached." })
    ),
    filename: Type.Optional(Type.String({ description: "add_asset: stem for the stored name." })),
    sha256: Type.Optional(
      Type.String({ description: "add_pdf_image: reading.sha256 of the PDF (required)." })
    ),
    pdfDocId: Type.Optional(
      Type.String({ description: "add_pdf_image: another PDF of the Work (default: source PDF)." })
    ),
    pageIndex: Type.Optional(
      Type.Integer({ minimum: 0, description: "add_pdf_image: zero-based." })
    ),
    region: Type.Optional(
      Type.Object(
        {
          x: Type.Number({ minimum: 0, maximum: 1 }),
          y: Type.Number({ minimum: 0, maximum: 1 }),
          width: Type.Number({ minimum: 0.006, maximum: 1 }),
          height: Type.Number({ minimum: 0.006, maximum: 1 }),
        },
        {
          additionalProperties: false,
          description:
            "add_pdf_image: area in fractions of the visible page from its top-left corner (the PDF area tool's); omit for the whole page.",
        }
      )
    ),
    longEdge: Type.Optional(
      Type.Integer({
        minimum: TEXT_PDF_IMAGE_LONG_EDGE.min,
        maximum: TEXT_PDF_IMAGE_LONG_EDGE.max,
        description: `add_pdf_image: picture size, longer edge in pixels (default ${TEXT_PDF_IMAGE_LONG_EDGE.default}).`,
      })
    ),
  },
  { additionalProperties: false }
);

const description =
  "The text Doc source panel (a Markdown source turned into the shared Reader only by generate): create a text Doc under a Work (create; sourcePdfDocId = the PDF it is transcribed from; same operationId never makes a second Doc), read_source (the whole saved source with rev and assets; in parts when large: from + version), save_source (PUT with expectedRev; the text may be invalid; append adds to the saved text; a conflict wrote nothing: read_source again, never just resend with the new rev), add_asset (an image the user attached) and add_pdf_image (a page or area of a PDF of the same Work as an independent image asset, rendered from the verified original: sha256 from the PDF reading, zero-based pageIndex, optional region; nothing is written to the PDF; then write ![caption](assets/<name>) in the source), validate and generate (sourceRev; generate replaces the reading text; when that would archive the user's annotations it waits for the user's confirmation card, which you cannot give or fake: declined/expired mean nothing was published), open_source_pdf (the file, like its button). The source panel's tabs are reader set_text_view; read and annotate the generated reading with reader read/create_annotation. Unsaved typing in the panel is the user's (page.textSource.unsaved): your save does not delete it, their next autosave then shows its conflict choice.";

type ToolResult = {
  content: { type: "text"; text: string }[];
  details: CopilotOperation;
};
const record = (
  id: string,
  action: string,
  partial: Partial<CopilotOperation>
): CopilotOperation => ({
  id,
  tool: TEXT_TOOL_NAME,
  action,
  status: "error",
  ...partial,
});
const sha8 = (text: string) => createHash("sha256").update(text).digest("hex");
/** A stable identity for one tool call of one run: the same call always names the same Doc / generation. */
const callId = (prefix: string, runId: string | undefined, toolCallId: string) =>
  `${prefix}-${createHash("sha256")
    .update(`${runId ?? "run"}:${toolCallId}`)
    .digest("hex")
    .slice(0, 32)}`;

type Failure = { ok: false; status: number; body: Record<string, unknown> };

/** How a refusal of the shared handlers reads as an operation status and as the model's result. */
function failure(
  fail: Failure,
  action: string
): { status: CopilotOperation["status"]; payload: Record<string, unknown> } {
  const body = fail.body as {
    detail?: string;
    code?: string;
    rev?: number;
    diagnostics?: unknown[];
  };
  const detail = body.detail ?? "the request failed";
  const code = body.code;
  switch (fail.status) {
    case 404:
      return {
        status: "not_found",
        payload: { ok: false, status: "not_found", detail: `${detail}; nothing was changed` },
      };
    case 409: {
      const busy = detail === "document busy";
      if (busy)
        return {
          status: "rejected",
          payload: {
            ok: false,
            status: "rejected",
            detail:
              "the Doc is busy (being generated, replaced or deleted); nothing was changed. Try again when it has finished",
          },
        };
      return {
        status: "conflict",
        payload: {
          ok: false,
          status: "conflict",
          ...(code ? { reason: code } : { reason: "rev_mismatch" }),
          ...(body.rev !== undefined ? { current: { rev: body.rev } } : {}),
          detail:
            code === "document_changed"
              ? "the PDF is not the original your reading was of; nothing was changed. Read the PDF again (reader read) and use its sha256"
              : `${detail}; nothing was changed. Read the source again (text read_source) to see what is stored now, then form a new request; never just replace the revision and resend (${action})`,
        },
      };
    }
    case 422:
    case 413:
    case 415:
    case 400:
      return {
        status: "invalid",
        payload: {
          ok: false,
          status: "invalid",
          ...(code ? { code } : {}),
          detail: `${detail}; nothing was changed`,
        },
      };
    case 503:
      return {
        status: "error",
        payload: {
          ok: false,
          status: "error",
          ...(code ? { code } : {}),
          detail: `${detail}; nothing was changed. Try again later`,
        },
      };
    default:
      return {
        status: "error",
        payload: {
          ok: false,
          status: "error",
          ...(code ? { code } : {}),
          detail: `${detail}`,
        },
      };
  }
}

export function createTextTool(context: TextToolContext) {
  const unsavedDraft = (docId: string) => {
    const page = context.page?.()?.textSource;
    return page?.docId === docId && page.unsaved ? true : undefined;
  };
  return defineTool({
    name: TEXT_TOOL_NAME,
    label: "Text",
    description,
    executionMode: "sequential",
    parameters,
    async execute(toolCallId, params) {
      const action = typeof params.action === "string" ? params.action : "unknown";
      const done = (operation: CopilotOperation, payload: object): ToolResult => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        details: operation,
      });
      if (!context.admitting())
        return done(record(toolCallId, action, { status: "error" }), {
          ok: false,
          status: "closed",
        });
      const track = <T>(work: Promise<T>) => (context.track ? context.track(work) : work);
      try {
        // The model's parameters are checked strictly: there is no `confirm` (or any approval) to send, so a request
        // that carries one is invalid and nothing runs.
        const parsed = TextOperationSchema.safeParse(params);
        if (!parsed.success)
          return done(record(toolCallId, action, { status: "invalid" }), {
            ok: false,
            status: "invalid",
            detail: "unknown action or invalid parameters; nothing was done",
            issues: parsed.error.issues
              .slice(0, 5)
              .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
        const op: TextOperation = parsed.data;
        const objectOf = (docId: string) => ({ kind: "doc" as const, id: docId });
        const refuse = (fail: Failure, docId?: string) => {
          const mapped = failure(fail, op.action);
          return done(
            record(toolCallId, op.action, {
              status: mapped.status,
              ...(docId ? { object: objectOf(docId) } : {}),
            }),
            mapped.payload
          );
        };
        const assetDone = (
          result: Awaited<ReturnType<TextOpDeps["addAsset"]>>,
          name: "add_asset" | "add_pdf_image",
          docId: string
        ) => {
          if (!result.ok) return refuse(result, docId);
          const added: TextAssetAdded = result.value;
          return done(
            record(toolCallId, name, {
              status: added.reused ? "noop" : "ok",
              object: objectOf(docId),
              rev: added.source.rev,
              label: added.asset.name,
            }),
            {
              ok: true,
              status: added.reused ? "noop" : "ok",
              asset: added.asset,
              rev: added.source.rev,
              reused: added.reused,
              ...(added.restored ? { restored: true } : {}),
              observed: `an independent image asset of the text (the PDF was not changed and nothing about its page or area is stored); use it as ![caption](assets/${added.asset.name}) alone in a paragraph. rev is the new source revision`,
            }
          );
        };

        const generate = async (
          docId: string,
          sourceRev: number,
          requestedId: string | undefined
        ) => {
          const object = objectOf(docId);
          const operationId = requestedId ?? callId("agent-generate", context.runId, toolCallId);
          const request = { sourceRev, operationId };
          const finish = (result: { ok: true; value: TextGenerationResult }, confirmed: boolean) =>
            done(
              record(toolCallId, "generate", {
                status: "ok",
                object,
                rev: result.value.publishedSourceRev,
                label: docId,
              }),
              {
                ok: true,
                status: "ok",
                publishedSourceRev: result.value.publishedSourceRev,
                replacedAnnotations: result.value.replacedAnnotations,
                stats: result.value.stats,
                diagnostics: result.value.diagnostics.slice(0, 30),
                observed: confirmed
                  ? `the reading text was replaced after the user confirmed; ${result.value.replacedAnnotations} annotation(s) of the older text are archived by the next annotations access (tell the user)`
                  : "the reading text was published; the user's Reader reads it again at once",
              }
            );
          const first = await track(context.text.generate(docId, request));
          if (first.ok) return finish(first, false);
          const body = first.body as { code?: string; impact?: TextReplacementImpact };
          if (first.status !== 409 || body.code !== "confirmation_required" || !body.impact)
            return refuse(first, docId);
          // The replacement would archive the user's annotations: only the real user can allow it, on a card bound to
          // exactly these values. The tool never sends a confirmation of its own.
          const impact = body.impact;
          if (!context.confirm)
            return done(record(toolCallId, "generate", { status: "unsupported", object }), {
              ok: false,
              status: "unsupported",
              detail:
                "this step needs the user's confirmation and none is available here; nothing was published",
            });
          let decision: Awaited<ReturnType<ConfirmationPort["request"]>>;
          try {
            decision = await context.confirm.request({
              toolCallId,
              action: "replace_text_reading",
              docId,
              label: docId,
              impact,
              baseRev: impact.annotationsRev,
              objectDigest: digest({ ...impact }),
            });
          } catch {
            return done(record(toolCallId, "generate", { status: "error", object }), {
              ok: false,
              status: "error",
              detail: "the confirmation could not be saved; nothing was published",
            });
          }
          if (decision.outcome === "declined")
            return done(record(toolCallId, "generate", { status: "declined", object }), {
              ok: false,
              status: "declined",
              detail:
                "the user declined; nothing was published. Do not ask again unless the user wants it",
            });
          if (decision.outcome === "expired")
            return done(record(toolCallId, "generate", { status: "expired", object }), {
              ok: false,
              status: "expired",
              detail:
                decision.reason === "stale"
                  ? "the source, the reading text or the annotations changed before the user confirmed; nothing was published. Read again and generate again only if it is still wanted"
                  : "the request ended before the user confirmed; nothing was published",
            });
          // Approved by the user's click on the card for exactly these values: the server compares them once more
          // inside its publish critical section (a change since then is refused there).
          const second = await track(
            context.text.generate(docId, {
              ...request,
              sourceRev: impact.sourceRev,
              confirm: impact,
            })
          );
          if (second.ok) return finish(second, true);
          const again = second.body as { code?: string };
          if (
            second.status === 409 &&
            (again.code === "confirmation_changed" || again.code === "stale")
          )
            return done(record(toolCallId, "generate", { status: "expired", object }), {
              ok: false,
              status: "expired",
              detail:
                "the source, the reading text or the annotations changed after the user confirmed; nothing was published. Read again and generate again only if it is still wanted",
            });
          return refuse(second, docId);
        };

        switch (op.action) {
          case "create": {
            const result = await track(
              context.text.create({
                workId: op.workId,
                ...(op.sourcePdfDocId ? { sourcePdfDocId: op.sourcePdfDocId } : {}),
                operationId: op.operationId ?? callId("agent-create", context.runId, toolCallId),
              })
            );
            if (!result.ok) return refuse(result);
            const { source } = result.value;
            return done(
              record(toolCallId, "create", {
                status: "ok",
                object: objectOf(source.doc_id),
                label: source.doc_id,
                docId: source.doc_id,
                rev: source.rev,
              }),
              {
                ok: true,
                status: "ok",
                created: result.status === 201,
                docId: source.doc_id,
                rev: source.rev,
                ...(source.source_pdf ? { sourcePdf: source.source_pdf } : {}),
                observed:
                  result.status === 201
                    ? "a new empty text Doc was added to the Work (nothing is generated yet)"
                    : "this operationId already made this Doc: it is returned, no second Doc was created",
              }
            );
          }
          case "read_source": {
            const result = context.text.read(op.docId);
            if (!result.ok) return refuse(result, op.docId);
            const source: TextSourceDto = result.value;
            const version = `${source.rev}:${sha8(source.markdown).slice(0, 12)}`;
            const from = op.from ?? 0;
            const total = source.markdown.length;
            if (from > total || (from === total && from > 0))
              return done(
                record(toolCallId, "read_source", {
                  status: "invalid",
                  object: objectOf(op.docId),
                }),
                {
                  ok: false,
                  status: "invalid",
                  detail: `from ${from} is beyond the source: it has ${total} characters; nothing was returned`,
                }
              );
            if (from > 0 && op.version !== version)
              return done(
                record(toolCallId, "read_source", {
                  status: "conflict",
                  object: objectOf(op.docId),
                }),
                {
                  ok: false,
                  status: "conflict",
                  reason: "version_changed",
                  version,
                  detail: op.version
                    ? "the source changed since the parts you read (parts of two versions are never joined); read it again from 0"
                    : "a continuation (from > 0) needs version: the version of the part you are continuing",
                }
              );
            const payloadAt = (to: number) => {
              const end = to >= total;
              return {
                ok: true,
                status: "ok",
                observed: "the saved source as stored right now",
                docId: source.doc_id,
                rev: source.rev,
                version,
                generated: source.generated,
                publishedSourceRev: source.published_source_rev,
                ...(source.source_pdf ? { sourcePdf: source.source_pdf } : {}),
                assets: source.assets,
                ...(unsavedDraft(op.docId)
                  ? {
                      userDraft:
                        "the user has typed text in the source panel that is not saved: it is theirs and is not in this result",
                    }
                  : {}),
                markdown: source.markdown.slice(from, to),
                batch: {
                  unit: "characters",
                  from,
                  to,
                  total,
                  status: end ? "complete" : "partial",
                  note: end
                    ? from === 0
                      ? "the whole source is in this result"
                      : "the rest of the source: nothing remains"
                    : `PART OF THE SOURCE ONLY: characters [${from}, ${to}) of ${total} are in this result and [${to}, ${total}) are NOT read; call read_source with from: ${to} and version: "${version}" for the next part; until the result says complete you have not read it all and must not say so`,
                },
              };
            };
            const fitTo = (room: number) => {
              const k = largestFit(
                total === from ? 0 : 1,
                total - from,
                (n) =>
                  Buffer.byteLength(JSON.stringify(JSON.stringify(payloadAt(from + n)))) +
                  RESULT_OVERHEAD_BYTES,
                room
              );
              if (k < 0) return -1;
              let to = from + k;
              if (to < total) {
                // a part ends at a line end when it can, and never inside a surrogate pair
                const line = source.markdown.lastIndexOf("\n", to - 1);
                if (line > from) to = line + 1;
                else if (to > from + 1) {
                  const high = source.markdown.charCodeAt(to - 1);
                  if (high >= 0xd800 && high <= 0xdbff) to -= 1;
                }
              }
              return to;
            };
            let to = total;
            const room = context.budget?.();
            if (room !== undefined) {
              let found = fitTo(room);
              if (context.reclaim && (found < 0 || found < total)) {
                const more = context.reclaim();
                if (more > room) {
                  const again = fitTo(more);
                  if (again >= 0) found = again;
                }
              }
              if (found < 0)
                return done(
                  record(toolCallId, "read_source", {
                    status: "rejected",
                    object: objectOf(op.docId),
                  }),
                  {
                    ok: false,
                    status: "rejected",
                    detail: `capacity: even the smallest part of the source (from ${from}) does not fit the ${Math.max(0, room)} bytes left in this model's window; nothing was returned and characters [${from}, ${total}) are NOT read`,
                  }
                );
              to = found;
            }
            return done(
              record(toolCallId, "read_source", {
                status: "ok",
                object: objectOf(op.docId),
                rev: source.rev,
              }),
              payloadAt(to)
            );
          }
          case "save_source": {
            let markdown = op.markdown;
            if (op.append) {
              // Read at the revision the caller planned from: the PUT's own expectedRev check then refuses anything newer.
              const current = context.text.read(op.docId);
              if (!current.ok) return refuse(current, op.docId);
              if (current.value.rev !== op.expectedRev)
                return refuse(
                  {
                    ok: false,
                    status: 409,
                    body: { detail: "rev mismatch", rev: current.value.rev },
                  },
                  op.docId
                );
              markdown = current.value.markdown + op.markdown;
            }
            const result = await track(
              context.text.save(op.docId, { expectedRev: op.expectedRev, markdown })
            );
            if (!result.ok) return refuse(result, op.docId);
            return done(
              record(toolCallId, "save_source", {
                status: "ok",
                object: objectOf(op.docId),
                rev: result.value.rev,
                label: op.docId,
              }),
              {
                ok: true,
                status: "ok",
                rev: result.value.rev,
                characters: result.value.markdown.length,
                observed:
                  "saved through the source panel's own save (expectedRev checked inside its critical section); the reading text is NOT changed until generate. The new rev replaces the one you sent",
                ...(unsavedDraft(op.docId)
                  ? {
                      userDraft:
                        "the user has unsaved typing in the panel: it was not touched; when their autosave runs it conflicts with this save and they choose between theirs and yours",
                    }
                  : {}),
              }
            );
          }
          case "add_asset": {
            const held = context.attachment?.(op.attachmentId);
            if (!held)
              return done(
                record(toolCallId, "add_asset", {
                  status: "not_found",
                  object: objectOf(op.docId),
                }),
                {
                  ok: false,
                  status: "not_found",
                  detail:
                    "no such attachment in this conversation: only an image the user attached to a message can be added; nothing was changed",
                }
              );
            const result = await track(
              context.text.addAsset(op.docId, {
                expectedRev: op.expectedRev,
                filename: op.filename ?? held.meta.filename,
                bytes: held.bytes,
              })
            );
            return assetDone(result, "add_asset", op.docId);
          }
          case "add_pdf_image": {
            const result = await track(
              context.text.addPdfImage(op.docId, {
                expectedRev: op.expectedRev,
                sha256: op.sha256,
                pageIndex: op.pageIndex,
                ...(op.pdfDocId ? { pdfDocId: op.pdfDocId } : {}),
                ...(op.region ? { region: op.region } : {}),
                ...(op.longEdge ? { longEdge: op.longEdge } : {}),
              })
            );
            return assetDone(result, "add_pdf_image", op.docId);
          }
          case "validate": {
            const result = context.text.validate(op.docId, { sourceRev: op.sourceRev });
            if (!result.ok) return refuse(result, op.docId);
            const v: TextValidationResult = result.value;
            return done(
              record(toolCallId, "validate", {
                status: "ok",
                object: objectOf(op.docId),
                rev: v.sourceRev,
              }),
              {
                ok: true,
                status: "ok",
                valid: v.valid,
                sourceRev: v.sourceRev,
                stats: v.stats,
                diagnostics: v.diagnostics.slice(0, 60),
                ...(v.diagnostics.length > 60
                  ? { diagnosticsOmitted: v.diagnostics.length - 60 }
                  : {}),
                observed:
                  "validation writes nothing; diagnostics carry the 1-based line and column in the source",
              }
            );
          }
          case "generate":
            return await generate(op.docId, op.sourceRev, op.operationId);
          case "open_source_pdf": {
            const result = context.text.read(op.docId);
            if (!result.ok) return refuse(result, op.docId);
            const pdf = result.value.source_pdf?.doc_id;
            if (!pdf)
              return done(
                record(toolCallId, "open_source_pdf", {
                  status: "rejected",
                  object: objectOf(op.docId),
                }),
                {
                  ok: false,
                  status: "rejected",
                  detail: "this text has no source PDF; nothing was opened",
                }
              );
            const shown = viewOutcomeResult(
              await context.viewAction({ action: "open_doc", docId: pdf })
            );
            return done(
              record(toolCallId, "open_source_pdf", {
                status: shown.status,
                object: objectOf(pdf),
              }),
              shown.payload
            );
          }
        }
        return done(record(toolCallId, action, { status: "unsupported" }), {
          ok: false,
          status: "unsupported",
        });
      } catch {
        return done(record(toolCallId, action, { status: "unknown" }), {
          ok: false,
          status: "unknown",
          detail:
            "unexpected failure; read the source (text read_source) to see what is stored now before repeating a write",
        });
      }
    },
  });
}
