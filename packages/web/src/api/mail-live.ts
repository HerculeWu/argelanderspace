import type { MailUnreadSummary } from "@argelanderspace/contracts";

/** The sidebar badge numbers (INBOX unread per account plus the watch state). */
export async function fetchMailUnread(signal?: AbortSignal): Promise<MailUnreadSummary> {
  const response = await fetch("/api/mail/unread", { cache: "no-store", signal });
  if (!response.ok) throw new Error("unavailable");
  return (await response.json()) as MailUnreadSummary;
}
