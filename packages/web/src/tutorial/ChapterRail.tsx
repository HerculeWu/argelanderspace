import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { Button, IconButton } from "../ui";
import { type StepRecords, chapterStatus, chapterSummary, recordOf } from "./machine";
import { tk } from "./text";
import type { ChapterDefinition, StepDefinition } from "./types";

/** The number a step shows in the rail: "2.3", or "2.A" for the chapter's agent card. */
export function stepNumber(chapter: ChapterDefinition, step: StepDefinition): string {
  if (step.kind === "agent") return `${chapter.n}.A`;
  return `${chapter.n}.${chapter.steps.filter((s) => s.kind !== "agent").indexOf(step) + 1}`;
}

export interface ChapterRailProps {
  chapters: readonly ChapterDefinition[];
  records: StepRecords;
  currentStepId: string | null;
  collapsed: boolean;
  /** TeX was found (true), not found (false), not known yet (null). */
  tex: boolean | null;
  texBusy: boolean;
  onToggle: () => void;
  onGoChapter: (chapter: ChapterDefinition) => void;
  onGoStep: (stepId: string) => void;
  onLeave: () => void;
  onRecheck: () => void;
  /** "Restart…" in the overflow menu: wired by the entry ticket; absent, the item is shown disabled. */
  onRestart?: () => void;
}

/** The chapter rail of prototype B: the registered chapters with their state, the current one opened to its steps. */
export function ChapterRail(props: ChapterRailProps) {
  const { chapters, records, currentStepId, collapsed, tex, texBusy } = props;
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);
  const stateLabel = (s: ReturnType<typeof chapterStatus>) => t(`tutorial.ui.rail.status.${s}`);
  return (
    <aside className={"tut-rail" + (collapsed ? " collapsed" : "")} data-ui="tutorial-chapter-rail" aria-label={t("tutorial.ui.rail.title")}>
      <div className="tut-rail-head">
        {!collapsed && (
          <div className="tut-rail-title">
            <Icon name="graduation-cap" cls="ico-sm" />
            {t("tutorial.ui.title")} · {t("tutorial.ui.rail.title")}
          </div>
        )}
        {!collapsed && (
          <span onClick={(e) => e.stopPropagation()}>
            <IconButton unstyled className="btn icon ghost" data-ui="tutorial-rail-more" label={t("tutorial.ui.rail.more")} aria-expanded={menu} aria-haspopup="menu" icon={<Icon name="ellipsis" cls="ico-sm" />} onClick={() => setMenu((m) => !m)} />
          </span>
        )}
        <IconButton
          unstyled
          className="btn icon ghost"
          data-ui="toggle-tutorial-chapters"
          label={collapsed ? t("tutorial.ui.rail.expand") : t("tutorial.ui.rail.collapse")}
          aria-expanded={!collapsed}
          icon={<Icon name={collapsed ? "panel-left-open" : "panel-left-close"} cls="ico-sm" />}
          onClick={props.onToggle}
        />
        {menu && !collapsed && (
          <div className="tut-rail-menu" role="menu" data-ui="tutorial-rail-menu" onClick={(e) => e.stopPropagation()}>
            <button type="button" role="menuitem" data-ui="tutorial-restart" disabled={!props.onRestart} onClick={() => { setMenu(false); props.onRestart?.(); }}>
              {t("tutorial.entry.restart")}
            </button>
          </div>
        )}
      </div>
      <div className="tut-rail-list">
        {chapters.map((chapter) => {
          const active = chapter.steps.some((s) => s.id === currentStepId);
          const status = chapterStatus(chapter, records, currentStepId);
          const summary = chapterSummary(chapter, records);
          const needsTex = tex === false && chapter.steps.some((s) => s.needsTex);
          const title = tk(t, `tutorial.chapters.${chapter.id}.title`);
          const chapterLabel = `${chapter.n} ${title} · ${stateLabel(status)}${needsTex ? ` · ${t("tutorial.ui.rail.status.needsTex")}` : ""}`;
          return (
            <div key={chapter.id}>
              <button
                type="button"
                className={`tut-ch ${status}` + (active ? " active" : "")}
                data-ui="tutorial-chapter"
                data-ui-key={chapter.id}
                data-state={status}
                aria-current={active ? "step" : undefined}
                aria-label={collapsed ? chapterLabel : undefined}
                title={collapsed ? chapterLabel : t("tutorial.ui.rail.summary", { ...summary })}
                onClick={() => props.onGoChapter(chapter)}
              >
                <span className="tut-ch-n">{status === "done" ? <Icon name="check" cls="ico-sm" /> : chapter.n}</span>
                {!collapsed && (
                  <span className="tut-ch-body">
                    <span className="tut-ch-title">{title}</span>
                    <span className="tut-ch-state">
                      {stateLabel(status)}
                      {needsTex && <span className="warn" data-ui="tutorial-chapter-needs-tex"> · {t("tutorial.ui.rail.status.needsTex")}</span>}
                    </span>
                  </span>
                )}
              </button>
              {needsTex && !collapsed && (
                <Button unstyled className="tut-rail-tex" data-ui="tutorial-recheck-tex" data-ui-key={chapter.id} busy={texBusy} disabled={texBusy} onClick={props.onRecheck}>
                  {texBusy ? t("tutorial.ui.recheckBusy") : t("tutorial.ui.recheck")}
                </Button>
              )}
              {!collapsed && active && (
                <div className="tut-steps">
                  {chapter.steps.map((step) => {
                    const r = recordOf(records, step.id);
                    const cur = step.id === currentStepId;
                    const icon = r?.state === "done" ? "circle-check" : r?.state === "skipped" ? "circle-dashed" : cur ? "circle-dot" : step.kind === "agent" ? "bot" : "circle";
                    return (
                      <button
                        type="button"
                        key={step.id}
                        className={"tut-step-row" + (cur ? " cur" : "") + (r?.state === "done" ? " done" : "")}
                        data-ui="tutorial-step"
                        data-ui-key={step.id}
                        data-state={r?.state ?? (cur ? "current" : "todo")}
                        aria-current={cur ? "step" : undefined}
                        onClick={() => props.onGoStep(step.id)}
                      >
                        <Icon name={icon} />
                        <span>
                          {stepNumber(chapter, step)} {tk(t, `tutorial.steps.${step.id}.title`)}
                          {r?.state === "skipped" ? ` · ${t("tutorial.ui.rail.status.skipped")}` : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!collapsed && (
        <div className="tut-rail-foot">
          <Button data-ui="exit-tutorial" data-ui-key="rail" onClick={props.onLeave}>
            <Icon name="log-out" cls="ico-sm" />
            {t("tutorial.ui.leave")}
          </Button>
        </div>
      )}
    </aside>
  );
}
