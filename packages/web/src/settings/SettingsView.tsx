import {
  type DiagnosticsInfo,
  isEmailAddress,
  isAbsoluteOnAnyPlatform,
  SETTING_KEYS,
  SETTINGS_GROUPS,
  SETTINGS_LOG_LEVELS,
  SETTINGS_SCHEMA,
  SETTINGS_UI_ACCENTS,
  SETTINGS_UI_DENSITIES,
  SETTINGS_UI_LANGUAGES,
  SETTINGS_UI_THEMES,
  type SettingChangeRefusal,
  type SettingChangeRequest,
  type SettingKey,
  type SettingsGroup,
  type SettingsProblem,
  type SettingsSnapshot,
} from "@argelanderspace/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingChangeFailure } from "../api/settings";
import { type Preferences, type SettingsNotice, usePreferences } from "../argelander/preferences";
import { useWorkspace } from "../argelander/workspace";
import { ACCENTS, type ThemeName } from "../argelander/theme";
import { Icon } from "../lib/icons";
import { ActionButton, Badge, Button, IconButton, InlineMessage } from "../ui";
import { AdsCredential } from "./AdsCredential";
import { fetchDiagnostics } from "../api/diagnostics";
import { useHostRequest } from "../host";
import { DiagnosticsExportDialog } from "./DiagnosticsExport";
import { EnvironmentCheck, useEnvironment } from "./EnvironmentCheck";
import "./settings.css";

/**
 * The settings page (desktop-app tickets 10, 11): one group at a time, the groups listed at the left. Appearance,
 * Project, Services (the ADS token, ticket 12, and the contact email), TeX & environment (the TeX directory and the
 * environment check, ticket 13), Copilot, Mail, Diagnostics (the log folder, the log level and the diagnostics bundle,
 * ticket 14) and Advanced have their rows. Every value comes from the settings endpoint and every change is one key of
 * config.toml; a save is acknowledged, and a refused one explained, by a floating notice at the foot of the page
 * (`SettingsNotices`), never inside the row.
 */

/** The groups this page fills; the others show one line saying so. */
const FILLED: ReadonlySet<SettingsGroup> = new Set(["appearance", "project", "services", "tex", "copilot", "mail", "diagnostics", "advanced"]);

/**
 * The desktop app's own controls (desktop-app ticket 17): opening the config file in the system's editor and showing
 * the log folder are native requests to the desktop host (`useHostRequest`); the request names no path — the host
 * knows its config file and log folder. In a browser there is no host, and the page shows the path and a copy action.
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
  must_be_email: "settings.problems.reason.must_be_email",
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

/** A native request from a button: a request the host did not take is said in the page's floating notice. */
function askOrSay(ask: () => Promise<boolean>, notify: (text: string) => void, failed: string): void {
  void ask().then((ok) => {
    if (!ok) notify(failed);
  });
}

/**
 * The config file: its path (the home written as `~` by the server), and in the desktop app the button that opens it
 * in the system's editor, in a browser a copy action.
 */
function ConfigPath({ P, settings, rowKey }: { P: Preferences; settings: SettingsSnapshot; rowKey?: SettingKey }) {
  const { t } = useTranslation();
  const path = settings.path;
  const openConfig = useHostRequest("open_config_file");
  if (openConfig !== null) {
    const button = (
      <Button data-ui="open-config-file" data-ui-key={rowKey} onClick={() => askOrSay(openConfig, P.notify, t("settings.host.requestFailed"))}>
        {t("settings.configFile.openInEditor")}
      </Button>
    );
    // Under a row the page cannot change, the button alone (approved prototype); at the head of the page, with the path.
    if (rowKey !== undefined) return button;
    return (
      <>
        <code className="st-path" data-ui="config-file-path" title={path}>{settings.pathDisplay}</code>
        {button}
      </>
    );
  }
  return (
    <>
      <code className="st-path" data-ui="config-file-path" title={path}>{settings.pathDisplay}</code>
      <ActionButton
        mode="icon"
        iconName="copy"
        iconSize="small"
        tooltipAlign="end"
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

function Row({ state, k, label, control, hint, fileOnly, extra }: { state: RowState; k: SettingKey; label: string; control: (disabled: boolean) => ReactNode; hint?: ReactNode; fileOnly?: boolean; extra?: ReactNode }) {
  const { t } = useTranslation();
  const { P, settings, locked } = state;
  const bad = settings.problems.some((problem) => problem.key === k);
  const refusal: SettingChangeRefusal | undefined = settings.uneditable[k];
  const fromFile = settings.sources[k] === "file";
  const canRestore = !fileOnly && !locked && refusal === undefined && (fromFile || bad);
  const restart = SETTINGS_SCHEMA[k].restart;
  const pending = settings.restartPending.includes(k);
  // Given on serve's command line (`--port`, `--data-dir`): the file's value does not apply to this run.
  const flag = k === "port" ? "--port" : k === "data_dir" ? "--data-dir" : null;
  const fromFlag = flag !== null && settings.running.from_flag.includes(k as "port" | "data_dir");
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
          {restart && !pending && <Badge>{t("settings.row.restart")}</Badge>}
          {pending && (
            <span className="st-pill warn" data-ui="setting-pending-restart" data-ui-key={k}>
              <Icon name="rotate-cw" cls="ico-sm" />
              {fileOnly ? t("settings.row.pendingRestartFile") : t("settings.row.pendingRestart")}
            </span>
          )}
          {fileOnly && <Badge>{t("settings.row.fileOnly")}</Badge>}
        </div>
        {hint && <div className="st-hint">{hint}</div>}
        {fromFlag && (
          <div className="st-hint" data-ui="setting-from-flag" data-ui-key={k}>
            {t("settings.row.fromFlag", { flag })}
          </div>
        )}
        {pending && <RunningValue settings={settings} k={k} />}
      </div>
      <div className={"st-control" + (fileOnly ? " st-control-path" : "")}>
        {control(locked || refusal !== undefined)}
        {!fileOnly && <span className="st-restore-slot">
          {canRestore && (
            <ActionButton
              mode="icon"
              iconName="rotate-ccw"
              iconSize="small"
              tooltipAlign="end"
              data-ui="restore-default"
              data-ui-key={k}
              label={t("settings.restore.label", { key: k })}
              tooltip={t("settings.restore.tooltip")}
              onClick={() => void P.change(k, { reset: true }, { fromSettingsPage: true })}
            />
          )}
        </span>}
      </div>
      {refusal !== undefined && !settings.readonly && (
        <div className="st-row-wide">
          <InlineMessage tone="warning" uiId="setting-unsafe" title={t("settings.uneditable.title", { key: k })}>
            {why ? t(why) : t("settings.uneditable.reason.other")} {t("settings.uneditable.tail")}
            <div className="st-inline-actions">
              <ConfigPath P={P} settings={settings} rowKey={k} />
            </div>
          </InlineMessage>
        </div>
      )}
      {extra && <div className="st-row-wide">{extra}</div>}
    </div>
  );
}

/** What the process still uses for a restart-only key changed since it started (`SettingsSnapshot.running`). */
function RunningValue({ settings, k }: { settings: SettingsSnapshot; k: SettingKey }) {
  const { t } = useTranslation();
  const running = settings.running;
  const shown =
    k === "port"
      ? running.port === null ? null : { display: String(running.port), path: String(running.port) }
      : k === "data_dir" || k === "global_dir" || k === "global_cache_dir"
        ? running[k]
        : null;
  if (shown === null) return null;
  return (
    <div className="st-hint st-still" data-ui="setting-still-in-use" data-ui-key={k}>
      {t("settings.row.stillUsing")}<code className="st-path" title={shown.path}>{shown.display}</code>
    </div>
  );
}

function Switch({ on, onChange, label, ui, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; ui: string; disabled: boolean }) {
  return (
    <Button unstyled data-ui={ui} role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={"tweak-switch" + (on ? " on" : "")} onClick={() => onChange(!on)}>
      <span />
    </Button>
  );
}

/**
 * A text setting: typed freely, written on Enter or when the field is left. Emptied, the key is restored to its
 * default (the line goes from the file). A value the page can tell is wrong is not sent and is explained under the
 * field; a refused save keeps the typed text (Enter retries; Escape goes back to the saved value).
 */
function TextSetting({ state, k, value, ui, label, disabled, validate, placeholder, mono, numeric, type = "text" }: {
  state: RowState; k: SettingKey; value: string; ui: string; label: string; disabled: boolean;
  validate?: (text: string) => string | null; placeholder?: string; mono?: boolean; numeric?: boolean; type?: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  // The value the field showed when editing began: the draft differs from it while the person is typing.
  const base = useRef(value);
  // The file's value changed while a draft was being typed: the draft stays, and the field says so.
  const [changedOutside, setChangedOutside] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The text last sent: the value that comes back for it (a default after clearing, 1870 for "01870") is this
  // field's own change, not one made outside.
  const submitted = useRef<string | null>(null);
  useEffect(() => {
    const typed = draftRef.current;
    if (typed === base.current || typed.trim() === value || typed.trim() === submitted.current) {
      submitted.current = null;
      setDraft(value);
      setError(null);
      setChangedOutside(false);
    } else {
      setChangedOutside(true);
    }
    base.current = value;
  }, [value]);
  const commit = () => {
    const text = draft.trim();
    // Judged against the file's value now, which may have changed while typing.
    if (text === value) {
      setChangedOutside(false);
      return;
    }
    let change: SettingChangeRequest;
    if (text === "") {
      change = { reset: true };
    } else {
      const wrong = validate?.(text) ?? null;
      setError(wrong);
      if (wrong) return;
      change = { set: numeric ? Number(text) : text };
    }
    setError(null);
    setChangedOutside(false);
    submitted.current = text;
    void state.P.change(k, change, HERE);
  };
  return (
    <div className="st-text">
      <input
        data-ui={ui}
        className={"plan-field-input st-input" + (mono ? " mono" : "")}
        type={type}
        inputMode={numeric ? "numeric" : undefined}
        spellCheck={false}
        autoComplete="off"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        aria-invalid={error !== null}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
          if (e.key === "Escape") {
            setDraft(value);
            setError(null);
            setChangedOutside(false);
          }
        }}
      />
      {changedOutside && (
        <div className="st-hint st-changed-outside" role="status" data-ui="setting-changed-outside" data-ui-key={k}>
          {t("settings.row.changedOutside")}
        </div>
      )}
      {error && (
        <div className="st-field-error" role="alert" data-ui="setting-field-error" data-ui-key={k}>
          <Icon name="circle-alert" cls="ico-sm" />
          {error}
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

/** A change made on this page: the page acknowledges it with the "written" notice. */
const HERE = { fromSettingsPage: true } as const;

function Appearance({ state }: { state: RowState }) {
  const { t } = useTranslation();
  const { tweaks } = state.P;
  const setTweak: Preferences["setTweak"] = (key, value) => state.P.setTweak(key, value, HERE);
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
      {/* `ui.labels` (show labels) is not shown for now (user decision 2026-10-14, desktop-app ticket 10): the key stays
          in the schema and is read, written and checked as before, until its meaning is defined. When the file has it
          wrong, a row without a control appears so that the key can still be restored to its default from here. */}
      {state.settings.problems.some((problem) => problem.key === "ui.labels") && (
        <Row state={state} k="ui.labels" label={t("settings.appearance.labels")} control={() => (
          <span className="st-hidden-note" data-ui="labels-hidden-note">{t("settings.appearance.labelsHidden")}</span>
        )} />
      )}
    </>
  );
}

function Project({ state }: { state: RowState }) {
  const { t } = useTranslation();
  const { settings } = state;
  const dataDir = String(settings.values.data_dir ?? "");
  const root = settings.running.project_root;
  return (
    <>
      {/* The project is the directory serve was started in: shown, not stored in the file (the desktop app's "open
          another folder" belongs to its host, a later ticket). */}
      <div className="st-row" data-ui="setting-row" data-ui-key="project-root">
        <div className="st-row-main">
          <div className="st-label"><span>{t("settings.project.current")}</span></div>
          <div className="st-hint">{t("settings.project.currentBrowser")}</div>
          <div className="st-badges"><Badge>{t("settings.row.notInFile")}</Badge></div>
        </div>
        <div className="st-control st-control-path">
          {root && <code className="st-path" data-ui="project-root-path" title={root.path}>{root.display}</code>}
        </div>
      </div>
      <Row state={state} k="data_dir" label={t("settings.project.dataDir")}
        hint={settings.restartPending.includes("data_dir") || settings.running.data_dir === null ? undefined : (
          <span data-ui="data-dir-in-use">{t("settings.row.inUse")}<code className="st-path" title={settings.running.data_dir.path}>{settings.running.data_dir.display}</code></span>
        )}
        control={(disabled) => (
          <TextSetting state={state} k="data_dir" ui="data-dir-input" label={t("settings.project.dataDir")} mono disabled={disabled} value={dataDir}
            validate={(text) => (isAbsoluteOnAnyPlatform(text) ? t("settings.project.absolute") : null)} />
        )} />
      <Row state={state} k="auto_ingest_arxiv" label={t("settings.project.autoIngest")} control={(disabled) => (
        <Switch ui="auto-ingest-switch" label={t("settings.project.autoIngest")} disabled={disabled} on={settings.values.auto_ingest_arxiv !== false}
          onChange={(on) => void state.P.change("auto_ingest_arxiv", { set: on }, HERE)} />
      )} />
    </>
  );
}

function Services({ state }: { state: RowState }) {
  const { t } = useTranslation();
  const { settings } = state;
  return (
    <>
      {/* The ADS token, first in the group as in the prototype; the notice for a leftover ads_dev_key is inside its row. */}
      <AdsCredential P={state.P} legacy={settings.legacy.includes("ads_dev_key")} />
      <Row state={state} k="contact_email" label={t("settings.services.contactEmail")} hint={t("settings.services.contactNote")}
        control={(disabled) => (
          <TextSetting state={state} k="contact_email" ui="contact-email-input" type="email" label={t("settings.services.contactEmail")} disabled={disabled}
            value={String(settings.values.contact_email ?? "")} placeholder={t("settings.services.contactPlaceholder")}
            validate={(text) => (isEmailAddress(text) ? null : t("settings.services.notEmail"))} />
        )} />
    </>
  );
}

/**
 * TeX & environment (desktop-app ticket 13): the TeX directory (`tex_dir`, an absolute path; emptied = search
 * automatically), what is the matter with it when it is set, and the environment check. Saving the directory checks
 * again; nothing needs a restart. (Choosing the folder in a dialog belongs to the desktop app's host.)
 */
function Tex({ state }: { state: RowState }) {
  const { t } = useTranslation();
  const { settings } = state;
  const texDir = String(settings.values.tex_dir ?? "");
  const env = useEnvironment(texDir);
  const dirState = env.report?.texDir.state;
  const dirProblem =
    dirState === "missing"
      ? "settings.tex.texDirMissing"
      : dirState === "no_latexmk"
        ? "settings.tex.texDirNoLatexmk"
        : dirState === "not_absolute"
          ? "settings.tex.texDirNotAbsolute"
          : null;
  return (
    <>
      <Row state={state} k="tex_dir" label={t("settings.tex.texDir")}
        control={(disabled) => (
          <TextSetting state={state} k="tex_dir" ui="tex-dir-input" label={t("settings.tex.texDir")} mono disabled={disabled} value={texDir}
            placeholder={t("settings.tex.texDirPlaceholder")}
            validate={(text) => (isAbsoluteOnAnyPlatform(text) ? null : t("settings.tex.texDirAbsolute"))} />
        )}
        extra={dirProblem !== null && texDir !== "" && (
          <InlineMessage tone="warning" uiId="tex-dir-problem" title={t(`${dirProblem}.title`)}>{t(`${dirProblem}.body`)}</InlineMessage>
        )} />
      <EnvironmentCheck state={env} />
    </>
  );
}

/** An entry to a setting kept outside config.toml: the Copilot's providers, the Mail accounts. */
function Entry({ kind }: { kind: "copilot" | "mail" }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const copilot = kind === "copilot";
  const open = copilot ? ws.openCopilotSettings : ws.openMailAccounts;
  return (
    <div className="st-row" data-ui="setting-row" data-ui-key={copilot ? "copilot-provider" : "mail-accounts"}>
        <div className="st-row-main">
          <div className="st-label"><span>{copilot ? t("settings.entries.provider") : t("settings.entries.mailAccounts")}</span></div>
          <div className="st-badges"><Badge>{t("settings.row.notInFile")}</Badge></div>
        </div>
        <div className="st-control">
          <Button data-ui={copilot ? "open-provider-settings" : "open-mail-accounts"} disabled={open === undefined} onClick={() => open?.()}>
            {copilot ? t("settings.entries.openProvider") : t("settings.entries.openMailAccounts")}
          </Button>
        </div>
    </div>
  );
}

function Advanced({ state }: { state: RowState }) {
  const { t } = useTranslation();
  const { settings } = state;
  const port = (text: string) => (/^\d+$/.test(text) && Number(text) <= 65535 ? null : t("settings.advanced.portRange"));
  const globalRow = (k: "global_dir" | "global_cache_dir") => (
    <Row state={state} k={k} fileOnly label={k === "global_dir" ? t("settings.advanced.globalData") : t("settings.advanced.globalCache")}
      control={() =>
        // Changed in the file since the start: the new value here, the one still in use under the label.
        settings.restartPending.includes(k) ? (
          <code className="st-path" data-ui="global-dir-path" data-ui-key={k} data-state="file">{String(settings.values[k] ?? t("settings.advanced.defaultLocation"))}</code>
        ) : (
          <code className="st-path" data-ui="global-dir-path" data-ui-key={k} title={settings.running[k].path}>{settings.running[k].display}</code>
        )
      } />
  );
  return (
    <>
      <Row state={state} k="port" label={t("settings.advanced.port")}
        hint={settings.restartPending.includes("port") || settings.running.port === null ? undefined : (
          <span data-ui="port-in-use">{t("settings.row.inUse")}<code className="st-path">{settings.running.port}</code></span>
        )}
        control={(disabled) => (
        <TextSetting state={state} k="port" ui="port-input" label={t("settings.advanced.port")} mono numeric disabled={disabled}
          value={String(settings.values.port ?? "")} validate={port} />
      )} />
      {globalRow("global_dir")}
      {globalRow("global_cache_dir")}
    </>
  );
}

/**
 * Diagnostics (desktop-app ticket 14), as in the approved prototype: where the log is (in the browser its path and a
 * copy action; the desktop app's "show the log folder" belongs to its host), the log level (it takes effect at once,
 * no restart) and the diagnostics bundle. These rows are there whatever the state of the config file, except the
 * level, which is a key of the file.
 */
function Diagnostics({ state }: { state: RowState }) {
  const { t } = useTranslation();
  const { P, settings } = state;
  const [info, setInfo] = useState<DiagnosticsInfo | null | "loading">("loading");
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    fetchDiagnostics(ac.signal).then(setInfo, () => {});
    return () => ac.abort();
  }, []);
  const dir = info !== null && info !== "loading" ? info.logDir : null;
  const showLogs = useHostRequest("open_log_folder");
  return (
    <>
      <div className="st-row" data-ui="setting-row" data-ui-key="log-folder">
        <div className="st-row-main">
          <div className="st-label"><span>{t("settings.diagnostics.logFolder")}</span></div>
        </div>
        <div className="st-control st-control-path">
          {dir !== null ? (
            <code className="st-path" data-ui="log-folder-path" title={dir.path}>{dir.display}</code>
          ) : (
            <span className="st-path" data-ui="log-folder-path" data-state={info === null ? "unknown" : "loading"}>
              {info === null ? t("settings.diagnostics.logFolderUnknown") : "…"}
            </span>
          )}
          {showLogs !== null ? (
            <Button data-ui="show-log-folder" onClick={() => askOrSay(showLogs, P.notify, t("settings.host.requestFailed"))}>
              {t("settings.diagnostics.showLogs")}
            </Button>
          ) : (
            dir !== null && (
              <ActionButton
                mode="icon"
                iconName="copy"
                iconSize="small"
                tooltipAlign="end"
                data-ui="copy-log-path"
                label={t("settings.diagnostics.copyPath")}
                tooltip={t("settings.diagnostics.copyPath")}
                onClick={() => void copyText(dir.path).then((ok) => P.notify(ok ? t("settings.configFile.pathCopied") : t("settings.configFile.copyFailed")))}
              />
            )
          )}
        </div>
      </div>
      <Row state={state} k="log_level" label={t("settings.diagnostics.logLevel")} control={(disabled) => (
        <select data-ui="log-level-select" className="plan-field-input st-select" aria-label={t("settings.diagnostics.logLevel")} disabled={disabled}
          value={String(settings.values.log_level ?? "info")} onChange={(e) => void P.change("log_level", { set: e.target.value }, HERE)}>
          {SETTINGS_LOG_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      )} />
      <div className="st-row" data-ui="setting-row" data-ui-key="export-diagnostics">
        <div className="st-row-main">
          <div className="st-label"><span>{t("settings.diagnostics.exportRow")}</span></div>
        </div>
        <div className="st-control">
          <Button data-ui="export-diagnostics-open" onClick={() => setExporting(true)}>{t("settings.diagnostics.exportOpen")}</Button>
        </div>
      </div>
      {exporting && <DiagnosticsExportDialog onClose={() => setExporting(false)} />}
    </>
  );
}

function GroupRows({ group, state }: { group: SettingsGroup; state: RowState }) {
  switch (group) {
    case "appearance":
      return <Appearance state={state} />;
    case "project":
      return <Project state={state} />;
    case "services":
      return <Services state={state} />;
    case "tex":
      return <Tex state={state} />;
    case "diagnostics":
      return <Diagnostics state={state} />;
    case "advanced":
      return <Advanced state={state} />;
    default:
      return null;
  }
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
            <ConfigPath P={P} settings={settings} />
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
            {!FILLED.has(group) ? (
              <p className="st-note" data-ui="settings-group-empty">{t("settings.groupEmpty")}</p>
            ) : group === "copilot" || group === "mail" ? (
              // Kept outside config.toml: shown whatever the state of the file.
              <Entry kind={group} />
            ) : settings ? (
              <GroupRows group={group} state={{ P, settings, locked: settings.readonly || unreachable }} />
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

function FailedNotice({ notice, onDismiss, notify }: { notice: Extract<SettingsNotice, { kind: "failed" }>; onDismiss: () => void; notify: (text: string) => void }) {
  const { t } = useTranslation();
  // The desktop app: the file can be opened from here (approved prototype); a browser has no such action.
  const openConfig = useHostRequest("open_config_file");
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
      {openConfig !== null && (
        <Button data-ui="settings-save-failed-open-config" onClick={() => askOrSay(openConfig, notify, t("settings.host.requestFailed"))}>
          {t("settings.configFile.openInEditor")}
        </Button>
      )}
      <ActionButton mode="icon" iconName="x" iconSize="small" data-ui="settings-save-failed-dismiss" label={t("settings.notices.dismiss")} tooltip={t("settings.notices.dismiss")} onClick={onDismiss} />
    </div>
  );
}

/** The floating notices of the settings: rendered once by the Shell, so a change made anywhere reports here. */
export function SettingsNotices({ notices, dismiss, notify }: Pick<Preferences, "notices" | "dismiss" | "notify">) {
  const { t } = useTranslation();
  return (
    <div className="st-notices" aria-live="polite" data-ui="settings-notices">
      {notices.map((notice) =>
        notice.kind === "failed" ? (
          <FailedNotice key={notice.id} notice={notice} onDismiss={() => dismiss(notice.id)} notify={notify} />
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
