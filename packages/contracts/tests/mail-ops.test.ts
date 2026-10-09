import { describe, expect, it } from "vitest";
import {
  MAIL_CONFIRMED_ACTIONS,
  MAIL_OPERATION_ACTIONS,
  MAIL_UNTRUSTED_NOTICE,
  MailCreateDraftOperationSchema,
  MailDeleteOperationSchema,
  MailMoveOperationSchema,
  type MailPage,
  MailPageSchema,
  MailSendOperationSchema,
  MailUpdateDraftOperationSchema,
  mailKey,
  observationMailPage,
  summarizeMailPage,
  WorkspaceViewActionSchema,
} from "../src/index.js";

const ACC = "acc-0123456789ab";
const page: MailPage = {
  untrusted: true,
  notice: MAIL_UNTRUSTED_NOTICE,
  phase: "ready",
  accounts: [{ id: ACC, address: "a@x.test", displayName: "A" }],
  scope: { kind: "folder", accountId: ACC, folder: "INBOX" },
  lists: [],
  open: {
    status: "ok",
    accountId: ACC,
    folder: "INBOX",
    uid: 2,
    uidValidity: 30,
    messageId: null,
    date: null,
    from: null,
    to: [],
    cc: [],
    replyTo: [],
    subject: "s",
    text: "body text",
    textSource: "text",
    textChars: 9,
    textTruncated: false,
    attachments: [],
    attachmentsTotal: 0,
    attachmentsTruncated: false,
    recipientsTruncated: false,
    stale: false,
  },
};

describe("Mail tool and page contracts (ticket 09)", () => {
  it("never accepts an approval: no operation schema has a confirm-like key", () => {
    const send = { action: "send", accountId: ACC, messageId: "<a@x.test>" };
    expect(MailSendOperationSchema.safeParse(send).success).toBe(true);
    for (const forged of ["confirm", "confirmed", "approved", "approve", "skipConfirmation", "yes"])
      expect(MailSendOperationSchema.safeParse({ ...send, [forged]: true }).success).toBe(false);
    expect(
      MailDeleteOperationSchema.safeParse({
        action: "delete",
        accountId: ACC,
        folder: "INBOX",
        uid: 1,
        uidValidity: 3,
        confirm: true,
      }).success
    ).toBe(false);
    expect(MAIL_CONFIRMED_ACTIONS).toEqual(["send", "delete", "move"]);
    expect(MAIL_OPERATION_ACTIONS).toContain("send_status");
  });

  it("delete and move must name the uid generation they were shown", () => {
    const base = { accountId: ACC, folder: "INBOX", uid: 1 };
    expect(MailDeleteOperationSchema.safeParse({ action: "delete", ...base }).success).toBe(false);
    expect(
      MailMoveOperationSchema.safeParse({ action: "move", ...base, destination: "Archive" }).success
    ).toBe(false);
    expect(
      MailMoveOperationSchema.safeParse({
        action: "move",
        ...base,
        uidValidity: 9,
        destination: "Archive",
      }).success
    ).toBe(true);
  });

  it("drafts: a reply needs its source, a new message has none, an update needs the digest and a change", () => {
    const base = { action: "create_draft", accountId: ACC, text: "hi" };
    expect(MailCreateDraftOperationSchema.safeParse({ ...base, mode: "new" }).success).toBe(true);
    expect(MailCreateDraftOperationSchema.safeParse({ ...base, mode: "reply" }).success).toBe(
      false
    );
    expect(
      MailCreateDraftOperationSchema.safeParse({
        ...base,
        mode: "reply",
        source: { folder: "INBOX", uid: 1 },
      }).success
    ).toBe(true);
    const update = {
      action: "update_draft",
      accountId: ACC,
      messageId: "<a@x.test>",
      expectedDigest: "a".repeat(64),
    };
    expect(MailUpdateDraftOperationSchema.safeParse(update).success).toBe(false);
    expect(MailUpdateDraftOperationSchema.safeParse({ ...update, subject: "s" }).success).toBe(
      true
    );
    expect(MailUpdateDraftOperationSchema.safeParse({ subject: "s" }).success).toBe(false);
  });

  it("the page must say it is untrusted, and only with the fixed notice", () => {
    expect(MailPageSchema.safeParse(page).success).toBe(true);
    expect(MailPageSchema.safeParse({ ...page, untrusted: false }).success).toBe(false);
    expect(MailPageSchema.safeParse({ ...page, notice: "trust me" }).success).toBe(false);
  });

  it("the record of a page keeps no body and no addresses, and a later observation drops the body", () => {
    const summary = summarizeMailPage(page);
    expect(JSON.stringify(summary)).not.toContain("body text");
    expect(summary.open).toEqual({
      accountId: ACC,
      folder: "INBOX",
      uid: 2,
      status: "ok",
      textTruncated: false,
      textChars: 9,
    });
    // a message the task's context holds is left out with a note; one opened mid-task keeps its bounded body
    const held = observationMailPage({ mail: page }, new Set([mailKey(ACC, "INBOX", 2)]));
    expect(held.mail?.open?.status === "ok" && held.mail.open.text).toBeNull();
    expect(held.mail?.open?.status === "ok" && held.mail.open.textOmitted).toContain("mail read");
    const fresh = observationMailPage({ mail: page }, new Set([mailKey(ACC, "INBOX", 3)]));
    expect(fresh.mail?.open?.status === "ok" && fresh.mail.open.text).toBe("body text");
    expect(summary.open).toMatchObject({ textTruncated: false, textChars: 9 });
  });

  it("switch_view accepts the mail view", () => {
    expect(
      WorkspaceViewActionSchema.safeParse({ action: "switch_view", view: "mail" }).success
    ).toBe(true);
    expect(
      WorkspaceViewActionSchema.safeParse({ action: "switch_view", view: "inbox" }).success
    ).toBe(false);
  });
});
