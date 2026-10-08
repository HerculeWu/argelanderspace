import type { MailFolder, MailFolderRole, MailHeader } from "@argelanderspace/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { Button, Dialog, IconButton, InlineMessage } from "../ui";
import type { FailureKind } from "./manage-error";
import type { PermanentDeleteState } from "./useMailActions";
import "./mail-manage.css";

const FOLDER_ICON: Record<string, string> = {
  inbox: "inbox",
  drafts: "file-pen-line",
  sent: "send",
  archive: "archive",
  junk: "shield-alert",
  trash: "trash-2",
  all: "mails",
  flagged: "star",
  custom: "folder",
};
/** Folders that make no sense as a place to file a message into. */
const NOT_TARGETS = new Set<MailFolderRole>(["drafts", "sent", "flagged"]);

/**
 * The reader's action bar. `back` (narrow layouts) and `leading` (reply, forward:
 * ticket 07) come first, then the management actions of ticket 06: star,
 * read/unread, move and delete. Each button acts at once and the page rolls the
 * change back if the server refuses (see useMailActions).
 */
export function MessageActions({
  header,
  role,
  folders,
  currentPath,
  folderLabel,
  busy,
  restoreTo,
  onBack,
  leading,
  onToggleRead,
  onToggleStar,
  onMove,
  onDelete,
}: {
  header: MailHeader | undefined;
  role: MailFolderRole | undefined;
  folders: MailFolder[];
  currentPath: string;
  folderLabel: (f: MailFolder) => string;
  busy: boolean;
  /** Where "move back" in Trash puts the message (the account's Inbox), when known. */
  restoreTo: string | null;
  onBack?: (() => void) | undefined;
  leading?: ReactNode;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onMove: (path: string) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const targets = folders.filter((f) => f.selectable && f.path !== currentPath && !NOT_TARGETS.has(f.role));
  const inTrash = role === "trash";
  const disabled = busy || !header;

  useEffect(() => {
    if (!menu) return;
    const onClick = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(false);
      trigger.current?.focus();
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    // The first target takes focus so the keyboard can reach and activate it right away.
    wrap.current?.querySelector<HTMLElement>('[data-ui="mail-move-target"]')?.focus();
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  // A message that changed folders or went away closes the menu with it.
  useEffect(() => setMenu(false), [header?.uid, currentPath]);

  return (
    <div className="mail-reader-actions" data-ui="mail-reader-actions">
      {onBack && (
        <IconButton
          unstyled
          className="btn icon ghost"
          data-ui="mail-reader-back"
          icon={<Icon name="arrow-left" cls="ico-sm" />}
          label={t("mail.backToList")}
          onClick={onBack}
        />
      )}
      {leading}
      {(onBack || leading) && <span className="mail-actions-sep" />}
      <IconButton
        unstyled
        className="btn icon ghost"
        data-ui="mail-star"
        disabled={disabled}
        icon={<Icon name="star" cls={`ico-sm${header?.starred ? " mail-starred" : ""}`} />}
        label={header?.starred ? t("mail.manage.unstar") : t("mail.manage.star")}
        data-starred={header?.starred ? "true" : "false"}
        onClick={onToggleStar}
      />
      <IconButton
        unstyled
        className="btn icon ghost"
        data-ui="mail-mark-unread"
        disabled={disabled}
        icon={<Icon name={header?.unread ? "mail-open" : "mail"} cls="ico-sm" />}
        label={header?.unread ? t("mail.manage.markRead") : t("mail.manage.markUnread")}
        onClick={onToggleRead}
      />
      <span className="mail-move-wrap" ref={wrap}>
        <IconButton
          unstyled
          ref={trigger}
          className="btn icon ghost"
          data-ui="mail-move"
          aria-expanded={menu}
          disabled={disabled || targets.length === 0}
          icon={<Icon name="folder-input" cls="ico-sm" />}
          label={t("mail.manage.move")}
          onClick={(e) => {
            e.stopPropagation();
            setMenu((o) => !o);
          }}
        />
        {menu && (
          <div className="mail-menu mail-move-menu" data-ui="mail-move-menu" role="group" aria-label={t("mail.manage.moveTo")}>
            <div className="mail-menu-label">{t("mail.manage.moveTo")}</div>
            {targets.map((f) => (
              <button
                key={f.path}
                type="button"
                data-ui="mail-move-target"
                data-ui-key={f.path}
                style={{ paddingLeft: 10 + f.depth * 14 }}
                onClick={() => {
                  setMenu(false);
                  onMove(f.path);
                }}
              >
                <Icon name={FOLDER_ICON[f.role] ?? "folder"} cls="ico-sm" />
                <span>{folderLabel(f)}</span>
              </button>
            ))}
          </div>
        )}
      </span>
      {inTrash && restoreTo && (
        <IconButton
          unstyled
          className="btn icon ghost"
          data-ui="mail-restore"
          disabled={disabled}
          icon={<Icon name="undo-2" cls="ico-sm" />}
          label={t("mail.manage.restore")}
          onClick={() => onMove(restoreTo)}
        />
      )}
      <IconButton
        unstyled
        className="btn icon ghost"
        data-ui={inTrash ? "mail-delete-forever" : "mail-delete"}
        disabled={disabled}
        icon={<Icon name="trash-2" cls={`ico-sm${inTrash ? " mail-danger-icon" : ""}`} />}
        label={inTrash ? t("mail.manage.deleteForever") : t("mail.manage.delete")}
        onClick={onDelete}
      />
    </div>
  );
}

/** Confirmation for the one irreversible change: removing a message from Trash for good. */
export function PermanentDeleteDialog({
  state,
  reason,
  failure,
  onCancel,
  onConfirm,
}: {
  state: PermanentDeleteState;
  /** How the last failure must be worded (see failureKind). */
  failure: FailureKind;
  /** Localised reason for the last failed attempt, if any. */
  reason: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      uiId="mail-permanent-delete-dialog"
      title={t("mail.manage.permanentTitle")}
      closeLabel={t("mail.close")}
      onClose={onCancel}
      busy={state.busy}
      initialFocusRef={cancelRef as React.RefObject<HTMLElement>}
      footer={
        <>
          <Button ref={cancelRef} data-ui="mail-permanent-delete-cancel" onClick={onCancel} disabled={state.busy}>
            {t("mail.cancel")}
          </Button>
          <Button
            appearance="primary"
            tone="danger"
            data-ui="mail-permanent-delete-confirm"
            busy={state.busy}
            onClick={onConfirm}
          >
            {t("mail.manage.permanentConfirm")}
          </Button>
        </>
      }
    >
      <p className="mail-permanent-subject">{state.subject || t("mail.noSubject")}</p>
      <p>{t("mail.manage.permanentBody")}</p>
      {reason && (
        <InlineMessage
          tone="danger"
          title={t(
            failure === "unknown"
              ? "mail.manage.outcomeUnknownTitle"
              : failure === "gone"
                ? "mail.manage.goneTitle"
                : "mail.manage.deleteFailedTitle"
          )}
        >
          {reason}
        </InlineMessage>
      )}
    </Dialog>
  );
}
