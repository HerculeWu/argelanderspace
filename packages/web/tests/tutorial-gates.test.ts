import { describe, expect, it } from "vitest";
import { CHAPTERS } from "../src/tutorial/chapters";
import { activeRungs } from "../src/tutorial/anchors";
import type { GateRun, StepDefinition, WorkbenchSnapshot } from "../src/tutorial/types";
import { fakeDom, fakeSnapshot } from "./tutorial-fixtures";

const step = (id: string): StepDefinition => {
  for (const c of CHAPTERS) for (const s of c.steps) if (s.id === id) return s;
  throw new Error(id);
};
const runOf = (baseline: WorkbenchSnapshot): GateRun => ({ baseline, memo: {} });
const holds = (id: string, s: WorkbenchSnapshot, run = runOf(s)) => step(id).gate!(s, run);

describe("chapter 0 gates and requirements against fake snapshots", () => {
  it("0.1 passes on the settings page only (L1)", () => {
    expect(holds("prepare.settings", fakeSnapshot({ view: "settings" }))).toBe(true);
    expect(holds("prepare.settings", fakeSnapshot({ view: "library" }))).toBe(false);
  });
  it("0.2 passes when the environment check is done, whatever it found (L3)", () => {
    expect(holds("prepare.environment", fakeSnapshot({ view: "settings", dom: fakeDom({ "environment-check": { "data-state": "done" } }) }))).toBe(true);
    expect(holds("prepare.environment", fakeSnapshot({ view: "settings", dom: fakeDom({ "environment-check": { "data-state": "checking" } }) }))).toBe(false);
    expect(holds("prepare.environment", fakeSnapshot({ view: "settings" }))).toBe(false);
    expect(step("prepare.environment").onPass).toBe("recheckEnvironment");
  });
  it("0.2 and 0.3 require the settings page; there is no registered action to it, so no take-me-there", () => {
    for (const id of ["prepare.environment", "prepare.ads"]) {
      const r = step(id).requires!;
      expect(r.test(fakeSnapshot({ view: "settings" }))).toBe(true);
      expect(r.test(fakeSnapshot({ view: "library" }))).toBe(false);
      expect(r.where).toBe("settings");
      expect(r.takeMeThere).toBeUndefined();
    }
  });
  it("0.3 and 0.A have no gate; 0.A is an agent card docked in the browser form", () => {
    expect(step("prepare.ads").gate).toBeUndefined();
    expect(step("prepare.agent").gate).toBeUndefined();
    expect(step("prepare.agent").kind).toBe("agent");
    expect(step("prepare.agent").browser?.anchors).toEqual([]);
  });
});

describe("chapter 1 gates against fake snapshots", () => {
  it("1.1 passes when the active pane shows the library (L1)", () => {
    expect(holds("tour.library", fakeSnapshot({ view: "library" }))).toBe(true);
    expect(holds("tour.library", fakeSnapshot({ view: "plan" }))).toBe(false);
  });
  it("the chapter's order (user ruling 2026-10-21): split, pane views, close the pane", () => {
    expect(CHAPTERS.find((c) => c.id === "tour")!.steps.map((s) => s.id)).toEqual(["tour.library", "tour.split", "tour.pane-views", "tour.close-pane", "tour.palette", "tour.tweaks"]);
  });
  it("1.2 split passes once there are two panes or more (a state gate)", () => {
    expect(holds("tour.split", fakeSnapshot({ panes: 1 }))).toBe(false);
    expect(holds("tour.split", fakeSnapshot({ panes: 2 }))).toBe(true);
    expect(holds("tour.split", fakeSnapshot({ panes: 3 }))).toBe(true);
  });
  it("1.4 close is a process gate: two panes seen during the showing, then one", () => {
    const start = fakeSnapshot({ view: "library", panes: 2 });
    const run = runOf(start);
    expect(holds("tour.close-pane", start, run)).toBe(false);
    expect(holds("tour.close-pane", fakeSnapshot({ view: "library", panes: 1 }), run)).toBe(true);
  });
  it("1.4 does not pass on one pane alone, nor with a split still open", () => {
    const one = fakeSnapshot({ panes: 1 });
    expect(holds("tour.close-pane", one, runOf(one))).toBe(false);
    const run = runOf(one);
    holds("tour.close-pane", fakeSnapshot({ panes: 3 }), run);
    expect(holds("tour.close-pane", fakeSnapshot({ panes: 2 }), run)).toBe(false);
    expect(holds("tour.close-pane", fakeSnapshot({ panes: 1 }), run)).toBe(true);
  });
  it("1.4's rungs carry conditions: the title bar's split button with one pane, the active (new) pane's close after", () => {
    const rungs = (panes: number) => activeRungs(step("tour.close-pane").anchors, fakeSnapshot({ panes })).map((a) => `${a.ui}${a.within ? `<${a.within.ui}` : ""}${a.scope ? `@${a.scope}` : ""}`);
    expect(rungs(1)).toEqual(["split-pane<titlebar-actions"]);
    expect(rungs(2)).toEqual(["close-pane@active-pane"]);
  });
  it("1.4 passes while the command palette is open (L3)", () => {
    expect(holds("tour.palette", fakeSnapshot({ paletteOpen: true }))).toBe(true);
    expect(holds("tour.palette", fakeSnapshot({ paletteOpen: false }))).toBe(false);
  });
  it("1.3 and 1.6 are look steps without gates; chapter 1 has no agent card", () => {
    expect(step("tour.pane-views").gate).toBeUndefined();
    expect(step("tour.tweaks").gate).toBeUndefined();
    expect(CHAPTERS.find((c) => c.id === "tour")!.steps.some((s) => s.kind === "agent")).toBe(false);
  });
});
