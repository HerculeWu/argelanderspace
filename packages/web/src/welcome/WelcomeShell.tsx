import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PreferencesProvider, usePreferencesState } from "../argelander/preferences";
import { TweaksPopover } from "../argelander/TweaksPopover";
import { Icon } from "../lib/icons";
import { SettingsNotices } from "../settings/SettingsView";
import { ActionButton } from "../ui";
import { WelcomePage } from "./WelcomePage";

/**
 * The desktop app with no project open (desktop-app ticket 18): the title bar keeps the theme switch and the
 * appearance quick settings — the same `[ui]` settings as the workbench's — and the body is the welcome page. No
 * navigation rail, no panes, no Copilot: the server answers nothing of a project here.
 */
export function WelcomeShell() {
  const { t } = useTranslation();
  const preferences = usePreferencesState();
  const { tweaks, setTweak } = preferences;
  const [tweaksOpen, setTweaksOpen] = useState(false);
  return (
    <PreferencesProvider value={preferences}>
      <div className="app" data-ui="app-shell">
        <div className="titlebar" data-ui="app-titlebar">
          <div className="tb-left">
            <span className="wordmark">
              <span className="wordmark-mark">✦</span>ArgelanderSpace
            </span>
          </div>
          <div className="tb-center">{t("shell.tagline")}</div>
          <div className="tb-right" data-ui="titlebar-actions">
            <ActionButton
              mode="icon"
              iconName={tweaks.theme === "dark" ? "sun" : "moon"}
              unstyled
              className="btn icon ghost"
              data-ui="toggle-theme"
              iconSize="small"
              label={t("shell.titlebar.toggleTheme")}
              onClick={() => setTweak("theme", tweaks.theme === "dark" ? "light" : "dark")}
            />
            <ActionButton
              mode="icon"
              iconName="sliders-horizontal"
              unstyled
              className="btn icon ghost"
              data-ui="open-tweaks"
              iconSize="small"
              label={t("shell.titlebar.tweaks")}
              tooltip={t("shell.titlebar.tweaks")}
              aria-expanded={tweaksOpen}
              onClick={() => setTweaksOpen((o) => !o)}
            />
            {tweaksOpen && <TweaksPopover tweaks={tweaks} set={setTweak} onClose={() => setTweaksOpen(false)} />}
            <div className="win-ctrl">
              <span className="win-b">
                <Icon name="minus" cls="ico-sm" />
              </span>
              <span className="win-b">
                <Icon name="square" cls="ico-sm" />
              </span>
              <span className="win-b close">
                <Icon name="x" cls="ico-sm" />
              </span>
            </div>
          </div>
        </div>
        <div className="app-body">
          <div className="main">
            <WelcomePage />
          </div>
        </div>
        <SettingsNotices notices={preferences.notices} dismiss={preferences.dismiss} notify={preferences.notify} />
      </div>
    </PreferencesProvider>
  );
}
