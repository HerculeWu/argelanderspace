/**
 * Chapter 8 "copilot" (in-app-tutorial ticket 24): its gate (two layers) and ladders against fake snapshots, the preset
 * conversation it replays, and the agent cards of every chapter against the skills the repository ships.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import type { PageContext } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import { CHAPTERS } from "../src/tutorial/chapters";
import { COPILOT_CHAPTER } from "../src/tutorial/chapters/copilot";
import { SAMPLE_CONVERSATION } from "../src/tutorial/sample-ids";
import type { GateRun, StepDefinition, TutorialAnchor, WorkbenchSnapshot } from "../src/tutorial/types";
import { fakeDom, fakePage, fakeSnapshot } from "./tutorial-fixtures";

const step = (id: string): StepDefinition => {
  const found = COPILOT_CHAPTER.steps.find((s) => s.id === id);
  if (!found) throw new Error(id);
  return found;
};
const runOf = (baseline: WorkbenchSnapshot): GateRun => ({ baseline, memo: {} });
const [Q1, Q2] = SAMPLE_CONVERSATION.questions;
const [PLAN_REPLY] = SAMPLE_CONVERSATION.operationReplies;

/** A snapshot of any view with the Copilot panel open or closed, as the Shell reports it (L1). */
function panel(open: boolean, view = "doc"): WorkbenchSnapshot {
  const page = fakePage(view) as unknown as { workspace: Record<string, unknown> };
  page.workspace = { ...page.workspace, copilotOpen: open };
  return fakeSnapshot({ page: page as unknown as PageContext });
}
/** The same without the workspace field (L1 unavailable): only the DOM of the sidebar tells. */
function noWorkspace(dom: Record<string, Record<string, string>>): WorkbenchSnapshot {
  const page = { ...(fakePage("doc") as unknown as Record<string, unknown>) };
  delete page.workspace;
  return fakeSnapshot({ page: page as unknown as PageContext, dom: fakeDom(dom) });
}
const shape = (a: TutorialAnchor) => [a.ui, a.key ?? null, a.within ? `${a.within.ui}[${a.within.key ?? ""}]` : null];
/** The rungs that apply now (a rung with a false condition counts as absent). */
const rungs = (s: StepDefinition, snap: WorkbenchSnapshot) => s.anchors.filter((a) => !a.when || a.when(snap)).map(shape);

describe("chapter 8 is registered after chapter 7 and before the finish page", () => {
  it("its steps, in the order of appendix A", () => {
    expect(COPILOT_CHAPTER.id).toBe("copilot");
    expect(COPILOT_CHAPTER.n).toBe(8);
    expect(COPILOT_CHAPTER.steps.map((s) => s.id)).toEqual(["copilot.open", "copilot.context", "copilot.operations", "copilot.conversations", "copilot.provider", "copilot.agent"]);
    const ids = CHAPTERS.map((c) => c.id);
    expect(ids.slice(-3)).toEqual(["writer", "copilot", "finish"]);
  });
  it("has no prerequisite, nothing to type and nothing that needs TeX", () => {
    for (const s of COPILOT_CHAPTER.steps) {
      expect(s.needsTex).toBeFalsy();
      expect(s.preparedText).toBeUndefined();
      expect(s.preparedCopy).toBeFalsy();
      expect(s.sources).toBeUndefined();
    }
    // Only 8.1 is gated; the rest are looks and the agent card.
    expect(COPILOT_CHAPTER.steps.filter((s) => s.gate).map((s) => s.id)).toEqual(["copilot.open"]);
    expect(step("copilot.agent").kind).toBe("agent");
    expect(step("copilot.agent").anchors).toEqual([]);
  });
});

describe("8.1: the gate is the panel being open", () => {
  const open = step("copilot.open");
  it("climbs from the toggle to the sidebar", () => {
    expect(open.anchors.map(shape)).toEqual([
      ["copilot-toggle", null, null],
      ["copilot-sidebar", null, null],
    ]);
  });
  it("L1: the Shell's copilotOpen", () => {
    const gate = open.gate!;
    expect(gate(panel(false), runOf(panel(false)))).toBe(false);
    expect(gate(panel(true), runOf(panel(false)))).toBe(true);
    // Already open when the step starts (resuming, coming back): passes at once.
    expect(gate(panel(true), runOf(panel(true)))).toBe(true);
    // L1 answers even when the DOM says otherwise: the first layer that has it wins.
    const l1Closed = { ...panel(false), dom: fakeDom({ "copilot-sidebar": {} }) };
    expect(gate(l1Closed, runOf(l1Closed))).toBe(false);
  });
  it("L3 when the page context has no workspace: the sidebar present and not hidden", () => {
    const gate = open.gate!;
    const shown = noWorkspace({ "copilot-sidebar": {} });
    const hidden = noWorkspace({ "copilot-sidebar": { hidden: "" } });
    const absent = noWorkspace({});
    expect(gate(shown, runOf(absent))).toBe(true);
    expect(gate(hidden, runOf(hidden))).toBe(false);
    expect(gate(absent, runOf(absent))).toBe(false);
  });
});

describe("8.2-8.5: looks at the open panel; a closed panel docks the card with 'take me there'", () => {
  it("8.2 climbs to the page context of the first question (asked in Jerabkova's reader)", () => {
    const s = step("copilot.context");
    expect(s.kind).toBe("look");
    expect(rungs(s, panel(true))).toEqual([
      ["copilot-messages", null, null],
      ["copilot-message", Q1, null],
      ["copilot-message-context", null, `copilot-message[${Q1}]`],
    ]);
  });
  it("8.3 climbs from the second question to the operation card of its reply (the Plan task); its card takes you to the plan page, no gate", () => {
    const s = step("copilot.operations");
    expect(s.kind).toBe("look");
    expect(s.gate).toBeUndefined();
    expect(rungs(s, panel(true))).toEqual([
      ["copilot-message", Q2, null],
      ["copilot-operation", null, `copilot-message[${PLAN_REPLY}]`],
    ]);
    expect(s.takeMeThere).toEqual({ action: "switch_view", view: "plan" });
    for (const id of ["copilot.open", "copilot.context", "copilot.conversations", "copilot.provider", "copilot.agent"]) expect(step(id).takeMeThere).toBeUndefined();
  });
  it("8.4 climbs from the Conversations button to its list", () => {
    expect(rungs(step("copilot.conversations"), panel(true))).toEqual([
      ["copilot-conversations", null, null],
      ["copilot-conversation-list", null, null],
    ]);
  });
  it("8.5 climbs from the settings button to the model settings", () => {
    expect(rungs(step("copilot.provider"), panel(true))).toEqual([
      ["copilot-settings", null, null],
      ["provider-settings", null, null],
    ]);
  });
  it("each requires the panel open (L1, L3 behind it); 'take me there' opens it with the workspace's registered action", () => {
    for (const id of ["copilot.context", "copilot.operations", "copilot.conversations", "copilot.provider"]) {
      const r = step(id).requires!;
      expect(r.where).toBe("copilot");
      expect(r.takeMeThere).toEqual({ action: "open_copilot" });
      expect(r.test(panel(true))).toBe(true);
      expect(r.test(panel(false))).toBe(false);
      expect(r.test(noWorkspace({ "copilot-sidebar": {} }))).toBe(true);
      expect(r.test(noWorkspace({ "copilot-sidebar": { hidden: "" } }))).toBe(false);
    }
    expect(step("copilot.open").requires).toBeUndefined();
    expect(step("copilot.agent").requires).toBeUndefined();
  });
});

// The agent cards of every chapter (ticket 24: the card audit): every skill they name is a skill the repository ships.
const SKILLS_DIR = fileURLToPath(new NodeURL("../../../skills", import.meta.url));
const LOCALES = fileURLToPath(new NodeURL("../src/locales", import.meta.url));
const SHIPPED = new Set(readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
type Tree = Record<string, Record<string, Record<string, string>>>;
const stepsOf = (locale: string) => (JSON.parse(readFileSync(`${LOCALES}/${locale}`, "utf8")) as { tutorial: { steps: Tree } }).tutorial.steps;
const agentSteps = CHAPTERS.flatMap((c) => c.steps.filter((s) => s.kind === "agent").map((s) => s.id));
const card = (steps: Tree, id: string) => {
  const [chapter, name] = id.split(".") as [string, string];
  return steps[chapter]?.[name] ?? {};
};

describe("the agent cards name the skills the repository ships", () => {
  it("every chapter but the tour ends with an agent card", () => {
    expect(agentSteps).toEqual(["prepare.agent", "library.agent", "reading.agent", "discovery.agent", "argument.agent", "plan.agent", "writer.agent", "copilot.agent"]);
  });
  for (const locale of ["zh-CN.json", "en.json"]) {
    it(`every argelander-* name on a card is a skill folder of skills/ (${locale})`, () => {
      const steps = stepsOf(locale);
      const named = agentSteps.flatMap((id) => Object.values(card(steps, id)).flatMap((text) => [...text.matchAll(/argelander-[a-z-]+/g)].map((m) => m[0])));
      expect(named.length).toBeGreaterThan(0);
      expect(named.filter((n) => !SHIPPED.has(n))).toEqual([]);
    });
    it(`a card whose prompt asks for a skill lists that skill on its skill line (${locale})`, () => {
      const steps = stepsOf(locale);
      for (const id of agentSteps) {
        const { prompt = "", skill = "" } = card(steps, id);
        for (const m of prompt.matchAll(/argelander-[a-z-]+/g)) expect(skill, id).toContain(m[0]);
      }
    });
    it(`0.A lists all five shipped skills; 8.A the Copilot's two read-only ones (${locale})`, () => {
      const steps = stepsOf(locale);
      expect(new Set(card(steps, "prepare.agent").skill?.match(/argelander-[a-z-]+/g))).toEqual(SHIPPED);
      // The Copilot's allow-list is the server's COPILOT_SKILL_NAMES (read as text: the web package does not import the server).
      const resources = readFileSync(fileURLToPath(new NodeURL("../../server/src/copilot-resources.ts", import.meta.url)), "utf8");
      const allowed = [...(resources.match(/COPILOT_SKILL_NAMES[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(allowed).toEqual(["argelander-read-paper", "argelander-query-paper-library"]);
      expect(card(steps, "copilot.agent").skill?.match(/argelander-[a-z-]+/g)).toEqual(allowed);
    });
  }
  it("8.1 warns that sending really calls a model and spends tokens, in both languages", () => {
    expect(card(stepsOf("zh-CN.json"), "copilot.open").body).toContain("token");
    expect(card(stepsOf("en.json"), "copilot.open").body).toContain("token");
  });
});

// Ticket 24 rulings: copy that said something the page or the skills do not do.
describe("chapter 8 and the agent cards say what the page and the skills really do", () => {
  const zh = stepsOf("zh-CN.json");
  const en = stepsOf("en.json");
  it("8.2 points at the fold titled with the paper, not at a label the message does not show", () => {
    expect(card(zh, "copilot.context").body).toContain("论文标题");
    expect(card(zh, "copilot.context").body).not.toContain("「页面上下文」");
    expect(card(en, "copilot.context").body).toContain("paper's title");
    expect(card(en, "copilot.context").body).not.toContain("“Page context”");
  });
  it("8.3 mentions the card's own take-me-there, with the framework's label", () => {
    const ui = (locale: string) => (JSON.parse(readFileSync(`${LOCALES}/${locale}`, "utf8")) as { tutorial: { ui: { takeMeThere: string } } }).tutorial.ui.takeMeThere;
    expect(card(zh, "copilot.operations").body).toContain(`「${ui("zh-CN.json")}」`);
    expect(card(en, "copilot.operations").body).toContain(`“${ui("en.json")}”`);
  });
  it("2.A: the command line ingest is followed by library build (skills/README.md: required after ingest)", () => {
    const readme = readFileSync(`${SKILLS_DIR}/README.md`, "utf8");
    expect(readme).toContain("`library build [--offline]`");
    for (const steps of [zh, en]) {
      expect(card(steps, "library.agent").skill).toContain("argelanderspace ingest arXiv:2202.06973");
      expect(card(steps, "library.agent").skill).toContain("argelanderspace library build");
    }
  });
  it("4.A: find-papers reads its ADS key from ~/.ads/dev_key, not the workbench's saved token (its SKILL.md)", () => {
    const skill = readFileSync(`${SKILLS_DIR}/argelander-find-papers/SKILL.md`, "utf8");
    expect(skill).toContain("`~/.ads/dev_key`");
    for (const steps of [zh, en]) expect(card(steps, "discovery.agent").skill).toContain("~/.ads/dev_key");
  });
});
