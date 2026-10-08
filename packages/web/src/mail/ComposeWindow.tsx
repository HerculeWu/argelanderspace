import {
  estimateMailWireBytes,
  MAIL_PROVIDER_LIMIT_BYTES,
  type MailAccount,
  type MailComposeDraft,
  type MailStagedAttachment,
} from "@argelanderspace/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { Button, Dialog, IconButton, InlineMessage } from "../ui";
import { fileSize } from "./format";
import "./compose.css";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward" | "draft";
export type SaveState = "idle" | "saving" | "saved" | "failed";

export interface ComposeState {
  /** Identity of this composer instance: a send reports back to exactly this one, never to another window. */
  uid: string;
  mode: ComposeMode;
  accountId: string;
  draft: MailComposeDraft;
  attachments: MailStagedAttachment[];
  /** The draft object the server last confirmed (null: none yet). Anything else is an unsaved edit. */
  savedDraft: MailComposeDraft | null;
  /** File names being uploaded right now. */
  uploading: string[];
  showCc: boolean;
  minimized: boolean;
  save: SaveState;
  savedAt: string | null;
  /** The account whose server Drafts folder holds the saved copy, if any. */
  savedOn: string | null;
  /** The user changed something: only then is the draft saved to the server. */
  touched: boolean;
  /** Why the last draft save failed (machine code), for the state line. */
  saveCode?: string | null;
  /** Machine code of the last send/attachment failure, shown inside the window. */
  error: string | null;
  /** Free text for a failure that has a name (e.g. a file too large). */
  errorName: string | null;
  sending: boolean;
  /**
   * A send of this window whose answer never arrived (the request may or may not have reached the
   * server). Before sending again its status is asked, so it can be joined instead of sent twice.
   */
  unconfirmed: { accountId: string; sendId: string; sig: string } | null;
  /**
   * This Message-ID already went out (the server said so). It can no longer be sent or saved; closing is
   * free and "Copy as new message" keeps the text. `sentCopy` "failed"/null: this may be the only record.
   */
  sent: {
    sentCopy: "saved" | "by_server" | "failed" | null;
    /** Its attachments were staged afresh from the Drafts copy (still usable for a copy). */
    restaged?: boolean;
  } | null;
}

export interface ComposeWindowProps {
  state: ComposeState;
  accounts: MailAccount[];
  onChange: (patch: Partial<MailComposeDraft> & { accountId?: string }) => void;
  onShowCc: () => void;
  onMinimize: (minimized: boolean) => void;
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onSend: () => void;
  onClose: () => void;
  /** Resolves to a failure code (the dialog stays open and shows it) or null when the draft is gone. */
  onDiscard: () => Promise<string | null>;
  /** An already-sent message: continue with its text as a new message (new Message-ID). */
  onCopyNew: () => void;
}

const PROVIDER_NAME: Record<string, string> = { gmail: "Gmail", icloud: "iCloud" };

export function ComposeWindow(p: ComposeWindowProps) {
  const { t } = useTranslation();
  const { state: c } = p;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const reply = c.mode === "reply" || c.mode === "replyAll";
  // Focus: the recipient for a new message or a forward, the body (cursor above the quote) for a reply.
  useEffect(() => {
    if (c.minimized) return;
    (reply ? bodyRef : toRef).current?.focus();
  }, [c.minimized, reply]);
  const title = c.draft.subject.trim() || t("mail.compose.newMessage");

  if (c.minimized)
    return (
      <div className="mc-window min" data-ui="mail-composer" data-state="minimized">
        <button className="mc-bar" aria-label={t("mail.compose.restore")} onClick={() => p.onMinimize(false)}>
          <span>{title}</span>
          <Icon name="chevron-up" cls="ico-sm" />
        </button>
      </div>
    );

  const account = p.accounts.find((a) => a.id === c.accountId);
  const total = c.attachments.reduce((n, a) => n + a.size, 0);
  const limit = account ? MAIL_PROVIDER_LIMIT_BYTES[account.preset] : null;
  const wire = estimateMailWireBytes(total, new TextEncoder().encode(c.draft.text).byteLength);
  const overLimit = limit !== null && wire > limit;
  const errorText = c.error
    ? t(`mail.compose.error.${c.error}`, {
        defaultValue: t(`mail.error.${c.error}`, { defaultValue: t("mail.error.unknown") }),
        name: c.errorName ?? "",
        limit: fileSize(40 * 1024 * 1024),
      })
    : null;
  const stateText =
    c.save === "saving"
      ? t("mail.compose.draftSaving")
      : c.save === "saved"
        ? c.savedAt
          ? t("mail.compose.draftSaved", { time: c.savedAt })
          : t("mail.compose.draftOnServer")
        : c.save === "failed"
          ? c.saveCode
            ? `${t("mail.compose.draftFailed")} (${t(`mail.compose.error.${c.saveCode}`, {
                defaultValue: t(`mail.error.${c.saveCode}`, { defaultValue: t("mail.error.unknown") }),
                name: "",
                limit: "",
              })})`
            : t("mail.compose.draftFailed")
          : "";

  return (
    <section className="mc-window" data-ui="mail-composer" role="dialog" aria-label={title}>
      <header className="mc-head">
        <span className="mc-title">{title}</span>
        <IconButton
          unstyled
          className="btn icon ghost"
          data-ui="mail-composer-minimize"
          icon={<Icon name="minus" cls="ico-sm" />}
          label={t("mail.compose.minimize")}
          onClick={() => p.onMinimize(true)}
        />
        <IconButton
          unstyled
          className="btn icon ghost"
          data-ui="mail-composer-close"
          icon={<Icon name="x" cls="ico-sm" />}
          label={t("mail.compose.close")}
          disabled={c.sending}
          onClick={p.onClose}
        />
      </header>
      <div className="mc-fields">
        <label className="mc-field">
          <span>{t("mail.compose.from")}</span>
          <select
            data-ui="mail-composer-from"
            value={c.accountId}
            // While an earlier send's answer is unknown the sender stays fixed (see MailCompose `change`).
            disabled={c.sending || c.unconfirmed !== null}
            onChange={(e) => p.onChange({ accountId: e.target.value })}
          >
            {p.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName} &lt;{a.address}&gt;
              </option>
            ))}
          </select>
        </label>
        <label className="mc-field">
          <span>{t("mail.compose.to")}</span>
          <input
            ref={toRef}
            data-ui="mail-composer-to"
            value={c.draft.to}
            readOnly={c.sending}
            onChange={(e) => p.onChange({ to: e.target.value })}
          />
          {!c.showCc && (
            <button
              type="button"
              className="mail-link"
              data-ui="mail-composer-show-cc"
              onClick={(e) => {
                e.preventDefault();
                p.onShowCc();
              }}
            >
              {t("mail.compose.showCcBcc")}
            </button>
          )}
        </label>
        {c.showCc && (
          <>
            <label className="mc-field">
              <span>{t("mail.compose.cc")}</span>
              <input data-ui="mail-composer-cc" value={c.draft.cc} readOnly={c.sending} onChange={(e) => p.onChange({ cc: e.target.value })} />
            </label>
            <label className="mc-field">
              <span>{t("mail.compose.bcc")}</span>
              <input data-ui="mail-composer-bcc" value={c.draft.bcc} readOnly={c.sending} onChange={(e) => p.onChange({ bcc: e.target.value })} />
            </label>
          </>
        )}
        <label className="mc-field">
          <span>{t("mail.compose.subject")}</span>
          <input
            data-ui="mail-composer-subject"
            value={c.draft.subject}
            readOnly={c.sending}
            onChange={(e) => p.onChange({ subject: e.target.value })}
          />
        </label>
      </div>
      <textarea
        className="mc-body"
        ref={bodyRef}
        data-ui="mail-composer-body"
        aria-label={t("mail.compose.body")}
        onFocus={(e) => {
          // A reply opens with the cursor above the quoted text.
          if (!e.currentTarget.dataset.placed) {
            e.currentTarget.dataset.placed = "1";
            if (c.mode === "reply" || c.mode === "replyAll") e.currentTarget.setSelectionRange(0, 0);
          }
        }}
        value={c.draft.text}
        readOnly={c.sending}
        onChange={(e) => p.onChange({ text: e.target.value })}
      />
      {(c.attachments.length > 0 || c.uploading.length > 0) && (
        <div className="mc-attachments" data-ui="mail-composer-attachments" role="group" aria-label={t("mail.attachments")}>
          {c.attachments.map((a) => (
            <div key={a.id} className="mc-attachment" data-ui="mail-composer-attachment" data-ui-key={a.id}>
              <Icon name="paperclip" cls="ico-sm" />
              <span title={`${a.filename} (${fileSize(a.size)})`}>{a.filename}</span>
              <span className="mc-attachment-size">{fileSize(a.size)}</span>
              <IconButton
                unstyled
                className="btn icon ghost"
                icon={<Icon name="x" cls="ico-sm" />}
                label={t("mail.compose.removeAttachment", { name: a.filename })}
                disabled={c.sending}
                onClick={() => p.onRemoveAttachment(a.id)}
              />
            </div>
          ))}
          {c.uploading.map((name) => (
            <div key={`up:${name}`} className="mc-attachment" role="status">
              <Icon name="loader-circle" cls="ico-sm mail-spin" />
              <span>{t("mail.compose.uploading", { name })}</span>
            </div>
          ))}
        </div>
      )}
      {c.attachments.length > 0 && (
        <div className="mc-size" data-ui="mail-composer-size">
          {overLimit && limit !== null && account ? (
            <InlineMessage tone="warning">
              {t("mail.compose.sizeWarn", {
                size: fileSize(wire),
                provider: PROVIDER_NAME[account.preset] ?? account.displayName,
                limit: fileSize(limit),
              })}
            </InlineMessage>
          ) : (
            <span>{t("mail.compose.attachmentsInfo", { count: c.attachments.length, size: fileSize(total) })}</span>
          )}
        </div>
      )}
      {c.sent && (
        <div className="mc-error" data-ui="mail-composer-sent">
          <InlineMessage tone="warning">{t("mail.compose.sentBanner")}</InlineMessage>
          <Button data-ui="mail-composer-copy-new" onClick={p.onCopyNew}>
            {t("mail.compose.copyNew")}
          </Button>
        </div>
      )}
      {errorText && (
        <div className="mc-error" data-ui="mail-composer-error">
          {/* Waiting for an upload, or attachments to add again, is not a failure. */}
          <InlineMessage tone={c.error === "uploading" || c.error === "attachments_readd" ? "warning" : "danger"}>
            {errorText}
          </InlineMessage>
        </div>
      )}
      <footer className="mc-foot">
        <Button
          appearance="primary"
          data-ui="mail-composer-send"
          busy={c.sending}
          busyLabel={t("mail.compose.sendBusy")}
          disabled={c.sent !== null}
          onClick={p.onSend}
        >
          <Icon name="send" cls="ico-sm" />
          {t("mail.compose.send")}
        </Button>
        <IconButton
          unstyled
          className="btn icon ghost"
          data-ui="mail-composer-attach"
          icon={<Icon name="paperclip" cls="ico-sm" />}
          label={t("mail.compose.attach")}
          disabled={c.sending}
          onClick={() => fileRef.current?.click()}
        />
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          data-ui="mail-composer-file"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length > 0) p.onAttach(files);
          }}
        />
        <span
          className={"mc-draft-state" + (c.save === "failed" ? " danger" : "")}
          role="status"
          data-ui="mail-composer-draft-state"
          title={stateText}
        >
          {stateText}
        </span>
        <IconButton
          unstyled
          className="btn icon ghost"
          data-ui="mail-composer-discard"
          icon={<Icon name="trash-2" cls="ico-sm" />}
          label={t("mail.compose.discard")}
          disabled={c.sending}
          onClick={() => setConfirmDiscard(true)}
        />
      </footer>
      {confirmDiscard && (
        <Dialog
          title={t("mail.compose.discardTitle")}
          uiId="mail-composer-discard-dialog"
          closeLabel={t("mail.compose.close")}
          busy={discarding}
          onClose={() => {
            if (discarding) return;
            setConfirmDiscard(false);
            setDiscardError(null);
          }}
          initialFocusRef={cancelRef as React.RefObject<HTMLElement>}
          footer={
            <>
              <Button
                ref={cancelRef}
                disabled={discarding}
                onClick={() => {
                  setConfirmDiscard(false);
                  setDiscardError(null);
                }}
              >
                {t("mail.compose.cancel")}
              </Button>
              <Button
                appearance="primary"
                tone="danger"
                data-ui="mail-composer-discard-confirm"
                busy={discarding}
                busyLabel={t("mail.compose.discarding")}
                onClick={() => {
                  setDiscarding(true);
                  setDiscardError(null);
                  void p.onDiscard().then((code) => {
                    setDiscarding(false);
                    if (code) setDiscardError(code); // the draft is still on the server: stay and say why
                    else setConfirmDiscard(false);
                  });
                }}
              >
                {t("mail.compose.discard")}
              </Button>
            </>
          }
        >
          {c.sent ? (
            // Deleting the leftover of a sent message: say whether it is the only record of what was sent.
            c.sent.sentCopy === "saved" || c.sent.sentCopy === "by_server" ? (
              <p>{t("mail.compose.discardSent")}</p>
            ) : (
              <div data-ui="mail-composer-discard-only-record">
                <InlineMessage tone="danger">
                  {c.sent.sentCopy === "failed"
                    ? t("mail.compose.discardSentOnly")
                    : t("mail.compose.discardSentMaybeOnly")}
                </InlineMessage>
              </div>
            )
          ) : (
            <p>{c.savedOn ? t("mail.compose.discardBody") : t("mail.compose.discardBodyLocal")}</p>
          )}
          {discardError && (
            <div data-ui="mail-composer-discard-error">
              <InlineMessage tone="danger">
                {t(`mail.compose.error.${discardError}`, {
                  defaultValue: t(`mail.error.${discardError}`, { defaultValue: t("mail.error.unknown") }),
                  name: "",
                  limit: "",
                })}
              </InlineMessage>
            </div>
          )}
        </Dialog>
      )}
    </section>
  );
}
