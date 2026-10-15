import type { HostCliStatus } from "@argelanderspace/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { changeCli, fetchCliStatus } from "../api/host";
import { useHostRequest } from "../host";
import { ActionButton, Badge, Button, Dialog, InlineMessage } from "../ui";

/**
 * "Command line & agents" (desktop-app ticket 24), the desktop app's only group, as in the approved prototype: the
 * command-line tool — a launcher in the user's own executable directory that runs the app's Node on its CLI — installed
 * or uninstalled by the host (`/api/host/cli`), and the bundled skills folder, shown by a native request. The app
 * changes no PATH: when the directory is not on it the page shows the line the user would add. None of this is in
 * config.toml, so it works whatever the state of that file.
 */
export function CliGroup({ notify }: { notify: (text: string) => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HostCliStatus | null | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallFailed, setUninstallFailed] = useState<string | null>(null);
  /** Uninstalling found someone else's file there by now: nothing of the app's is left to remove. */
  const [uninstallForeign, setUninstallForeign] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const showSkills = useHostRequest("open_skills_folder");

  useEffect(() => {
    let live = true;
    void fetchCliStatus().then((answer) => {
      if (live) setStatus(answer);
    });
    return () => {
      live = false;
    };
  }, []);

  const install = async () => {
    setBusy(true);
    setFailed(null);
    const result = await changeCli("install");
    setBusy(false);
    if (result.kind === "failed") setFailed(t("settings.cli.installFailed", { code: result.code ?? "?" }));
    else setStatus(result.status);
  };

  const uninstall = async () => {
    setBusy(true);
    setUninstallFailed(null);
    const result = await changeCli("uninstall");
    setBusy(false);
    if (result.kind === "failed") {
      // The dialog stays open: retry or cancel.
      setUninstallFailed(t("settings.cli.uninstallFailed", { code: result.code ?? "?" }));
      return;
    }
    setStatus(result.status);
    // Someone else's file is there by now: said in the dialog, in uninstall's words; it stays until closed.
    if (result.kind === "foreign") setUninstallForeign(true);
    else setUninstalling(false);
  };

  /** On POSIX the whole shell line is copied, on Windows the directory. */
  const copyLine = async (line: string, windows: boolean) => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(line);
    } catch {
      ok = false;
    }
    const done = windows ? t("settings.configFile.pathCopied") : t("settings.cli.lineCopied");
    notify(ok ? done : t("settings.configFile.copyFailed"));
  };

  const known = status !== null && status !== "loading" ? status : null;
  const installed = known !== null && (known.state === "installed" || known.state === "outdated");
  return (
    <>
      <div className="st-row" data-ui="setting-row" data-ui-key="cli-tool">
        <div className="st-row-main">
          <div className="st-label"><span>{t("settings.cli.tool")}</span></div>
          <div className="st-badges" data-ui="cli-status" data-state={known?.state ?? (status === null ? "unknown" : "loading")}>
            {known !== null && (installed ? <Badge tone="accent">{t("settings.cli.installed")}</Badge> : <Badge>{t("settings.cli.before")}</Badge>)}
          </div>
          {known !== null && (
            <div className="st-hint">
              {t("settings.cli.target")}: <code className="st-path" title={known.file.path}>{known.file.display}</code>
            </div>
          )}
          {status === null && <div className="st-hint" data-ui="cli-status-unknown">{t("settings.cli.unknown")}</div>}
        </div>
        <div className="st-control">
          {known !== null && known.state === "outdated" && (
            <Button appearance="primary" data-ui="cli-install" busy={busy} onClick={() => void install()}>
              {t("settings.cli.reinstall")}
            </Button>
          )}
          {known !== null && installed ? (
            <Button data-ui="cli-uninstall" disabled={busy} onClick={() => { setUninstallFailed(null); setUninstallForeign(false); setUninstalling(true); }}>
              {t("settings.cli.uninstall")}
            </Button>
          ) : (
            <Button appearance="primary" data-ui="cli-install" busy={busy} disabled={known === null} onClick={() => void install()}>
              {t("settings.cli.install")}
            </Button>
          )}
        </div>
        {known !== null && installed && !known.inPath && (
          <div className="st-row-wide">
            <InlineMessage tone="warning" uiId="cli-path-hint" title={t("settings.cli.pathTitle")}>
              {known.platform === "windows" ? t("settings.cli.pathWin") : t("settings.cli.pathBody")}
              <div className="st-codeline">
                <code data-ui="cli-path-line">{known.pathLine}</code>
                <ActionButton
                  mode="icon"
                  iconName="copy"
                  iconSize="small"
                  tooltipAlign="end"
                  data-ui="copy-path-line"
                  label={known.platform === "windows" ? t("settings.cli.copyPath") : t("settings.cli.copyLine")}
                  tooltip={known.platform === "windows" ? t("settings.cli.copyPath") : t("settings.cli.copyLine")}
                  onClick={() => void copyLine(known.pathLine, known.platform === "windows")}
                />
              </div>
            </InlineMessage>
          </div>
        )}
        {known !== null && known.state === "outdated" && (
          <div className="st-row-wide">
            <InlineMessage tone="warning" uiId="cli-outdated" title={t("settings.cli.outdatedTitle")}>
              {t("settings.cli.outdatedBody", { path: known.file.display })}
            </InlineMessage>
          </div>
        )}
        {known !== null && known.state === "foreign" && (
          <div className="st-row-wide">
            <InlineMessage tone="warning" uiId="cli-conflict" title={t("settings.cli.conflictTitle")}>
              {t("settings.cli.conflictBody", { path: known.file.display })}
            </InlineMessage>
          </div>
        )}
        {failed !== null && (
          <div className="st-row-wide">
            <InlineMessage tone="danger" uiId="cli-install-failed">{failed}</InlineMessage>
          </div>
        )}
      </div>
      {showSkills !== null && (
        <div className="st-row" data-ui="setting-row" data-ui-key="skills-folder">
          <div className="st-row-main"><div className="st-label"><span>{t("settings.cli.skills")}</span></div></div>
          <div className="st-control">
            <Button
              data-ui="show-skills-folder"
              onClick={() => void showSkills().then((ok) => { if (!ok) notify(t("settings.host.requestFailed")); })}
            >
              {t("settings.cli.showSkills")}
            </Button>
          </div>
        </div>
      )}
      {uninstalling && known !== null && (
        <Dialog
          title={t("settings.cli.uninstallTitle")}
          uiId="uninstall-cli"
          closeLabel={t("settings.cli.cancel")}
          onClose={() => setUninstalling(false)}
          initialFocusRef={cancelRef as React.RefObject<HTMLElement>}
          busy={busy}
          footer={
            <>
              <Button ref={cancelRef} data-ui="uninstall-cli-cancel" onClick={() => setUninstalling(false)}>{t("settings.cli.cancel")}</Button>
              <Button appearance="primary" tone="danger" data-ui="uninstall-cli-confirm" busy={busy} disabled={uninstallForeign} onClick={() => void uninstall()}>
                {t("settings.cli.uninstall")}
              </Button>
            </>
          }
        >
          <p>{t("settings.cli.uninstallBody", { path: known.file.display, command: known.command })}</p>
          {uninstallFailed !== null && <InlineMessage tone="danger" uiId="cli-uninstall-failed">{uninstallFailed}</InlineMessage>}
          {uninstallForeign && (
            <InlineMessage tone="warning" uiId="cli-uninstall-foreign">
              {t("settings.cli.uninstallForeign", { path: known.file.display })}
            </InlineMessage>
          )}
        </Dialog>
      )}
    </>
  );
}
