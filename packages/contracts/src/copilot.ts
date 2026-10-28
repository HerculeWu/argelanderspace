import { z } from "zod";
import { ArgumentGraphSizeSchema, ArgumentViewActionSchema } from "./argument-copilot.js";
import {
  type ArgumentContextSummary,
  ArgumentContextSummarySchema,
  ArgumentPageSchema,
} from "./argument-ops.js";
import { type ContextCoverage, ContextCoverageSchema } from "./context-batch.js";
import { ConfirmationBase } from "./copilot-confirmation-base.js";
import {
  CopilotCommandConfirmationSchema,
  CopilotEditFileConfirmationSchema,
  CopilotWriteFileConfirmationSchema,
  FILE_TOOL_CONFIRMATION_ACTIONS,
} from "./copilot-file-tools.js";
import {
  type DiscoveryContextSummary,
  DiscoveryContextSummarySchema,
  DiscoveryPageSchema,
  DiscoverySavedViewActionSchema,
} from "./discovery-ops.js";
import {
  DocDeletedViewActionSchema,
  type LibraryContextSummary,
  LibraryContextSummarySchema,
  LibraryPageSchema,
  LibraryViewActionSchema,
} from "./library-ops.js";
import { MailAccountIdSchema } from "./mail.js";
import { MailMessageIdSchema } from "./mail-compose.js";
import { type MailContextSummary, MailContextSummarySchema, MailPageSchema } from "./mail-ops.js";
import { MailAddressSchema } from "./mail-read.js";
import {
  type PdfContextSummary,
  PdfContextSummarySchema,
  PdfMaterialEnvelopeSchema,
  PdfPageSchema,
} from "./pdf-ops.js";
import { type CopilotOperation, CopilotOperationSchema, PlanViewActionSchema } from "./plan-ops.js";
import { PlanSchema, TaskSchema } from "./plans.js";
import { ThinkingLevelSchema } from "./providers.js";
import {
  type ReaderContextSummary,
  ReaderContextSummarySchema,
  ReaderObservationPageSchema,
  ReaderPageSchema,
  ReaderViewActionSchema,
} from "./reader-ops.js";
import { SHELF_ENTRY_ID_RE } from "./shelf.js";
import { ShelfTakeRequestSchema, ShelfTakeResultSchema } from "./shelf-take.js";
import {
  ShelfAddPreviewRequestSchema,
  ShelfAddPreviewResponseSchema,
  ShelfAddResponseSchema,
  ShelfReplacedEntrySchema,
  ShelfReplaceImpactSchema,
} from "./shelf-write.js";
import { TextReplacementImpactSchema } from "./text-doc.js";
import {
  type TextContextSummary,
  TextContextSummarySchema,
  TextSourcePageSchema,
} from "./text-ops.js";
import { WorkspaceSnapshotSchema, WorkspaceViewActionSchema } from "./workspace-ops.js";
import {
  type WriterContextSummary,
  WriterContextSummarySchema,
  WriterDeleteImpactSchema,
  WriterPageSchema,
  WriterViewActionSchema,
} from "./writer-ops.js";

export const CopilotIdSchema = z.string().uuid();
export const ConversationModelSchema = z
  .object({
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    thinking: ThinkingLevelSchema.nullable(),
  })
  .strict();
export type ConversationModel = z.infer<typeof ConversationModelSchema>;

export const PlanPageSchema = z
  .object({
    rev: z.number().int().nonnegative(),
    mode: z.enum(["list", "board", "focus", "timeline"]),
    selectedPlanId: z.string().nullable(),
    plans: z.array(PlanSchema),
    groups: z.array(z.object({ key: z.string(), taskIds: z.array(z.string()) }).strict()),
    detail: z.object({ planId: z.string(), task: TaskSchema }).strict().nullable(),
    saveState: z.enum(["saved", "pending", "error"]),
    ui: z
      .object({
        completedExpanded: z.boolean(),
        readingPosition: z
          .object({
            region: z.string(),
            top: z.number().nonnegative(),
            left: z.number().nonnegative(),
          })
          .nullable(),
        selectedText: z.string().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PlanPage = z.infer<typeof PlanPageSchema>;

const pageContext = (reader: typeof ReaderPageSchema | typeof ReaderObservationPageSchema) =>
  z
    .object({
      version: z.literal(1),
      viewId: CopilotIdSchema,
      revision: z.number().int().nonnegative(),
      paneId: z.number().int().positive(),
      view: z.string().min(1).max(100),
      otherPanes: z
        .array(z.object({ paneId: z.number().int().positive(), view: z.string() }).strict())
        .max(2),
      status: z.enum(["complete", "unavailable", "error"]),
      plan: PlanPageSchema.nullable(),
      /** The Library page (copilot ticket 13); optional so older views and headless callers stay valid. */
      library: LibraryPageSchema.nullable().optional(),
      /** The Library tab's exploration (Discovery) while it is open (copilot ticket 17); replaces `library` then. */
      discovery: DiscoveryPageSchema.nullable().optional(),
      /** The Library tab's argument graph view while it is open (argument graph ticket 04); replaces `library` then. */
      argument: ArgumentPageSchema.nullable().optional(),
      /** The LaTeX Reader of the active pane (copilot ticket 18); optional so older views and headless callers stay valid. */
      reader: reader.nullable().optional(),
      /** The PDF Reader of the active pane (copilot ticket 20); identity, position and control state, not the pages. */
      pdf: PdfPageSchema.nullable().optional(),
      /** A text Doc's source panel (copilot ticket 29): the editor's current text, assets, diagnostics, revisions. */
      textSource: TextSourcePageSchema.nullable().optional(),
      /** The Writer of the active pane (copilot ticket 22): the manuscript list or one open manuscript. */
      writer: WriterPageSchema.nullable().optional(),
      /** The Mail page (Mail ticket 09): the open message in full and the list headers, all untrusted external data. */
      mail: MailPageSchema.nullable().optional(),
      /** Layout and appearance of the Shell; optional so older views and headless callers stay valid. */
      workspace: WorkspaceSnapshotSchema.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      // Only data the page really loaded counts as complete: the Library's built-in example data does not.
      const covered =
        (value.view === "plan" && value.plan !== null) ||
        (value.view === "library" && value.library?.source === "live") ||
        (value.view === "library" && !!value.discovery?.graph) ||
        // An argument graph page is complete once its graph really loaded (ready, or empty: no graph yet is an answer).
        (value.view === "library" &&
          (value.argument?.phase === "ready" || value.argument?.phase === "empty")) ||
        (value.view === "doc" &&
          (!!(value.reader?.reading || value.reader?.readingRef || value.reader?.readingOmitted) ||
            value.pdf?.phase === "ready" ||
            value.textSource?.phase === "ready")) ||
        // A Writer page is complete once its list or its open manuscript really loaded.
        (value.view === "write" &&
          !!value.writer &&
          (value.writer.list?.phase === "ready" ||
            (value.writer.editor?.phase === "ready" &&
              !!(value.writer.editor.saved || value.writer.editor.savedOmitted)))) ||
        // A Mail page is complete once its accounts and lists really loaded.
        (value.view === "mail" && value.mail?.phase === "ready");
      if ((value.status === "complete") !== covered)
        ctx.addIssue({ code: "custom", message: "invalid page coverage" });
    });
/** What a view publishes (a Reader page may not carry `readingOmitted`). */
export const PageContextSchema = pageContext(ReaderPageSchema);
/** A page as the service records it in a later observation. */
export const ObservationPageContextSchema = pageContext(ReaderObservationPageSchema);
export type PageContext = z.infer<typeof PageContextSchema>;
export const CopilotMessageRequestSchema = z
  .object({
    clientMessageId: CopilotIdSchema,
    text: z
      .string()
      .min(1)
      .max(100_000)
      .refine((text) => !!text.trim()),
    viewId: CopilotIdSchema,
    contextRevision: z.number().int().nonnegative(),
  })
  .strict();
export type CopilotMessageRequest = z.infer<typeof CopilotMessageRequestSchema>;
/** Resume carries no text: the host writes the request from what the record proves. */
export const CopilotResumeRequestSchema = CopilotMessageRequestSchema.omit({
  text: true,
});
export type CopilotResumeRequest = z.infer<typeof CopilotResumeRequestSchema>;

export const EventCursorSchema = z
  .object({ instanceId: CopilotIdSchema, seq: z.number().int().nonnegative() })
  .strict();
export type EventCursor = z.infer<typeof EventCursorSchema>;
export const CopilotRunSchema = z
  .object({
    id: CopilotIdSchema,
    // `stopping` is Stop accepted but the SDK not settled; `stopped` is the user's own Stop;
    // `interrupted` is a service exit/restart. Neither is an error.
    // `waiting-for-user` is a run held at a human confirmation; Stop and steering still work there.
    status: z.enum([
      "running",
      "waiting-for-user",
      "stopping",
      "completed",
      "failed",
      "stopped",
      "interrupted",
    ]),
    error: z.string().nullable(),
    /** With `error: "capacity"`: the run ended because the automatic compaction of its context did not finish. */
    compactionFailed: z.boolean().optional(),
  })
  .strict();
export type CopilotRun = z.infer<typeof CopilotRunSchema>;
export const ConversationSchema = z
  .object({
    version: z.literal(1),
    id: CopilotIdSchema,
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    model: ConversationModelSchema.nullable(),
    sessionId: CopilotIdSchema,
    run: CopilotRunSchema.nullable(),
  })
  .strict();
export type Conversation = z.infer<typeof ConversationSchema>;
export interface CopilotMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /**
   * The reasoning text the provider exposed for this reply (a summary for OpenAI/Codex; the SDK keeps it in the assistant entry already, and a snapshot carries at most its last 20,000 characters).
   * Display only: never sent back as user content; absent when the provider gave none.
   */
  thinking?: string;
  /** A host-written resume request after Stop/failure/restart; shown as a marker, not as user text. */
  kind?: "resume";
  /** Steering accepted while the run is working, not yet read by the model. */
  pending?: boolean;
  /** Legacy: names of files an old message carried (the removed attachment feature); shown read-only. */
  attachments?: { filename: string }[];
  /** Operations this assistant message requested, with their committed outcomes. */
  operations?: CopilotOperation[];
  context?: {
    contextId: string;
    view: string;
    status: PageContext["status"];
    revision: number;
    objects: { id: string; rev: number; name?: string }[];
    library?: LibraryContextSummary;
    discovery?: DiscoveryContextSummary;
    argument?: ArgumentContextSummary;
    reader?: ReaderContextSummary;
    pdf?: PdfContextSummary;
    text?: TextContextSummary;
    writer?: WriterContextSummary;
    mail?: MailContextSummary;
    coverage?: ContextCoverage;
  };
}
/** A record that cannot be read is reported by itself; it never hides the readable conversations. */
export interface CopilotConversationList {
  version: 1;
  conversations: Conversation[];
  unreadable: { id: string; code: string }[];
}
/**
 * A delete the model asked for and the user has not yet confirmed. Bound to this object and this
 * PlansFile.rev: any change to either makes it expire. The id is never shown to the model.
 */
export const CopilotPlanConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    // Only a whole Plan waits for the user; a Task delete is immediate with the six-second undo.
    action: z.literal("delete_plan"),
    object: z
      .object({ kind: z.literal("plan"), id: z.string().min(1), planId: z.string().min(1) })
      .strict(),
    /** Verbatim plan name or task title. */
    label: z.string(),
    /** The plan's name (the task's parent for a task delete). */
    planName: z.string(),
    /** What the delete takes with it. For a task: 1 task, 1 unfinished unless done. */
    impact: z
      .object({ tasks: z.number().int().nonnegative(), openTasks: z.number().int().nonnegative() })
      .strict(),
    /** Hash of the plan's stored content when it was shown; any later change expires the card. */
    objectDigest: z.string().min(1),
  })
  .strict();
/** What replacing a Doc's text puts at risk, as the acquisition dialog shows it (`known` count or `unknown`). */
export const DocReplaceImpactSchema = z.discriminatedUnion("annotations", [
  z.object({ annotations: z.literal("known"), count: z.number().int().nonnegative() }).strict(),
  z.object({ annotations: z.literal("unknown") }).strict(),
]);
export type DocReplaceImpact = z.infer<typeof DocReplaceImpactSchema>;
/**
 * A replacement of an existing arXiv LaTeX Doc (the Files tab's "refresh arXiv source") the model asked for.
 * Bound to the Work, the target Doc, the annotation count the dialog would show and the annotations rev:
 * a change to any of them expires it.
 */
export const CopilotDocConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("refresh_arxiv_source"),
    object: z
      .object({ kind: z.literal("doc"), id: z.string().min(1), workId: z.string().min(1) })
      .strict(),
    /** The Work's title. */
    label: z.string(),
    impact: DocReplaceImpactSchema,
    objectDigest: z.string().min(1),
  })
  .strict();
/**
 * The Files tab's "delete document" dialog the model asked for: the global physical delete of one Doc. Bound to the
 * Doc, every Work that lists it (and their Doc lists), the annotation count and revision it shows, and the Doc's
 * content binding; any change to them expires it. The count is read before the card exists, so there is no
 * loading state: `unknown` is shown as unknown, never as zero.
 */
export const CopilotDocDeleteConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("delete_doc"),
    object: z.object({ kind: z.literal("doc"), id: z.string().min(1) }).strict(),
    /** pdf: the original PDF, metadata and sidecars are deleted; latex: the stored text, assets and annotations. */
    format: z.enum(["pdf", "latex", "text"]),
    /** Every Work that lists the Doc: it is removed from all of them, not only the one the user is looking at. */
    works: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string(),
            main: z.boolean(),
            remaining: z.number().int().nonnegative(),
          })
          .strict()
      )
      .max(500),
    impact: DocReplaceImpactSchema,
    objectDigest: z.string().min(1),
  })
  .strict();
/**
 * The manuscript list's delete dialog the model asked for: the physical delete of the whole manuscript directory.
 * Bound to the manuscript's revision and content digest; any change to either expires it.
 */
export const CopilotManuscriptDeleteConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("delete_manuscript"),
    object: z.object({ kind: z.literal("manuscript"), id: z.string().min(1) }).strict(),
    /** Verbatim manuscript title. */
    label: z.string(),
    /** What is deleted with it: cells, comments and the uploaded figure files. */
    impact: WriterDeleteImpactSchema,
    objectDigest: z.string().min(1),
  })
  .strict();
export type CopilotManuscriptDeleteConfirmation = z.infer<
  typeof CopilotManuscriptDeleteConfirmationSchema
>;
/**
 * Replacing the reading text of a text Doc that has annotations (copilot ticket 29; the page's replacement dialog the
 * model asked for). Bound to the Doc and to EVERY value of the server's impact (source and published revisions,
 * annotation count and revision, old and new content fingerprints); on approval those very values are what the
 * generation is asked to confirm, and the server compares them again inside its publish critical section. The model
 * can neither supply nor see them as an approval.
 */
export const CopilotTextReplaceConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("replace_text_reading"),
    object: z.object({ kind: z.literal("doc"), id: z.string().min(1) }).strict(),
    /** The Doc's title (its id when it has none). */
    label: z.string(),
    impact: TextReplacementImpactSchema,
    objectDigest: z.string().min(1),
  })
  .strict();
export type CopilotTextReplaceConfirmation = z.infer<typeof CopilotTextReplaceConfirmationSchema>;
const MailCardAccountSchema = z
  .object({
    id: MailAccountIdSchema,
    address: z.string().max(254),
    displayName: z.string().max(200),
  })
  .strict();
const MailCardRecipients = z.array(MailAddressSchema).max(500);
/**
 * Sending a message the model asked for (Mail ticket 09). Everything the card shows (account, recipients, subject, the
 * whole body, attachments) is read from ONE snapshot of the draft, and the very same snapshot is what is sent on
 * approval; the digest binds the card to the stored draft, so a draft changed after the card was made expires it.
 * The model cannot supply or see an approval.
 */
export const CopilotMailSendConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("send_mail"),
    object: z
      .object({
        kind: z.literal("mail_draft"),
        id: MailMessageIdSchema,
        accountId: MailAccountIdSchema,
      })
      .strict(),
    account: MailCardAccountSchema,
    to: MailCardRecipients,
    cc: MailCardRecipients,
    bcc: MailCardRecipients,
    subject: z.string().max(2000),
    text: z.string().max(4_000_000),
    attachments: z
      .array(
        z
          .object({
            filename: z.string().max(1000),
            contentType: z.string().max(255),
            size: z.number().int().min(0),
          })
          .strict()
      )
      .max(50),
    /** A reply or forward: the Message-ID it answers (null for a new message). */
    inReplyTo: MailMessageIdSchema.nullable(),
    /** What the user is being asked to send: a new message, a reply, or a forward. */
    kind: z.enum(["new", "reply", "forward"]),
    objectDigest: z.string().min(1),
  })
  .strict();
const MailCardMessage = z
  .object({
    folder: z.string().min(1).max(1024),
    uid: z.number().int().min(1),
    uidValidity: z.number().int().min(0),
    from: MailAddressSchema.nullable(),
    subject: z.string().max(10_000),
    date: z.string().nullable(),
  })
  .strict();
const MailCardMessageObject = z
  .object({
    kind: z.literal("mail_message"),
    id: z.string().min(1),
    accountId: MailAccountIdSchema,
  })
  .strict();
/** Deleting one message (into Trash, or for good when it already is in Trash). */
export const CopilotMailDeleteConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("delete_mail"),
    object: MailCardMessageObject,
    account: MailCardAccountSchema,
    message: MailCardMessage,
    /** True: the message is already in Trash and is removed for good (cannot be undone). */
    permanent: z.boolean(),
    objectDigest: z.string().min(1),
  })
  .strict();
/** Moving one message to another folder. */
export const CopilotMailMoveConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("move_mail"),
    object: MailCardMessageObject,
    account: MailCardAccountSchema,
    message: MailCardMessage,
    destination: z.string().min(1).max(1024),
    objectDigest: z.string().min(1),
  })
  .strict();
/**
 * Replacing the whole argument graph of a Work, or clearing it, while it holds arguments (argument graph ticket 09): the
 * page's "Clear" dialog, widened to the whole-graph write. Bound to the stored graph's rev and to the digest of the
 * stored graph (rev, arguments, edges), so a change to it expires the card. The proposed graph is not bound: it is the
 * model's own request, checked before the card is shown and written as given. The counts are what the card shows.
 */
export const CopilotArgumentReplaceConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("replace_argument_graph"),
    object: z
      .object({ kind: z.literal("work"), id: z.string().min(1), workId: z.string().min(1) })
      .strict(),
    /** The Work's title. */
    label: z.string(),
    /** `clear` empties the graph; `replace` writes the proposed one. */
    mode: z.enum(["replace", "clear"]),
    /** What the graph holds now (it is lost). */
    current: ArgumentGraphSizeSchema,
    /** What it holds after (0 and 0 for a clear). */
    next: ArgumentGraphSizeSchema,
    objectDigest: z.string().min(1),
  })
  .strict();
export type CopilotArgumentReplaceConfirmation = z.infer<
  typeof CopilotArgumentReplaceConfirmationSchema
>;
/**
 * Adding a Work to the Shelf, or replacing the Shelf's entries of the same paper (shelf ticket 07): the Add dialog the
 * model asked for. `request` is exactly what is sent when the user approves (the chosen Docs, the chosen annotation ids
 * of each, the argument graph and note switches): the service makes it from the model's request before the card exists,
 * and the click never takes another one. What the card shows comes from a read-only preview of that request
 * (`POST /api/shelf/entries/preview`): the Docs that go in with their annotation counts, the chosen annotations that are
 * not current (they do not go in), and `impact` — null for a new entry, else every entry the add replaces, which the
 * approval sends back as `confirm` unchanged (the server refuses it as `confirmation_changed` when the Shelf no longer
 * holds exactly those). `objectDigest` binds the card to that preview: a change before the click expires it.
 */
export const CopilotShelfAddConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("shelf_add"),
    object: z
      .object({ kind: z.literal("work"), id: z.string().min(1), workId: z.string().min(1) })
      .strict(),
    /** The Work's title. */
    label: z.string(),
    request: ShelfAddPreviewRequestSchema,
    carried: ShelfAddResponseSchema.shape.carried,
    notCarried: ShelfAddResponseSchema.shape.notCarried,
    /** Docs whose older annotation batch the add will archive (empty: the project does not change). */
    wouldArchive: ShelfAddPreviewResponseSchema.shape.wouldArchive,
    impact: ShelfReplaceImpactSchema.nullable(),
    objectDigest: z.string().min(1),
  })
  .strict();
export type CopilotShelfAddConfirmation = z.infer<typeof CopilotShelfAddConfirmationSchema>;
/**
 * Taking a Shelf entry into this project (shelf ticket 07). `request` is what is sent on approval (the entry's rev, the
 * annotations left out, the argument graph and note switches); `plan` is the read-only preview of exactly that request
 * (`POST /api/shelf/entries/:id/take/preview`): the target Work (new, or merged into, with the fields filled), the main
 * Doc, the Docs taken with their annotation counts, the Docs skipped and why, and what happens to the argument graph and
 * the note. The approval sends `planDigest` with the take; when the plan worked out again under the lock differs the
 * server writes nothing (`plan_changed`). `baseRev` is the entry's rev.
 */
export const CopilotShelfTakeConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("shelf_take"),
    object: z
      .object({ kind: z.literal("shelf_entry"), id: z.string().regex(SHELF_ENTRY_ID_RE) })
      .strict(),
    /** The entry's title. */
    label: z.string(),
    request: ShelfTakeRequestSchema.omit({ planDigest: true }),
    plan: ShelfTakeResultSchema,
    planDigest: z.string().regex(/^[0-9a-f]{64}$/),
    objectDigest: z.string().min(1),
  })
  .strict();
export type CopilotShelfTakeConfirmation = z.infer<typeof CopilotShelfTakeConfirmationSchema>;
/**
 * Deleting one Shelf entry (shelf ticket 07; the Shelf dialog's delete): only the Shelf's copy, at the rev shown
 * (`baseRev`; the server refuses a replaced entry as `rev_mismatch`). `entry` is what the entry holds when it is of this
 * build's format (`status: ok`); an entry of a newer format or a damaged one can be deleted too, with `entry` null.
 */
export const CopilotShelfDeleteConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("shelf_delete"),
    object: z
      .object({ kind: z.literal("shelf_entry"), id: z.string().regex(SHELF_ENTRY_ID_RE) })
      .strict(),
    /** The entry's title ("" when an entry of a newer format or a damaged one has none to show). */
    label: z.string(),
    status: z.enum(["ok", "incompatible", "damaged"]),
    entry: ShelfReplacedEntrySchema.nullable(),
    objectDigest: z.string().min(1),
  })
  .strict();
export type CopilotShelfDeleteConfirmation = z.infer<typeof CopilotShelfDeleteConfirmationSchema>;
export type CopilotMailSendConfirmation = z.infer<typeof CopilotMailSendConfirmationSchema>;
export type CopilotMailDeleteConfirmation = z.infer<typeof CopilotMailDeleteConfirmationSchema>;
export type CopilotMailMoveConfirmation = z.infer<typeof CopilotMailMoveConfirmationSchema>;
/** Every confirmation card; the one source of each kind's fields (the server's requests and records follow from it). */
const CONFIRMATION_CARD_SCHEMAS = [
  CopilotMailSendConfirmationSchema,
  CopilotMailDeleteConfirmationSchema,
  CopilotMailMoveConfirmationSchema,
  CopilotTextReplaceConfirmationSchema,
  CopilotPlanConfirmationSchema,
  CopilotDocConfirmationSchema,
  CopilotDocDeleteConfirmationSchema,
  CopilotManuscriptDeleteConfirmationSchema,
  CopilotArgumentReplaceConfirmationSchema,
  CopilotShelfAddConfirmationSchema,
  CopilotShelfTakeConfirmationSchema,
  CopilotShelfDeleteConfirmationSchema,
  CopilotCommandConfirmationSchema,
  CopilotEditFileConfirmationSchema,
  CopilotWriteFileConfirmationSchema,
] as const;
export const CopilotConfirmationSchema = z.union(CONFIRMATION_CARD_SCHEMAS);
export type CopilotDocDeleteConfirmation = z.infer<typeof CopilotDocDeleteConfirmationSchema>;
export type CopilotPlanConfirmation = z.infer<typeof CopilotPlanConfirmationSchema>;
export type CopilotDocConfirmation = z.infer<typeof CopilotDocConfirmationSchema>;
export type CopilotConfirmation = z.infer<typeof CopilotConfirmationSchema>;

/** The real UI's decision. It repeats what the card showed so a click can only bind to that version. */
export const CopilotConfirmationDecisionSchema = z
  .object({
    decision: z.enum(["approve", "decline"]),
    viewId: CopilotIdSchema,
    /** Exactly the actions of the cards above. */
    action: z.enum(
      CONFIRMATION_CARD_SCHEMAS.map((card) => card.shape.action.value) as [
        CopilotConfirmation["action"],
        ...CopilotConfirmation["action"][],
      ]
    ),
    objectId: z.string().min(1),
    baseRev: z.number().int().nonnegative(),
    /**
     * With an approval of a file or command tool call (copilot ticket 57): also allow every later call of its class
     * (commands, or file writes) in this conversation until the service restarts. Only a real view's click sends it.
     */
    remember: z.boolean().optional(),
  })
  .strict();
export type CopilotConfirmationDecision = z.infer<typeof CopilotConfirmationDecisionSchema>;

/** Undo of a confirmed task delete, from a real view. */
export const CopilotUndoRequestSchema = z.object({ viewId: CopilotIdSchema }).strict();

/** Durable record of a confirmation: requested before the card exists, resolved before anything runs. */
export const OPERATION_CONFIRMATION_TYPE = "argelander.confirmation.v1";
const OperationConfirmationBase = {
  version: z.literal(1),
  phase: z.enum(["requested", "resolved"]),
  confirmationId: CopilotIdSchema,
  runId: CopilotIdSchema,
  toolCallId: z.string().min(1),
  baseRev: z.number().int().nonnegative(),
  outcome: z.enum(["approved", "declined", "expired"]).optional(),
};
export const OperationConfirmationSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...OperationConfirmationBase,
      action: z.literal("send_mail"),
      accountId: z.string().min(1),
      messageId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...OperationConfirmationBase,
      action: z.enum(["delete_mail", "move_mail"]),
      accountId: z.string().min(1),
      folder: z.string().min(1),
      uid: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      ...OperationConfirmationBase,
      action: z.literal("replace_text_reading"),
      docId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...OperationConfirmationBase,
      action: z.literal("delete_doc"),
      docId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...OperationConfirmationBase,
      action: z.literal("delete_plan"),
      planId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...OperationConfirmationBase,
      action: z.literal("delete_manuscript"),
      manuscriptId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...OperationConfirmationBase,
      action: z.literal("refresh_arxiv_source"),
      workId: z.string().min(1),
      docId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...OperationConfirmationBase,
      action: z.literal("replace_argument_graph"),
      workId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...OperationConfirmationBase,
      action: z.literal("shelf_add"),
      workId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...OperationConfirmationBase,
      action: z.enum(["shelf_take", "shelf_delete"]),
      entryId: z.string().min(1),
    })
    .strict(),
  // A file or command tool call (copilot ticket 57): the record keeps no command and no path.
  z
    .object({
      ...OperationConfirmationBase,
      action: z.enum(FILE_TOOL_CONFIRMATION_ACTIONS),
    })
    .strict(),
]);
export type OperationConfirmation = z.infer<typeof OperationConfirmationSchema>;

/**
 * What a running run is doing right now (public run status: the operation under way, the reply being written, or
 * thinking). `thinking` is only the reasoning text the provider exposes (a summary for OpenAI/Codex); empty when the
 * provider gives none. The UI never promises raw internal reasoning.
 */
export const CopilotLiveSchema = z
  .object({
    phase: z.enum(["working", "thinking", "writing", "operation"]),
    /** With `operation`: the tool call being prepared or executed; `page` is the 1-based page it reads. */
    operation: z
      .object({
        tool: z.string(),
        action: z.string().optional(),
        page: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    thinking: z.string(),
    /** Time since the run started, measured when the service sent this state. */
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();
export type CopilotLive = z.infer<typeof CopilotLiveSchema>;

/**
 * What the host records in a `CompactionEntry`'s `details` (release-0.2 ticket 11): who asked for it and which model wrote the
 * summary. The history stays readable without it; a compaction that has none is shown as an automatic one by an unknown model.
 */
export const CompactionDetailsSchema = z
  .object({
    version: z.literal(1),
    origin: z.enum(["manual", "auto"]),
    provider: z.string(),
    model: z.string(),
  })
  .strict();
export type CompactionDetails = z.infer<typeof CompactionDetailsSchema>;
/** One compaction marker of the shown history: the model sees the summary instead of everything before `beforeMessageId`. */
export interface CopilotCompaction {
  /** The compaction entry's id. */
  id: string;
  /** The first shown message the model still sees as written; null when no shown message follows the cut. */
  beforeMessageId: string | null;
  /** How many shown messages come before the marker (the model no longer sees them as written). */
  count: number;
  origin: "manual" | "auto";
  /** The model that wrote the summary, when the entry says so. */
  model: string | null;
  at: string;
  /** The summary also carries what an earlier summary said. */
  includesPrevious: boolean;
  /** The read-only summary text. */
  summary: string;
}
/** A compaction under way (the panel disables sending and shows the running state). */
export interface CopilotCompactionState {
  origin: "manual" | "auto";
  startedAt: string;
}

export interface ConversationSnapshot {
  version: 1;
  conversation: Conversation;
  messages: CopilotMessage[];
  /** The compaction markers, oldest first (absent in a snapshot of a service that predates compaction). */
  compactions?: CopilotCompaction[];
  /** The compaction under way, if any. */
  compaction?: CopilotCompactionState | null;
  /** Whether a manual compaction has anything to compact now (a conversation that is still short has not). */
  canCompact?: boolean;
  /** The running run's current status; null/absent when no run works. A reconnecting client gets it here. */
  live?: CopilotLive | null;
  /** Confirmations the user can act on now (this service instance only; a restart revives none). */
  confirmations: CopilotConfirmation[];
  stream: string;
  eventCursor: EventCursor;
}
export const WsCopilotEventSchema = z
  .object({
    type: z.literal("copilot.event"),
    conversationId: CopilotIdSchema,
    runId: CopilotIdSchema.nullable(),
    eventCursor: EventCursorSchema,
    kind: z.enum(["stream", "changed"]),
    text: z.string().optional(),
    live: CopilotLiveSchema.nullable().optional(),
  })
  .strict();
export type WsCopilotEvent = z.infer<typeof WsCopilotEventSchema>;
/** Targeted at exactly one browser view (never broadcast to other tabs). */
export const WsCopilotViewActionSchema = z
  .object({
    type: z.literal("copilot.view-action"),
    viewId: CopilotIdSchema,
    actionId: z.string().uuid(),
    action: z.union([
      PlanViewActionSchema,
      WorkspaceViewActionSchema,
      LibraryViewActionSchema,
      DocDeletedViewActionSchema,
      DiscoverySavedViewActionSchema,
      ReaderViewActionSchema,
      WriterViewActionSchema,
      ArgumentViewActionSchema,
    ]),
  })
  .strict();
export type WsCopilotViewAction = z.infer<typeof WsCopilotViewActionSchema>;

export const CopilotSubscriptionSchema = z
  .object({
    type: z.enum(["copilot.subscribe", "copilot.unsubscribe"]),
    conversationId: CopilotIdSchema,
    viewId: CopilotIdSchema,
  })
  .strict();
export const WsCopilotSubscribedSchema = z
  .object({
    type: z.literal("copilot.subscribed"),
    conversationId: CopilotIdSchema,
    viewId: CopilotIdSchema,
  })
  .strict();

/** What an old user envelope recorded about a file handed over with it (metadata only; read-only, shown by name). */
export const LegacySentAttachmentSchema = z
  .object({ filename: z.string().max(255).optional() })
  .passthrough();
export const CopilotPromptSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("resume").optional(),
    messageId: CopilotIdSchema,
    text: z.string().min(1),
    /** What of the Reader reading or PDF material this message delivers (ticket 24); absent for other pages. */
    coverage: ContextCoverageSchema.optional(),
    /**
     * The page as the service sends it: a Reader reading too large for the room left in the window is either a
     * batch of its entries (`coverage` says which) or left out (`readingOmitted`), never cut silently (ticket 24).
     */
    context: ObservationPageContextSchema,
    /** The material of the PDF Doc the page shows (copilot ticket 20): derived by the service from the verified original. */
    pdf: PdfMaterialEnvelopeSchema.optional(),
    /**
     * Legacy (removed attachment feature, ticket 15): accepted on read so a conversation written by the old format
     * still loads; the history keeps what was delivered as sent. Never written, never acted on.
     */
    attachments: z.array(LegacySentAttachmentSchema).max(5).optional(),
  })
  .strict();
export type CopilotPrompt = z.infer<typeof CopilotPromptSchema>;
export const CopilotContextReferenceSchema = z
  .object({
    clientMessageId: CopilotIdSchema,
    messageId: CopilotIdSchema,
    runId: CopilotIdSchema,
    context: z
      .object({
        contextId: CopilotIdSchema,
        view: z.string().min(1),
        status: z.enum(["complete", "unavailable", "error"]),
        revision: z.number().int().nonnegative(),
        /** What the Library page carried (copilot ticket 13); absent for other pages. */
        library: LibraryContextSummarySchema.optional(),
        /** What the Library tab's exploration carried (copilot ticket 17); absent otherwise. */
        discovery: DiscoveryContextSummarySchema.optional(),
        /** What the argument graph view carried (argument graph ticket 04); absent otherwise. */
        argument: ArgumentContextSummarySchema.optional(),
        /** What the Reader carried (copilot ticket 18); absent for other pages. */
        reader: ReaderContextSummarySchema.optional(),
        /** What the PDF Reader carried (copilot ticket 20); absent for other pages. */
        pdf: PdfContextSummarySchema.optional(),
        /** What a text Doc's source panel carried (copilot ticket 29); absent for other pages. */
        text: TextContextSummarySchema.optional(),
        /** What the Writer carried (copilot ticket 22); absent for other pages. */
        writer: WriterContextSummarySchema.optional(),
        /** What the Mail page carried (Mail ticket 09); no body and no addresses. */
        mail: MailContextSummarySchema.optional(),
        /** What of the Reader reading / PDF material this message delivered (copilot ticket 24). */
        coverage: ContextCoverageSchema.optional(),
        objects: z.array(
          z.object({ id: z.string().min(1), rev: z.number().int().nonnegative() }).strict()
        ),
      })
      .strict(),
  })
  .strict();

export type CopilotContextReference = z.infer<typeof CopilotContextReferenceSchema>;
export const CopilotObservationSchema = z
  .object({
    version: z.literal(1),
    taskContextId: CopilotIdSchema,
    page: ObservationPageContextSchema,
  })
  .strict();

/**
 * Durable record of a business write: `begin` is persisted before the write runs, `done` after it has a
 * result. A `begin` without `done` means the outcome is unknown (never proof the write did not happen).
 */
export const OPERATION_JOURNAL_TYPE = "argelander.operation.v1";
export const OperationJournalSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(["begin", "submitted", "done"]),
    operationId: z.string().min(1).max(200),
    toolCallId: z.string().min(1),
    runId: CopilotIdSchema,
    action: z.string(),
    hash: z.string(),
    object: z
      .object({
        planId: z.string().optional(),
        taskId: z.string().optional(),
        workId: z.string().optional(),
        /** The Writer manuscript the operation targets (copilot ticket 22). */
        manuscriptId: z.string().optional(),
        /** The mail send this operation started (Mail ticket 09): chosen by the application, never by the model. */
        sendId: z.string().max(64).optional(),
        /** The Job-table job this operation submitted (recorded right after the submit). */
        jobId: z.string().optional(),
        /** A readable one-line description of the request (for example an import's mode and text). */
        summary: z.string().max(240).optional(),
      })
      .strict()
      .optional(),
    baseRev: z.number().int().nonnegative().optional(),
    result: z
      .object({ payload: z.record(z.string(), z.unknown()), operation: CopilotOperationSchema })
      .strict()
      .optional(),
  })
  .strict();
export type OperationJournal = z.infer<typeof OperationJournalSchema>;

/**
 * A steering message the service accepted (HTTP 202) while a run was working. It is saved before the
 * acceptance is returned, so a crash or a later failure cannot lose the user's words. It stays "queued"
 * until a user message with the same messageId exists in the history; a later run hands it to the model.
 */
export const STEER_QUEUE_TYPE = "argelander.steer.v1";
export const QueuedSteerSchema = z
  .object({
    version: z.literal(1),
    clientMessageId: CopilotIdSchema,
    messageId: CopilotIdSchema,
    runId: CopilotIdSchema,
    envelope: z.string().min(1),
    reference: CopilotContextReferenceSchema,
  })
  .strict();
export type QueuedSteer = z.infer<typeof QueuedSteerSchema>;

/** Everything a bound browser view can be asked to do: Plan page navigation or Shell layout/appearance. */
export type CopilotViewAction = WsCopilotViewAction["action"];
