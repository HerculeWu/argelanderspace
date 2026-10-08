import type { TFunction } from "i18next";

export type FailureKind = "unknown" | "gone" | "partial" | "failed";

/**
 * How a failed management call must be worded.
 * - `unknown`: the connection broke (or the service answered unreadably), so the change may or may not have
 *   happened and nothing may claim either.
 * - `gone`: the message is no longer there.
 * - `partial`: a copy exists in the destination and the original is still here: the state is KNOWN.
 * - `failed`: the server answered and refused, so nothing changed.
 */
export const failureKind = (code: string): FailureKind =>
  code === "connection_lost" || code === "unreachable" || code === "unavailable"
    ? "unknown"
    : code === "partial"
      ? "partial"
      : code === "message_not_found"
        ? "gone"
        : "failed";

/** Localised reason for a failed management call: specific text first, then the shared mail one. */
export const manageReason = (t: TFunction, code: string): string =>
  t(`mail.manage.error.${code}`, {
    defaultValue: t(`mail.error.${code}`, { defaultValue: t("mail.error.unknown") }),
  });

/** Reason for a failed search: it never "changes" anything, so it has its own wording. */
export const searchReason = (t: TFunction, code: string): string =>
  t(`mail.search.error.${code}`, {
    defaultValue: t(`mail.error.${code}`, { defaultValue: t("mail.error.unknown") }),
  });
