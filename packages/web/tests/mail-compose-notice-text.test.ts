/**
 * Copilot ticket 41: the compose session raises notice events; the page words them at render time, so the same event
 * reads in the language that is current when it is shown (a language switch rewords notices already on screen).
 * The wording is the one the page used before the events (same keys, same "no subject" and reason fallbacks).
 */
import { expect, test } from "vitest";
import i18n from "../src/i18n";
import type { NoticeEvent } from "../src/mail/compose-session";
import { noticeText } from "../src/mail/MailCompose";

const ev = (kind: NoticeEvent["kind"], params: NoticeEvent["params"] = {}): NoticeEvent => ({
  id: 1,
  tone: "warning",
  kind,
  params,
});

test("the same event reads in English and in Chinese", () => {
  const e = ev("restoreFailed", { subject: "Hello", code: "recipient_rejected" });
  const en = noticeText(i18n.getFixedT("en"), e);
  const zh = noticeText(i18n.getFixedT("zh-CN"), e);
  expect(en).toBe(
    i18n.getFixedT("en")("mail.compose.restoreFailed", {
      subject: "Hello",
      reason: i18n.getFixedT("en")("mail.compose.error.recipient_rejected", { name: "", limit: "" }),
    })
  );
  expect(en).toMatch(/^“Hello” was not sent: /);
  expect(zh).not.toBe(en);
  expect(zh).toContain("Hello");
});

test("an empty subject reads as 'no subject'; an unknown code falls back to the generic reason", () => {
  const t = i18n.getFixedT("en");
  expect(noticeText(t, ev("unknown", { subject: "" }))).toBe(t("mail.compose.unknown", { subject: t("mail.noSubject") }));
  expect(noticeText(t, ev("error", { code: "something_new" }))).toBe(t("mail.error.unknown"));
  expect(noticeText(t, ev("initFailed", { code: "unreachable" }))).toBe(
    `${t("mail.compose.initFailed")} ${t("mail.compose.error.unreachable", { name: "", limit: "" })}`
  );
});

test("sent warnings join in the order the page always used", () => {
  const t = i18n.getFixedT("en");
  expect(noticeText(t, ev("sentWarnings", { noCopy: true, draftKept: false, rejected: 2 }))).toBe(
    `${t("mail.compose.sentNoCopy")} ${t("mail.compose.rejectedSome", { n: 2 })}`
  );
  expect(noticeText(t, ev("sentWarnings", { noCopy: false, draftKept: true, rejected: 0 }))).toBe(
    t("mail.compose.sentDraftKept")
  );
});

test("every notice kind has wording in both languages (no raw key leaks)", () => {
  const kinds: NoticeEvent["kind"][] = [
    "initReady", "initFailed", "attachmentDropped", "error", "undone", "restoreFailed", "restoreUndone", "sentNamed",
    "sentWarnings", "interrupted", "unknown", "statusLost", "earlierAccepted", "ownedElsewhere", "tooLate",
    "leftAttachment", "leftAttachmentFailed", "leftSentEdits", "leftNotSentSaved", "leftNotSent", "leftUnknown",
    "leftUnsaved",
  ];
  for (const lng of ["en", "zh-CN"]) {
    const t = i18n.getFixedT(lng);
    for (const k of kinds) {
      const text = noticeText(t, ev(k, { subject: "S", code: "unreachable", name: "f.pdf", rejected: 1, noCopy: true }));
      expect(text, `${lng} ${k}`).not.toMatch(/mail\.(compose|error)\./);
      expect(text.length, `${lng} ${k}`).toBeGreaterThan(0);
    }
  }
});
