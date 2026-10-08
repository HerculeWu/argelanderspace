/**
 * RFC 822 source -> display structure (Mail ticket 05). postal-mime does the
 * MIME work; this module only flattens its result into the shapes the server
 * caches and serves. Nothing here sanitises HTML: that is the web client's job
 * and `html` stays untrusted until then.
 */

import PostalMime, { type Address, type Mailbox } from "postal-mime";

export interface ParsedAddress {
  name: string;
  address: string;
}
export interface ParsedAttachment {
  /** Index among all attachments of this source. */
  part: number;
  filename: string;
  contentType: string;
  size: number;
  /** Content-ID without angle brackets. */
  contentId: string | null;
  inline: boolean;
  content: Uint8Array;
}
export interface ParsedMail {
  messageId: string | null;
  subject: string;
  date: string | null;
  from: ParsedAddress | null;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  replyTo: ParsedAddress[];
  text: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
}

const mailbox = (m: Mailbox): ParsedAddress => ({ name: m.name ?? "", address: m.address ?? "" });
function flatten(list: Address[] | undefined): ParsedAddress[] {
  const out: ParsedAddress[] = [];
  for (const a of list ?? []) {
    if (a.group) out.push(...a.group.map(mailbox));
    else out.push(mailbox(a));
  }
  return out;
}

function isoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const stripBrackets = (id: string) => id.replace(/^<|>$/g, "").trim();

export async function parseMailSource(source: Uint8Array): Promise<ParsedMail> {
  const email = await PostalMime.parse(source);
  const from = flatten(email.from ? [email.from] : undefined)[0] ?? null;
  const attachments: ParsedAttachment[] = email.attachments.map((a, part) => {
    const content =
      typeof a.content === "string"
        ? new TextEncoder().encode(a.content)
        : a.content instanceof Uint8Array
          ? a.content
          : new Uint8Array(a.content);
    const contentId = a.contentId ? stripBrackets(a.contentId) : null;
    return {
      part,
      filename: a.filename ?? "",
      contentType: a.mimeType || "application/octet-stream",
      size: content.byteLength,
      contentId: contentId || null,
      // Shown inside the HTML body (a cid: reference), not listed as a file.
      inline:
        a.related === true || (a.disposition === "inline" && contentId !== null && !a.filename),
      content,
    };
  });
  return {
    messageId: email.messageId ? stripBrackets(email.messageId) : null,
    subject: email.subject ?? "",
    date: isoDate(email.date),
    from,
    to: flatten(email.to),
    cc: flatten(email.cc),
    replyTo: flatten(email.replyTo),
    text: email.text ?? null,
    html: email.html ?? null,
    attachments,
  };
}
