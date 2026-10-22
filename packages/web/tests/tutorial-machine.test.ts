import { describe, expect, it } from "vitest";
import { CHAPTERS } from "../src/tutorial/chapters";
import {
  alignPosition,
  chapterStatus,
  chapterSummary,
  gatePasses,
  isLastOfChapter,
  nextStepId,
  previousStepId,
  progressWith,
  recordOf,
  withRecord,
} from "../src/tutorial/machine";
import type { ChapterDefinition } from "../src/tutorial/types";
import { fakeProgress } from "./tutorial-fixtures";

const AT = "2026-10-21T01:00:00.000Z";
const prepare = CHAPTERS.find((c) => c.id === "prepare")!;
const tour = CHAPTERS.find((c) => c.id === "tour")!;

describe("step ids align with the definitions (spec section 6)", () => {
  it("a position still defined is kept", () => {
    expect(alignPosition(CHAPTERS, "tour.split")).toBe("tour.split");
  });
  it("a position gone from a chapter still defined falls back to that chapter's first step", () => {
    expect(alignPosition(CHAPTERS, "tour.removed-step")).toBe("tour.library");
  });
  it("a position whose chapter is gone falls back to chapter 0", () => {
    expect(alignPosition(CHAPTERS, "nowhere.step")).toBe("prepare.settings");
  });
  it("no position starts at chapter 0", () => {
    expect(alignPosition(CHAPTERS, null)).toBe("prepare.settings");
  });
  it("records of ids no longer defined are ignored, not counted, and kept for the file", () => {
    const records = { "gone.step": { state: "done" as const, at: AT }, "tour.library": { state: "done" as const, at: AT } };
    expect(chapterSummary(tour, records)).toEqual({ done: 1, skipped: 0, total: 6 });
    const file = progressWith(fakeProgress(), "tour.split", records, AT);
    expect(file.steps["gone.step"]).toEqual({ state: "done", at: AT });
    expect(file.position).toBe("tour.split");
    expect(file.updatedAt).toBe(AT);
  });
  it("a new id is not done", () => {
    expect(recordOf({}, "tour.tweaks")).toBeNull();
    expect(recordOf({}, "toString")).toBeNull();
  });
});

describe("moving between steps", () => {
  it("next and back cross chapter borders; nothing before the first or after the last registered step", () => {
    expect(nextStepId(CHAPTERS, "prepare.agent")).toBe("tour.library");
    expect(previousStepId(CHAPTERS, "tour.library")).toBe("prepare.agent");
    expect(previousStepId(CHAPTERS, "prepare.settings")).toBeNull();
    // after the last step of the last registered chapter (whichever chapters are registered) there is none
    const lastChapter = CHAPTERS[CHAPTERS.length - 1]!;
    expect(nextStepId(CHAPTERS, lastChapter.steps[lastChapter.steps.length - 1]!.id)).toBeNull();
    expect(nextStepId(CHAPTERS, "tour.tweaks")).toBe(CHAPTERS[CHAPTERS.findIndex((c) => c.id === "tour") + 1]?.steps[0]?.id ?? null);
    expect(isLastOfChapter(CHAPTERS, "prepare.agent")).toBe(true);
    expect(isLastOfChapter(CHAPTERS, "tour.split")).toBe(false);
  });
});

describe("chapter state in the rail", () => {
  const all = (state: "done" | "skipped", ch: ChapterDefinition) => Object.fromEntries(ch.steps.map((s) => [s.id, { state, at: AT }]));
  it("not started, in progress (current or partly recorded), done, skipped", () => {
    expect(chapterStatus(tour, {}, "prepare.settings")).toBe("notStarted");
    expect(chapterStatus(tour, {}, "tour.split")).toBe("inProgress");
    expect(chapterStatus(tour, { "tour.library": { state: "done", at: AT } }, "prepare.ads")).toBe("inProgress");
    expect(chapterStatus(prepare, all("done", prepare), "tour.library")).toBe("done");
    expect(chapterStatus(prepare, withRecord(all("done", prepare), "prepare.environment", "skipped", AT), null)).toBe("skipped");
  });
});

describe("a gate passes only while its step is not done", () => {
  const step = prepare.steps[0]!;
  it("never reached: the holding gate passes", () => {
    expect(gatePasses(step, null, true)).toBe(true);
    expect(gatePasses(step, null, false)).toBe(false);
  });
  it("skipped, then shown again with the gate holding: it passes (recorded done)", () => {
    expect(gatePasses(step, { state: "skipped", at: AT }, true)).toBe(true);
  });
  it("already done: it does not pass again (Back can show the step)", () => {
    expect(gatePasses(step, { state: "done", at: AT }, true)).toBe(false);
  });
  it("a step without a gate never passes by itself", () => {
    expect(gatePasses(prepare.steps[2]!, null, true)).toBe(false);
  });
});
