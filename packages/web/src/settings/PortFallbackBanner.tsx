import { useTranslation } from "react-i18next";
import { useHostInfo } from "../host";
import { Icon } from "../lib/icons";

/**
 * The desktop app listens on another port than the configured one this time (desktop-app ticket 17): the configured
 * port was taken when it started. The links the CLI prints point to the configured port, so they do not open this
 * window — said at the top of every view, in the warning style of the config banner, for as long as this run lasts
 * (it cannot be dismissed: the next link an agent gives would fail without a word otherwise). When another
 * ArgelanderSpace holds the port, the links open that one, and the banner says so.
 */
export function PortFallbackBanner() {
  const { t } = useTranslation();
  const host = useHostInfo();
  const fallback = host?.mode === "desktop" ? host.portFallback : null;
  if (fallback === null) return null;
  return (
    <div className="config-banner location" data-ui="port-fallback-banner" data-occupant={fallback.occupant} role="alert">
      <Icon name="triangle-alert" cls="ico-sm" />
      <div className="config-banner-text">
        <span className="config-banner-row">
          <strong>{t("settings.host.portFallback.title")}</strong>{" "}
          {t("settings.host.portFallback.body", { configured: fallback.configured, actual: fallback.actual })}
        </span>
        {fallback.occupant === "argelanderspace" && (
          <span className="config-banner-row" data-ui="port-fallback-own">
            {t("settings.host.portFallback.ownServer", { configured: fallback.configured })}
          </span>
        )}
      </div>
    </div>
  );
}
