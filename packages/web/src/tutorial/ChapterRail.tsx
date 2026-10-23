import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton, Button, Tooltip } from "../ui";
import { FINISH_CHAPTER_ID } from "./chapters/finish";
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
  /** A product modal is open: the rail steps below its overlay and takes no input, as the card does. */
  yielded?: boolean;
  /**
   * The folded rail is over the step's highlighted element: hidden for that step (not seen, no input, out of the
   * accessibility tree); still measured, so the next step can tell whether it may be shown again.
   */
  hidden?: boolean;
}

/** The chapter rail of prototype B: the registered chapters with their state, the current one opened to its steps. */
export function ChapterRail(props: ChapterRailProps) {
  const { chapters, records, currentStepId, collapsed, tex, texBusy } = props;
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = (refocus: boolean) => {
    setMenu(false);
    if (refocus) moreRef.current?.focus();
  };
  useEffect(() => {
    if (!menu) return;
    // The first item takes the focus, so the keyboard is in the menu at once (its items stay focusable when disabled).
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = () => setMenu(false);
    // Escape closes the menu before anything else sees it (capture phase, default prevented: the tutorial's own
    // Escape and the product's both leave it alone), and gives the focus back to the button that opened it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);
  /** Menu keys: Up/Down move between items (wrapping), Home/End go to the ends, Tab closes. */
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let to: number | null = null;
    if (event.key === "ArrowDown") to = (at + 1) % items.length;
    else if (event.key === "ArrowUp") to = (at - 1 + items.length) % items.length;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = items.length - 1;
    else if (event.key === "Tab") setMenu(false);
    if (to === null) return;
    event.preventDefault();
    items[to]!.focus();
  };
  const stateLabel = (s: ReturnType<typeof chapterStatus>) => t(`tutorial.ui.rail.status.${s}`);
  return (
    <aside
      className={"tut-rail" + (collapsed ? " collapsed" : "") + (props.yielded ? " yielded" : "") + (props.hidden ? " concealed" : "")}
      data-ui="tutorial-chapter-rail"
      aria-label={t("tutorial.ui.rail.title")}
      aria-hidden={props.hidden ? true : undefined}
      // React 18 passes an unknown attribute through only as a string.
      {...(props.yielded || props.hidden ? { inert: "" } : {})}
    >
      <div className="tut-rail-head">
        {!collapsed && (
          <div className="tut-rail-title">
            <Icon name="graduation-cap" cls="ico-sm" />
            {t("tutorial.ui.rail.heading")}
          </div>
        )}
        {!collapsed && (
          <span onClick={(e) => e.stopPropagation()}>
            <ActionButton
              ref={moreRef}
              unstyled
              mode="icon"
              iconName="ellipsis"
              className="btn icon ghost"
              data-ui="tutorial-rail-more"
              label={t("tutorial.ui.rail.more")}
              tooltip={t("tutorial.ui.rail.more")}
              aria-expanded={menu}
              aria-haspopup="menu"
              onClick={() => setMenu((m) => !m)}
            />
          </span>
        )}
        <ActionButton
          unstyled
          mode="icon"
          iconSize="small"
          iconName={collapsed ? "panel-left-open" : "panel-left-close"}
          className="btn icon ghost"
          data-ui="toggle-tutorial-chapters"
          label={collapsed ? t("tutorial.ui.rail.expand") : t("tutorial.ui.rail.collapse")}
          tooltip={collapsed ? t("tutorial.ui.rail.expand") : t("tutorial.ui.rail.collapse")}
          aria-expanded={!collapsed}
          onClick={props.onToggle}
        />
        {menu && !collapsed && (
          <div ref={menuRef} className="tut-rail-menu" role="menu" aria-label={t("tutorial.ui.rail.more")} data-ui="tutorial-rail-menu" onClick={(e) => e.stopPropagation()} onKeyDown={onMenuKey}>
            <button
              type="button"
              role="menuitem"
              data-ui="tutorial-restart"
              aria-disabled={!props.onRestart || undefined}
              onClick={() => {
                if (!props.onRestart) return;
                setMenu(false);
                props.onRestart();
              }}
            >
              {t("tutorial.entry.restart")}
            </button>
          </div>
        )}
      </div>
      <div className="tut-rail-list">
        {chapters.map((chapter) => {
          const active = chapter.steps.some((s) => s.id === currentStepId);
          // The finish page's row (prototype B): a flag and its title, no state line and no steps.
          if (chapter.id === FINISH_CHAPTER_ID) {
            const title = tk(t, `tutorial.chapters.${chapter.id}.title`);
            const row = (
              <button
                type="button"
                className={"tut-ch notStarted" + (active ? " active" : "")}
                data-ui="tutorial-chapter"
                data-ui-key={chapter.id}
                aria-current={active ? "step" : undefined}
                aria-label={collapsed ? title : undefined}
                onClick={() => props.onGoChapter(chapter)}
              >
                <span className="tut-ch-n"><Icon name="flag" cls="ico-sm" /></span>
                {!collapsed && <span className="tut-ch-body"><span className="tut-ch-title">{title}</span></span>}
              </button>
            );
            return <div key={chapter.id}>{collapsed ? <Tooltip content={title}>{row}</Tooltip> : row}</div>;
          }
          const status = chapterStatus(chapter, records, currentStepId);
          const summary = chapterSummary(chapter, records);
          const needsTex = tex === false && chapter.steps.some((s) => s.needsTex);
          const title = tk(t, `tutorial.chapters.${chapter.id}.title`);
          const chapterLabel = needsTex
            ? t("tutorial.ui.rail.chapterLabelNeedsTex", { n: chapter.n, title, state: stateLabel(status) })
            : t("tutorial.ui.rail.chapterLabel", { n: chapter.n, title, state: stateLabel(status) });
          return (
            <div key={chapter.id}>
              <Tooltip content={collapsed ? chapterLabel : t("tutorial.ui.rail.summary", { ...summary })}>
              <button
                type="button"
                className={`tut-ch ${status}` + (active ? " active" : "")}
                data-ui="tutorial-chapter"
                data-ui-key={chapter.id}
                data-state={status}
                aria-current={active ? "step" : undefined}
                aria-label={collapsed ? chapterLabel : undefined}
                onClick={() => props.onGoChapter(chapter)}
              >
                <span className="tut-ch-n">{status === "done" ? <Icon name="check" cls="ico-sm" /> : chapter.n}</span>
                {!collapsed && (
                  <span className="tut-ch-body">
                    <span className="tut-ch-title">{title}</span>
                    <span className="tut-ch-state">
                      {stateLabel(status)}
                      {needsTex && <span className="warn" data-ui="tutorial-chapter-needs-tex">{t("tutorial.ui.rail.status.needsTex")}</span>}
                    </span>
                  </span>
                )}
              </button>
              </Tooltip>
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
                          {t(r?.state === "skipped" ? "tutorial.ui.rail.stepRowSkipped" : "tutorial.ui.rail.stepRow", {
                            number: stepNumber(chapter, step),
                            title: tk(t, `tutorial.steps.${step.id}.title`),
                          })}
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
