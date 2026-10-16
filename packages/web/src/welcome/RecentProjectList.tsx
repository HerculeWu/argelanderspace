import type { HostRecentProject } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton, Badge, Button } from "../ui";
import { openedAtText } from "./opened-at";
import "../settings/settings.css";
import "./welcome.css";

/**
 * The recently opened projects as the welcome page lists them (desktop-app ticket 18, approved prototype): each one an
 * open button (folder name, path, last opened) and a remove icon; a folder that is gone is marked and cannot be
 * opened, only removed. The settings page lists the same rows with a project open (desktop-app ticket 19).
 */
export function RecentProjectList({ ui, projects, disabled, onOpen, onRemove }: {
  ui: string;
  projects: HostRecentProject[];
  disabled: boolean;
  onOpen: (project: HostRecentProject) => void;
  onRemove: (project: HostRecentProject) => void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  return (
    <ul className="wl-list" data-ui={ui}>
      {projects.map((project) => (
        <li key={project.path} className={`wl-item${project.missing ? " missing" : ""}`} data-ui="recent-project" data-ui-key={project.path} data-missing={project.missing ? "1" : "0"}>
          <Button unstyled className="wl-open" data-ui="recent-project-open" data-ui-key={project.path} disabled={project.missing || disabled} onClick={() => onOpen(project)}>
            <span className="wl-name">
              <Icon name="folder" cls="ico-sm" />
              {project.name}
              {project.missing && <Badge>{t("welcome.missing")}</Badge>}
            </span>
            <code className="st-path" title={project.path}>{project.display}</code>
            <span className="wl-when">{t("welcome.openedAt", { when: openedAtText(project.openedAt, language) })}</span>
          </Button>
          <ActionButton mode="icon" iconName="x" iconSize="small" data-ui="recent-project-remove" data-ui-key={project.path} label={t("welcome.remove", { name: project.name })} tooltip={t("welcome.remove", { name: project.name })} disabled={disabled} onClick={() => onRemove(project)} />
        </li>
      ))}
    </ul>
  );
}
