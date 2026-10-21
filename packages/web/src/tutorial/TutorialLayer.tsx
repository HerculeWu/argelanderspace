import type { CopilotViewAction, PageContext, TutorialProgress, TutorialState } from "@argelanderspace/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchEnvironment } from "../api/environment";
import { fetchTutorial, putTutorial } from "../api/tutorial";
import { usePreferences } from "../argelander/preferences";
import { useHostAnswer } from "../host";
import { Icon } from "../lib/icons";
import { Button, Dialog, Tooltip } from "../ui";
import { ANCHOR_MISSING_MS, activeRungs, domQuery, isRendered, measure as measureElement, resolveLadder } from "./anchors";
import { ChapterRail } from "./ChapterRail";
import { CHAPTERS } from "./chapters";
import { FINISH_CHAPTER_ID } from "./chapters/finish";
import { FinishCard } from "./FinishCard";
import { takeTutorialEntryOnce } from "./entry";
import { watchSources } from "./l2";
import {
  AUTO_ADVANCE_MS,
  type StepRecords,
  alignPosition,
  findStep,
  gatePasses,
  isLastOfChapter,
  nextStepId,
  previousStepId,
  progressWith,
  recordOf,
  withRecord,
} from "./machine";
import { createProgressWriter, samePath } from "./progress";
import { Spotlight } from "./Spotlight";
import { CARD_MARGIN, type Dock, StepCard } from "./StepCard";
import type { AnchorLadder, ChapterDefinition, GateRun, WorkbenchSnapshot } from "./types";
import { TutorialRestartDialog, useTutorialEntry } from "./TutorialEntry";
import "./tutorial.css";

export interface TutorialLayerProps {
  /** The page context the Shell gives the Copilot: the same object, not a copy (ADR 0005). */
  context: PageContext;
  /** The Shell's view-action runner: the tutorial's only active operation on the product is navigation through it. */
  onViewAction: (action: CopilotViewAction) => Promise<unknown>;
}

/**
 * The tutorial layer (spec sections 3, 5, 6). Mounted by the Shell on every page; renders only when the open project is
 * the one `tutorial.json` is bound to. Entered through the tutorial's entry it shows the card of the step it was at;
 * entered any other way, only the capsule.
 */
export function TutorialLayer({ context, onViewAction }: TutorialLayerProps) {
  const { settings } = usePreferences();
  const host = useHostAnswer();
  const [state, setState] = useState<TutorialState | null | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    fetchTutorial(controller.signal).then(setState, () => undefined);
    return () => controller.abort();
  }, []);
  const root = settings?.running.project_root?.path ?? null;
  const progress = state?.progress ?? null;
  if (host === undefined || !progress || !samePath(progress.project?.path, root)) return null;
  return <TutorialRunner initial={progress} context={context} onViewAction={onViewAction} desktop={host?.mode === "desktop"} entered={takeTutorialEntryOnce()} />;
}

/** The restart dialog the chapter rail opens: the entry's own, on the open tutorial project. */
function RailRestart({ path, desktop, onClose }: { path: string; desktop: boolean; onClose: () => void }) {
  const entry = useTutorialEntry(path);
  return <TutorialRestartDialog entry={entry} path={path} desktop={desktop} onClose={onClose} />;
}

export interface RunnerDeps {
  put: (progress: TutorialProgress) => Promise<unknown>;
  /** TeX found: true / false; null when the check did not answer. */
  checkTex: () => Promise<boolean | null>;
  now: () => string;
  /** Where an element is on screen (tests without layout replace it). */
  measure: typeof measureElement;
  /** The chapter rail's box (tests without layout replace it). */
  railBox: (rail: Element) => DOMRect;
  /** Whether an element is drawn (zero-size or invisible ones are not there for the ladder; tests replace it). */
  rendered: (el: Element) => boolean;
}

const DEFAULT_DEPS: RunnerDeps = {
  put: putTutorial,
  checkTex: async () => {
    const report = await fetchEnvironment();
    return report ? report.tools.some((tool) => tool.tool === "latexmk" && tool.found) : null;
  },
  now: () => new Date().toISOString(),
  measure: measureElement,
  railBox: (rail) => rail.getBoundingClientRect(),
  rendered: isRendered,
};

export interface TutorialRunnerProps extends TutorialLayerProps {
  initial: TutorialProgress;
  desktop: boolean;
  entered: boolean;
  chapters?: readonly ChapterDefinition[];
  deps?: Partial<RunnerDeps>;
}

interface Placement {
  /** The step this was measured for (a measurement of the step before is not looked at by the rail rule). */
  step: string | null;
  element: Element | null;
  rect: DOMRect | null;
  /** The highlighted element's whole box. */
  box: DOMRect | null;
  visible: boolean;
  /** The chapter rail's right edge, the card's left limit (0 while the rail is hidden). */
  railRight: number;
  /** The chapter rail's box as drawn now, open or folded (null when absent). */
  railBox: DOMRect | null;
}
const sameBox = (a: DOMRect | null, b: DOMRect | null) => a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);
/** Two boxes share some area. */
const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const NO_ANCHORS: AnchorLadder = [];
const NO_DATA: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Layers of the product that own an Escape while they are open (they close on it, mostly without preventing its
 * default). Generic signals first — a modal dialog, an open menu or popup — then the product's own floating layers.
 */
const PRODUCT_ESCAPE_OWNERS = [
  '[data-ui="dialog-overlay"]',
  '[data-ui="writer-dialog-overlay"]',
  '[role="dialog"][aria-modal="true"]',
  '[data-ui="command-palette"]',
  '[role="menu"]',
  '[aria-haspopup][aria-expanded="true"]',
  'details[open][data-ui="doc-actions"]',
  '[data-ui="latex-selection-tools"]',
  '[data-ui="latex-annotation-chooser"]',
  '[data-ui="latex-annotation-popover"]',
  '[data-ui="pdf-selection-tools"]',
  '[data-ui="pdf-annotation-toolbar-frame"]',
  'html[data-pdf-area-mode="true"]',
  'html[data-pdf-text-mode="true"]',
  '[data-ui="argument-detail"][data-placement="overlay"]',
  '[data-ui="argument-role-chooser"]',
  '[data-ui="argument-audit-popover"]',
  '[data-ui="mail-account-menu-list"]',
  '[data-ui="mail-move-menu"]',
  '[data-ui="add-cell-menu"]',
  '[data-ui="cell-type-menu"]',
  // Open popups of the product without a role (some do not close on Escape; it is still not the tutorial's).
  '[data-ui="import-menu"]',
  '[data-ui="work-label-menu"]',
  '[data-ui="pane-view-menu"]',
  '[data-ui="tweaks-popover"]',
  '[data-ui="task-doc-picker"]',
].join(", ");

/** The Escape is someone else's: typed into a field, or some product layer is open (the tutorial's own do not count). */
function escapeBelongsElsewhere(event: KeyboardEvent, layer: Element | null): boolean {
  for (const node of [event.target, document.activeElement]) {
    if (!(node instanceof Element)) continue;
    if (node.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return true;
  }
  for (const el of document.querySelectorAll(PRODUCT_ESCAPE_OWNERS)) if (!layer?.contains(el)) return true;
  return false;
}
const NO_PLACEMENT: Placement = { step: null, element: null, rect: null, box: null, visible: false, railRight: 0, railBox: null };
const samePlacement = (a: Placement, b: Placement) =>
  a.step === b.step && a.element === b.element && a.visible === b.visible && a.railRight === b.railRight && sameBox(a.rect, b.rect) && sameBox(a.box, b.box) && sameBox(a.railBox, b.railBox);

/** The tutorial for the bound project: step machine, observation, progress writes and the presentation. */
export function TutorialRunner({ initial, context, onViewAction, desktop, entered, chapters = CHAPTERS, deps: given }: TutorialRunnerProps) {
  const { t } = useTranslation();
  const deps = useMemo(() => ({ ...DEFAULT_DEPS, ...given }), [given]);
  const [open, setOpen] = useState(entered);
  const [position, setPosition] = useState<string | null>(() => alignPosition(chapters, initial.position));
  const [records, setRecords] = useState<StepRecords>(() => ({ ...initial.steps }));
  const [railCollapsed, setRailCollapsed] = useState(false);
  /** The step during which the user opened the rail again: it is not folded away by itself while that step lasts. */
  const [railOpenedAt, setRailOpenedAt] = useState<string | null>(null);
  /** The step during which the folded rail is hidden (its highlighted element is under it); shown again on the next. */
  const [railHiddenAt, setRailHiddenAt] = useState<string | null>(null);
  const [leaveAsk, setLeaveAsk] = useState(false);
  /** The rail's "Restart…" was chosen (in-app-tutorial ticket 25). */
  const [restartAsk, setRestartAsk] = useState(false);
  /** A progress write failed (the leave dialog says so), and whether its one notice is still shown. */
  const [saveFailed, setSaveFailed] = useState(false);
  const [notSaved, setNotSaved] = useState(false);
  const [tex, setTex] = useState<boolean | null>(null);
  const [texBusy, setTexBusy] = useState(false);
  const [passed, setPassed] = useState<string | null>(null);
  const [domVersion, setDomVersion] = useState(0);
  /** The data read back for the step's L2 sources, tagged with the step it was read for. */
  const [l2, setL2] = useState<{ step: string | null; data: Readonly<Record<string, unknown>> }>({ step: null, data: NO_DATA });
  const [missing, setMissing] = useState(false);
  const [placement, setPlacement] = useState<Placement>(NO_PLACEMENT);
  const layerRef = useRef<HTMLDivElement>(null);

  // The progress as last written, so every write is the whole file with the newest position and records.
  const latest = useRef({ position, records });
  latest.current = { position, records };
  const writer = useMemo(
    () =>
      createProgressWriter(
        (p) => deps.put(p),
        () => {
          setSaveFailed(true);
          setNotSaved(true);
        },
      ),
    [deps],
  );
  const write = useCallback(
    (nextPosition: string | null, nextRecords: StepRecords) => {
      latest.current = { position: nextPosition, records: nextRecords };
      void writer.save(progressWith(initial, nextPosition, nextRecords, deps.now()));
    },
    [writer, initial, deps],
  );

  const place = findStep(chapters, position);
  const step = place?.step ?? null;
  const ladder = step ? (!desktop && step.browser ? step.browser.anchors : step.anchors) : NO_ANCHORS;
  const record = step ? recordOf(records, step.id) : null;

  // TeX (spec section 6): read once at mount, kept in memory only.
  const recheck = useCallback(() => {
    setTexBusy(true);
    deps.checkTex().then(
      (found) => {
        setTex(found);
        setTexBusy(false);
      },
      () => setTexBusy(false),
    );
  }, [deps]);
  useEffect(() => recheck(), [recheck]);

  // L3: the DOM changed outside the layer — the snapshot is looked at again.
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const observer = new MutationObserver((mutations) => {
      const layer = layerRef.current;
      if (layer && mutations.every((m) => layer.contains(m.target))) return;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setDomVersion((v) => v + 1);
      });
    });
    // class / style / hidden too: an anchor shown or hidden by them is found or lost without a frame loop.
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-ui", "data-ui-key", "data-state", "aria-expanded", "class", "style", "hidden"],
    });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [open]);

  // L2: the step's sources, only while it is shown. What was read is tagged with its step, so a step never sees the
  // data of the step before (not even for the render before this effect runs).
  const stepId = step?.id ?? null;
  const railHidden = railHiddenAt !== null && railHiddenAt === stepId;
  useEffect(() => {
    if (!open || !stepId || !step?.sources?.length) return;
    const from = stepId;
    return watchSources(step.sources, (id, value) =>
      setL2((prev) => ({ step: from, data: { ...(prev.step === from ? prev.data : NO_DATA), [id]: value } })),
    );
  }, [open, stepId]);
  const data = stepId !== null && l2.step === stepId ? l2.data : NO_DATA;
  // The step's own first read has answered for every source: before that its gate is not looked at (no baseline yet).
  const sourcesRead = !step?.sources?.length || step.sources.every((source) => Object.getOwnPropertyDescriptor(data, source.id) !== undefined);

  const activePaneId = context.workspace?.activePaneId ?? context.paneId ?? null;
  const snapshot = useMemo<WorkbenchSnapshot>(() => {
    const dom = domQuery(document, activePaneId);
    return {
      page: context,
      modalOpen: dom.present({ ui: "dialog-overlay" }),
      paletteOpen: dom.present({ ui: "command-palette" }),
      dom,
      data,
    };
    // domVersion: the DOM is looked at again when it changed; open / stepId: and when a step starts (its gate is looked at
    // against the page as it is then).
  }, [context, data, activePaneId, domVersion, open, stepId]);

  // One showing of a step: its baseline (taken once the step's own first L2 read is in) and the scratch record of a
  // process gate.
  const run = useRef<{ key: string; run: GateRun } | null>(null);
  const showKey = open && stepId ? stepId : null;
  if (showKey === null) run.current = null;
  else if (run.current?.key !== showKey) run.current = sourcesRead ? { key: showKey, run: { baseline: snapshot, memo: {} } } : null;

  const go = useCallback(
    (id: string | null) => {
      if (id === null || id === latest.current.position) return;
      setPosition(id);
      setPassed(null);
      write(id, latest.current.records);
    },
    [write],
  );
  const finish = useCallback(() => setOpen(false), []);

  // The gate: looked at when the step starts and at every change of the snapshot (spec section 5).
  const advanceTimer = useRef<number | undefined>(undefined);
  // The timer belongs to one showing of one step: leaving the tutorial or the step cancels it.
  useEffect(() => () => window.clearTimeout(advanceTimer.current), [open, stepId]);
  useEffect(() => {
    if (!open || !step?.gate || !run.current || passed === step.id) return;
    const holds = step.gate(snapshot, run.current.run);
    if (!gatePasses(step, recordOf(latest.current.records, step.id), holds)) return;
    const nextRecords = withRecord(latest.current.records, step.id, "done", deps.now());
    setRecords(nextRecords);
    write(latest.current.position, nextRecords);
    setPassed(step.id);
    if (step.onPass === "recheckEnvironment") recheck();
    const from = step.id;
    window.clearTimeout(advanceTimer.current);
    advanceTimer.current = window.setTimeout(() => {
      if (latest.current.position !== from) return;
      const next = nextStepId(chapters, from);
      if (next) go(next);
      else finish();
    }, AUTO_ADVANCE_MS);
  }, [open, step, snapshot, passed, deps, write, recheck, go, finish, chapters]);

  // The rungs that apply in this state of the workbench (a rung may carry a condition).
  const rungs = useMemo(() => activeRungs(ladder, snapshot), [ladder, snapshot]);
  const modalOpen = snapshot.modalOpen;
  // Where the anchor is: looked at every frame while it is found and shown beside it (scrolling, resizing, layout).
  // With no anchor to look for, an anchor not found, or a product modal open, it is looked at once per change of the
  // snapshot (the DOM observer above) instead of every frame.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(NO_PLACEMENT);
      return;
    }
    let frame = 0;
    const tick = () => {
      const found = rungs.length && !modalOpen ? resolveLadder(document, rungs, activePaneId, deps.rendered) : null;
      const m = found ? deps.measure(found.element) : { rect: null, box: null, visible: false };
      const rail = document.querySelector('[data-ui="tutorial-chapter-rail"]');
      const railBox = rail ? deps.railBox(rail) : null;
      const next: Placement = {
        step: stepId,
        element: found?.element ?? null,
        rect: m.rect,
        box: m.box ?? m.rect,
        visible: m.visible,
        railRight: railBox && !railHidden ? Math.round(railBox.right) : 0,
        railBox,
      };
      setPlacement((prev) => (samePlacement(prev, next) ? prev : next));
      if (found) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
    // snapshot: an anchor that appeared or changed is looked for again (the loop does not run while none is found).
  }, [open, rungs, snapshot, activePaneId, deps, modalOpen, railCollapsed, railHidden, stepId]);

  // The rail covers the highlighted element. Open (the settings groups, the library's left column): it folds to 44 px,
  // unless the user opened it again during this step (user ruling 2026-10-21). Folded (a control on the page's left
  // edge, a whole pane): the whole rail is hidden for the rest of the step — not drawn, no room kept, no input — and
  // looked at again on the next step (user ruling F3, ticket 21). Otherwise as the prototype. A layout effect, so the
  // folded rail is not painted for a frame over an element it is about to leave.
  useLayoutEffect(() => {
    if (!open || !stepId || railHidden || placement.step !== stepId) return;
    if (!placement.box || !placement.railBox || !overlaps(placement.box, placement.railBox)) return;
    if (!railCollapsed) {
      if (railOpenedAt !== stepId) setRailCollapsed(true);
    } else setRailHiddenAt(stepId);
  }, [open, railCollapsed, railHidden, stepId, railOpenedAt, placement]);

  const requiresOk = !step?.requires || step.requires.test(snapshot);
  const lookingForAnchor = open && ladder.length > 0 && requiresOk && !modalOpen && !placement.element;
  // A missing anchor is waited for (MutationObserver above), then said to be missing after ANCHOR_MISSING_MS.
  useEffect(() => {
    setMissing(false);
    if (!lookingForAnchor) return;
    const timer = window.setTimeout(() => setMissing(true), ANCHOR_MISSING_MS);
    return () => window.clearTimeout(timer);
  }, [lookingForAnchor, stepId]);

  // Escape asks to leave, unless it is someone else's: the product handled it (default prevented, or stopped before it
  // bubbled up to the window), it was typed into a field, or a product layer was open when it was pressed. That last
  // one is looked at in the capture phase, before the product's own listeners close their layer on the same key.
  useEffect(() => {
    if (!open || leaveAsk) return;
    const elsewhere = new WeakSet<Event>();
    const onCapture = (event: KeyboardEvent) => {
      if (event.key === "Escape" && escapeBelongsElsewhere(event, layerRef.current)) elsewhere.add(event);
    };
    const onBubble = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || elsewhere.has(event)) return;
      setLeaveAsk(true);
    };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onBubble);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onBubble);
    };
  }, [open, leaveAsk]);

  const stayRef = useRef<HTMLButtonElement>(null);
  const capsuleChapter = place?.chapter.n ?? 0;

  if (!open || !place || !step) {
    return (
      <div className="tut-layer" data-ui="tutorial-layer" data-state="capsule" ref={layerRef}>
        <div className="tut-capsule-dock">
          {/* Its name is its visible text; what clicking does is the shared tooltip. */}
          <Tooltip content={t("tutorial.ui.capsuleResume")}>
            <button type="button" className="tut-capsule" data-ui="tutorial-capsule" onClick={() => setOpen(true)}>
              <Icon name="graduation-cap" />
              {place?.chapter.id === FINISH_CHAPTER_ID ? t("tutorial.ui.title") : t("tutorial.ui.capsule", { chapter: capsuleChapter })}
            </button>
          </Tooltip>
        </div>
      </div>
    );
  }

  const texBlocked = Boolean(step.needsTex) && tex === false;
  // A gated step not yet done, or one whose gate passed in this showing (its line says so until the card moves on).
  const gated = Boolean(step.gate) && (record?.state !== "done" || passed === step.id);
  const take = step.requires?.takeMeThere;
  let dock: Dock = null;
  if (snapshot.modalOpen) dock = { kind: "modal" };
  else if (ladder.length === 0) dock = { kind: "none" };
  else if (!requiresOk && step.requires) dock = { kind: "requires", where: step.requires.where, whereValues: step.requires.whereValues, canTake: Boolean(take) };
  else if (!placement.element) dock = missing ? { kind: "missing" } : { kind: "waiting" };
  else if (!placement.visible) dock = { kind: "offscreen" };

  const next = () => {
    // Next on a step not yet done: a needs-TeX step without TeX is skipped (it cannot be done here); a step without a
    // gate, or a gated one whose anchor cannot be found (the user did it by themselves), is done. The record and the
    // new position go out in one write.
    const anchorMissing = dock?.kind === "waiting" || dock?.kind === "missing";
    const state = record?.state === "done" ? null : texBlocked ? "skipped" : !step.gate || anchorMissing ? "done" : null;
    if (state) {
      const nextRecords = withRecord(latest.current.records, step.id, state, deps.now());
      setRecords(nextRecords);
      latest.current = { ...latest.current, records: nextRecords };
    }
    const to = nextStepId(chapters, step.id);
    if (to) go(to);
    else {
      write(latest.current.position, latest.current.records);
      finish();
    }
  };
  const skip = () => {
    const nextRecords = withRecord(latest.current.records, step.id, "skipped", deps.now());
    setRecords(nextRecords);
    latest.current = { ...latest.current, records: nextRecords };
    const to = nextStepId(chapters, step.id);
    if (to) go(to);
    else {
      write(latest.current.position, nextRecords);
      finish();
    }
  };
  const last = isLastOfChapter(chapters, step.id);
  const following = last ? nextStepId(chapters, step.id) : null;
  // The last chapter's last step leads to the finish page: its button says "Finish tutorial".
  const nextLabel = !last ? "next" : following && findStep(chapters, following)?.chapter.id !== FINISH_CHAPTER_ID ? "nextChapter" : "finish";
  const onFinishPage = place.chapter.id === FINISH_CHAPTER_ID;
  // The finish page's "Close the tutorial": recorded done with the position in one write; the capsule stays.
  const closeFinish = () => {
    const nextRecords = withRecord(latest.current.records, step.id, "done", deps.now());
    setRecords(nextRecords);
    write(latest.current.position, nextRecords);
    finish();
  };
  // The finish page's "Review any chapter": the rail opens (and stays open for this step), its first chapter focused.
  const review = () => {
    setRailHiddenAt(null);
    setRailCollapsed(false);
    setRailOpenedAt(step.id);
    window.requestAnimationFrame(() => layerRef.current?.querySelector<HTMLElement>('[data-ui="tutorial-chapter"]')?.focus());
  };
  const rect = dock === null ? placement.rect : null;

  return (
    <div className="tut-layer" data-ui="tutorial-layer" data-state="open" ref={layerRef}>
      {rect && !leaveAsk && <Spotlight rect={rect} pulse={gated && passed !== step.id} />}
      <ChapterRail
        chapters={chapters}
        records={records}
        currentStepId={step.id}
        collapsed={railCollapsed}
        tex={tex}
        texBusy={texBusy}
        onToggle={() => {
          if (railCollapsed) setRailOpenedAt(step.id);
          setRailCollapsed(!railCollapsed);
        }}
        onGoChapter={(chapter) => go(chapter.steps[0]?.id ?? null)}
        onGoStep={go}
        onLeave={() => setLeaveAsk(true)}
        onRecheck={recheck}
        onRestart={() => setRestartAsk(true)}
        yielded={modalOpen}
        hidden={railHidden}
      />
      {onFinishPage ? (
        <FinishCard desktop={desktop} onReview={review} onClose={closeFinish} onLeave={() => setLeaveAsk(true)} />
      ) : (
      <StepCard
        key={step.id}
        chapter={place.chapter}
        step={step}
        index={place.si + 1}
        count={place.chapter.steps.length}
        anchor={dock === null ? placement.element : null}
        dock={dock}
        avoidLeft={Math.max(placement.railRight, 0) + CARD_MARGIN}
        browserCopy={!desktop && Boolean(step.browser)}
        gated={gated}
        passed={passed === step.id}
        skipped={record?.state === "skipped"}
        texBlocked={texBlocked}
        texBusy={texBusy}
        firstStep={previousStepId(chapters, step.id) === null}
        nextLabel={nextLabel}
        notSaved={notSaved}
        onDismissNotSaved={() => setNotSaved(false)}
        onBack={() => go(previousStepId(chapters, step.id))}
        onNext={next}
        onSkip={skip}
        onLeave={() => setLeaveAsk(true)}
        onTakeMeThere={() => {
          if (take) void onViewAction(take);
        }}
        onScrollTo={() => placement.element?.scrollIntoView({ block: "center", behavior: "smooth" })}
        onRecheck={recheck}
      />
      )}
      {restartAsk && initial.project && (
        <RailRestart path={initial.project.path} desktop={desktop} onClose={() => setRestartAsk(false)} />
      )}
      {leaveAsk && (
        <Dialog
          title={t("tutorial.ui.leaveDialog.title")}
          uiId="exit-tutorial-dialog"
          closeLabel={t("common.close")}
          onClose={() => setLeaveAsk(false)}
          initialFocusRef={stayRef}
          width={440}
          footer={
            <>
              <Button ref={stayRef} data-ui="exit-tutorial-keep" onClick={() => setLeaveAsk(false)}>
                {t("tutorial.ui.leaveDialog.cancel")}
              </Button>
              <Button
                appearance="primary"
                data-ui="exit-tutorial-confirm"
                onClick={() => {
                  setLeaveAsk(false);
                  setOpen(false);
                }}
              >
                {t("tutorial.ui.leaveDialog.confirm")}
              </Button>
            </>
          }
        >
          <p className="tut-text">{saveFailed ? t("tutorial.ui.leaveDialog.bodyNotSaved") : t("tutorial.ui.leaveDialog.body")}</p>
        </Dialog>
      )}
    </div>
  );
}
