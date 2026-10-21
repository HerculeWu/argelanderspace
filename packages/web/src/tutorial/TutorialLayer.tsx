import type { CopilotViewAction, PageContext, TutorialProgress, TutorialState } from "@argelanderspace/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchEnvironment } from "../api/environment";
import { fetchTutorial, putTutorial } from "../api/tutorial";
import { usePreferences } from "../argelander/preferences";
import { useHostAnswer } from "../host";
import { Icon } from "../lib/icons";
import { Button, Dialog } from "../ui";
import { ANCHOR_MISSING_MS, activeRungs, domQuery, measure as measureElement, resolveLadder } from "./anchors";
import { ChapterRail } from "./ChapterRail";
import { CHAPTERS } from "./chapters";
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
};

export interface TutorialRunnerProps extends TutorialLayerProps {
  initial: TutorialProgress;
  desktop: boolean;
  entered: boolean;
  chapters?: readonly ChapterDefinition[];
  deps?: Partial<RunnerDeps>;
}

interface Placement {
  element: Element | null;
  rect: DOMRect | null;
  /** The highlighted element's whole box. */
  box: DOMRect | null;
  visible: boolean;
  /** The chapter rail's right edge, the card's left limit. */
  railRight: number;
  /** The open chapter rail's box (null when collapsed or absent). */
  railBox: DOMRect | null;
}
const sameBox = (a: DOMRect | null, b: DOMRect | null) => a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);
/** Two boxes share some area. */
const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const NO_ANCHORS: AnchorLadder = [];
const NO_PLACEMENT: Placement = { element: null, rect: null, box: null, visible: false, railRight: 0, railBox: null };
const samePlacement = (a: Placement, b: Placement) =>
  a.element === b.element && a.visible === b.visible && a.railRight === b.railRight && sameBox(a.rect, b.rect) && sameBox(a.box, b.box) && sameBox(a.railBox, b.railBox);

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
  const [leaveAsk, setLeaveAsk] = useState(false);
  /** The rail's "Restart…" was chosen (in-app-tutorial ticket 25). */
  const [restartAsk, setRestartAsk] = useState(false);
  const [notSaved, setNotSaved] = useState(false);
  const [tex, setTex] = useState<boolean | null>(null);
  const [texBusy, setTexBusy] = useState(false);
  const [passed, setPassed] = useState<string | null>(null);
  const [domVersion, setDomVersion] = useState(0);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [missing, setMissing] = useState(false);
  const [placement, setPlacement] = useState<Placement>(NO_PLACEMENT);
  const layerRef = useRef<HTMLDivElement>(null);

  // The progress as last written, so every write is the whole file with the newest position and records.
  const latest = useRef({ position, records });
  latest.current = { position, records };
  const writer = useMemo(() => createProgressWriter((p) => deps.put(p), () => setNotSaved(true)), [deps]);
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
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ui", "data-ui-key", "data-state", "aria-expanded"] });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [open]);

  // L2: the step's sources, only while it is shown.
  const stepId = step?.id ?? null;
  useEffect(() => {
    setData({});
    if (!open || !step?.sources?.length) return;
    return watchSources(step.sources, (id, value) => setData((d) => ({ ...d, [id]: value })));
  }, [open, stepId]);

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
    // domVersion: the DOM is looked at again when it changed.
  }, [context, data, activePaneId, domVersion]);

  // One showing of a step: its baseline and the scratch record of a process gate.
  const run = useRef<{ key: string; run: GateRun } | null>(null);
  const showKey = open && stepId ? stepId : null;
  if (showKey === null) run.current = null;
  else if (run.current?.key !== showKey) run.current = { key: showKey, run: { baseline: snapshot, memo: {} } };

  const go = useCallback(
    (id: string | null) => {
      if (id === null || id === latest.current.position) return;
      setPosition(id);
      setPassed(null);
      setNotSaved(false);
      write(id, latest.current.records);
    },
    [write],
  );
  const finish = useCallback(() => setOpen(false), []);

  // The gate: looked at when the step starts and at every change of the snapshot (spec section 5).
  const advanceTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(advanceTimer.current), []);
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
  // Where the anchor is: looked at every frame while the card is shown (scrolling, resizing, layout).
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(NO_PLACEMENT);
      return;
    }
    let frame = 0;
    const tick = () => {
      const found = rungs.length ? resolveLadder(document, rungs, activePaneId) : null;
      const m = found ? deps.measure(found.element) : { rect: null, box: null, visible: false };
      const rail = document.querySelector('[data-ui="tutorial-chapter-rail"]');
      const railBox = rail ? deps.railBox(rail) : null;
      const next: Placement = {
        element: found?.element ?? null,
        rect: m.rect,
        box: m.box ?? m.rect,
        visible: m.visible,
        railRight: railBox ? Math.round(railBox.right) : 0,
        railBox: rail && !rail.classList.contains("collapsed") ? railBox : null,
      };
      setPlacement((prev) => (samePlacement(prev, next) ? prev : next));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [open, rungs, activePaneId, deps]);

  // The open rail covers the highlighted element (the settings groups, the library's left column): fold it to 44 px,
  // unless the user opened it again during this step (user ruling 2026-10-21; otherwise as the prototype).
  useEffect(() => {
    if (!open || railCollapsed || !stepId || railOpenedAt === stepId) return;
    if (placement.box && placement.railBox && overlaps(placement.box, placement.railBox)) setRailCollapsed(true);
  }, [open, railCollapsed, stepId, railOpenedAt, placement]);

  const requiresOk = !step?.requires || step.requires.test(snapshot);
  const lookingForAnchor = open && ladder.length > 0 && requiresOk && !placement.element;
  // A missing anchor is waited for (MutationObserver above), then said to be missing after ANCHOR_MISSING_MS.
  useEffect(() => {
    setMissing(false);
    if (!lookingForAnchor) return;
    const timer = window.setTimeout(() => setMissing(true), ANCHOR_MISSING_MS);
    return () => window.clearTimeout(timer);
  }, [lookingForAnchor, stepId]);

  // Escape asks to leave, unless it belongs to something else (a dialog, the command palette, a field being typed in).
  useEffect(() => {
    if (!open || leaveAsk) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[data-ui="dialog-overlay"], [data-ui="command-palette"]')) return;
      const target = event.target instanceof Node ? event.target : null;
      const inLayer = Boolean(target && layerRef.current?.contains(target));
      if (inLayer || document.activeElement === document.body || document.activeElement === null) setLeaveAsk(true);
    };
    // Capture phase: seen before the Shell's own Escape (which closes the command palette and may remove it before a
    // later listener runs), so the palette or a dialog still tells that this Escape is theirs.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, leaveAsk]);

  const stayRef = useRef<HTMLButtonElement>(null);
  const capsuleChapter = place?.chapter.n ?? 0;

  if (!open || !place || !step) {
    return (
      <div className="tut-layer" data-ui="tutorial-layer" data-state="capsule" ref={layerRef}>
        <button type="button" className="tut-capsule" data-ui="tutorial-capsule" aria-label={t("tutorial.ui.capsuleResume")} title={t("tutorial.ui.capsuleResume")} onClick={() => setOpen(true)}>
          <Icon name="graduation-cap" />
          {t("tutorial.ui.capsule", { chapter: capsuleChapter })}
        </button>
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
    if (!step.gate && record?.state !== "done") {
      const nextRecords = withRecord(latest.current.records, step.id, "done", deps.now());
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
  const nextLabel = !last ? "next" : nextStepId(chapters, step.id) ? "nextChapter" : "finish";
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
      />
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
          <p className="tut-text">{t("tutorial.ui.leaveDialog.body")}</p>
        </Dialog>
      )}
    </div>
  );
}
