/**
 * Writing, sending and the 8 second undo (Mail ticket 07). Three pieces share one provider mounted by
 * MailView: the floating composer, the undo countdowns at the bottom of the page, and the reply /
 * forward actions of the open message. What they show and do is the page's compose session
 * (compose-session.ts, Copilot ticket 41); this file only creates it with the page, subscribes, and words
 * its notices in the current language (switching the language rewords notices already shown).
 */

import type { MailAccount, MailComposeDraft, MailMessage } from "@argelanderspace/contracts";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import * as composeApi from "../api/mail-compose";
import { Icon } from "../lib/icons";
import { ActionButton, Button, Dialog, IconButton } from "../ui";
import {
  browserComposeClock,
  type ComposeSession,
  createComposeSession,
  type NoticeEvent,
  type Pending,
  sessionLeftStore,
  uuid,
} from "./compose-session";
import { type ComposeState, ComposeWindow } from "./ComposeWindow";
import { browserSendTrackerDeps, createSendTracker, MAIL_PAGE_SEND_POLICY, type SendTracker } from "./send-tracker";
import "./compose.css";

export type { LeftBehind } from "./compose-session";
export { uuid };

export interface Notice {
  id: number;
  tone: "info" | "warning" | "danger";
  text: string;
  action?: { label: string; run: (id: number) => void };
  /** Server marker to forget when the user closes this notice. */
  forget?: { accountId: string; sendId: string };
  /** The tab-kept record this notice offers. */
  left?: { uid: string; rev?: string; holdsText: boolean };
  autoCloseMs?: number;
}

export interface MailComposeApi {
  startNew(): void;
  startFrom(mode: "reply" | "replyAll" | "forward", message: MailMessage): void;
  editDraft(message: MailMessage): void;
  busy: boolean;
  canCompose: boolean;
  isDraftsFolder(accountId: string, folder: string): boolean;
}

const Ctx = createContext<MailComposeApi | null>(null);
const LayerCtx = createContext<{
  compose: ComposeState | null;
  pendings: Pending[];
  now: number;
  notices: Notice[];
  actions: {
    change: (patch: Partial<MailComposeDraft> & { accountId?: string }) => void;
    showCc: () => void;
    minimize: (v: boolean) => void;
    attach: (files: File[]) => void;
    removeAttachment: (id: string) => void;
    send: () => void;
    close: () => void;
    discard: () => Promise<string | null>;
    undo: (sendId: string) => void;
    closeNotice: (id: number, confirmed?: boolean) => void;
    copyNew: () => void;
    cancelDrop: () => void;
    dropLeft: (uid: string) => void;
  };
  confirmDrop: string | null;
  accounts: MailAccount[];
} | null>(null);

export const useMailCompose = () => useContext(Ctx);

export interface MailComposeProviderProps {
  accounts: MailAccount[];
  /** Account ids that can currently send (logged in). */
  sendableIds: string[];
  /** Show the Drafts folder of this account. */
  onOpenDrafts: (accountId: string) => void;
  /** Something changed on the server (a send finished, a draft changed): refresh the lists. */
  onChanged: () => void;
  isDraftsFolder: (accountId: string, folder: string) => boolean;
  children: ReactNode;
}

/** A notice event in the current language. */
export function noticeText(t: TFunction, n: NoticeEvent): string {
  const errText = (code: string | null | undefined) =>
    t(`mail.compose.error.${code}`, {
      defaultValue: t(`mail.error.${code}`, { defaultValue: t("mail.error.unknown") }),
      name: "",
      limit: "",
    });
  const p = n.params;
  const subject = p.subject || t("mail.noSubject");
  const reason = p.code ? errText(p.code) : "";
  const name = p.name ?? "";
  switch (n.kind) {
    case "initReady":
      return t("mail.compose.initReady", { subject });
    case "initFailed":
      return `${t("mail.compose.initFailed")} ${errText(p.code)}`;
    case "error":
      return errText(p.code);
    case "undone":
      return t("mail.compose.undone");
    case "ownedElsewhere":
      return t("mail.compose.ownedElsewhere");
    case "tooLate":
      return t("mail.compose.tooLate");
    case "attachmentDropped":
      return t("mail.compose.attachmentDropped", { name });
    case "restoreFailed":
      return t("mail.compose.restoreFailed", { subject, reason });
    case "restoreUndone":
      return t("mail.compose.restoreUndone", { subject });
    case "sentNamed":
      return t("mail.compose.sentNamed", { subject });
    case "sentWarnings": {
      const warnings: string[] = [];
      if (p.noCopy) warnings.push(t("mail.compose.sentNoCopy"));
      else if (p.draftKept) warnings.push(t("mail.compose.sentDraftKept"));
      if ((p.rejected ?? 0) > 0) warnings.push(t("mail.compose.rejectedSome", { n: p.rejected }));
      return warnings.join(" ");
    }
    case "interrupted":
      return t("mail.compose.interrupted", { subject });
    case "unknown":
      return t("mail.compose.unknown", { subject });
    case "statusLost":
      return t("mail.compose.statusLost", { subject });
    case "earlierAccepted":
      return t("mail.compose.earlierAccepted", { subject });
    case "leftAttachment":
      return t("mail.compose.leftAttachment", { subject, name });
    case "leftAttachmentFailed":
      return t("mail.compose.leftAttachmentFailed", { subject, name, reason });
    case "leftSentEdits":
      return t("mail.compose.leftSentEdits", { subject });
    case "leftNotSentSaved":
      return t("mail.compose.leftNotSentSaved", { subject, reason });
    case "leftNotSent":
      return t("mail.compose.leftNotSent", { subject, reason });
    case "leftUnknown":
      return t("mail.compose.leftUnknown", { subject });
    case "leftUnsaved":
      return t("mail.compose.leftUnsaved", { subject });
  }
}

/** One session per mounted Mail page; the page's tracker goes with it. */
function makeSession(props: { current: MailComposeProviderProps }, language: { current: string }) {
  const tracker = createSendTracker(browserSendTrackerDeps, MAIL_PAGE_SEND_POLICY);
  const session = createComposeSession({
    api: composeApi,
    tracker,
    clock: browserComposeClock,
    uuid,
    storage: sessionLeftStore,
    host: {
      onChanged: () => props.current.onChanged(),
      onOpenDrafts: (id) => props.current.onOpenDrafts(id),
      accounts: () => props.current.accounts,
      sendable: () => props.current.accounts.filter((a) => props.current.sendableIds.includes(a.id)),
      locale: () => (language.current === "en" ? "en" : "zh-CN"),
    },
  });
  return { session, tracker, disposed: false };
}

export function MailComposeProvider(props: MailComposeProviderProps) {
  const { t, i18n } = useTranslation();
  const { accounts, sendableIds } = props;
  const sendable = useMemo(() => accounts.filter((a) => sendableIds.includes(a.id)), [accounts, sendableIds]);
  const propsRef = useRef(props);
  propsRef.current = props;
  const language = useRef(i18n.language);
  language.current = i18n.language;
  const own = useRef<{ session: ComposeSession; tracker: SendTracker; disposed: boolean } | null>(null);
  own.current ??= makeSession(propsRef, language);
  const [, renew] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    // A page mounted again (React may do that with the same component) gets a fresh session.
    let o = own.current as NonNullable<typeof own.current>;
    if (o.disposed) {
      o = own.current = makeSession(propsRef, language);
      renew();
    }
    void o.session.start();
    return () => {
      o.disposed = true;
      o.session.dispose();
      o.tracker.dispose();
    };
  }, []);
  const s = own.current.session;
  const st = useSyncExternalStore(s.subscribe, s.getState);
  const { compose, busy } = st;
  // Worded at render time: a language switch rewords the notices already on screen.
  const notices = useMemo<Notice[]>(
    () =>
      st.notices.map((n) => ({
        id: n.id,
        tone: n.tone,
        text: noticeText(t, n),
        ...(n.action ? { action: { label: n.action.label === "openIt" ? t("mail.compose.openIt") : t("mail.compose.openDrafts"), run: n.action.run } } : {}),
        ...(n.forget ? { forget: n.forget } : {}),
        ...(n.left ? { left: n.left } : {}),
        ...(n.autoCloseMs ? { autoCloseMs: n.autoCloseMs } : {}),
      })),
    [st.notices, t, i18n.language] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const api = useMemo<MailComposeApi>(
    () => ({
      startNew: s.startNew,
      startFrom: (mode, message) => void s.startFrom(mode, message),
      editDraft: (message) => void s.editDraft(message),
      busy,
      canCompose: sendable.length > 0 && compose === null,
      isDraftsFolder: props.isDraftsFolder,
    }),
    [s, busy, sendable.length, props.isDraftsFolder, compose]
  );

  const layer = useMemo(
    () => ({
      compose,
      pendings: st.pendings,
      now: st.now,
      notices,
      accounts: sendable,
      actions: {
        change: s.edit,
        showCc: s.showCc,
        minimize: s.minimize,
        attach: s.attach,
        removeAttachment: s.removeAttachment,
        send: () => void s.send(),
        close: () => void s.close(),
        discard: s.discard,
        undo: (sendId: string) => void s.undo(sendId),
        closeNotice: s.closeNotice,
        copyNew: s.copyAsNew,
        cancelDrop: s.cancelDrop,
        dropLeft: s.dropLeft,
      },
      confirmDrop: st.confirmDrop,
    }),
    [s, compose, st.pendings, st.now, notices, sendable, st.confirmDrop]
  );

  return (
    <Ctx.Provider value={api}>
      <LayerCtx.Provider value={layer}>{props.children}</LayerCtx.Provider>
    </Ctx.Provider>
  );
}


/** The floating composer, the undo countdowns and the notices. Mount once inside the Mail page's root. */
export function MailComposeLayer() {
  const { t } = useTranslation();
  const layer = useContext(LayerCtx);
  const keepRef = useRef<HTMLButtonElement>(null);
  if (!layer) return null;
  const { compose, pendings, now, notices, actions, accounts, confirmDrop } = layer;
  return (
    <>
      {compose && (
        <ComposeWindow
          state={compose}
          accounts={accounts}
          onChange={actions.change}
          onShowCc={actions.showCc}
          onMinimize={actions.minimize}
          onAttach={actions.attach}
          onRemoveAttachment={actions.removeAttachment}
          onSend={actions.send}
          onClose={actions.close}
          onDiscard={actions.discard}
          onCopyNew={actions.copyNew}
        />
      )}
      {(pendings.length > 0 || notices.length > 0) && (
        <div className="mc-toasts" data-ui="mail-toasts">
          {pendings.map((p) => {
            const seconds = Math.max(0, Math.ceil((p.endsAt - now) / 1000));
            return (
              <div
                key={p.sendId}
                className="mc-toast"
                data-ui="mail-send-undo"
                data-ui-key={p.sendId}
                data-phase={p.phase}
                role="status"
              >
                <Icon
                  name={p.phase === "window" ? "send" : "loader-circle"}
                  cls={p.phase === "window" ? "ico-sm" : "ico-sm mail-spin"}
                />
                <span>
                  {p.phase === "window"
                    ? t("mail.compose.sending", { n: seconds })
                    : p.unreachable
                      ? t("mail.compose.reconnecting")
                      : t("mail.compose.sendingNow")}
                </span>
                <span className="mc-toast-meta">{p.subject || t("mail.noSubject")}</span>
                {p.phase === "window" && (
                  <Button
                    data-ui="mail-send-undo-action"
                    data-ui-key={p.sendId}
                    onClick={() => actions.undo(p.sendId)}
                  >
                    {t("mail.compose.undo")}
                  </Button>
                )}
              </div>
            );
          })}
          {notices.map((n) => (
            <div
              key={n.id}
              className={`mc-toast ${n.tone}`}
              data-ui="mail-notice"
              data-tone={n.tone}
              role={n.tone === "info" ? "status" : "alert"}
            >
              <Icon name={n.tone === "info" ? "check" : "triangle-alert"} cls="ico-sm" />
              <span>{n.text}</span>
              {n.action && (
                <Button data-ui="mail-notice-action" onClick={() => n.action?.run(n.id)}>
                  {n.action.label}
                </Button>
              )}
              <ActionButton
                unstyled
                mode="icon"
                iconName="xmark"
                className="btn icon ghost"
                data-ui="mail-notice-close"
                label={t("mail.compose.dismiss")}
                tooltip={t("mail.compose.dismiss")}
                onClick={() => actions.closeNotice(n.id)}
              />
            </div>
          ))}
        </div>
      )}
      {confirmDrop !== null && (
        <Dialog
          title={t("mail.compose.leftDropTitle")}
          uiId="mail-left-drop-dialog"
          closeLabel={t("mail.compose.close")}
          onClose={actions.cancelDrop}
          initialFocusRef={keepRef as React.RefObject<HTMLElement>}
          footer={
            <>
              <Button ref={keepRef} onClick={actions.cancelDrop}>
                {t("mail.compose.cancel")}
              </Button>
              <Button
                appearance="primary"
                tone="danger"
                data-ui="mail-left-drop-confirm"
                onClick={() => actions.dropLeft(confirmDrop)}
              >
                {t("mail.compose.leftDropConfirm")}
              </Button>
            </>
          }
        >
          <p>{t("mail.compose.leftDropBody")}</p>
        </Dialog>
      )}
    </>
  );
}

/** "Write" button of the folder pane. */
export function ComposeButton({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const api = useMailCompose();
  if (!api) return null;
  return compact ? (
    <ActionButton
      unstyled
      mode="icon"
      iconName="square-pen"
      className="btn icon ghost"
      data-ui="mail-compose-compact"
      disabled={!api.canCompose}
      label={t("mail.compose.write")}
      tooltip={t("mail.compose.write")}
      onClick={api.startNew}
    />
  ) : (
    <div className="mc-write-row">
      <Button appearance="primary" data-ui="mail-compose" disabled={!api.canCompose} onClick={api.startNew}>
        <Icon name="square-pen" cls="ico-sm" />
        {t("mail.compose.write")}
      </Button>
    </div>
  );
}

/** Reply / reply all / forward (or, in Drafts, edit) for the open message. One mount point in the reader. */
export function MailComposeActions({ message }: { message: MailMessage }) {
  const { t } = useTranslation();
  const api = useMailCompose();
  if (!api) return null;
  const inDrafts = api.isDraftsFolder(message.accountId, message.folder);
  const disabled = api.busy || !api.canCompose;
  return (
    <div className="mc-actions" data-ui="mail-compose-actions" role="group" aria-label={t("mail.compose.actions")}>
      {inDrafts ? (
        <ActionButton
          unstyled
          mode="icon"
          iconName="mail-pencil"
          className="btn icon ghost"
          data-ui="mail-edit-draft"
          disabled={disabled}
          label={t("mail.compose.editDraft")}
          tooltip={t("mail.compose.editDraft")}
          onClick={() => api.editDraft(message)}
        />
      ) : (
        <>
          <ActionButton unstyled mode="icon" iconName="reply" className="btn icon ghost" data-ui="mail-reply" disabled={disabled} label={t("mail.compose.reply")} tooltip={t("mail.compose.reply")} onClick={() => api.startFrom("reply", message)} />
          <IconButton unstyled className="btn icon ghost" data-ui="mail-reply-all" disabled={disabled} icon={<Icon name="reply-all" cls="ico-sm" />} label={t("mail.compose.replyAll")} onClick={() => api.startFrom("replyAll", message)} />
          <ActionButton unstyled mode="icon" iconName="forward" className="btn icon ghost" data-ui="mail-forward" disabled={disabled} label={t("mail.compose.forward")} tooltip={t("mail.compose.forward")} onClick={() => api.startFrom("forward", message)} />
        </>
      )}
    </div>
  );
}
