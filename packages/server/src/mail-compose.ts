/**
 * Writing mail (Mail ticket 07; ADR 0008): initial content for reply / reply all / forward / editing a
 * draft, attachment staging, and saving drafts to the account's server-side Drafts folder. The remote
 * mailbox is the authority; the staged attachments (global cache) are disposable and only needed
 * between "add attachment" and "send" (a missing one is reported as `attachment_missing` and the user
 * adds it again). Recipients, subjects, bodies and file names are user/third-party content: they are
 * never logged and never put into an error body.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isMailMessageId,
  MAIL_ACCOUNT_ID_PATTERN,
  MAIL_ATTACHMENT_MAX_BYTES,
  MAIL_ATTACHMENT_MAX_COUNT,
  MAIL_ATTACHMENT_TOTAL_MAX_BYTES,
  MAIL_STAGED_ID_PATTERN,
  type MailAccount,
  type MailComposeDraft,
  type MailComposeFailureCode,
  type MailComposeInitRequest,
  type MailComposeInitResponse,
  type MailSaveDraftResponse,
  type MailStagedAttachment,
  MailStagedAttachmentSchema,
} from "@argelanderspace/contracts";
import {
  type ComposedMail,
  type CredentialStore,
  composeMail,
  type MailAccountStore,
  type MailLoginTarget,
  type MailMailbox,
  type MailOutgoing,
  type OutAddress,
  type OutAttachment,
  parseMailSource,
  parseRecipients,
} from "@argelanderspace/infra";

export class MailComposeError extends Error {
  readonly code: MailComposeFailureCode;
  constructor(code: MailComposeFailureCode) {
    super(code);
    this.code = code;
  }
}

export interface MailComposeDeps {
  accounts: MailAccountStore;
  credentials: CredentialStore;
  /** Reads the source of the message being replied to / forwarded / edited. */
  mailbox: MailMailbox;
  outgoing: MailOutgoing;
  /** The global cache directory (staged attachments live under `mail/_staged`). */
  cacheDir: () => string;
  maxMessageBytes?: number;
}

const STAGED_TTL_MS = 7 * 24 * 3600 * 1000;

function sweepDir(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (Date.now() - statSync(p).mtimeMs > STAGED_TTL_MS) rmSync(p, { force: true });
    }
  } catch {
    /* best effort; a missing directory is the normal case */
  }
}

/** Server start: clear staged attachments nobody sent or discarded within 7 days (also done lazily on staging). */
export function sweepStagedAttachmentsIn(cacheDir: string): void {
  sweepDir(join(cacheDir, "mail", "_staged"));
}
const READ_MAX = 40 * 1024 * 1024;

/** Tags -> text for quoting an HTML-only message. Not a sanitiser: the result is plain text only. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatAddress(a: { name: string; address: string }): string {
  const name = a.name.trim();
  if (!name) return a.address;
  return /[",;<>()[\]:@\\]/.test(name)
    ? `"${name.replace(/(["\\])/g, "\\$1")}" <${a.address}>`
    : `${name} <${a.address}>`;
}

const SUBJECT_PREFIX = /^\s*((re|aw|sv|antw|回复|答复)|(fwd?|wg|转发))\s*[:：]\s*/i;
function prefixed(subject: string, prefix: "Re" | "Fwd"): string {
  // Strip one level of an existing re/fwd prefix of the same family so "Re: Re: x" never builds up.
  const m = SUBJECT_PREFIX.exec(subject);
  const sameFamily = m ? (prefix === "Re" ? m[2] !== undefined : m[3] !== undefined) : false;
  const base = sameFamily ? subject.replace(SUBJECT_PREFIX, "") : subject;
  return `${prefix}: ${base}`.trim();
}

const WROTE = {
  en: (when: string, who: string) => `On ${when}, ${who} wrote:`,
  "zh-CN": (when: string, who: string) => `${when}，${who} 写道：`,
} as const;
const FORWARD_LABELS = {
  en: {
    head: "---------- Forwarded message ----------",
    from: "From",
    date: "Date",
    subject: "Subject",
    to: "To",
    cc: "Cc",
  },
  "zh-CN": {
    head: "---------- 转发的邮件 ----------",
    from: "发件人",
    date: "日期",
    subject: "主题",
    to: "收件人",
    cc: "抄送",
  },
} as const;

function whenText(iso: string | null, locale: "en" | "zh-CN"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(d)} UTC`;
}

const quote = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => (l === "" ? ">" : `> ${l}`))
    .join("\n");

const normalise = (address: string) => address.trim().toLowerCase();

export class MailComposeService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private sendGuard: (accountId: string, messageId: string) => boolean = () => false;
  constructor(private readonly deps: MailComposeDeps) {}

  /** The send service tells us which drafts are in an undo window / being sent (they must not be edited). */
  setSendGuard(guard: (accountId: string, messageId: string) => boolean): void {
    this.sendGuard = guard;
  }
  private refuseIfSending(accountId: string, messageId: string): void {
    if (this.sendGuard(accountId, messageId)) throw new MailComposeError("already_pending");
  }

  /** Remove staged attachments older than the TTL; called when the server starts and when files are staged. */
  sweepStagedAttachments(): void {
    sweepStagedAttachmentsIn(this.deps.cacheDir());
  }

  // ---- accounts ------------------------------------------------------------

  account(id: string): MailAccount {
    let found: MailAccount | undefined;
    try {
      found = this.deps.accounts.read().accounts.find((a) => a.id === id);
    } catch {
      throw new MailComposeError("storage");
    }
    if (!found) throw new MailComposeError("account_not_found");
    return found;
  }
  async imapTarget(a: MailAccount): Promise<MailLoginTarget> {
    const got = await this.deps.credentials.get(a.credentialRef);
    if (got.status !== "ok") throw new MailComposeError("credential_missing");
    return { ...a.imap, user: a.imapUser, password: got.password };
  }
  async smtpTarget(a: MailAccount): Promise<MailLoginTarget> {
    const got = await this.deps.credentials.get(a.credentialRef);
    if (got.status !== "ok") throw new MailComposeError("credential_missing");
    return { ...a.smtp, user: a.smtpUser, password: got.password };
  }

  /** Serialise work on one draft within this process (saves, discards and the send's own save). */
  async withDraftLock<T>(accountId: string, messageId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${accountId}\u0000${messageId}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  newMessageId(a: MailAccount): string {
    const domain =
      (a.address.split("@")[1] ?? "localhost").replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
    return `<${randomUUID()}@${domain}>`;
  }

  // ---- attachment staging --------------------------------------------------

  /**
   * Not under an account's directory: the user may switch the sender while composing, and a draft's
   * attachments must follow. Cleared by the 7 day sweep (and by send/discard); never user data.
   */
  private stagedDir(accountId: string): string {
    if (!MAIL_ACCOUNT_ID_PATTERN.test(accountId)) throw new MailComposeError("invalid_input");
    return join(this.deps.cacheDir(), "mail", "_staged");
  }

  stage(
    accountId: string,
    filename: string,
    contentType: string,
    content: Uint8Array
  ): MailStagedAttachment {
    this.account(accountId);
    if (content.byteLength > MAIL_ATTACHMENT_MAX_BYTES)
      throw new MailComposeError("attachment_too_large");
    const dir = this.stagedDir(accountId);
    const meta: MailStagedAttachment = {
      id: randomBytes(16).toString("hex"),
      filename:
        [...filename]
          .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
          .join("")
          .slice(0, 255) || "attachment",
      contentType: /^[\w.+-]+\/[\w.+-]+$/.test(contentType)
        ? contentType.toLowerCase()
        : "application/octet-stream",
      size: content.byteLength,
    };
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.sweepStaged(dir);
      writeFileSync(join(dir, `${meta.id}.bin.tmp`), content, { mode: 0o600 });
      renameSync(join(dir, `${meta.id}.bin.tmp`), join(dir, `${meta.id}.bin`));
      writeFileSync(join(dir, `${meta.id}.json`), JSON.stringify(meta), { mode: 0o600 });
    } catch {
      throw new MailComposeError("storage");
    }
    return meta;
  }

  private sweepStaged(dir: string): void {
    sweepDir(dir);
  }

  readStaged(
    accountId: string,
    id: string
  ): { meta: MailStagedAttachment; content: Buffer } | null {
    if (!MAIL_STAGED_ID_PATTERN.test(id)) return null;
    const dir = this.stagedDir(accountId);
    try {
      const meta = MailStagedAttachmentSchema.parse(
        JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"))
      );
      const content = readFileSync(join(dir, `${id}.bin`));
      return content.byteLength === meta.size ? { meta, content } : null;
    } catch {
      return null;
    }
  }

  deleteStaged(accountId: string, ids: string[]): void {
    let dir: string;
    try {
      dir = this.stagedDir(accountId);
    } catch {
      return;
    }
    for (const id of ids) {
      if (!MAIL_STAGED_ID_PATTERN.test(id)) continue;
      rmSync(join(dir, `${id}.json`), { force: true });
      rmSync(join(dir, `${id}.bin`), { force: true });
    }
  }

  // ---- building the message --------------------------------------------------

  /** Validate the draft and build the message. `forSend` additionally requires a recipient. */
  async build(
    a: MailAccount,
    draft: MailComposeDraft,
    forSend: boolean
  ): Promise<ComposedMail & { staged: string[] }> {
    const lists: Record<"to" | "cc" | "bcc", OutAddress[]> = { to: [], cc: [], bcc: [] };
    for (const field of ["to", "cc", "bcc"] as const) {
      const parsed = parseRecipients(draft[field]);
      if (!parsed.ok) throw new MailComposeError("invalid_recipient");
      lists[field] = parsed.list;
    }
    if (forSend && lists.to.length + lists.cc.length + lists.bcc.length === 0)
      throw new MailComposeError("no_recipients");
    if (new Set(draft.attachments).size !== draft.attachments.length)
      throw new MailComposeError("invalid_input");
    if (draft.attachments.length > MAIL_ATTACHMENT_MAX_COUNT)
      throw new MailComposeError("attachment_too_large");
    const attachments: OutAttachment[] = [];
    let total = 0;
    for (const id of draft.attachments) {
      const got = this.readStaged(a.id, id);
      if (!got) throw new MailComposeError("attachment_missing");
      total += got.meta.size;
      attachments.push({
        filename: got.meta.filename,
        contentType: got.meta.contentType,
        content: got.content,
      });
    }
    if (total > MAIL_ATTACHMENT_TOTAL_MAX_BYTES) throw new MailComposeError("attachment_too_large");
    const composed = await composeMail({
      from: { name: a.displayName, address: a.address },
      ...lists,
      subject: draft.subject,
      text: draft.text,
      messageId: draft.messageId,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      attachments,
    });
    return { ...composed, staged: draft.attachments };
  }

  // ---- drafts ------------------------------------------------------------------

  /** Save (create or replace) the draft in the server's Drafts folder. */
  async saveDraft(accountId: string, draft: MailComposeDraft): Promise<MailSaveDraftResponse> {
    const a = this.account(accountId);
    const built = await this.build(a, draft, false);
    const t = await this.imapTarget(a);
    const r = await this.withDraftLock(a.id, draft.messageId, () => {
      // A draft in its undo window is frozen: an edit saved now could outlive (or replace) the version being sent.
      this.refuseIfSending(a.id, draft.messageId);
      return this.deps.outgoing.saveDraft(t, { raw: built.raw, messageId: draft.messageId });
    });
    if (!r.ok) throw new MailComposeError(r.code);
    return {
      messageId: draft.messageId,
      savedAt: new Date().toISOString(),
      folder: r.value.folder,
      uid: r.value.uid,
    };
  }

  /** Remove the draft from Drafts and drop its staged attachments. */
  async discardDraft(accountId: string, messageId: string, staged: string[]): Promise<void> {
    if (!isMailMessageId(messageId)) throw new MailComposeError("invalid_input");
    const a = this.account(accountId);
    const t = await this.imapTarget(a);
    const r = await this.withDraftLock(a.id, messageId, () => {
      this.refuseIfSending(a.id, messageId);
      return this.deps.outgoing.deleteDraft(t, { messageId });
    });
    if (!r.ok) throw new MailComposeError(r.code);
    this.deleteStaged(a.id, staged);
  }

  // ---- initial content ----------------------------------------------------------

  private async fetchSource(
    a: MailAccount,
    req: { folder: string; uid: number; uidValidity?: number | undefined }
  ) {
    const t = await this.imapTarget(a);
    const r = await this.deps.mailbox.openMessage(t, {
      folder: req.folder,
      uid: req.uid,
      uidValidity: req.uidValidity,
      wantSource: true,
      markSeen: false,
      maxBytes: this.deps.maxMessageBytes ?? READ_MAX,
    });
    if (!r.ok) throw new MailComposeError(r.code);
    if (!r.value.source) throw new MailComposeError("message_not_found");
    try {
      return await parseMailSource(r.value.source);
    } catch {
      throw new MailComposeError("protocol_error");
    }
  }

  /** Stage the visible (non-inline) attachments of a fetched message, up to the per-message caps. */
  private stageAll(
    a: MailAccount,
    list: {
      filename: string;
      contentType: string;
      size: number;
      inline: boolean;
      content: Uint8Array;
    }[]
  ): MailStagedAttachment[] {
    const out: MailStagedAttachment[] = [];
    let total = 0;
    for (const f of list.filter((x) => !x.inline).slice(0, MAIL_ATTACHMENT_MAX_COUNT)) {
      total += f.size;
      if (total > MAIL_ATTACHMENT_TOTAL_MAX_BYTES) break;
      out.push(this.stage(a.id, f.filename, f.contentType, f.content));
    }
    return out;
  }

  async init(accountId: string, req: MailComposeInitRequest): Promise<MailComposeInitResponse> {
    const a = this.account(accountId);
    const p = await this.fetchSource(a, req);
    const locale = req.locale === "zh-CN" ? "zh-CN" : "en";
    const bodyText = p.text ?? (p.html ? htmlToText(p.html) : "");
    const origId = p.messageId ? `<${p.messageId}>` : null;
    const validOrig = origId && isMailMessageId(origId) ? origId : null;
    const fmt = (list: { name: string; address: string }[]) => list.map(formatAddress).join(", ");
    const self = normalise(a.address);
    const fresh = this.newMessageId(a);
    const draft: MailComposeDraft = {
      messageId: fresh,
      inReplyTo: null,
      references: [],
      to: "",
      cc: "",
      bcc: "",
      subject: "",
      text: "",
      attachments: [],
    };
    let attachments: MailStagedAttachment[] = [];

    if (req.mode === "draft") {
      const id = origId && isMailMessageId(origId) ? origId : fresh;
      if (id !== fresh) this.refuseIfSending(a.id, id);
      Object.assign(draft, {
        messageId: id,
        inReplyTo: p.inReplyTo && isMailMessageId(p.inReplyTo) ? p.inReplyTo : null,
        references: p.references.filter((r) => isMailMessageId(r)).slice(-100),
        to: fmt(p.to),
        cc: fmt(p.cc),
        bcc: fmt(p.bcc),
        subject: p.subject,
        text: bodyText,
      });
      // The draft's own attachments become staged ones, so saving the edited draft keeps them.
      attachments = this.stageAll(a, p.attachments);
      draft.attachments = attachments.map((s) => s.id);
    } else if (req.mode === "forward") {
      const L = FORWARD_LABELS[locale];
      const lines = [
        "",
        "",
        L.head,
        `${L.from}: ${p.from ? formatAddress(p.from) : ""}`,
        `${L.date}: ${whenText(p.date, locale)}`,
        `${L.subject}: ${p.subject}`,
        `${L.to}: ${fmt(p.to)}`,
        ...(p.cc.length > 0 ? [`${L.cc}: ${fmt(p.cc)}`] : []),
        "",
        bodyText,
      ];
      Object.assign(draft, { subject: prefixed(p.subject, "Fwd"), text: lines.join("\n") });
      attachments = this.stageAll(a, p.attachments);
      draft.attachments = attachments.map((s) => s.id);
    } else {
      // reply / replyAll
      const fromSelf = p.from ? normalise(p.from.address) === self : false;
      const primary = fromSelf ? p.to : p.replyTo.length > 0 ? p.replyTo : p.from ? [p.from] : [];
      // Replying to a message we sent ourselves goes to its recipients; we are only left out otherwise.
      const seen = new Set<string>(fromSelf ? [] : [self]);
      const pick = (list: { name: string; address: string }[]) =>
        list.filter((x) => {
          const key = normalise(x.address);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      // The primary recipients are kept even when one of them is us (replying to our own message).
      const to = pick(primary);
      let cc: { name: string; address: string }[] = [];
      if (req.mode === "replyAll") {
        const others = pick(fromSelf ? [] : p.to);
        to.push(...others);
        cc = pick(p.cc);
      }
      const when = whenText(p.date, locale);
      const who = p.from ? formatAddress(p.from) : "";
      Object.assign(draft, {
        to: fmt(to),
        cc: fmt(cc),
        subject: prefixed(p.subject, "Re"),
        inReplyTo: validOrig,
        references: [
          ...(p.references.some((r) => isMailMessageId(r))
            ? p.references.filter((r) => isMailMessageId(r))
            : p.inReplyTo && isMailMessageId(p.inReplyTo)
              ? [p.inReplyTo]
              : []),
          ...(validOrig ? [validOrig] : []),
        ].slice(-100),
        text: `\n\n${WROTE[locale](when, who)}\n${quote(bodyText)}\n`,
      });
    }
    return { draft, attachments };
  }
}
