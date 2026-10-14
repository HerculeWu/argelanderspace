import { type AdsCredentialStatus, type AdsTokenTestOutcome, isAdsTokenShaped } from "@argelanderspace/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AdsCredentialFailure,
  type AdsCredentialOutcome,
  fetchAdsCredential,
  importAdsDevKey,
  removeAdsToken,
  saveAdsToken,
  testAdsToken,
} from "../api/ads-credential";
import type { Preferences } from "../argelander/preferences";
import { Icon } from "../lib/icons";
import { Badge, Button, Dialog, InlineMessage } from "../ui";

/**
 * The ADS token row of the "Literature services & credentials" group (desktop-app ticket 12), as the approved
 * prototype has it: a secret input while nothing is saved (or while replacing), the state and its protection once
 * saved — never the value; the consent card when the keychain is unavailable (Save stays disabled until it is ticked);
 * a permanent warning when the token is in the restricted file; the import of `~/.ads/dev_key` when the file is there;
 * removal through a dialog whose focus starts on Cancel; and the notice for a config.toml that still has `ads_dev_key`
 * (it no longer has any effect), dismissed with "Got it" for the rest of this page session.
 */

/** "Got it" on the legacy notice holds until the page is loaded again (the prototype's scope; ticket 12). */
let legacyDismissed = false;

const FAILED = {
  invalid_request: "settings.ads.failed.other",
  invalid_token: "settings.ads.failed.invalid_token",
  keychain_unavailable: "settings.ads.failed.keychain_unavailable",
  not_saved: "settings.ads.failed.not_saved",
  no_dev_key: "settings.ads.failed.no_dev_key",
  dev_key_unreadable: "settings.ads.failed.dev_key_unreadable",
  file_unreadable: "settings.ads.failed.file_unreadable",
  storage_failed: "settings.ads.failed.other",
  unreachable: "settings.ads.failed.unreachable",
} as const satisfies Record<AdsCredentialFailure, string>;

const TEST_TONE = { valid: "info", rejected: "danger", unreachable: "warning", rate_limited: "warning" } as const;
const TEST_TITLE = {
  valid: "settings.ads.okTitle",
  rejected: "settings.ads.rejectedTitle",
  unreachable: "settings.ads.unreachableTitle",
  rate_limited: "settings.ads.ratelimitedTitle",
} as const;
const TEST_BODY = {
  valid: "settings.ads.ok",
  rejected: "settings.ads.rejected",
  unreachable: "settings.ads.unreachable",
  rate_limited: "settings.ads.ratelimited",
} as const;

export function AdsCredential({ P, legacy }: { P: Preferences; legacy: boolean }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AdsCredentialStatus | null | "unreachable">(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [consent, setConsent] = useState(false);
  /** The keychain refused a save this time, though the status said it answered. */
  const [refusedByKeychain, setRefusedByKeychain] = useState(false);
  const [test, setTest] = useState<null | "testing" | AdsTokenTestOutcome>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [dismissed, setDismissed] = useState(legacyDismissed);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAdsCredential(controller.signal)
      .then((s) => setStatus(s ?? "unreachable"))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const legacyNotice = legacy && !dismissed && (
    <div className="st-with-action">
      <InlineMessage tone="warning" uiId="ads-legacy-key" title={t("settings.services.legacyTitle")}>
        {t("settings.services.legacyBody")}
      </InlineMessage>
      <Button
        data-ui="ads-legacy-dismiss"
        onClick={() => {
          legacyDismissed = true;
          setDismissed(true);
        }}
      >
        {t("settings.services.legacyDismiss")}
      </Button>
    </div>
  );

  if (status === null)
    return (
      <div className="st-row st-cred" data-ui="ads-credential" data-state="loading">
        <div className="st-row-main"><div className="st-label"><span>{t("settings.ads.token")}</span></div></div>
        {legacyNotice && <div className="st-row-wide st-stack">{legacyNotice}</div>}
      </div>
    );
  if (status === "unreachable")
    return (
      <div className="st-row st-cred" data-ui="ads-credential" data-state="unreachable">
        <div className="st-row-main"><div className="st-label"><span>{t("settings.ads.token")}</span></div></div>
        <div className="st-row-wide">
          <InlineMessage tone="warning" uiId="ads-credential-unavailable">{t("settings.ads.statusUnavailable")}</InlineMessage>
        </div>
        {legacyNotice && <div className="st-row-wide st-stack">{legacyNotice}</div>}
      </div>
    );

  const saved = status.saved;
  const entering = saved === "none" || editing;
  const needConsent = entering && (status.keychain === "unavailable" || refusedByKeychain);
  const token = draft.trim();
  const result = test !== null && test !== "testing" ? test : null;

  /** A change came back: the new state, or the reason it was not made (in the floating notice). */
  type Done = "settings.ads.savedNotice" | "settings.ads.importedNotice" | "settings.ads.removedNotice";
  const settle = (outcome: AdsCredentialOutcome, done: Done): boolean => {
    if (outcome.ok) {
      setStatus(outcome.status);
      setEditing(false);
      setDraft("");
      setConsent(false);
      setRefusedByKeychain(false);
      setTest(null);
      P.notify(t(done));
      return true;
    }
    if (outcome.reason === "keychain_unavailable") {
      setRefusedByKeychain(true);
      setEditing(true);
    }
    P.notify(t(FAILED[outcome.reason]));
    return false;
  };

  const save = async () => {
    if (busy || !isAdsTokenShaped(token) || (needConsent && !consent)) {
      if (token !== "" && !isAdsTokenShaped(token)) P.notify(t(FAILED.invalid_token));
      return;
    }
    setBusy(true);
    try {
      settle(await saveAdsToken(token, needConsent && consent), "settings.ads.savedNotice");
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    const mine = ++generation.current;
    setTest("testing");
    const outcome = await testAdsToken();
    if (mine !== generation.current) return;
    if (outcome.ok) setTest(outcome.result);
    else {
      setTest(null);
      P.notify(t(FAILED[outcome.reason]));
    }
  };

  const runImport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      settle(await importAdsDevKey(needConsent && consent), "settings.ads.importedNotice");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      if (settle(await removeAdsToken(), "settings.ads.removedNotice")) setRemoving(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-row st-cred" data-ui="ads-credential" data-state={saved}>
      <div className="st-row-main">
        <div className="st-label"><span>{t("settings.ads.token")}</span></div>
        <div className="st-badges" data-ui="ads-credential-status" data-state={saved}>
          {saved === "none" ? <Badge>{t("settings.ads.none")}</Badge> : <Badge tone="accent">{t("settings.ads.saved")}</Badge>}
          {saved === "keychain" && (
            <span className="st-pill ok" data-ui="ads-protection" data-state="keychain">
              <Icon name="shield-check" cls="ico-sm" />
              {t("settings.ads.keychain")}
            </span>
          )}
          {saved === "file" && (
            <span className="st-pill warn" data-ui="ads-protection" data-state="file">
              <Icon name="shield-alert" cls="ico-sm" />
              {t("settings.ads.file")}
            </span>
          )}
          {saved === "unreadable" && (
            <span className="st-pill danger" data-ui="ads-protection" data-state="unreadable">
              <Icon name="circle-alert" cls="ico-sm" />
              {t("settings.ads.unreadable")}
            </span>
          )}
          <Badge>{t("settings.row.notInFile")}</Badge>
        </div>
        <div className="st-hint">{t("settings.ads.hidden")}</div>
      </div>
      <div className="st-control st-cred-actions">
        {entering ? (
          <>
            <input
              data-ui="ads-token-input"
              className="plan-field-input st-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={t("settings.ads.token")}
              placeholder={t("settings.ads.input")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
            <Button appearance="primary" data-ui="ads-token-save" busy={busy} disabled={token === "" || (needConsent && !consent)} onClick={() => void save()}>
              {t("settings.ads.save")}
            </Button>
            {saved !== "none" && (
              <Button
                data-ui="ads-token-cancel-replace"
                onClick={() => {
                  setEditing(false);
                  setDraft("");
                  setConsent(false);
                  setRefusedByKeychain(false);
                }}
              >
                {t("settings.ads.cancel")}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button
              data-ui="ads-token-test"
              busy={test === "testing"}
              busyLabel={<><Icon name="loader-circle" cls="ico-sm st-spin" />{t("settings.ads.testing")}</>}
              onClick={() => void runTest()}
            >
              {t("settings.ads.test")}
            </Button>
            <Button data-ui="ads-token-replace" onClick={() => setEditing(true)}>{t("settings.ads.replace")}</Button>
            <Button appearance="secondary" tone="danger" data-ui="ads-token-remove" onClick={() => setRemoving(true)}>{t("settings.ads.remove")}</Button>
          </>
        )}
      </div>
      <div className="st-row-wide st-stack">
        {saved === "file" && <InlineMessage tone="warning" uiId="ads-file-store-note">{t("settings.ads.fileNote")}</InlineMessage>}
        {saved === "unreadable" && <InlineMessage tone="danger" uiId="ads-file-unreadable">{t("settings.ads.unreadableNote")}</InlineMessage>}
        {needConsent && (
          <InlineMessage tone="warning" uiId="ads-keychain-unavailable" title={t("settings.ads.noKeychainTitle")}>
            {t("settings.ads.noKeychainBody")}
            <label className="st-check">
              <input type="checkbox" data-ui="ads-keychain-consent" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              {t("settings.ads.consent")}
            </label>
          </InlineMessage>
        )}
        {test === "testing" && (
          <div className="st-testing" role="status" data-ui="ads-test-running">
            <Icon name="loader-circle" cls="ico-sm st-spin" />
            {t("settings.ads.testing")}
          </div>
        )}
        {result && (
          <InlineMessage tone={TEST_TONE[result]} uiId="ads-test-result" title={t(TEST_TITLE[result])}>
            <span data-ui="ads-test-outcome" data-state={result}>{t(TEST_BODY[result])}</span>
          </InlineMessage>
        )}
        {status.devKey.exists && (
          <div className="st-import" data-ui="ads-devkey-import">
            <Icon name="file-key" cls="ico-sm" />
            <span>{t("settings.ads.devkey")}</span>
            <code className="st-path" title={status.devKey.path.path}>{status.devKey.path.display}</code>
            <Button data-ui="ads-devkey-import-button" busy={busy} disabled={needConsent && !consent} onClick={() => void runImport()}>
              {t("settings.ads.import")}
            </Button>
            <span className="st-hint">
              {saved !== "none" ? `${t("settings.ads.importReplace")} ` : ""}
              {t("settings.ads.importNote")}
            </span>
          </div>
        )}
        {legacyNotice}
      </div>
      {removing && (
        <Dialog
          title={t("settings.ads.removeTitle")}
          uiId="remove-ads-token"
          closeLabel={t("settings.ads.removeCancel")}
          onClose={() => setRemoving(false)}
          initialFocusRef={cancelRef as React.RefObject<HTMLElement>}
          busy={busy}
          footer={
            <>
              <Button ref={cancelRef} data-ui="remove-ads-token-cancel" onClick={() => setRemoving(false)}>{t("settings.ads.removeCancel")}</Button>
              <Button appearance="primary" tone="danger" data-ui="remove-ads-token-confirm" busy={busy} onClick={() => void remove()}>
                {t("settings.ads.removeConfirm")}
              </Button>
            </>
          }
        >
          <p>{t("settings.ads.removeBody", { where: saved === "file" ? t("settings.ads.whereFile") : t("settings.ads.whereKeychain") })}</p>
        </Dialog>
      )}
    </div>
  );
}
