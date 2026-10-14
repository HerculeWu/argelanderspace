import { affectsDataLocation, type SettingsSnapshot } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { Button } from "../ui";

/**
 * The workbench's banner for a faulty config.toml (desktop-app ticket 10, user decision 2026-10-14): at the top of
 * every view while the file has a problem, gone by itself once the file is repaired. It cannot be dismissed: it is
 * one line at most of the time, and a workbench that runs on another data location than the file names must not be
 * able to hide that.
 *
 * Two strengths. When the problem is about where data lives — the whole file cannot be parsed or read, or `data_dir`,
 * `global_dir` or `global_cache_dir` is faulty — it is a warning that says the default data location is open, not
 * the one the file names. Any other faulty key gets a quieter line. Either way only key names, never a value; and a
 * way to the settings page, which lists the problems with their reasons.
 */
export function ConfigProblemsBanner({ settings, onOpenSettings }: { settings: SettingsSnapshot | null; onOpenSettings: () => void }) {
  const { t } = useTranslation();
  if (!settings || settings.problems.length === 0) return null;
  const location = settings.problems.some(affectsDataLocation);
  const keys = [...new Set(settings.problems.flatMap((problem) => (problem.key === null ? [] : [problem.key])))];
  const wholeFile = settings.problems.some((problem) => problem.key === null);
  const keyList = keys.join(", ");
  return (
    <div className={"config-banner " + (location ? "location" : "keys")} data-ui="config-problems-banner" data-severity={location ? "data-location" : "keys"} role={location ? "alert" : "status"}>
      <Icon name={location ? "triangle-alert" : "info"} cls="ico-sm" />
      <div className="config-banner-text">
        {location ? (
          <>
            <strong>{t("settings.banner.locationTitle")}</strong>
            <span>
              {wholeFile ? t("settings.banner.locationFile") : null}
              {keys.length > 0 ? ` ${t("settings.banner.locationKeys", { keys: keyList })}` : null} {t("settings.banner.restart")}
            </span>
          </>
        ) : (
          <span>{t("settings.banner.otherTitle", { count: keys.length, keys: keyList })}</span>
        )}
      </div>
      <Button unstyled className="config-banner-open" data-ui="config-problems-open-settings" onClick={onOpenSettings}>
        {t("settings.banner.open")}
      </Button>
    </div>
  );
}
