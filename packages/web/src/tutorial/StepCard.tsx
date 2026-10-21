import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton, Badge, Button, InlineMessage } from "../ui";
import { PreparedText } from "./PreparedText";
import { tk } from "./text";
import type { ChapterDefinition, StepDefinition, WhereKey } from "./types";

/** Card placement (spec section 3): right, then left, below, above the anchor; 14 px away, 12 px from the window. */
export const CARD_OFFSET = 14;
export const CARD_MARGIN = 12;
/** A docked card's distance from the window's right and bottom edges (`.tut-card.docked`). */
export const DOCK_MARGIN = 16;

interface Size {
  width: number;
  height: number;
}
interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Whether the card has room on at least one side of its anchor (right, left, below, above; 14 px away, inside the
 * window's padding). An anchor as large as the window (a whole reader pane) has none: the card then sits where a docked
 * card sits, not shifted over the page's top left (polish round, ticket 21).
 */
export function fitsBeside(anchor: Pick<DOMRect, "top" | "right" | "bottom" | "left">, card: Size, view: Size, padding: Edges): boolean {
  return (
    view.width - padding.right - (anchor.right + CARD_OFFSET) >= card.width ||
    anchor.left - CARD_OFFSET - padding.left >= card.width ||
    view.height - padding.bottom - (anchor.bottom + CARD_OFFSET) >= card.height ||
    anchor.top - CARD_OFFSET - padding.top >= card.height
  );
}

/** Why the card is docked at the bottom right instead of beside its anchor; null: it is beside its anchor. */
export type Dock =
  | null
  | { kind: "modal" }
  | { kind: "requires"; where: WhereKey; whereValues?: Readonly<Record<string, string>>; canTake: boolean }
  | { kind: "waiting" }
  | { kind: "missing" }
  | { kind: "offscreen" }
  /** No anchor at all (agent cards in the browser form, the finish page): docked without any warning. */
  | { kind: "none" };

/** What the card's main button says (`tutorial.ui.<label>`; the copy test checks every one). */
export const NEXT_LABELS = ["next", "nextChapter", "finish"] as const;
export type NextLabel = (typeof NEXT_LABELS)[number];

export interface StepCardProps {
  chapter: ChapterDefinition;
  step: StepDefinition;
  index: number;
  count: number;
  /** The anchor element the card sits beside (when not docked). */
  anchor: Element | null;
  dock: Dock;
  /** Room the card keeps clear of on the left: the chapter rail's right edge plus the margin. */
  avoidLeft: number;
  /** The browser form's copy for this step. */
  browserCopy: boolean;
  gated: boolean;
  /** The gate passed in this showing; the card moves on shortly. */
  passed: boolean;
  skipped: boolean;
  texBlocked: boolean;
  texBusy: boolean;
  firstStep: boolean;
  nextLabel: NextLabel;
  /** A progress write failed: the notice stays until the user dismisses it. */
  notSaved: boolean;
  onDismissNotSaved?: () => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  onLeave: () => void;
  onTakeMeThere: () => void;
  onScrollTo: () => void;
  onRecheck: () => void;
}

/** The floating step card of prototype B, beside its anchor or docked at the bottom right. */
export function StepCard(props: StepCardProps) {
  const { chapter, step, dock, anchor, avoidLeft } = props;
  const { t } = useTranslation();
  const card = useRef<HTMLDivElement>(null);
  const docked = dock !== null;

  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    if (docked || !anchor) {
      delete el.dataset.placement;
      el.style.transform = "";
      el.style.visibility = "";
      return;
    }
    // Hidden until the first placement: a card just shown would otherwise sit at the window's top left for a frame,
    // over the chapter rail.
    el.style.visibility = "hidden";
    const padding = { top: CARD_MARGIN, right: CARD_MARGIN, bottom: CARD_MARGIN, left: avoidLeft };
    // Each placement is numbered: an answer for an earlier one (another anchor, an earlier scroll position) that
    // arrives late is dropped, and so is any answer after this anchor was left.
    let generation = 0;
    let live = true;
    const stop = autoUpdate(anchor, el, () => {
      const mine = ++generation;
      // The layout size (offsetWidth / offsetHeight: the card's entry animation scales it for a moment); the box where
      // there is no layout (tests).
      const box = el.getBoundingClientRect();
      const own = { width: el.offsetWidth || box.width, height: el.offsetHeight || box.height };
      const view = { width: window.innerWidth, height: window.innerHeight };
      if (!fitsBeside(anchor.getBoundingClientRect(), own, view, padding)) {
        // No room beside it: at the docked card's place (bottom right), still highlighting the anchor.
        el.dataset.placement = "fallback";
        el.style.transform = `translate(${Math.round(view.width - own.width - DOCK_MARGIN)}px, ${Math.round(view.height - own.height - DOCK_MARGIN)}px)`;
        el.style.visibility = "";
        return;
      }
      delete el.dataset.placement;
      void computePosition(anchor, el, {
        strategy: "fixed",
        placement: "right-start",
        middleware: [offset(CARD_OFFSET), flip({ fallbackPlacements: ["left-start", "bottom-start", "top-start"], padding }), shift({ padding, crossAxis: true })],
      }).then(({ x, y }) => {
        if (!live || mine !== generation) return;
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        el.style.visibility = "";
      });
    });
    return () => {
      live = false;
      stop();
    };
  }, [anchor, docked, avoidLeft]);

  const key = `tutorial.steps.${step.id}`;
  const agent = step.kind === "agent";
  // A step skipped earlier and shown again with its gate still false is shown as usual, and can be skipped again.
  const waitingLine = props.gated && !props.texBlocked;
  // The anchor cannot be found (waiting, then "the interface has changed"): the user does the step and clicks Next.
  const anchorMissing = dock?.kind === "waiting" || dock?.kind === "missing";
  const nextDisabled = props.gated && !props.passed && !props.texBlocked && !anchorMissing;
  const showSkip = (props.gated || props.texBlocked) && !props.passed;
  const titleId = `tut-title-${step.id}`;
  let notice: ReactNode = null;
  if (dock?.kind === "modal") notice = <p className="tut-text" data-ui="tutorial-modal-yield">{t("tutorial.ui.modalYield")}</p>;
  else if (dock?.kind === "requires") {
    const where = tk(t, `tutorial.ui.where.${dock.where}`, dock.whereValues);
    notice = (
      <InlineMessage tone="info" uiId="tutorial-requires" title={t("tutorial.ui.requiresTitle", { where })}>
        {dock.canTake ? t("tutorial.ui.requiresBody") : t("tutorial.ui.requiresBodyNoAction")}
        {dock.canTake && (
          <div>
            <Button data-ui="tutorial-take-me-there" onClick={props.onTakeMeThere}>{t("tutorial.ui.takeMeThere")}</Button>
          </div>
        )}
      </InlineMessage>
    );
  } else if (dock?.kind === "waiting") notice = <InlineMessage tone="info" uiId="tutorial-anchor-waiting">{t("tutorial.ui.anchorWaiting")}</InlineMessage>;
  else if (dock?.kind === "missing")
    notice = (
      <InlineMessage tone="warning" uiId="tutorial-anchor-missing" title={t("tutorial.ui.anchorMissingTitle")}>
        {t("tutorial.ui.anchorMissingBody")}
      </InlineMessage>
    );
  else if (dock?.kind === "offscreen")
    notice = (
      <InlineMessage tone="info" uiId="tutorial-anchor-offscreen" title={t("tutorial.ui.anchorOffscreenTitle")}>
        <Button data-ui="scroll-to-tutorial-anchor" onClick={props.onScrollTo}>{t("tutorial.ui.anchorOffscreen")}</Button>
      </InlineMessage>
    );

  const intro = agent ? tk(t, `${key}.${props.browserCopy ? "introBrowser" : "intro"}`) : tk(t, `${key}.body`);
  const prepared = agent
    ? { label: t("tutorial.ui.preparedText"), text: tk(t, `${key}.${props.browserCopy ? "promptBrowser" : "prompt"}`) }
    : step.preparedText !== undefined
      ? { label: tk(t, `${key}.prepared.label`), text: step.preparedText }
      : step.preparedCopy
        ? { label: tk(t, `${key}.prepared.label`), text: tk(t, `${key}.prepared.text`) }
        : null;

  return (
    <div
      ref={card}
      className={"tut-card" + (docked ? " docked" : "") + (dock?.kind === "modal" ? " yielded" : "") + (agent ? " agent" : "")}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-ui="tutorial-step-card"
      data-ui-key={step.id}
      data-state={dock ? dock.kind : "anchored"}
    >
      <div className="tut-card-head">
        <div className="tut-crumb">
          <Icon name="graduation-cap" cls="ico-sm" />
          <span>{t("tutorial.ui.cardHeader", { chapter: chapter.n, index: props.index, count: props.count, title: tk(t, `tutorial.chapters.${chapter.id}.title`) })}</span>
        </div>
        <ActionButton
          unstyled
          mode="icon"
          iconName="x"
          className="btn icon ghost"
          data-ui="exit-tutorial"
          data-ui-key="card"
          label={t("tutorial.ui.leave")}
          tooltip={t("tutorial.ui.leave")}
          onClick={props.onLeave}
        />
      </div>
      <div className="tut-card-body">
        {agent && (
          <span className="tut-agent-tag" data-ui="tutorial-agent-tag">
            <Icon name="bot" />
            {t("tutorial.ui.agentCard")}
          </span>
        )}
        <h2 className="tut-title" id={titleId}>{tk(t, `${key}.title`)}</h2>
        {(step.needsTex || props.skipped) && (
          <div className="tut-badges">
            {step.needsTex && <Badge tone={props.texBlocked ? "neutral" : "accent"}>{t("tutorial.ui.needsTex")}</Badge>}
            {props.skipped && <Badge>{t("tutorial.ui.rail.status.skipped")}</Badge>}
          </div>
        )}
        {props.notSaved && (
          <div className="tut-not-saved">
            <InlineMessage tone="warning" uiId="tutorial-progress-not-saved">{t("tutorial.ui.progressNotSaved")}</InlineMessage>
            <ActionButton
              unstyled
              mode="icon"
              iconName="x"
              className="btn icon ghost"
              data-ui="dismiss-tutorial-progress-notice"
              label={t("tutorial.ui.dismissNotice")}
              tooltip={t("tutorial.ui.dismissNotice")}
              onClick={props.onDismissNotSaved}
            />
          </div>
        )}
        <p className="tut-text">{intro}</p>
        {notice}
        {props.texBlocked && (
          <InlineMessage tone="warning" uiId="tutorial-needs-tex" title={t("tutorial.ui.noTexTitle")}>
            {t("tutorial.ui.noTexBody", { alt: tk(t, `${key}.alt`) })}
            <div>
              <Button data-ui="tutorial-recheck-tex" data-ui-key="card" busy={props.texBusy} disabled={props.texBusy} onClick={props.onRecheck}>
                {props.texBusy ? t("tutorial.ui.recheckBusy") : t("tutorial.ui.recheck")}
              </Button>
            </div>
          </InlineMessage>
        )}
        {prepared && dock?.kind !== "modal" && <PreparedText label={prepared.label} text={prepared.text} uiKey={step.id} />}
        {agent && !props.browserCopy && (
          <p className="tut-skills" data-ui="tutorial-agent-skills">{t("tutorial.ui.agentSkill", { name: tk(t, `${key}.skill`) })}</p>
        )}
      </div>
      {waitingLine && (
        <div className={"tut-wait" + (props.passed ? " passed" : "")} data-ui="tutorial-waiting" data-state={props.passed ? "passed" : "waiting"} role="status">
          <Icon name={props.passed ? "circle-check" : "loader-circle"} />
          {tk(t, `${key}.waiting`)}
        </div>
      )}
      <div className="tut-card-foot">
        <Button data-ui="tutorial-previous" disabled={props.firstStep} onClick={props.onBack}>{t("tutorial.ui.back")}</Button>
        <span className="spacer" />
        {showSkip && (
          <button type="button" className="tut-skip-link" data-ui="tutorial-skip-step" onClick={props.onSkip}>
            {t("tutorial.ui.skip")}
          </button>
        )}
        <Button appearance="primary" data-ui="tutorial-next" disabled={nextDisabled} onClick={props.onNext}>
          {t(`tutorial.ui.${props.nextLabel}`)}
        </Button>
      </div>
    </div>
  );
}
