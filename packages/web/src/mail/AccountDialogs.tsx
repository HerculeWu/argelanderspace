import { MAIL_PRESETS, MAIL_SERVER_SAVES_SENT, type MailAccount, type MailAccountCreate, type MailPresetId } from "@argelanderspace/contracts";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createMailAccount, MailApiError, removeMailAccount, updateMailAccount } from "../api/mail";
import { Icon } from "../lib/icons";
import { Button, Dialog, InlineMessage, Select } from "../ui";

const PRESETS: { id: MailPresetId; icon: string }[] = [
  { id: "gmail", icon: "mail" },
  { id: "icloud", icon: "cloud" },
  { id: "custom", icon: "server" },
];
const endpointText = (e: { host: string; port: number; security: string }) =>
  `${e.host}:${e.port} ${e.security === "tls" ? "TLS" : "STARTTLS"}`;
/** Built from the contracts presets so the dialog can never disagree with what the server will use. */
const serverSummary = (id: Exclude<MailPresetId, "custom">) => {
  const p = MAIL_PRESETS[id];
  return p.imap && p.smtp ? `IMAP ${endpointText(p.imap)} · SMTP ${endpointText(p.smtp)}` : "";
};

type Security = "tls" | "starttls";
interface ServerForm {
  host: string;
  port: string;
  security: Security;
  user: string;
}
const emptyServer = (port: string): ServerForm => ({ host: "", port, security: "tls", user: "" });

/** Localised reason for one failed protocol test or a request error; never server text. */
function useReason() {
  const { t } = useTranslation();
  return (code: string | undefined) => {
    const key = `mail.error.${code ?? "unknown"}`;
    return t(key, { defaultValue: t("mail.error.unknown") });
  };
}

function ErrorBlock({ error }: { error: MailApiError }) {
  const { t } = useTranslation();
  const reason = useReason();
  const test = error.extra.test;
  return (
    <InlineMessage tone="danger" title={reason(error.code)}>
      {test ? (
        <ul className="mail-test-list" data-ui="mail-add-account-test">
          {([["protocolImap", test.imap], ["protocolSmtp", test.smtp]] as const).map(([label, r]) => (
            <li key={label}>
              {t("mail.add.testLine", { protocol: t(`mail.add.${label}`), result: r.ok ? t("mail.add.testOk") : reason(r.code) })}
            </li>
          ))}
          <li>{t("mail.add.loginFailed")}</li>
        </ul>
      ) : null}
    </InlineMessage>
  );
}

/** Shown after the server said the OS keychain is unusable: storing in the 0600 file needs explicit consent. */
function KeychainConsent({ consent, onConsent }: { consent: boolean; onConsent: (v: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <div className="mail-keychain" data-ui="mail-keychain-fallback">
      <InlineMessage tone="warning" title={t("mail.add.keychainMissing")}>
        {t("mail.add.keychainBody")}
      </InlineMessage>
      <label className="mail-check">
        <input
          type="checkbox"
          data-ui="mail-keychain-consent"
          checked={consent}
          onChange={(e) => onConsent(e.target.checked)}
        />
        {t("mail.add.keychainConsent")}
      </label>
    </div>
  );
}

/**
 * "Keep a copy of sent mail in Sent myself": the inverse of `MailAccount.serverSavesSent`. Turn it off when the
 * provider's server already files sent mail (otherwise there would be two copies); on when it does not.
 */
function SentCopyOption({ keepOwnCopy, onChange }: { keepOwnCopy: boolean; onChange: (keep: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <div className="mail-sent-copy" data-ui="mail-sent-copy">
      <label className="mail-check">
        <input type="checkbox" data-ui="mail-sent-copy-toggle" checked={keepOwnCopy} onChange={(e) => onChange(e.target.checked)} />
        {t("mail.sentCopy.label")}
      </label>
      <p className="mail-note">{t("mail.sentCopy.hint")}</p>
    </div>
  );
}

export function AddAccountDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (account: MailAccount) => void;
}) {
  const uid = useId();
  const { t } = useTranslation();
  const [preset, setPreset] = useState<MailPresetId | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [imap, setImap] = useState<ServerForm>(emptyServer("993"));
  const [smtp, setSmtp] = useState<ServerForm>(emptyServer("465"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MailApiError | null>(null);
  const [needConsent, setNeedConsent] = useState(false);
  const [consent, setConsent] = useState(false);
  // null: follow the provider's default; a choice is sent as the account's own setting
  const [keepOwnCopy, setKeepOwnCopy] = useState<boolean | null>(null);
  const submitting = useRef(false);

  const edited = () => setError(null);
  const custom = preset === "custom";
  const portOk = (s: ServerForm) => /^\d{1,5}$/.test(s.port) && Number(s.port) >= 1 && Number(s.port) <= 65535;
  const canSubmit =
    preset !== null &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    password.length > 0 &&
    (!needConsent || consent) &&
    (!custom || (imap.host.trim() !== "" && smtp.host.trim() !== "" && portOk(imap) && portOk(smtp)));

  const build = (): MailAccountCreate | null => {
    if (!preset) return null;
    const address = email.trim();
    const base = {
      preset,
      address,
      displayName: custom ? (address.split("@")[1] ?? address) : t(`mail.add.${preset}`),
      password,
      ...(needConsent && consent ? { fileFallbackConsent: true } : {}),
      ...(keepOwnCopy !== null ? { serverSavesSent: !keepOwnCopy } : {}),
    };
    if (!custom) return base;
    const endpoint = (s: ServerForm) => ({ host: s.host.trim(), port: Number(s.port), security: s.security });
    return {
      ...base,
      imap: endpoint(imap),
      smtp: endpoint(smtp),
      imapUser: imap.user.trim() || address,
      smtpUser: smtp.user.trim() || address,
    };
  };

  const submit = async () => {
    const body = build();
    if (!body || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await createMailAccount(body);
      onAdded(r.account);
    } catch (e) {
      const err = e instanceof MailApiError ? e : new MailApiError("unreachable", 0);
      if (err.code === "keychain_unavailable") setNeedConsent(true);
      else setError(err);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const passwordLabel = custom ? t("mail.add.password") : t("mail.add.appPassword");
  const serverFields = (key: "imap" | "smtp", value: ServerForm, set: (v: ServerForm) => void) => (
    <fieldset className="mail-server" data-ui={`mail-server-${key}`}>
      <legend>{t(`mail.add.${key}`)}</legend>
      <label className="mail-dfield grow">
        <span>{t("mail.add.host")}</span>
        <input value={value.host} onChange={(e) => { set({ ...value, host: e.target.value }); edited(); }} />
      </label>
      <label className="mail-dfield port">
        <span>{t("mail.add.port")}</span>
        <input inputMode="numeric" value={value.port} onChange={(e) => { set({ ...value, port: e.target.value }); edited(); }} />
      </label>
      <label className="mail-dfield sec" htmlFor={`${uid}-${key}-security`}>
        <span>{t("mail.add.security")}</span>
        <Select id={`${uid}-${key}-security`} aria-label={t("mail.add.security")} value={value.security} onChange={(v) => { set({ ...value, security: v as Security }); edited(); }}
          options={[{ value: "tls", label: t("mail.add.tls") }, { value: "starttls", label: t("mail.add.starttls") }]} />
      </label>
      <label className="mail-dfield full">
        <span>{t("mail.add.username")}</span>
        <input value={value.user} placeholder={email} onChange={(e) => { set({ ...value, user: e.target.value }); edited(); }} />
      </label>
    </fieldset>
  );

  return (
    <Dialog
      uiId="mail-add-account-dialog"
      title={t("mail.add.title")}
      description={preset ? t(`mail.add.${preset}`) : t("mail.add.chooseProvider")}
      closeLabel={t("mail.close")}
      onClose={onClose}
      busy={busy}
      width={520}
      footer={
        preset && (
          <>
            <Button onClick={() => { setPreset(null); setError(null); }} disabled={busy}>{t("mail.add.back")}</Button>
            <Button appearance="primary" data-ui="mail-add-account-submit" disabled={!canSubmit} busy={busy} busyLabel={t("mail.add.checking")} onClick={() => void submit()}>
              {t("mail.add.submit")}
            </Button>
          </>
        )
      }
    >
      {!preset ? (
        <div className="mail-presets" data-ui="mail-provider-presets">
          {PRESETS.map((p) => (
            <button key={p.id} className="mail-preset" data-ui="mail-provider-preset" data-ui-key={p.id} onClick={() => setPreset(p.id)}>
              <Icon name={p.icon} />
              <span>{t(`mail.add.${p.id}`)}</span>
            </button>
          ))}
        </div>
      ) : (
        <form className="mail-account-form" onSubmit={(e) => { e.preventDefault(); if (canSubmit) void submit(); }}>
          <p className="mail-note">{t(preset === "gmail" ? "mail.add.gmailNote" : preset === "icloud" ? "mail.add.icloudNote" : "mail.add.customNote")}</p>
          <label className="mail-dfield full">
            <span>{t("mail.add.email")}</span>
            <input data-ui="mail-account-email" type="email" autoComplete="off" value={email} onChange={(e) => { setEmail(e.target.value); edited(); }} />
          </label>
          <label className="mail-dfield full">
            <span>{passwordLabel}</span>
            <input data-ui="mail-account-password" type="password" autoComplete="new-password" value={password} onChange={(e) => { setPassword(e.target.value); edited(); }} />
          </label>
          {custom ? <>{serverFields("imap", imap, setImap)}{serverFields("smtp", smtp, setSmtp)}</> : <div className="mail-server-summary">{serverSummary(preset as Exclude<MailPresetId, "custom">)}</div>}
          <SentCopyOption keepOwnCopy={keepOwnCopy ?? !MAIL_SERVER_SAVES_SENT[preset]} onChange={setKeepOwnCopy} />
          {needConsent && <KeychainConsent consent={consent} onConsent={setConsent} />}
          {error && <ErrorBlock error={error} />}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

/** The account's few settings that are not its server or password (only the Sent copy so far). Saved with the rev check. */
export function AccountSettingsDialog({
  account,
  rev,
  onClose,
  onSaved,
}: {
  account: MailAccount;
  rev: number;
  onClose: () => void;
  onSaved: (account: MailAccount, rev: number) => void;
}) {
  const { t } = useTranslation();
  const initial = !(account.serverSavesSent ?? MAIL_SERVER_SAVES_SENT[account.preset]);
  const [keepOwnCopy, setKeepOwnCopy] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MailApiError | null>(null);
  const submitting = useRef(false);
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await updateMailAccount(account.id, {
        rev,
        preset: account.preset,
        address: account.address,
        displayName: account.displayName,
        imap: account.imap,
        smtp: account.smtp,
        imapUser: account.imapUser,
        smtpUser: account.smtpUser,
        serverSavesSent: !keepOwnCopy,
      });
      onSaved(r.account, r.rev);
    } catch (e) {
      setError(e instanceof MailApiError ? e : new MailApiError("unreachable", 0));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      uiId="mail-account-settings-dialog"
      title={t("mail.settings.title", { a: account.address })}
      closeLabel={t("mail.close")}
      onClose={onClose}
      busy={busy}
      width={480}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{t("mail.cancel")}</Button>
          <Button appearance="primary" data-ui="mail-account-settings-save" disabled={keepOwnCopy === initial} busy={busy} onClick={() => void submit()}>
            {t("mail.settings.save")}
          </Button>
        </>
      }
    >
      <SentCopyOption keepOwnCopy={keepOwnCopy} onChange={(v) => { setKeepOwnCopy(v); setError(null); }} />
      {error && <ErrorBlock error={error} />}
    </Dialog>
  );
}

/** A rejected or lost password: verify and store a new one for the same server settings. */
export function ReenterPasswordDialog({
  account,
  rev,
  onClose,
  onSaved,
}: {
  account: MailAccount;
  rev: number;
  onClose: () => void;
  onSaved: (account: MailAccount, rev: number) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MailApiError | null>(null);
  const [needConsent, setNeedConsent] = useState(false);
  const [consent, setConsent] = useState(account.credentialProtection === "file");
  const submitting = useRef(false);
  const canSubmit = password.length > 0 && (!needConsent || consent);
  const submit = async () => {
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await updateMailAccount(account.id, {
        rev,
        preset: account.preset,
        address: account.address,
        displayName: account.displayName,
        imap: account.imap,
        smtp: account.smtp,
        imapUser: account.imapUser,
        smtpUser: account.smtpUser,
        password,
        ...(needConsent && consent ? { fileFallbackConsent: true } : {}),
      });
      onSaved(r.account, r.rev);
    } catch (e) {
      const err = e instanceof MailApiError ? e : new MailApiError("unreachable", 0);
      if (err.code === "keychain_unavailable") setNeedConsent(true);
      else setError(err);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      uiId="mail-reenter-password-dialog"
      title={t("mail.reenterTitle")}
      description={t("mail.reenterBody", { a: account.address })}
      closeLabel={t("mail.close")}
      onClose={onClose}
      busy={busy}
      width={480}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{t("mail.cancel")}</Button>
          <Button appearance="primary" data-ui="mail-reenter-password-submit" disabled={!canSubmit} busy={busy} busyLabel={t("mail.add.checking")} onClick={() => void submit()}>
            {t("mail.save")}
          </Button>
        </>
      }
    >
      <form className="mail-account-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="mail-dfield full">
          <span>{t("mail.add.password")}</span>
          <input data-ui="mail-account-password" type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} />
        </label>
        {needConsent && <KeychainConsent consent={consent} onConsent={setConsent} />}
        {error && <ErrorBlock error={error} />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function RemoveAccountDialog({
  account,
  rev,
  onClose,
  onRemoved,
}: {
  account: MailAccount;
  rev: number;
  onClose: () => void;
  onRemoved: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MailApiError | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeMailAccount(account.id, rev);
      onRemoved(account.id);
    } catch (e) {
      setError(e instanceof MailApiError ? e : new MailApiError("unreachable", 0));
      setBusy(false);
    }
  };
  return (
    <Dialog
      uiId="mail-remove-account-dialog"
      title={t("mail.removeTitle", { a: account.address })}
      closeLabel={t("mail.close")}
      onClose={onClose}
      busy={busy}
      initialFocusRef={cancelRef as React.RefObject<HTMLElement>}
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose} disabled={busy}>{t("mail.cancel")}</Button>
          <Button appearance="primary" tone="danger" data-ui="mail-remove-account-confirm" busy={busy} onClick={() => void remove()}>
            {t("mail.remove")}
          </Button>
        </>
      }
    >
      <p>{t("mail.removeBody")}</p>
      {error && <ErrorBlock error={error} />}
    </Dialog>
  );
}
