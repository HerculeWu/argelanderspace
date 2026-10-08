import type { MailAccount, MailFolder, MailHeader, MailMessage } from "@argelanderspace/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchMailAccounts,
  fetchMailFolders,
  fetchMailHeaders,
  MailApiError,
  mailAttachmentUrl,
  openMailMessage,
} from "../api/mail";
import { Icon } from "../lib/icons";
import { Badge, Button, IconButton, InlineMessage } from "../ui";
import { AddAccountDialog, ReenterPasswordDialog, RemoveAccountDialog } from "./AccountDialogs";
import { addressList, addressName, fileSize, longDate, shortDate } from "./format";
import { MailHtmlBody, useInlineImages, useSanitizedMailHtml } from "./MailHtmlBody";
import "./mail.css";

const PAGE = 50;
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

type Health = "loading" | "ok" | "auth" | "offline";
interface AccountState {
  health: Health;
  code: string | null;
  stale: boolean;
  folders: MailFolder[];
}
interface Source {
  accountId: string;
  folder: string;
  headers: MailHeader[];
  uidValidity: number | null;
  nextBefore: number | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  stale: boolean;
}
type Scope = { kind: "unified" } | { kind: "folder"; accountId: string; path: string };
interface Ref {
  accountId: string;
  folder: string;
  uid: number;
}
type Opened =
  | { ref: Ref; status: "loading" }
  | { ref: Ref; status: "error"; code: string }
  | { ref: Ref; status: "ok"; message: MailMessage; stale: boolean };

const sourceKey = (accountId: string, folder: string) => `${accountId}\u0000${folder}`;
const refKey = (r: Ref) => `${r.accountId}\u0000${r.folder}\u0000${r.uid}`;
const errorCode = (e: unknown) => (e instanceof MailApiError ? e.code : "unreachable");
const AUTH_CODES = new Set(["auth_failed", "credential_missing"]);

export function MailView() {
  const { t, i18n } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const layout = width >= 1000 ? "wide" : width >= 720 ? "medium" : "narrow";

  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [rev, setRev] = useState(0);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, AccountState>>({});
  const [sources, setSources] = useState<Record<string, Source>>({});
  const [scope, setScope] = useState<Scope>({ kind: "unified" });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [folderPane, setFolderPane] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [remoteLoaded, setRemoteLoaded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [reenter, setReenter] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  const requested = useRef(new Set<string>());
  const sourceSeq = useRef(new Map<string, number>());
  const openedRef = useRef<Opened | null>(null);
  openedRef.current = opened;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(null);
      document.querySelector<HTMLElement>(`[data-ui="mail-account-menu"][data-ui-key="${menu}"]`)?.focus();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    // The first action takes focus so the keyboard can reach and activate it right away.
    document.querySelector<HTMLElement>('[data-ui="mail-account-remove"]')?.focus();
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // ---- accounts and folders ------------------------------------------------
  const loadAccounts = useCallback(async () => {
    try {
      const r = await fetchMailAccounts();
      if (!alive.current) return;
      setAccounts(r.accounts);
      setRev(r.rev);
      setAccountsError(null);
    } catch (e) {
      if (alive.current) setAccountsError(errorCode(e));
    }
  }, []);
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const loadFolders = useCallback(async (accountId: string) => {
    setStates((s) => ({
      ...s,
      [accountId]: { health: "loading", code: null, stale: false, folders: s[accountId]?.folders ?? [] },
    }));
    try {
      const r = await fetchMailFolders(accountId);
      if (!alive.current) return;
      setStates((s) => ({ ...s, [accountId]: { health: "ok", code: null, stale: r.stale, folders: r.folders } }));
    } catch (e) {
      if (!alive.current) return;
      const code = errorCode(e);
      setStates((s) => ({
        ...s,
        [accountId]: { health: AUTH_CODES.has(code) ? "auth" : "offline", code, stale: false, folders: [] },
      }));
    }
  }, []);
  useEffect(() => {
    for (const a of accounts ?? []) {
      const key = `folders\u0000${a.id}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      void loadFolders(a.id);
    }
  }, [accounts, loadFolders]);

  const inboxPath = useCallback(
    (accountId: string) => states[accountId]?.folders.find((f) => f.role === "inbox")?.path ?? "INBOX",
    [states]
  );

  // ---- message lists ---------------------------------------------------------
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const loadSource = useCallback(async (accountId: string, folder: string, more = false) => {
    const key = sourceKey(accountId, folder);
    const seq = (sourceSeq.current.get(key) ?? 0) + 1;
    sourceSeq.current.set(key, seq);
    const prev = sourcesRef.current[key];
    const before = more ? (prev?.nextBefore ?? null) : null;
    const base = {
      accountId,
      folder,
      headers: prev?.headers ?? [],
      uidValidity: prev?.uidValidity ?? null,
      nextBefore: prev?.nextBefore ?? null,
      stale: false,
    };
    setSources((s) => ({ ...s, [key]: { ...base, loading: !more, loadingMore: more, error: null } }));
    try {
      const r = await fetchMailHeaders(accountId, folder, { before, limit: PAGE });
      if (!alive.current || sourceSeq.current.get(key) !== seq) return;
      const seen = new Set<number>();
      const merged = (more ? [...base.headers, ...r.headers] : r.headers).filter((h) => !seen.has(h.uid) && seen.add(h.uid));
      setSources((s) => ({
        ...s,
        [key]: {
          accountId,
          folder,
          headers: merged,
          uidValidity: r.uidValidity,
          nextBefore: r.nextBefore,
          loading: false,
          loadingMore: false,
          error: null,
          stale: r.stale,
        },
      }));
    } catch (e) {
      if (!alive.current || sourceSeq.current.get(key) !== seq) return;
      const code = errorCode(e);
      if (AUTH_CODES.has(code))
        setStates((s) => ({ ...s, [accountId]: { health: "auth", code, stale: false, folders: [] } }));
      setSources((s) => ({ ...s, [key]: { ...base, loading: false, loadingMore: false, error: code } }));
    }
  }, []);

  const scopeSources = useMemo(() => {
    if (scope.kind === "folder") return [{ accountId: scope.accountId, folder: scope.path }];
    return (accounts ?? [])
      .filter((a) => states[a.id]?.health === "ok")
      .map((a) => ({ accountId: a.id, folder: inboxPath(a.id) }));
  }, [scope, accounts, states, inboxPath]);

  useEffect(() => {
    for (const s of scopeSources) {
      const key = `list\u0000${sourceKey(s.accountId, s.folder)}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      void loadSource(s.accountId, s.folder);
    }
  }, [scopeSources, loadSource]);

  const refresh = () => {
    for (const a of accounts ?? []) void loadFolders(a.id);
    for (const s of scopeSources) void loadSource(s.accountId, s.folder);
  };

  const listSources = scopeSources.map((s) => sources[sourceKey(s.accountId, s.folder)]).filter((s): s is Source => !!s);
  const rows = useMemo(() => {
    const all = listSources.flatMap((s) => s.headers.map((h) => ({ h, accountId: s.accountId, folder: s.folder })));
    return all.sort((a, b) => (b.h.date ?? "").localeCompare(a.h.date ?? "") || b.h.uid - a.h.uid);
  }, [listSources]);
  const loadingFirst = scopeSources.length > 0 && listSources.some((s) => s.loading && s.headers.length === 0);
  const anyMore = listSources.some((s) => s.nextBefore !== null);
  const moreBusy = listSources.some((s) => s.loadingMore);
  const listErrors = listSources.filter((s) => s.error).map((s) => s.error as string);
  const listStale = listSources.some((s) => s.stale);

  // ---- opening a message -----------------------------------------------------
  const markReadLocally = (r: Ref) => {
    const key = sourceKey(r.accountId, r.folder);
    setSources((s) => {
      const cur = s[key];
      if (!cur) return s;
      return { ...s, [key]: { ...cur, headers: cur.headers.map((h) => (h.uid === r.uid ? { ...h, unread: false } : h)) } };
    });
    setStates((s) => {
      const st = s[r.accountId];
      if (!st) return s;
      return {
        ...s,
        [r.accountId]: {
          ...st,
          folders: st.folders.map((f) =>
            f.path === r.folder && f.unread !== null && f.unread > 0 ? { ...f, unread: f.unread - 1 } : f
          ),
        },
      };
    });
  };

  const openMessage = async (row: { h: MailHeader; accountId: string; folder: string }) => {
    const ref: Ref = { accountId: row.accountId, folder: row.folder, uid: row.h.uid };
    setReaderOpen(true);
    setDrawer(false);
    setOpened({ ref, status: "loading" });
    try {
      const r = await openMailMessage(ref.accountId, {
        folder: ref.folder,
        uid: ref.uid,
        uidValidity: sources[sourceKey(ref.accountId, ref.folder)]?.uidValidity ?? undefined,
        unread: row.h.unread,
      });
      if (!alive.current || !openedRef.current || refKey(openedRef.current.ref) !== refKey(ref)) return;
      setOpened({ ref, status: "ok", message: r.message, stale: r.stale });
      if (row.h.unread && r.seen) markReadLocally(ref);
    } catch (e) {
      if (!alive.current || !openedRef.current || refKey(openedRef.current.ref) !== refKey(ref)) return;
      setOpened({ ref, status: "error", code: errorCode(e) });
    }
  };

  const select = (next: Scope) => {
    setScope(next);
    setOpened(null);
    setReaderOpen(false);
    setDrawer(false);
  };

  // ---- derived display -------------------------------------------------------
  const lang = i18n.language;
  const accountById = (id: string) => (accounts ?? []).find((a) => a.id === id);
  const folderLabel = (f: MailFolder) => (f.role === "custom" ? f.name : t(`mail.folder.${f.role}`));
  const inboxUnread = (a: MailAccount) =>
    states[a.id]?.health === "ok" ? (states[a.id]?.folders.find((f) => f.role === "inbox")?.unread ?? 0) : 0;
  const totalUnread = (accounts ?? []).reduce((n, a) => n + inboxUnread(a), 0);
  const scopeFolder =
    scope.kind === "folder" ? states[scope.accountId]?.folders.find((f) => f.path === scope.path) : null;
  const title =
    scope.kind === "unified"
      ? t("mail.unified")
      : `${scopeFolder ? folderLabel(scopeFolder) : scope.path} · ${accountById(scope.accountId)?.displayName ?? ""}`;
  const selectedKey = opened ? refKey(opened.ref) : null;

  // ---- pieces ------------------------------------------------------------------
  const folderRow = (opts: {
    id: string;
    icon: string;
    name: string;
    count: number;
    active: boolean;
    depth?: number;
    disabled?: boolean;
    onClick: () => void;
  }) => (
    <button
      key={opts.id}
      className={"mail-folder" + (opts.active ? " on" : "")}
      data-ui="mail-folder"
      data-ui-key={opts.id}
      aria-current={opts.active ? "true" : undefined}
      disabled={opts.disabled}
      style={{ paddingLeft: 10 + (opts.depth ?? 0) * 14 }}
      onClick={opts.onClick}
    >
      <Icon name={opts.icon} cls="ico-sm" />
      <span className="mail-folder-name">{opts.name}</span>
      {opts.count > 0 && (
        <span className="mail-count" role="img" aria-label={t("mail.unreadCount", { n: opts.count })}>
          {opts.count}
        </span>
      )}
    </button>
  );

  const folderPaneEl = (
    <nav className="mail-folders" data-ui="mail-folders" aria-label={t("mail.accounts")}>
      <div className="lib-side-head">
        <span className="lib-side-title">{t("mail.title")}</span>
        <span className="lib-side-count" />
        <IconButton
          unstyled
          className="lib-side-collapse"
          data-ui="mail-folders-collapse"
          icon={<Icon name="panel-left-close" cls="ico-sm" />}
          label={t("mail.collapse")}
          onClick={() => (layout === "wide" ? setFolderPane(false) : setDrawer(false))}
        />
      </div>
      <div className="mail-tree">
        {folderRow({
          id: "unified",
          icon: "mails",
          name: t("mail.unified"),
          count: totalUnread,
          active: scope.kind === "unified",
          onClick: () => select({ kind: "unified" }),
        })}
        {(accounts ?? []).map((a) => {
          const st = states[a.id];
          return (
            <div key={a.id} className="mail-account" data-ui="mail-account" data-ui-key={a.id}>
              <div className="mail-account-head">
                <button
                  className="mail-account-toggle"
                  aria-expanded={!collapsed[a.id]}
                  onClick={() => setCollapsed((c) => ({ ...c, [a.id]: !c[a.id] }))}
                >
                  <Icon name={collapsed[a.id] ? "chevron-right" : "chevron-down"} cls="ico-sm" />
                  <span className="mail-account-text">
                    <span className="mail-account-name">{a.displayName}</span>
                    <span className="mail-account-addr">{a.address}</span>
                  </span>
                </button>
                <IconButton
                  unstyled
                  className="btn icon ghost mail-account-more"
                  data-ui="mail-account-menu"
                  data-ui-key={a.id}
                  icon={<Icon name="ellipsis" cls="ico-sm" />}
                  label={t("mail.accountMenu")}
                  aria-expanded={menu === a.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu((m) => (m === a.id ? null : a.id));
                  }}
                />
              </div>
              {menu === a.id && (
                <div className="mail-menu" data-ui="mail-account-menu-list" onClick={(e) => e.stopPropagation()}>
                  <button className="danger" data-ui="mail-account-remove" onClick={() => { setMenu(null); setRemoving(a.id); }}>
                    {t("mail.removeAccount")}
                  </button>
                </div>
              )}
              {st?.health === "ok" && st.stale && (
                <div className="mail-account-flag warn" data-ui="mail-account-stale" role="status">
                  <Icon name="wifi-off" cls="ico-sm" />
                  <span>{t("mail.staleFolders")}</span>
                </div>
              )}
              {a.credentialProtection === "file" && (
                <div className="mail-account-flag" data-ui="mail-account-file-store" title={t("mail.fileStoreLong")}>
                  <Icon name="file-key" cls="ico-sm" />
                  <span>{t("mail.fileStore")}</span>
                </div>
              )}
              {st?.health === "auth" && (
                <div className="mail-account-flag danger" data-ui="mail-account-auth-failed" role="alert">
                  <Icon name="circle-alert" cls="ico-sm" />
                  <span>{t("mail.authFailed")}</span>
                  <button className="mail-link" data-ui="mail-account-reenter" onClick={() => setReenter(a.id)}>
                    {t("mail.reenter")}
                  </button>
                </div>
              )}
              {st?.health === "offline" && (
                <div className="mail-account-flag warn" data-ui="mail-account-offline" role="status">
                  <Icon name="wifi-off" cls="ico-sm" />
                  <span>{t(`mail.error.${st.code}`, { defaultValue: t("mail.offline") })}</span>
                  <button className="mail-link" data-ui="mail-account-retry" onClick={() => void loadFolders(a.id)}>
                    {t("mail.retry")}
                  </button>
                </div>
              )}
              {!collapsed[a.id] &&
                st?.health !== "auth" &&
                (st?.folders ?? []).map((f) =>
                  folderRow({
                    id: `${a.id}:${f.path}`,
                    icon: FOLDER_ICON[f.role] ?? "folder",
                    name: folderLabel(f),
                    depth: f.depth + 1,
                    disabled: !f.selectable,
                    count: f.role === "drafts" || f.role === "sent" || f.role === "trash" ? 0 : (f.unread ?? 0),
                    active: scope.kind === "folder" && scope.accountId === a.id && scope.path === f.path,
                    onClick: () => select({ kind: "folder", accountId: a.id, path: f.path }),
                  })
                )}
            </div>
          );
        })}
      </div>
      <div className="mail-folders-foot">
        <Button data-ui="mail-add-account" onClick={() => setAdding(true)}>
          <Icon name="plus" cls="ico-sm" />
          {t("mail.addAccount")}
        </Button>
      </div>
    </nav>
  );

  const listEl = (
    <section className="mail-list" data-ui="mail-message-list" aria-label={title}>
      <div className="mail-list-head">
        <div className="mail-list-title">
          <span>{title}</span>
          <IconButton
            unstyled
            className="btn icon ghost"
            data-ui="mail-refresh"
            icon={<Icon name="refresh-cw" cls="ico-sm" />}
            label={t("mail.refresh")}
            onClick={refresh}
          />
        </div>
      </div>
      {listStale && (
        <div className="mail-banner" data-ui="mail-stale-notice">
          <InlineMessage tone="warning">{t("mail.stale")}</InlineMessage>
        </div>
      )}
      {listErrors.length > 0 && (
        <div className="mail-banner" data-ui="mail-list-error">
          <InlineMessage tone="danger" title={t("mail.listFailed")}>
            {t(`mail.error.${listErrors[0]}`, { defaultValue: t("mail.error.unknown") })}
          </InlineMessage>
        </div>
      )}
      <div className="mail-rows">
        {loadingFirst ? (
          <div className="mail-empty" role="status">
            <Icon name="loader-circle" cls="ico-sm mail-spin" />
            {t("mail.loading")}
          </div>
        ) : rows.length === 0 ? (
          accounts !== null && listErrors.length === 0 && (
            <div className="mail-empty">{accountsError ? "" : t("mail.emptyFolder")}</div>
          )
        ) : (
          rows.map(({ h, accountId, folder }) => {
            const key = refKey({ accountId, folder, uid: h.uid });
            const outgoing = scopeFolder?.role === "sent" || scopeFolder?.role === "drafts";
            return (
              <button
                key={key}
                className={"mail-row" + (key === selectedKey ? " sel" : "") + (h.unread ? " unread" : "")}
                data-ui="mail-message-row"
                data-ui-key={`${accountId}:${folder}:${h.uid}`}
                aria-current={key === selectedKey ? "true" : undefined}
                onClick={() => void openMessage({ h, accountId, folder })}
              >
                <span className="mail-row-mark">
                  {h.unread && <span className="mail-dot" role="img" aria-label={t("mail.unread")} />}
                </span>
                <span className="mail-row-body">
                  <span className="mail-row-top">
                    <span className="mail-row-from">
                      {outgoing ? addressList(h.to) : addressName(h.from) || t("mail.noSender")}
                    </span>
                    {h.hasAttachments && (
                      <Icon name="paperclip" cls="ico-sm mail-row-icon" role="img" aria-label={t("mail.hasAttachments")} />
                    )}
                    {h.starred && <Icon name="star" cls="ico-sm mail-row-icon star" role="img" aria-label={t("mail.starred")} />}
                    <span className="mail-row-date">{shortDate(h.date, lang)}</span>
                  </span>
                  <span className="mail-row-subject">{h.subject || t("mail.noSubject")}</span>
                  {scope.kind === "unified" && (
                    <span className="mail-row-preview">
                      <span className="mail-row-acc">{accountById(accountId)?.displayName}</span>
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
        {anyMore && (
          <div className="mail-more">
            <Button data-ui="mail-load-more" busy={moreBusy} busyLabel={t("mail.loadingMore")} onClick={() => {
              for (const s of listSources) if (s.nextBefore !== null) void loadSource(s.accountId, s.folder, true);
            }}>
              {t("mail.loadMore")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );

  const renderReader = () => {
    if (!opened)
      return (
        <section className="mail-reader mail-reader-empty" data-ui="mail-reader">
          <Icon name="mail-open" />
          <span>{t("mail.selectHint")}</span>
        </section>
      );
    const back =
      layout === "narrow" ? (
        <div className="mail-reader-actions" data-ui="mail-reader-actions">
          <IconButton
            unstyled
            className="btn icon ghost"
            data-ui="mail-reader-back"
            icon={<Icon name="arrow-left" cls="ico-sm" />}
            label={t("mail.backToList")}
            onClick={() => setReaderOpen(false)}
          />
        </div>
      ) : null;
    if (opened.status === "loading")
      return (
        <section className="mail-reader" data-ui="mail-reader" aria-busy="true">
          <header className="mail-reader-head">{back}</header>
          <div className="mail-reader-state" role="status">
            <Icon name="loader-circle" cls="ico-sm mail-spin" />
            {t("mail.loading")}
          </div>
        </section>
      );
    if (opened.status === "error") {
      const failed = opened;
      return (
        <section className="mail-reader" data-ui="mail-reader">
          <header className="mail-reader-head">{back}</header>
          <div className="mail-reader-state" data-ui="mail-open-error">
            <InlineMessage tone="danger" title={t("mail.openFailed")}>
              {t(`mail.error.${failed.code}`, { defaultValue: t("mail.error.unknown") })}
            </InlineMessage>
            <Button
              data-ui="mail-open-retry"
              onClick={() => {
                const row = rows.find((r) => refKey({ accountId: r.accountId, folder: r.folder, uid: r.h.uid }) === refKey(failed.ref));
                if (row) void openMessage(row);
              }}
            >
              {t("mail.retry")}
            </Button>
          </div>
        </section>
      );
    }
    const key = refKey(opened.ref);
    return (
      <OpenedReader
        message={opened.message}
        stale={opened.stale}
        back={back}
        accountName={accountById(opened.message.accountId)?.displayName ?? null}
        language={lang}
        loadRemote={remoteLoaded.has(key)}
        onLoadRemote={() => setRemoteLoaded((s) => new Set(s).add(key))}
      />
    );
  };
  const readerEl = renderReader();

  const narrowShowsReader = layout === "narrow" && readerOpen && opened !== null;
  const showFolders = layout === "wide" && folderPane;
  const reenterAccount = reenter ? accountById(reenter) : undefined;
  const removeAccount = removing ? accountById(removing) : undefined;

  if (accounts !== null && accounts.length === 0 && !accountsError)
    return (
      <div className="mail-mail wide" data-ui="mail-view" data-layout={layout} ref={rootRef}>
        <div className="mail-onboarding" data-ui="mail-empty">
          <Icon name="mail" />
          <Button appearance="primary" data-ui="mail-add-account" onClick={() => setAdding(true)}>
            <Icon name="plus" cls="ico-sm" />
            {t("mail.addAccount")}
          </Button>
        </div>
        {adding && (
          <AddAccountDialog
            onClose={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              void loadAccounts();
            }}
          />
        )}
      </div>
    );

  return (
    <div className={"mail-mail " + layout} data-ui="mail-view" data-layout={layout} ref={rootRef}>
      {showFolders ? (
        folderPaneEl
      ) : (
        <div className="mail-folders-collapsed">
          <IconButton
            unstyled
            className="btn icon ghost"
            data-ui="mail-folders-expand"
            aria-expanded={drawer}
            icon={<Icon name="panel-left-open" cls="ico-sm" />}
            label={t("mail.expand")}
            onClick={() => (layout === "wide" ? setFolderPane(true) : setDrawer((d) => !d))}
          />
        </div>
      )}
      {layout !== "wide" && drawer && (
        <>
          <div className="mail-drawer-scrim" onClick={() => setDrawer(false)} />
          <div className="mail-drawer">{folderPaneEl}</div>
        </>
      )}
      {accountsError && (
        <div className="mail-reader-state" data-ui="mail-accounts-error">
          <InlineMessage tone="danger" title={t("mail.listFailed")}>
            {t(`mail.error.${accountsError}`, { defaultValue: t("mail.error.unknown") })}
          </InlineMessage>
          <Button onClick={() => void loadAccounts()}>{t("mail.retry")}</Button>
        </div>
      )}
      {!accountsError && !narrowShowsReader && listEl}
      {!accountsError && (layout !== "narrow" || narrowShowsReader) && readerEl}
      {adding && (
        <AddAccountDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void loadAccounts();
            setScope({ kind: "unified" });
          }}
        />
      )}
      {reenterAccount && (
        <ReenterPasswordDialog
          account={reenterAccount}
          rev={rev}
          onClose={() => setReenter(null)}
          onSaved={(a, newRev) => {
            setReenter(null);
            setRev(newRev);
            setAccounts((list) => (list ?? []).map((x) => (x.id === a.id ? a : x)));
            for (const key of [...requested.current]) if (key.includes(a.id)) requested.current.delete(key);
            void loadFolders(a.id);
          }}
        />
      )}
      {removeAccount && (
        <RemoveAccountDialog
          account={removeAccount}
          rev={rev}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            setScope({ kind: "unified" });
            setOpened(null);
            void loadAccounts();
          }}
        />
      )}
    </div>
  );
}

function OpenedReader({
  message: m,
  stale,
  back,
  accountName,
  language,
  loadRemote,
  onLoadRemote,
}: {
  message: MailMessage;
  stale: boolean;
  back: React.ReactNode;
  accountName: string | null;
  language: string;
  loadRemote: boolean;
  onLoadRemote: () => void;
}) {
  const { t } = useTranslation();
  const inline = useInlineImages(m);
  const sanitized = useSanitizedMailHtml(m, loadRemote, inline);
  const showHtml = sanitized !== null && sanitized.html.trim() !== "";
  const files = m.attachments; // inline images stay downloadable too
  return (
    <section className="mail-reader" data-ui="mail-reader" aria-label={m.subject || t("mail.noSubject")}>
      <header className="mail-reader-head">
        {back}
        <h1 className="mail-subject">{m.subject || t("mail.noSubject")}</h1>
        <div className="mail-meta">
          <div className="mail-avatar" aria-hidden="true">
            {(addressName(m.from) || "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="mail-meta-text">
            <div>
              <strong>{addressName(m.from) || t("mail.noSender")}</strong>{" "}
              {m.from?.name.trim() && <span className="mail-addr">&lt;{m.from.address}&gt;</span>}
            </div>
            <div className="mail-addr">
              {t("mail.recipients", { list: addressList(m.to) })}
              {m.cc.length > 0 && ` · ${t("mail.ccList", { list: addressList(m.cc) })}`}
            </div>
          </div>
          <div className="mail-meta-side">
            <span>{longDate(m.date, language)}</span>
            {accountName && <Badge>{accountName}</Badge>}
          </div>
        </div>
      </header>
      {stale && (
        <div className="mail-banner" data-ui="mail-stale-notice">
          <InlineMessage tone="warning">{t("mail.stale")}</InlineMessage>
        </div>
      )}
      {showHtml && sanitized.hadRemote && !loadRemote && (
        <div className="mail-remote" data-ui="mail-remote-content-bar" role="status">
          <Icon name="image-off" cls="ico-sm" />
          <span>{t("mail.remoteBlocked")}</span>
          <Button data-ui="mail-load-remote" onClick={onLoadRemote}>
            {t("mail.loadRemote")}
          </Button>
        </div>
      )}
      {showHtml && sanitized.hadRemote && loadRemote && (
        <div className="mail-remote loaded" data-ui="mail-remote-content-bar" role="status">
          <Icon name="image" cls="ico-sm" />
          <span>{t("mail.remoteLoaded")}</span>
        </div>
      )}
      <div className="mail-body">
        {showHtml ? (
          <MailHtmlBody title={m.subject || t("mail.noSubject")} body={sanitized.html} loadRemote={loadRemote} />
        ) : (
          <div className="mail-text" data-ui="mail-text-body">
            {m.text && m.text.trim() !== "" ? m.text : t("mail.noBody")}
          </div>
        )}
        {files.length > 0 && (
          <div className="mail-attachments" data-ui="mail-attachments" role="group" aria-label={t("mail.attachments")}>
            {files.map((a) => (
              <div key={a.part} className="mail-attachment" data-ui="mail-attachment" data-ui-key={a.part}>
                <Icon name={a.contentType.startsWith("image/") ? "image" : "file-text"} cls="ico-sm" />
                <span title={`${a.filename} (${fileSize(a.size)})`}>{a.filename || t("mail.attachments")}</span>
                <a
                  className="btn icon ghost"
                  data-ui="mail-attachment-download"
                  href={mailAttachmentUrl(m.accountId, m, a.part)}
                  download={a.filename || undefined}
                  aria-label={t("mail.downloadNamed", { name: a.filename || t("mail.attachments") })}
                  title={`${t("mail.downloadNamed", { name: a.filename || t("mail.attachments") })} (${fileSize(a.size)})`}
                >
                  <Icon name="download" cls="ico-sm" />
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
