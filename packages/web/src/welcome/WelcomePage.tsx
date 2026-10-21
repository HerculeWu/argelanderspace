import type { HostRecentProject, HostRecentProjects } from "@argelanderspace/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchRecentProjects, openRecentProject, removeRecentProject } from "../api/host";
import { usePreferences } from "../argelander/preferences";
import { useHostRequest } from "../host";
import { Icon } from "../lib/icons";
import { TutorialEntryButtons, TutorialEntryMessages, TutorialRestartDialog, useTutorialEntry } from "../tutorial";
import { Button, InlineMessage } from "../ui";
import { RecentProjectList } from "./RecentProjectList";
import "../settings/settings.css";
import "./welcome.css";

/**
 * The welcome page (desktop-app ticket 18; approved prototype, ticket 03): what the desktop app shows with no project
 * open. Only "Open folder…" and the recent projects; no way to the settings page. A folder that is gone is marked and
 * cannot be opened, only removed. Opening one — picked or from the list — is the host's: it stops, and the shell
 * starts the next host for that folder, with a new page.
 */
export function WelcomePage() {
  const { t } = useTranslation();
  const P = usePreferences();
  const pickFolder = useHostRequest("pick_folder");
  // undefined: not known yet; null: could not be read.
  const [recent, setRecent] = useState<HostRecentProjects | null | undefined>(undefined);
  // Once the host is leaving for a project, nothing else is asked of it.
  const [leaving, setLeaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  // The tutorial's entry (in-app-tutorial ticket 25): a secondary button beside "Open folder…".
  const tutorial = useTutorialEntry(null);
  const [restartAsk, setRestartAsk] = useState(false);

  const reload = useCallback(async () => {
    const list = await fetchRecentProjects();
    if (alive.current) setRecent(list);
  }, []);
  useEffect(() => void reload(), [reload]);

  const open = async (project: HostRecentProject) => {
    const result = await openRecentProject(project.path);
    if (!alive.current) return;
    if (result === "leaving") setLeaving(true);
    else if (result === "folder_missing" || result === "unknown_project") {
      if (result === "folder_missing") P.notify(t("welcome.nowMissing"));
      await reload();
    } else P.notify(t("welcome.openFailed"));
  };
  const remove = async (project: HostRecentProject) => {
    const list = await removeRecentProject(project.path);
    if (!alive.current) return;
    if (list === null) P.notify(t("welcome.removeFailed"));
    else setRecent(list);
  };
  const pick = () => {
    if (pickFolder === null) return;
    void pickFolder().then((ok) => {
      if (!ok) P.notify(t("settings.host.requestFailed"));
    });
  };

  return (
    <div className="wl-root" data-ui="welcome-page">
      <div className="wl-col">
        <div className="wl-hero">
          <span className="wordmark wl-mark">
            <span className="wordmark-mark">✦</span>ArgelanderSpace
          </span>
          <h1 className="serif wl-title">{t("welcome.title")}</h1>
          <div className="wl-actions">
            <Button appearance="primary" data-ui="welcome-open-folder" disabled={leaving || pickFolder === null} onClick={pick}>
              <Icon name="folder-open" cls="ico-sm" />
              {t("welcome.openFolder")}
            </Button>
            {tutorial.desktop && <TutorialEntryButtons entry={tutorial} ui="welcome" onRestart={() => setRestartAsk(true)} />}
          </div>
        </div>
        {tutorial.desktop && <TutorialEntryMessages entry={tutorial} hideFailure={restartAsk} />}
        {restartAsk && tutorial.state?.project && (
          <TutorialRestartDialog entry={tutorial} path={tutorial.state.project.path} desktop onClose={() => setRestartAsk(false)} />
        )}
        {recent?.lastMissing && (
          <InlineMessage tone="warning" uiId="welcome-last-missing" title={t("welcome.lastMissing")}>
            <code className="st-path" title={recent.lastMissing.path}>{recent.lastMissing.display}</code>
          </InlineMessage>
        )}
        <section className="wl-recent" aria-labelledby="wl-recent-h">
          <h2 id="wl-recent-h" className="wl-recent-h">{t("welcome.recent")}</h2>
          {recent === null ? (
            <InlineMessage tone="danger" uiId="welcome-recent-failed">{t("welcome.listFailed")}</InlineMessage>
          ) : recent === undefined ? null : recent.projects.length === 0 ? (
            <p className="wl-empty" data-ui="welcome-recent-empty">{t("welcome.recentEmpty")}</p>
          ) : (
            <RecentProjectList ui="welcome-recent-list" projects={recent.projects} disabled={leaving} onOpen={(project) => void open(project)} onRemove={(project) => void remove(project)} />
          )}
        </section>
      </div>
    </div>
  );
}
