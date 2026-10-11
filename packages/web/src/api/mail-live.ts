import type { MailUnreadSummary } from "@argelanderspace/contracts";
import { apiRequest, HttpError, underlyingError } from "./request";

/** The sidebar badge numbers (INBOX unread per account plus the watch state). */
export async function fetchMailUnread(signal?: AbortSignal): Promise<MailUnreadSummary> {
  try {
    return await apiRequest<MailUnreadSummary>("/api/mail/unread", { cache: "no-store" }, { signal });
  } catch (e) {
    if (e instanceof HttpError && e.status > 0) throw new Error("unavailable");
    throw underlyingError(e);
  }
}
