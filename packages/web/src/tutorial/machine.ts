import type { TutorialProgress, TutorialStepRecord } from "@argelanderspace/contracts";
import type { ChapterDefinition, StepDefinition } from "./types";

/** After a gate passes, the card waits this long before it moves on, so the user sees it pass (spec section 3). */
export const AUTO_ADVANCE_MS = 900;

export type StepRecords = Readonly<Record<string, TutorialStepRecord>>;
/** A chapter's state in the rail (`tutorial.ui.rail.status.*`; the copy test checks every one). */
export const CHAPTER_STATUSES = ["notStarted", "inProgress", "done", "skipped"] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

export interface StepPlace {
  chapter: ChapterDefinition;
  step: StepDefinition;
  /** Index of the chapter among the registered ones, and of the step in its chapter. */
  ci: number;
  si: number;
}

/** A step id's chapter: the part before the first dot. */
export const chapterIdOf = (stepId: string): string => stepId.split(".")[0] ?? "";

export function findStep(chapters: readonly ChapterDefinition[], id: string | null): StepPlace | null {
  if (id === null) return null;
  for (let ci = 0; ci < chapters.length; ci++) {
    const chapter = chapters[ci]!;
    const si = chapter.steps.findIndex((s) => s.id === id);
    if (si >= 0) return { chapter, step: chapter.steps[si]!, ci, si };
  }
  return null;
}

const firstStepOf = (chapter: ChapterDefinition | undefined): string | null => chapter?.steps[0]?.id ?? null;

/**
 * Where to resume (spec section 6): the recorded position when that step still exists; else the first step of its
 * chapter when the chapter still exists; else the first step of chapter 0.
 */
export function alignPosition(chapters: readonly ChapterDefinition[], position: string | null): string | null {
  if (findStep(chapters, position)) return position;
  if (position !== null) {
    const chapter = chapters.find((c) => c.id === chapterIdOf(position));
    const first = firstStepOf(chapter);
    if (first) return first;
  }
  return firstStepOf(chapters.find((c) => c.n === 0) ?? chapters[0]);
}

/**
 * The records that apply to the current definitions: an id still defined keeps its state, an id no longer defined is
 * ignored (kept in the file, never shown or counted), a new id is not done.
 */
export function recordOf(records: StepRecords, id: string): TutorialStepRecord | null {
  return Object.getOwnPropertyDescriptor(records, id) ? records[id]! : null;
}

/** The step after `id`, crossing into the next registered chapter; null after the last one. */
export function nextStepId(chapters: readonly ChapterDefinition[], id: string): string | null {
  const place = findStep(chapters, id);
  if (!place) return null;
  if (place.si + 1 < place.chapter.steps.length) return place.chapter.steps[place.si + 1]!.id;
  for (let ci = place.ci + 1; ci < chapters.length; ci++) {
    const first = firstStepOf(chapters[ci]);
    if (first) return first;
  }
  return null;
}

/** The step before `id`, crossing back into the previous chapter's last step; null before the first one. */
export function previousStepId(chapters: readonly ChapterDefinition[], id: string): string | null {
  const place = findStep(chapters, id);
  if (!place) return null;
  if (place.si > 0) return place.chapter.steps[place.si - 1]!.id;
  for (let ci = place.ci - 1; ci >= 0; ci--) {
    const steps = chapters[ci]!.steps;
    if (steps.length) return steps[steps.length - 1]!.id;
  }
  return null;
}

/** The last step of its chapter (its card's button says "Next chapter", or "Finish" after the last chapter). */
export function isLastOfChapter(chapters: readonly ChapterDefinition[], id: string): boolean {
  const place = findStep(chapters, id);
  return Boolean(place && place.si === place.chapter.steps.length - 1);
}

export interface ChapterSummary {
  done: number;
  skipped: number;
  total: number;
}

export function chapterSummary(chapter: ChapterDefinition, records: StepRecords): ChapterSummary {
  let done = 0;
  let skipped = 0;
  for (const step of chapter.steps) {
    const r = recordOf(records, step.id);
    if (r?.state === "done") done++;
    else if (r?.state === "skipped") skipped++;
  }
  return { done, skipped, total: chapter.steps.length };
}

/**
 * A chapter's state in the rail (spec section 6): complete when every step is done or skipped — "done" when none was
 * skipped, "skipped" when one was; "in progress" when it holds the current step or some step is recorded; else
 * "not started". "Needs TeX" is shown beside this state, from the definitions and the environment.
 */
export function chapterStatus(chapter: ChapterDefinition, records: StepRecords, currentStepId: string | null): ChapterStatus {
  const { done, skipped, total } = chapterSummary(chapter, records);
  if (total > 0 && done + skipped === total) return skipped > 0 ? "skipped" : "done";
  if (done + skipped > 0) return "inProgress";
  if (currentStepId !== null && chapter.steps.some((s) => s.id === currentStepId)) return "inProgress";
  return "notStarted";
}

/** Record a step's state; the records are replaced, never mutated. */
export function withRecord(records: StepRecords, id: string, state: TutorialStepRecord["state"], at: string): StepRecords {
  return { ...records, [id]: { state, at } };
}

/**
 * What showing a gated step does with its gate (spec section 5/6): a gate that holds while the step is not done
 * (never reached, skipped, or resumed) passes — the step is recorded done and the card moves on. A step already done
 * shows as done and does not move on by itself (so Back can show it).
 */
export function gatePasses(step: StepDefinition, record: TutorialStepRecord | null, holds: boolean): boolean {
  return Boolean(step.gate) && holds && record?.state !== "done";
}

/** The whole file to write: the progress as read with the new position and records. */
export function progressWith(base: TutorialProgress, position: string | null, records: StepRecords, now: string): TutorialProgress {
  return { ...base, position, steps: { ...records }, updatedAt: now };
}
