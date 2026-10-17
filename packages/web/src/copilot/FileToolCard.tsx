import type { CopilotOperation, FileToolChange, FileToolRecord } from "@argelanderspace/contracts";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { getConfiguredIcon, InlineMessage } from "../ui";

/**
 * The tool card of one file or command call (copilot ticket 57, approved prototype `prototype-tools`): a collapsed
 * line (state mark, category, one-line target, result or exit code, time) that opens to the command or path, where it
 * ran, how it was allowed, the change or the output. A long output keeps its head and tail here; the whole output went
 * to the model only. Everything shown is conversation content, rendered as plain text.
 */

/**
 * Bidirectional control characters, zero-width and other invisible characters (marks, joiners, soft hyphen, Hangul
 * filler, tag characters) can make a command or a path read as something else than
 * it is: they are shown as `⟨U+202E⟩` marks with a warning style instead of being drawn (or not drawn) by the browser.
 */
const HIDDEN_CLASS =
  "[\\u00AD\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\u3164\\uFEFF\\u{E0000}-\\u{E007F}]";
const HIDDEN = new RegExp(`(${HIDDEN_CLASS})`, "u");
const HIDDEN_ONE = new RegExp(`^${HIDDEN_CLASS}$`, "u");
export function VisibleText({ text }: { text: string }) {
  if (!HIDDEN.test(text)) return <>{text}</>;
  return (
    <>
      {text.split(HIDDEN).map((part, at) =>
        HIDDEN_ONE.test(part) ? (
          <mark key={at} className="copilot-tool-ctl" data-ui="copilot-tool-control" title={`U+${part.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`}>
            ⟨U+{part.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}⟩
          </mark>
        ) : (
          <span key={at}>{part}</span>
        )
      )}
    </>
  );
}

export type FileToolState = "running" | "ok" | "fail" | "interrupted" | "declined" | "guard" | "other";

/** The state a card shows, from the operation row (the row's status, with the guard told from other refusals). */
export function fileToolState(operation: CopilotOperation): FileToolState {
  switch (operation.status) {
    case "pending":
      return "running";
    case "ok":
    case "noop":
      return "ok";
    case "error":
      return "fail";
    case "interrupted":
    case "expired":
      return "interrupted";
    case "declined":
      return "declined";
    case "rejected":
      return operation.fileTool?.guard ? "guard" : "other";
    default:
      return "other";
  }
}

export const fmtDuration = (ms: number): string =>
  ms < 950 ? `${Math.max(1, Math.round(ms / 10) * 10)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const MARK: Record<FileToolState, { cls: string; icon: string }> = {
  running: { cls: "pending", icon: "clock" },
  ok: { cls: "ok", icon: "check" },
  fail: { cls: "danger", icon: "triangle-alert" },
  guard: { cls: "danger", icon: "triangle-alert" },
  other: { cls: "danger", icon: "triangle-alert" },
  interrupted: { cls: "stopped", icon: "octagon-x" },
  declined: { cls: "stopped", icon: "ban" },
};
/** The category icon: the tool's own, from the icon resource keyed by `copilot-tool-category`. */
const CATEGORY_ICON: Record<FileToolRecord["kind"], string> = {
  command: "terminal",
  read: "file-text",
  grep: "search",
  find: "folder-search",
  ls: "folder",
  edit: "file-pen",
  write: "file-plus",
};

function Output({ record }: { record: FileToolRecord }) {
  const { t } = useTranslation();
  const out = record.output;
  if (!out) return null;
  const total = out.head.length + out.tail.length + out.omitted;
  return (
    <>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable output must be reachable by keyboard */}
      <pre className="copilot-mail-body copilot-tool-out" data-ui="copilot-tool-output" tabIndex={0}>
        <VisibleText text={out.head.join("\n")} />
        {out.omitted > 0 ? <span className="copilot-tool-omit">{"\n"}{t("copilot.tools.omitted", { n: out.omitted })}{"\n"}</span> : out.tail.length ? "\n" : null}
        <VisibleText text={out.tail.join("\n")} />
      </pre>
      {out.omitted > 0 && (
        <p className="copilot-mail-note" data-ui="copilot-tool-truncated">
          {t("copilot.tools.truncated", { head: out.head.length, tail: out.tail.length, total })}
        </p>
      )}
    </>
  );
}

export function DiffBlock({ lines }: { lines: NonNullable<FileToolChange["diff"]> }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable output must be reachable by keyboard
    <pre className="copilot-mail-body copilot-tool-diff" data-ui="copilot-tool-diff" tabIndex={0}>
      {lines.map((line, at) => (
        <span key={at} className={`copilot-tool-dl ${line.k}`}>
          <i aria-hidden="true">{line.k === "add" ? "+" : line.k === "del" ? "−" : line.k === "hunk" ? "" : " "}</i>
          <VisibleText text={line.s} />
        </span>
      ))}
    </pre>
  );
}

const kb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(0.1, Math.round(bytes / 102.4) / 10)} KB`);

/** The one line saying what a write is: used by the confirmation card and the tool card. */
export function changeSummary(t: TFunction, tool: "edit" | "write", change: FileToolChange): string {
  if (tool === "edit" && change.unchanged === undefined)
    return t("copilot.tools.editInfoBare", { edits: change.edits ?? 0, added: change.added ?? 0, removed: change.removed ?? 0 });
  if (tool === "edit")
    return t("copilot.tools.editInfo", { edits: change.edits ?? 0, added: change.added ?? 0, removed: change.removed ?? 0, unchanged: change.unchanged ?? 0 });
  return change.overwrite
    ? t("copilot.tools.overwriteInfo", { old: kb(change.oldBytes ?? 0), size: kb(change.bytes ?? 0), lines: change.lines ?? 0 })
    : t("copilot.tools.newInfo", { size: kb(change.bytes ?? 0), lines: change.lines ?? 0 });
}

export function ChangeBlock({ tool, change }: { tool: "edit" | "write"; change: FileToolChange }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="copilot-tool-sum">{changeSummary(t, tool, change)}</p>
      {change.contextOmitted && <p className="copilot-tool-state" data-ui="copilot-tool-context-omitted">{t("copilot.tools.contextOmitted")}</p>}
      {change.diff ? (
        <DiffBlock lines={change.diff} />
      ) : change.preview?.length ? (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable output must be reachable by keyboard
        <pre className="copilot-mail-body copilot-tool-out" tabIndex={0}>
          <VisibleText text={change.preview.join("\n")} />
          {change.previewMore ? <span className="copilot-tool-omit">{"\n"}{t("copilot.tools.moreLines", { n: change.previewMore })}</span> : null}
        </pre>
      ) : null}
    </>
  );
}

function guardText(t: TFunction, record: FileToolRecord): string {
  const guard = record.guard;
  if (!guard) return "";
  const where = t(
    guard.inside === "data_dir"
      ? "copilot.tools.guardWhereData"
      : guard.inside === "global_dir"
        ? "copilot.tools.guardWhereGlobal"
        : guard.inside === "config_dir"
          ? "copilot.tools.guardWhereConfig"
          : guard.inside === "tools_dir"
            ? "copilot.tools.guardWhereTools"
            : "copilot.tools.guardWhereCache"
  );
  const settingsKind = guard.inside === "config_dir" || guard.inside === "cache_dir" || guard.inside === "tools_dir";
  const key = guard.via === "symlink" ? "guardSymlink" : guard.via === "parent_ref" ? "guardParent" : settingsKind ? "guardDirectSettings" : "guardDirect";
  return t(`copilot.tools.${key}`, { path: record.path ?? record.target, where, folder: guard.folder, resolved: guard.resolved });
}

export function FileToolCard({ operation, defaultOpen }: { operation: CopilotOperation; defaultOpen?: boolean }) {
  const { t } = useTranslation();
  const record = operation.fileTool as FileToolRecord;
  const state = fileToolState(operation);
  const running = state === "running";
  const started = record.startedAt ? Date.parse(record.startedAt) : Number.NaN;
  const now = useNow(running && !Number.isNaN(started));
  const elapsed = running && !Number.isNaN(started) ? Math.max(0, now - started) : record.durationMs;
  const mark = MARK[state];
  const meta: string[] = [];
  if (state === "running") meta.push(t("copilot.tools.running"));
  else if (state === "declined") meta.push(t("copilot.tools.declined"));
  else if (state === "guard") meta.push(t("copilot.tools.guardShort"));
  else if (state === "interrupted") {
    meta.push(t("copilot.tools.interrupted"));
    if (record.durationMs) meta.push(fmtDuration(record.durationMs));
  } else if (state === "other") meta.push(t(`copilot.operations.status.${operation.status}`));
  else {
    if (state === "fail" && !(record.kind === "command" && record.exitCode !== undefined)) meta.push(t("copilot.operations.status.error"));
    else if (record.kind === "command" && record.exitCode !== undefined) meta.push(t("copilot.tools.exit", { code: record.exitCode }));
    else if (record.result) {
      const r = record.result;
      const unit = r.unit === "created" && record.change?.overwrite ? "overwritten" : r.unit;
      meta.push(t(`copilot.tools.result.${unit}`, { n: r.n ?? 0, added: r.added ?? 0, removed: r.removed ?? 0 }));
    }
    if (record.durationMs) meta.push(fmtDuration(record.durationMs));
  }
  if (running && elapsed) meta.push(fmtDuration(elapsed));
  const category = record.kind === "command" ? (operation.tool === "powershell" ? "powershell" : "bash") : record.kind;
  const approvalKey = record.approval === "once" ? "approvedOnce" : record.approval === "session" ? "approvedSession" : record.approval === "auto" ? "approvedAuto" : null;
  return (
    <details className="copilot-operation copilot-tool" data-ui="copilot-tool-card" data-ui-key={operation.id} data-tool={category} data-state={state} open={defaultOpen}>
      <summary>
        <span className={`copilot-operation-mark ${mark.cls}`} aria-hidden="true"><Icon name={mark.icon} /></span>
        <span className="copilot-tool-cat" data-ui="copilot-tool-category">
          <span className="copilot-tool-cat-icon" aria-hidden="true">{getConfiguredIcon(CATEGORY_ICON[record.kind], "copilot-tool-category")}</span>
          {category}
        </span>
        <code className="copilot-tool-target" data-ui="copilot-tool-target"><VisibleText text={record.target} /></code>
        <span className="copilot-tool-meta" data-ui="copilot-tool-meta">{meta.join(" · ")}</span>
        <span className="copilot-operation-chevron" aria-hidden="true"><Icon name="chevron-down" /></span>
      </summary>
      <div className="copilot-tool-body">
        <dl className="copilot-mail-fields">
          {record.kind === "command" && <><dt>{t("copilot.tools.command")}</dt><dd><pre className="copilot-mail-body copilot-tool-cmd"><VisibleText text={record.command ?? record.target} /></pre></dd></>}
          <dt>{t("copilot.tools.cwd")}</dt><dd><code>{record.cwd}</code></dd>
          {record.kind !== "command" && record.path && <><dt>{t("copilot.tools.path")}</dt><dd><code><VisibleText text={record.path} /></code></dd></>}
          {approvalKey && <><dt>{t("copilot.tools.approval")}</dt><dd>{t(`copilot.tools.${approvalKey}`)}</dd></>}
        </dl>
        {state === "guard" && (
          <InlineMessage tone="danger" uiId="copilot-tool-guard" title={t("copilot.tools.guardTitle")}><VisibleText text={guardText(t, record)} /></InlineMessage>
        )}
        {state === "declined" && <p className="copilot-tool-state">{t("copilot.tools.declinedBody")}</p>}
        {state === "interrupted" && <p className="copilot-tool-state warn">{t(record.beforeRun || operation.status === "expired" ? "copilot.tools.interruptedBeforeBody" : record.kind === "command" ? "copilot.tools.interruptedBody" : "copilot.tools.interruptedOther")}</p>}
        {record.change && (record.kind === "edit" || record.kind === "write") && <ChangeBlock tool={record.kind} change={record.change} />}
        {state === "fail" && record.exitCode !== undefined && record.exitCode !== 0 && <p className="copilot-tool-state danger">{t("copilot.tools.nonzero", { code: record.exitCode })}</p>}
        {state === "fail" && record.error && <p className="copilot-tool-state danger"><VisibleText text={record.error} /></p>}
        {state === "other" && <p className="copilot-tool-state danger">{t(`copilot.operations.status.${operation.status}`)}</p>}
        <Output record={record} />
        {running && !record.output && <p className="copilot-tool-state">{t("copilot.tools.noOutputYet")}</p>}
      </div>
    </details>
  );
}
