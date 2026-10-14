import type { SettingsProblem, SettingsSnapshot, StartupLocations } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { Button } from "../ui";

const LOCATION_KEYS = ["data_dir", "global_dir", "global_cache_dir"] as const;
type LocationKey = (typeof LOCATION_KEYS)[number];
const isLocationKey = (key: string | null): key is LocationKey => (LOCATION_KEYS as readonly (string | null)[]).includes(key);
const wholeFile = (reason: SettingsProblem["reason"] | null) => reason === "unparseable" || reason === "unreadable";

/** The locations the process uses by default because their key (or the whole file) was faulty when `serve` started. */
function defaultedAtStart(startup: StartupLocations | null): LocationKey[] {
  if (!startup) return [];
  return LOCATION_KEYS.filter((key) => startup[key].source === "default" && startup[key].problem !== null);
}

/**
 * The workbench's banner for a faulty config.toml (desktop-app ticket 10, user decision 2026-10-14): at the top of
 * every view while there is something to say, gone by itself once there is not. It cannot be dismissed: it is one or
 * two lines, and a workbench that runs on another data location than the file names must not be able to hide that.
 *
 * Two parts, and they come from different things:
 *   - Where the running process keeps its data comes only from `settings.startup`, fixed when `serve` started: a
 *     warning when project data, or the global directories (Mail, credentials, log), are in their default location
 *     because the file was faulty then — it stays after the file is repaired, until a restart, and it says so.
 *   - The file as it is now (`settings.problems`) gives the quieter line: the file cannot be read now (the settings
 *     page is read-only; the running workbench is not affected), other faulty keys with their defaults, a location key
 *     that became faulty while running (its location is still the one of the start), or a `data_dir` that is not used
 *     because `--data-dir` was given.
 * Only key names, never a value; and a way to the settings page, which lists the problems with their reasons.
 */
export function ConfigProblemsBanner({ settings, onOpenSettings }: { settings: SettingsSnapshot | null; onOpenSettings: () => void }) {
  const { t } = useTranslation();
  if (!settings) return null;
  const startup = settings.startup;
  const defaulted = defaultedAtStart(startup);
  const project = defaulted.includes("data_dir");
  const global = defaulted.some((key) => key !== "data_dir");
  const flagIgnored = startup?.data_dir.source === "flag" && startup.data_dir.problem !== null;
  const atStartFile = defaulted.some((key) => wholeFile(startup?.[key].problem ?? null));
  const atStartKeys = defaulted.filter((key) => !wholeFile(startup?.[key].problem ?? null));

  const fileNow = settings.problems.some((problem) => problem.key === null);
  const keysNow = [...new Set(settings.problems.flatMap((problem) => (problem.key === null ? [] : [problem.key])))];
  // A location key the warning already names, or the `data_dir` that --data-dir overrides, is not repeated.
  const locationNow = keysNow.filter((key) => isLocationKey(key) && !defaulted.includes(key) && !(key === "data_dir" && flagIgnored));
  const otherNow = keysNow.filter((key) => !isLocationKey(key));

  const warning = project || global;
  const quiet = fileNow || otherNow.length > 0 || locationNow.length > 0 || flagIgnored;
  if (!warning && !quiet) return null;
  const title = project && global ? t("settings.banner.bothTitle") : project ? t("settings.banner.projectTitle") : t("settings.banner.globalTitle");
  const quietParts = [
    ...(fileNow ? [t("settings.banner.fileNow")] : []),
    ...(flagIgnored ? [t("settings.banner.flagIgnored")] : []),
    ...(locationNow.length > 0 ? [t("settings.banner.locationNow", { keys: locationNow.join(", ") })] : []),
    ...(otherNow.length > 0 ? [t("settings.banner.otherTitle", { count: otherNow.length, keys: otherNow.join(", ") })] : []),
  ];
  return (
    <div className={"config-banner " + (warning ? "location" : "keys")} data-ui="config-problems-banner" data-severity={warning ? "data-location" : "keys"} role={warning ? "alert" : "status"}>
      <Icon name={warning ? "triangle-alert" : "info"} cls="ico-sm" />
      <div className="config-banner-text">
        {warning && (
          <span className="config-banner-row" data-ui="config-problems-location">
            <strong>{title}</strong>{" "}
            {[...(atStartFile ? [t("settings.banner.startupFile")] : []), ...(atStartKeys.length > 0 ? [t("settings.banner.startupKeys", { keys: atStartKeys.join(", ") })] : []), t("settings.banner.restart")].join(" ")}
          </span>
        )}
        {quiet && (
          <span className="config-banner-row" data-ui="config-problems-now">
            {quietParts.join(" ")}
          </span>
        )}
      </div>
      <Button unstyled className="config-banner-open" data-ui="config-problems-open-settings" onClick={onOpenSettings}>
        {t("settings.banner.open")}
      </Button>
    </div>
  );
}
