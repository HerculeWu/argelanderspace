/**
 * The Copilot's Mail operations as plain functions over the SAME services the Mail page's routes use (Mail ticket 09;
 * ADR 0005, ADR 0008): reading, listing and searching go through the read and manage services, drafts through the
 * compose service, and a send through the send service, so the 8 second undo window, the sent guard and the claim are
 * the ones the user's own Send button has. There is no second SMTP path here.
 *
 * Failures are reported by CODE only. A message's text, a recipient or a server's answer never reaches an error.
 */
import { createHash } from "node:crypto";
import {
  type MailAccount,
  type MailAddress,
  type MailComposeDraft,
  type MailFolder,
  type MailHeader,
  type MailMessage,
  type MailSendStatus,
  PDF_MAX_BYTES,
} from "@argelanderspace/contracts";
import { parseRecipients } from "@argelanderspace/infra";
import {
  type DraftSnapshot,
  htmlToText,
  MailComposeError,
  type MailComposeService,
} from "./mail-compose.js";
import type { MailComposeServices } from "./mail-compose-routes.js";
import type { MailManageService } from "./mail-manage.js";
import type { MailReadService } from "./mail-read.js";

/** What the tool needs of the application's Mail services (each built lazily, shared with the routes). */
export interface MailOpDeps {
  accounts: () => { list(): { accounts: MailAccount[] } };
  read: () => MailReadService;
  manage: () => MailManageService;
  services: () => MailComposeServices;
}

export type MailFailureStatus = "not_found" | "conflict" | "rejected" | "error" | "unknown";
export interface MailFailure {
  ok: false;
  status: MailFailureStatus;
  code: string;
}

const NOT_FOUND = new Set([
  "message_not_found",
  "folder_not_found",
  "account_not_found",
  "destination_not_found",
  "not_found",
]);
const CONFLICT = new Set([
  "message_changed",
  "already_pending",
  "already_sent",
  "owned_elsewhere",
  "not_pending",
]);
const REJECTED = new Set([
  "invalid_input",
  "invalid_recipient",
  "no_recipients",
  "attachment_missing",
  "attachment_too_large",
  "message_too_large",
  "too_large",
  "drafts_unavailable",
  "recipient_rejected",
  "not_in_trash",
  "trash_not_found",
  "unsupported",
  "refused",
  "confirmation_required",
]);
/** The change may or may not have happened. */
const UNKNOWN = new Set(["connection_lost", "partial", "outcome_unknown"]);

/** A service error as a code and a status; anything else is a plain `error` with no detail. */
export function mailFailure(error: unknown): MailFailure {
  const code =
    error instanceof Error && typeof (error as unknown as { code?: unknown }).code === "string"
      ? (error as unknown as { code: string }).code
      : "unknown";
  return {
    ok: false,
    code,
    status: NOT_FOUND.has(code)
      ? "not_found"
      : CONFLICT.has(code)
        ? "conflict"
        : REJECTED.has(code)
          ? "rejected"
          : UNKNOWN.has(code)
            ? "unknown"
            : "error",
  };
}

/** Run a service call and return its value or its failure. */
export async function attempt<T>(work: () => Promise<T> | T): Promise<T | MailFailure> {
  try {
    return await work();
  } catch (error) {
    return mailFailure(error);
  }
}
export const failed = (value: unknown): value is MailFailure =>
  typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;

export function accountsOf(deps: MailOpDeps) {
  return deps
    .accounts()
    .list()
    .accounts.map((a) => ({
      id: a.id,
      address: a.address,
      displayName: a.displayName,
      preset: a.preset,
    }));
}

export const foldersOf = (deps: MailOpDeps, accountId: string) =>
  attempt(async () => {
    const r = await deps.read().folders(accountId);
    return {
      stale: r.stale,
      folders: r.folders.map((f: MailFolder) => ({
        path: f.path,
        name: f.name,
        role: f.role,
        selectable: f.selectable,
        unread: f.unread,
        total: f.total,
      })),
    };
  });

export interface HeaderPage {
  uidValidity: number;
  total: number;
  headers: MailHeader[];
  nextBefore: number | null;
  stale: boolean;
}

export const listHeaders = (
  deps: MailOpDeps,
  op: { accountId: string; folder: string; before?: number | undefined; limit?: number | undefined }
) =>
  attempt(async (): Promise<HeaderPage> => {
    const r = await deps.read().headers(op.accountId, op.folder, op.before, op.limit ?? 30);
    return {
      uidValidity: r.uidValidity,
      total: r.total,
      headers: r.headers,
      nextBefore: r.nextBefore,
      stale: r.stale,
    };
  });

export const searchHeaders = (
  deps: MailOpDeps,
  op: {
    accountId: string;
    folder: string;
    criteria: import("@argelanderspace/contracts").MailSearchCriteria;
    before?: number | undefined;
    limit?: number | undefined;
  }
) =>
  attempt(async () => {
    const r = await deps.manage().search(op.accountId, {
      folder: op.folder,
      criteria: op.criteria,
      ...(op.before !== undefined ? { before: op.before } : {}),
      limit: op.limit ?? 30,
    });
    return {
      uidValidity: r.uidValidity,
      matches: r.matches,
      headers: r.headers,
      nextBefore: r.nextBefore,
    };
  });

/** The readable text of a message: its plain-text part, else the text of its HTML. */
export function readableText(m: MailMessage): { text: string; source: "text" | "html" | null } {
  if (m.text !== null && m.text.trim() !== "") return { text: m.text, source: "text" };
  if (m.html !== null && m.html.trim() !== "") return { text: htmlToText(m.html), source: "html" };
  return { text: "", source: null };
}

/**
 * Open a message WITHOUT marking it read (`unread: false`): a Copilot reading is not the user having read it. A
 * message that is not in the local cache is still fetched from the server and its \Seen flag is left alone.
 */
export const openMessage = (
  deps: MailOpDeps,
  op: { accountId: string; folder: string; uid: number; uidValidity?: number | undefined }
) =>
  attempt(async () => {
    const r = await deps.read().open(op.accountId, {
      folder: op.folder,
      uid: op.uid,
      ...(op.uidValidity !== undefined ? { uidValidity: op.uidValidity } : {}),
      unread: false,
    });
    return r;
  });

export interface MailDraftView {
  accountId: string;
  messageId: string;
  digest: string;
  inReplyTo: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  attachments: { filename: string; contentType: string; size: number }[];
}

const recipientsOf = (text: string): MailAddress[] => {
  const parsed = parseRecipients(text);
  return parsed.ok ? parsed.list.map((a) => ({ name: a.name, address: a.address })) : [];
};

export function draftView(snapshot: DraftSnapshot): MailDraftView {
  const d = snapshot.draft;
  return {
    accountId: snapshot.accountId,
    messageId: d.messageId,
    digest: snapshot.digest,
    inReplyTo: d.inReplyTo,
    to: recipientsOf(d.to),
    cc: recipientsOf(d.cc),
    bcc: recipientsOf(d.bcc),
    subject: d.subject,
    text: d.text,
    attachments: snapshot.files,
  };
}

/** Recipients that did not parse make the snapshot unfit to show on a card: nothing could be called "the recipients". */
export function recipientsParse(draft: MailComposeDraft): boolean {
  return (
    parseRecipients(draft.to).ok && parseRecipients(draft.cc).ok && parseRecipients(draft.bcc).ok
  );
}

/** What each draft this process made was made as (reply/forward/new), by its creation mode, never guessed from a subject. */
const draftKinds = new Map<string, "new" | "reply" | "forward">();
export function draftKindOf(
  messageId: string,
  inReplyTo: string | null
): "new" | "reply" | "forward" {
  return draftKinds.get(messageId) ?? (inReplyTo ? "reply" : "new");
}
function rememberKind(messageId: string, kind: "new" | "reply" | "forward"): void {
  draftKinds.set(messageId, kind);
  if (draftKinds.size > 500) draftKinds.delete(draftKinds.keys().next().value as string);
}

export const createDraft = (
  deps: MailOpDeps,
  op: import("@argelanderspace/contracts").MailCreateDraftOperation
) =>
  attempt(async () => {
    const compose = deps.services().compose;
    const account = compose.account(op.accountId);
    let draft: MailComposeDraft;
    if (op.mode === "new" || !op.source) {
      draft = {
        messageId: compose.newMessageId(account),
        inReplyTo: null,
        references: [],
        to: op.to ?? "",
        cc: op.cc ?? "",
        bcc: op.bcc ?? "",
        subject: op.subject ?? "",
        text: op.text,
        attachments: [],
      };
    } else {
      const init = await compose.init(op.accountId, {
        mode: op.mode === "reply" ? "reply" : op.mode === "reply_all" ? "replyAll" : "forward",
        folder: op.source.folder,
        uid: op.source.uid,
        ...(op.source.uidValidity !== undefined ? { uidValidity: op.source.uidValidity } : {}),
        locale: op.locale ?? "en",
      });
      draft = {
        ...init.draft,
        ...(op.to !== undefined ? { to: op.to } : {}),
        ...(op.cc !== undefined ? { cc: op.cc } : {}),
        ...(op.bcc !== undefined ? { bcc: op.bcc } : {}),
        ...(op.subject !== undefined ? { subject: op.subject } : {}),
        // What the model wrote goes above the quote or the forwarded text, as the cursor sits for the user.
        text: `${op.text.replace(/\s+$/, "")}${init.draft.text}`,
      };
    }
    try {
      await compose.saveDraft(op.accountId, draft);
    } finally {
      // The Drafts copy holds the attachments; the staged copies were only for this save.
      compose.deleteStaged(op.accountId, draft.attachments);
    }
    rememberKind(
      draft.messageId,
      op.mode === "forward" ? "forward" : op.mode === "new" ? "new" : "reply"
    );
    return draftView(await compose.draftSnapshot(op.accountId, draft.messageId, { stage: false }));
  });

export const readDraft = (deps: MailOpDeps, accountId: string, messageId: string) =>
  attempt(async () =>
    draftView(await deps.services().compose.draftSnapshot(accountId, messageId, { stage: false }))
  );

export const updateDraft = (
  deps: MailOpDeps,
  op: import("@argelanderspace/contracts").MailUpdateDraftOperation
) =>
  attempt(async () => {
    const { snapshot } = await deps
      .services()
      .compose.patchDraft(op.accountId, op.messageId, op.expectedDigest, {
        ...(op.to !== undefined ? { to: op.to } : {}),
        ...(op.cc !== undefined ? { cc: op.cc } : {}),
        ...(op.bcc !== undefined ? { bcc: op.bcc } : {}),
        ...(op.subject !== undefined ? { subject: op.subject } : {}),
        ...(op.text !== undefined ? { text: op.text } : {}),
      });
    return draftView(snapshot);
  });

/** A send's card: everything it shows is read from this one snapshot, and the same snapshot is what is sent. */
export interface SendPlan {
  snapshot: DraftSnapshot;
  view: MailDraftView;
  account: { id: string; address: string; displayName: string };
}

export const planSend = (deps: MailOpDeps, accountId: string, messageId: string) =>
  attempt(async (): Promise<SendPlan> => {
    const compose = deps.services().compose;
    const account = compose.account(accountId);
    const snapshot = await compose.draftSnapshot(accountId, messageId, { stage: true });
    if (!recipientsParse(snapshot.draft)) {
      compose.deleteStaged(
        accountId,
        snapshot.attachments.map((x) => x.id)
      );
      throw new MailComposeError("invalid_recipient");
    }
    return {
      snapshot,
      view: draftView(snapshot),
      account: { id: account.id, address: account.address, displayName: account.displayName },
    };
  });

/** Staged copies made for a card that will not be used (declined, expired, replaced). */
export function releaseSend(deps: MailOpDeps, plan: SendPlan): void {
  try {
    deps.services().compose.deleteStaged(
      plan.snapshot.accountId,
      plan.snapshot.attachments.map((x) => x.id)
    );
  } catch {
    /* disposable staging; the 7 day sweep clears what is left */
  }
}

/** True when the stored draft is still exactly what the card showed. */
export async function draftUnchanged(
  deps: MailOpDeps,
  accountId: string,
  messageId: string,
  digest: string
): Promise<"same" | "changed" | MailFailure> {
  const now = await attempt(() =>
    deps.services().compose.draftSnapshot(accountId, messageId, { stage: false })
  );
  if (failed(now)) return now;
  return now.digest === digest ? "same" : "changed";
}

/** Hand the approved snapshot to the one send path (claim, Drafts, 8 second window, one SMTP, sent guard). */
export const startSend = (deps: MailOpDeps, plan: SendPlan, sendId: string) =>
  attempt(
    async (): Promise<MailSendStatus> =>
      deps.services().send.start(plan.snapshot.accountId, { sendId, draft: plan.snapshot.draft })
  );

export const sendStatusOf = (deps: MailOpDeps, accountId: string, sendId: string) =>
  attempt(() => deps.services().send.status(accountId, sendId));

export const flagsOfFolder = (folders: MailFolder[], path: string) =>
  folders.find((f) => f.path === path) ?? null;

/** A message as a delete or move card shows it: from the server's own answer for exactly this uid. */
export interface MessageTarget {
  account: { id: string; address: string; displayName: string };
  folder: string;
  uid: number;
  uidValidity: number;
  from: MailAddress | null;
  subject: string;
  date: string | null;
  /** Delete only: the folder is Trash, so the delete is for good. */
  inTrash: boolean;
}

export const describeTarget = (
  deps: MailOpDeps,
  op: {
    accountId: string;
    folder: string;
    uid: number;
    uidValidity: number;
    destination?: string;
  }
) =>
  attempt(async (): Promise<MessageTarget> => {
    const read = deps.read();
    const account = read.account(op.accountId);
    const folders = await read.folders(op.accountId);
    const here = flagsOfFolder(folders.folders, op.folder);
    if (!here) throw new MailComposeError("folder_not_found");
    if (op.destination !== undefined) {
      const there = flagsOfFolder(folders.folders, op.destination);
      if (!there?.selectable) throw new MailComposeError("folder_not_found");
    }
    const opened = await read.open(op.accountId, {
      folder: op.folder,
      uid: op.uid,
      uidValidity: op.uidValidity,
      unread: false,
    });
    const m = opened.message;
    if (m.uidValidity !== op.uidValidity) throw new MailComposeError("message_changed");
    return {
      account: { id: account.id, address: account.address, displayName: account.displayName },
      folder: op.folder,
      uid: op.uid,
      uidValidity: m.uidValidity,
      from: m.from,
      subject: m.subject,
      date: m.date,
      inTrash: here.role === "trash",
    };
  });

export const runDelete = (deps: MailOpDeps, t: MessageTarget) =>
  attempt(() =>
    deps.manage().remove(t.account.id, {
      folder: t.folder,
      uid: t.uid,
      uidValidity: t.uidValidity,
      ...(t.inTrash ? { permanent: true } : {}),
    })
  );

export const runMove = (deps: MailOpDeps, t: MessageTarget, destination: string) =>
  attempt(() =>
    deps.manage().move(t.account.id, {
      folder: t.folder,
      uid: t.uid,
      uidValidity: t.uidValidity,
      destination,
    })
  );

/** Digest of a delete/move request, so a card is bound to exactly this message and target. */
export function targetDigest(t: MessageTarget, extra: string): string {
  return createHash("sha256")
    .update(JSON.stringify([t.account.id, t.folder, t.uid, t.uidValidity, t.inTrash, extra]))
    .digest("hex");
}

// ---- attachments ---------------------------------------------------------------------------------------- //

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|x-tex|x-latex))/i;
export const isPdfAttachment = (contentType: string, filename: string): boolean =>
  /^application\/pdf$/i.test(contentType) || /\.pdf$/i.test(filename);
export const isTextAttachment = (contentType: string, filename: string): boolean =>
  TEXT_TYPES.test(contentType) || /\.(txt|md|csv|json|tex|bib|log|xml|ya?ml)$/i.test(filename);

export interface AttachmentBytes {
  filename: string;
  contentType: string;
  content: Buffer;
}

export const attachmentBytes = (
  deps: MailOpDeps,
  op: {
    accountId: string;
    folder: string;
    uid: number;
    uidValidity?: number | undefined;
    part: number;
  }
) =>
  attempt(async (): Promise<AttachmentBytes> => {
    const a = await deps.read().attachment(op.accountId, {
      folder: op.folder,
      uid: op.uid,
      uidValidity: op.uidValidity,
      part: op.part,
    });
    if (a.content.byteLength > PDF_MAX_BYTES) throw new MailComposeError("too_large");
    return { filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content) };
  });

export type { MailComposeService };
