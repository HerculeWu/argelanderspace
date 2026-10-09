import {
  MAIL_ATTACHMENT_MAX_COUNT,
  MAIL_CONTEXT_ACCOUNTS_MAX,
  MAIL_CONTEXT_HEADER_TO_MAX,
  MAIL_CONTEXT_HEADERS_MAX,
  MAIL_CONTEXT_RECIPIENTS_MAX,
  MAIL_CONTEXT_TEXT_MAX,
  MAIL_UNTRUSTED_NOTICE,
  type MailAccount,
  type MailHeader,
  type MailMessage,
  type MailPage,
} from "@argelanderspace/contracts";

/** The slice of the Mail page's state the Copilot is told about (Mail ticket 09). */
export interface MailContextInput {
  accounts: MailAccount[] | null;
  accountsError: boolean;
  /** The lists are still being asked for (nothing shown yet): the page is not complete. */
  listsPending?: boolean;
  scope: { kind: "unified" } | { kind: "folder"; accountId: string; path: string };
  /** The lists the page shows now (the folder, the unified inboxes, or the search results). */
  lists: {
    accountId: string;
    folder: string;
    headers: MailHeader[];
    uidValidity: number | null;
    nextBefore: number | null;
    stale: boolean;
  }[];
  opened:
    | { ref: { accountId: string; folder: string; uid: number }; status: "loading" }
    | { ref: { accountId: string; folder: string; uid: number }; status: "error"; code: string }
    | { ref: { accountId: string; folder: string; uid: number }; status: "ok"; message: MailMessage; stale: boolean }
    | null;
}

/** Text of an HTML-only message: its text content, never executed (DOMParser builds an inert document). */
export function htmlText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const node of Array.from(doc.querySelectorAll("script,style,head,template"))) node.remove();
    return (doc.body.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}

export function buildMailPage(input: MailContextInput): MailPage {
  const phase = input.accountsError
    ? "error"
    : input.accounts === null
      ? "loading"
      : input.accounts.length === 0
        ? "no_accounts"
        : input.listsPending
          ? "loading"
          : "ready";
  const open: MailPage["open"] = (() => {
    const o = input.opened;
    if (!o) return null;
    if (o.status === "loading") return { status: "loading", ...o.ref };
    if (o.status === "error") return { status: "error", ...o.ref, code: o.code.slice(0, 100) };
    const m = o.message;
    const own = m.text !== null && m.text.trim() !== "";
    const full = own ? (m.text as string) : m.html ? htmlText(m.html) : "";
    const truncated = full.length > MAIL_CONTEXT_TEXT_MAX;
    let text = truncated ? full.slice(0, MAIL_CONTEXT_TEXT_MAX) : full;
    // never end on half of a surrogate pair
    if (truncated && (text.charCodeAt(text.length - 1) & 0xfc00) === 0xd800) text = text.slice(0, -1);
    return {
      status: "ok",
      ...o.ref,
      uidValidity: m.uidValidity,
      messageId: m.messageId,
      date: m.date,
      from: m.from,
      // Outside senders choose how many recipients and attachments there are: a bounded part is kept and said so.
      to: m.to.slice(0, MAIL_CONTEXT_RECIPIENTS_MAX),
      cc: m.cc.slice(0, MAIL_CONTEXT_RECIPIENTS_MAX),
      replyTo: m.replyTo.slice(0, MAIL_CONTEXT_RECIPIENTS_MAX),
      recipientsTruncated: [m.to, m.cc, m.replyTo].some((l) => l.length > MAIL_CONTEXT_RECIPIENTS_MAX),
      subject: m.subject,
      text: full === "" ? null : text,
      textSource: full === "" ? null : own ? "text" : "html",
      textChars: full.length,
      textTruncated: truncated,
      attachments: m.attachments.slice(0, MAIL_ATTACHMENT_MAX_COUNT),
      attachmentsTotal: m.attachments.length,
      attachmentsTruncated: m.attachments.length > MAIL_ATTACHMENT_MAX_COUNT,
      stale: o.stale,
    };
  })();
  return {
    untrusted: true,
    notice: MAIL_UNTRUSTED_NOTICE,
    phase,
    ...(input.accounts && input.accounts.length > MAIL_CONTEXT_ACCOUNTS_MAX ? { accountsTruncated: true } : {}),
    ...(input.lists.length > 50 ? { listsTruncated: true } : {}),
    accounts: (input.accounts ?? []).slice(0, MAIL_CONTEXT_ACCOUNTS_MAX).map((a) => ({
      id: a.id,
      address: a.address,
      displayName: a.displayName,
    })),
    scope:
      input.scope.kind === "folder"
        ? { kind: "folder", accountId: input.scope.accountId, folder: input.scope.path }
        : { kind: "unified" },
    lists: input.lists.slice(0, 50).map((l) => ({
      accountId: l.accountId,
      folder: l.folder,
      uidValidity: l.uidValidity,
      headers: l.headers.slice(0, MAIL_CONTEXT_HEADERS_MAX).map((h) => ({
        ...h,
        to: h.to.slice(0, MAIL_CONTEXT_HEADER_TO_MAX),
        ...(h.to.length > MAIL_CONTEXT_HEADER_TO_MAX ? { toTruncated: true } : {}),
      })),
      loaded: l.headers.length,
      hasMore: l.nextBefore !== null,
      stale: l.stale,
    })),
    open,
  };
}
