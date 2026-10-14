import {
  SETTING_KEYS,
  SETTINGS_GROUPS,
  SETTINGS_SCHEMA,
  SETTINGS_UI_ACCENTS,
  SETTINGS_UI_DENSITIES,
  SETTINGS_UI_LANGUAGES,
  SETTINGS_UI_THEMES,
  type SettingChangeRefusal,
  type SettingKey,
  type SettingsGroup,
  type SettingsProblem,
  type SettingsSnapshot,
} from "@argelanderspace/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingChangeFailure } from "../api/settings";
import { type Preferences, type SettingsNotice, usePreferences } from "../argelander/preferences";
import { ACCENTS, type ThemeName } from "../argelander/theme";
import { Icon } from "../lib/icons";
import { ActionButton, Badge, Button, IconButton, InlineMessage } from "../ui";
import "./settings.css";

/**
 * The settings page (desktop-app ticket 10): one group at a time, the groups listed at the left. This ticket fills
 * the Appearance group; the others are listed and say that they have nothing yet. Every value comes from the
 * settings endpoint and every change is one key of config.toml; a save is acknowledged, and a refused one explained,
 * by a floating notice at the foot of the page (`SettingsNotices`), never inside the row.
 */

/** `cli` belongs to the desktop app only; a page in a browser does not list it. */
const BROWSER_GROUPS = SETTINGS_GROUPS.filter((group) => group !== "cli");

const GROUP_ICON: Record<SettingsGroup, string> = {
  appearance: "palette",
  project: "folder-open",
  services: "key-round",
  tex: "wrench",
  copilot: "sparkles",
  mail: "mail",
  cli: "terminal",
  diagnostics: "activity",
  advanced: "sliders-horizontal",
};
const GROUP_LABEL = {
  appearance: "settings.groups.appearance",
  project: "settings.groups.project",
  services: "settings.groups.services",
  tex: "settings.groups.tex",
  copilot: "settings.groups.copilot",
  mail: "settings.groups.mail",
  cli: "settings.groups.cli",
  diagnostics: "settings.groups.diagnostics",
  advanced: "settings.groups.advanced",
} as const satisfies Record<SettingsGroup, string>;

const PROBLEM_REASON = {
  wrong_type: "settings.problems.reason.wrong_type",
  out_of_range: "settings.problems.reason.out_of_range",
  not_one_of: "settings.problems.reason.not_one_of",
  must_be_relative: "settings.problems.reason.must_be_relative",
  must_be_absolute: "settings.problems.reason.must_be_absolute",
  not_a_table: "settings.problems.reason.not_a_table",
  unparseable: "settings.problems.reason.unparseable",
  unreadable: "settings.problems.reason.unreadable",
} as const satisfies Record<SettingsProblem["reason"], string>;

/** How the file is written, as the reason a key cannot be changed by the page. */
const LAYOUT_REASON = {
  dotted_key: "settings.uneditable.reason.dotted_key",
  inline_table: "settings.uneditable.reason.inline_table",
  multiline_string: "settings.uneditable.reason.multiline_string",
  array_of_tables: "settings.uneditable.reason.array_of_tables",
  not_a_scalar: "settings.uneditable.reason.not_a_scalar",
  table_not_a_table: "settings.uneditable.reason.table_not_a_table",
  duplicate_key: "settings.uneditable.reason.duplicate_key",
  unsupported_layout: "settings.uneditable.reason.unsupported_layout",
  self_check_failed: "settings.uneditable.reason.self_check_failed",
  invalid_encoding: "settings.uneditable.reason.invalid_encoding",
} as const;
const layoutReason = (reason: SettingChangeFailure) =>
  reason in LAYOUT_REASON ? LAYOUT_REASON[reason as keyof typeof LAYOUT_REASON] : null;

const ACCENT_LABEL = {
  azure: "shell.tweaks.accents.azure",
  teal: "shell.tweaks.accents.teal",
  violet: "shell.tweaks.accents.violet",
  amber: "shell.tweaks.accents.amber",
  neutral: "shell.tweaks.accents.neutral",
} as const;
const DENSITY_LABEL = {
  compact: "shell.tweaks.density.compact",
  regular: "shell.tweaks.density.regular",
  comfy: "shell.tweaks.density.comfy",
} as const;

/** The swatch of an accent, by the browser's own colour arithmetic. */
function swatch(accent: string, theme: ThemeName): string {
  const a = ACCENTS[accent] ?? ACCENTS.azure!;
  return `oklch(${theme === "dark" ? 0.72 : 0.55} ${a.c} ${a.h})`;
}

/** The keys a problem is about: the key itself, or every key of a table that is not a table. */
function problemKeys(problem: SettingsProblem): SettingKey[] {
  if (problem.key === null) return [];
  return SETTING_KEYS.filter((key) => key === problem.key || SETTINGS_SCHEMA[key].table === problem.key);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function ConfigPath({ P, path }: { P: Preferences; path: string }) {
  const { t } = useTranslation();
  return (
    <>
      <code className="st-path" data-ui="config-file-path">{path}</code>
      <ActionButton
        mode="icon"
        iconName="copy"
        iconSize="small"
        data-ui="copy-config-path"
        label={t("settings.configFile.copyPath")}
        tooltip={t("settings.configFile.copyPath")}
        onClick={() => void copyText(path).then((ok) => P.notify(ok ? t("settings.configFile.pathCopied") : t("settings.configFile.copyFailed")))}
      />
    </>
  );
}

interface RowState {
  P: Preferences;
  settings: SettingsSnapshot;
  /** Nothing can be changed now: the file is read-only, or the server does not answer. */
  locked: boolean;
}

function Row({ state, k, label, control }: { state: RowState; k: SettingKey; label: string; control: (disabled: boolean) => ReactNode }) {
  const { t } = useTranslation();
  const { P, settings, locked } = state;
  const bad = settings.problems.some((problem) => problem.key === k);
  const refusal: SettingChangeRefusal | undefined = settings.uneditable[k];
  const fromFile = settings.sources[k] === "file";
  const canRestore = !locked && refusal === undefined && (fromFile || bad);
  const why = refusal === undefined ? null : layoutReason(refusal);
  return (
    <div className="st-row" data-ui="setting-row" data-ui-key={k}>
      <div className="st-row-main">
        <div className="st-label">
          <span>{label}</span>
          <code className="st-key">{k}</code>
        </div>
        <div className="st-badges">
          {bad ? (
            <span className="st-pill danger" data-ui="setting-invalid">
              <Icon name="circle-alert" cls="ico-sm" />
              {t("settings.source.invalid")}
            </span>
          ) : fromFile ? (
            <Badge tone="accent">{t("settings.source.file")}</Badge>
          ) : (
            <Badge>{t("settings.source.default")}</Badge>
          )}
        </div>
      </div>
      <div className="st-control">
        {control(locked || refusal !== undefined)}
        <span className="st-restore-slot">
          {canRestore && (
            <ActionButton
              mode="icon"
              iconName="rotate-ccw"
              iconSize="small"
              data-ui="restore-default"
              data-ui-key={k}
              label={t("settings.restore.label", { key: k })}
              tooltip={t("settings.restore.tooltip")}
              onClick={() => void P.change(k, { reset: true })}
            />
          )}
        </span>
      </div>
      {refusal !== undefined && !settings.readonly && (
        <div className="st-row-wide">
          <InlineMessage tone="warning" uiId="setting-unsafe" title={t("settings.uneditable.title", { key: k })}>
            {why ? t(why) : t("settings.uneditable.reason.other")} {t("settings.uneditable.tail")}
            <div className="st-inline-actions">
              <ConfigPath P={P} path={settings.path} />
            </div>
          </InlineMessage>
        </div>
      )}
    </div>
  );
}

function Segments<T extends string>({ ui, label, items, value, disabled, onChange }: { ui: string; label: string; items: { v: T; text: string }[]; value: T; disabled: boolean; onChange: (v: T) => void }) {
  return (
    <div className="tweak-seg st-seg" role="group" aria-label={label}>
      {items.map((item) => (
        <Button key={item.v} unstyled data-ui={ui} data-ui-key={item.v} disabled={disabled} aria-pressed={value === item.v} className={"tweak-seg-btn" + (value === item.v ? " on" : "")} onClick={() => onChange(item.v)}>
          {item.text}
        </Button>
      ))}
    </div>
  );
}

function Appearance({ state }: { state: RowState }) {
  const { t } = useTranslation();
  const { tweaks, setTweak } = state.P;
  return (
    <>
      <Row state={state} k="ui.language" label={t("settings.appearance.language")} control={(disabled) => (
        <Segments ui="language-option" label={t("settings.appearance.language")} disabled={disabled} value={tweaks.language ?? "zh-CN"} onChange={(v) => setTweak("language", v)}
          items={SETTINGS_UI_LANGUAGES.map((v) => ({ v, text: v === "zh-CN" ? t("shell.tweaks.language.zhCN") : t("shell.tweaks.language.en") }))} />
      )} />
      <Row state={state} k="ui.theme" label={t("settings.appearance.theme")} control={(disabled) => (
        <Segments ui="theme-option" label={t("settings.appearance.theme")} disabled={disabled} value={tweaks.theme} onChange={(v) => setTweak("theme", v)}
          items={SETTINGS_UI_THEMES.map((v) => ({ v, text: v === "dark" ? t("shell.tweaks.theme.dark") : t("shell.tweaks.theme.light") }))} />
      )} />
      <Row state={state} k="ui.accent" label={t("settings.appearance.accent")} control={(disabled) => (
        <div className="tweak-swatches" role="group" aria-label={t("settings.appearance.accent")}>
          {SETTINGS_UI_ACCENTS.map((a) => (
            <IconButton key={a} unstyled data-ui="accent-option" data-ui-key={a} disabled={disabled} label={t(ACCENT_LABEL[a])} aria-pressed={tweaks.accent === a} className={"tweak-swatch" + (tweaks.accent === a ? " on" : "")} style={{ background: swatch(a, tweaks.theme) }} icon={<span />} onClick={() => setTweak("accent", a)} />
          ))}
        </div>
      )} />
      <Row state={state} k="ui.density" label={t("settings.appearance.density")} control={(disabled) => (
        <Segments ui="density-option" label={t("settings.appearance.density")} disabled={disabled} value={tweaks.density} onChange={(v) => setTweak("density", v)}
          items={SETTINGS_UI_DENSITIES.map((v) => ({ v, text: t(DENSITY_LABEL[v]) }))} />
      )} />
      <Row state={state} k="ui.labels" label={t("settings.appearance.labels")} control={(disabled) => (
        <Button unstyled data-ui="labels-switch" role="switch" aria-checked={tweaks.labels} aria-label={t("settings.appearance.labels")} disabled={disabled} className={"tweak-switch" + (tweaks.labels ? " on" : "")} onClick={() => setTweak("labels", !tweaks.labels)}>
          <span />
        </Button>
      )} />
    </>
  );
}

export function SettingsView(_props: { paneId?: number }) {
  const { t } = useTranslation();
  const P = usePreferences();
  const { settings, unreachable } = P;
  const [group, setGroup] = useState<SettingsGroup>("appearance");
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo?.({ top: 0 });
  }, [group]);

  const keyProblems = settings ? settings.problems.filter((problem) => problem.key !== null) : [];
  const badIn = (g: SettingsGroup): number =>
    keyProblems.filter((problem) => problemKeys(problem).some((key) => SETTINGS_SCHEMA[key].group === g)).length;

  return (
    <div className="st-root" data-ui="settings-page">
      <header className="st-head">
        <h1 className="st-title">{t("settings.title")}</h1>
        {settings && (
          <div className="st-config" data-ui="config-file">
            <span className="st-config-label">{t("settings.configFile.label")}</span>
            <ConfigPath P={P} path={settings.path} />
          </div>
        )}
      </header>
      {unreachable && (
        <div className="st-banner">
          <InlineMessage tone="danger" uiId="settings-unreachable" title={t("settings.unreachable.title")}>
            {t("settings.unreachable.body")}
          </InlineMessage>
        </div>
      )}
      {settings?.readonly && (
        <div className="st-banner">
          <InlineMessage tone="danger" uiId={settings.file === "unreadable" ? "config-unreadable" : "config-unparseable"} title={settings.file === "unreadable" ? t("settings.readonly.unreadableTitle") : t("settings.readonly.unparseableTitle")}>
            {t("settings.readonly.body")}
          </InlineMessage>
        </div>
      )}
      {settings && !settings.readonly && keyProblems.length > 0 && (
        <div className="st-banner">
          <InlineMessage tone="warning" uiId="config-bad-keys" title={t("settings.problems.title", { count: keyProblems.length })}>
            {t("settings.problems.body")}
            <ul className="st-bad-list">
              {keyProblems.map((problem) => (
                <li key={`${problem.key}:${problem.reason}`} data-ui="config-bad-key" data-ui-key={String(problem.key)}>
                  <code>{problem.key}</code> · {t(PROBLEM_REASON[problem.reason])}
                </li>
              ))}
            </ul>
          </InlineMessage>
        </div>
      )}
      <div className="st-layout">
        <nav className="st-nav" data-ui="settings-groups" aria-label={t("settings.groupsLabel")}>
          {BROWSER_GROUPS.map((g) => {
            const n = badIn(g);
            const name = t(GROUP_LABEL[g]);
            return (
              <Button key={g} unstyled data-ui="settings-group" data-ui-key={g} className={"st-nav-item" + (group === g ? " on" : "")} aria-current={group === g ? "page" : undefined} aria-label={n > 0 ? t("settings.groupProblems", { name, n }) : undefined} onClick={() => setGroup(g)}>
                <Icon name={GROUP_ICON[g]} cls="ico-sm" />
                <span>{name}</span>
                {n > 0 && <span className="st-nav-count" aria-hidden="true">{n}</span>}
              </Button>
            );
          })}
        </nav>
        <div className="st-body" ref={body} data-ui="settings-group-body" data-group={group}>
          <h2 className="st-group-title">{t(GROUP_LABEL[group])}</h2>
          <div className="st-rows">
            {group !== "appearance" ? (
              <p className="st-note" data-ui="settings-group-empty">{t("settings.groupEmpty")}</p>
            ) : settings ? (
              <Appearance state={{ P, settings, locked: settings.readonly || unreachable }} />
            ) : (
              !unreachable && <p className="st-note" data-ui="settings-loading" role="status">{t("settings.loading")}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const FAILED_TEXT = {
  unparseable: "settings.notices.failed.unparseable",
  busy: "settings.notices.failed.busy",
  unreadable: "settings.notices.failed.unreadable",
  not_writable: "settings.notices.failed.not_writable",
  write_failed: "settings.notices.failed.write_failed",
  invalid_value: "settings.notices.failed.invalid_value",
  unrepresentable_value: "settings.notices.failed.invalid_value",
  unreachable: "settings.notices.failed.unreachable",
} as const;

function FailedNotice({ notice, onDismiss }: { notice: Extract<SettingsNotice, { kind: "failed" }>; onDismiss: () => void }) {
  const { t } = useTranslation();
  const why = layoutReason(notice.reason);
  const text = why
    ? t("settings.notices.failed.layout", { why: t(why) })
    : notice.reason in FAILED_TEXT
      ? t(FAILED_TEXT[notice.reason as keyof typeof FAILED_TEXT])
      : t("settings.notices.failed.not_editable");
  return (
    <div className="ag-toast view-in danger st-notice-fail" data-ui="settings-save-failed" data-ui-key={notice.key} data-reason={notice.reason} role="alert">
      <Icon name="triangle-alert" cls="ico-sm" />
      <span className="ag-toast-text">
        <strong className="st-notice-title">{t("settings.notices.failedTitle", { key: notice.key })}</strong>
        {text}
      </span>
      <ActionButton mode="icon" iconName="x" iconSize="small" data-ui="settings-save-failed-dismiss" label={t("settings.notices.dismiss")} tooltip={t("settings.notices.dismiss")} onClick={onDismiss} />
    </div>
  );
}

/** The floating notices of the settings: rendered once by the Shell, so a change made anywhere reports here. */
export function SettingsNotices({ notices, dismiss }: Pick<Preferences, "notices" | "dismiss">) {
  const { t } = useTranslation();
  return (
    <div className="st-notices" aria-live="polite" data-ui="settings-notices">
      {notices.map((notice) =>
        notice.kind === "failed" ? (
          <FailedNotice key={notice.id} notice={notice} onDismiss={() => dismiss(notice.id)} />
        ) : (
          <div key={notice.id} className="ag-toast view-in" data-ui="toast" data-ui-key={notice.kind === "saved" ? "settings-saved" : undefined} role="status">
            <Icon name={notice.kind === "saved" ? "check" : "info"} cls="ico-sm" />
            <span className="ag-toast-text">{notice.kind === "saved" ? t("settings.notices.saved") : notice.text}</span>
          </div>
        )
      )}
    </div>
  );
}
