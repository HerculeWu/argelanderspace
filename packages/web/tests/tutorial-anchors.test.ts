import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { PANE_VIEWS, SETTINGS_GROUPS } from "@argelanderspace/contracts";
import { describe, expect, it } from "vitest";
import { CHAPTERS } from "../src/tutorial/chapters";
import type { ChapterDefinition, TutorialAnchor } from "../src/tutorial/types";

// The static guard of the tutorial anchors (spec Testing Decisions "web"): every `data-ui` the definitions name — each
// rung of every ladder, the browser variants, and the L3 signals — must still be written in the product source.
const SRC = fileURLToPath(new NodeURL("../src", import.meta.url));
const TUTORIAL_DIR = join(SRC, "tutorial");

/** The signals the observation layer reads from the DOM itself (not from a step's ladder). */
const L3_SIGNALS: TutorialAnchor[] = [{ ui: "dialog-overlay" }, { ui: "command-palette" }];

/** Identifiers of repeated instances: an anchor on one of them must say which (a key, or the active-pane scope). */
const REPEATED = new Set(["work-item", "doc-item", "argument-node", "pane-header", "copilot-message", "workspace-pane", "navigate-view", "settings-group", "pane-view-option", "outline-item", "import-option", "task-doc-choice"]);

/** Enumerated keys and where their values come from; object-id keys are not checked here. */
const ENUM_KEYS: Record<string, readonly string[]> = {
  "navigate-view": PANE_VIEWS,
  "settings-group": SETTINGS_GROUPS,
};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(entry.name)) yield p;
  }
}

/**
 * Every `data-ui` written as a literal in the product source (outside the tutorial module itself). A shared component
 * that builds its identifiers from a `ui` prefix (data-ui={`${ui}-node`}, the layered graph canvas) contributes each
 * suffix under every literal `ui="<prefix>"` passed in the source (`argument-node` from ui="argument"). A helper that
 * renders data-ui={uiId} from its argument contributes the literals passed to it in that file (the argument panel's
 * linkToggle(..., "add-argument-use")).
 */
function productIdentifiers(): Set<string> {
  const found = new Set<string>();
  const suffixes = new Set<string>();
  const prefixes = new Set<string>();
  for (const file of walk(SRC)) {
    if (file.startsWith(TUTORIAL_DIR)) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/data-ui=["']([a-z0-9-]+)["']/g)) found.add(m[1]!);
    for (const m of text.matchAll(/\buiId=["']([a-z0-9-]+)["']/g)) found.add(m[1]!);
    for (const m of text.matchAll(/data-ui=\{`\$\{ui\}(-[a-z0-9-]+)`\}/g)) suffixes.add(m[1]!);
    for (const m of text.matchAll(/\sui=["']([a-z0-9-]+)["']/g)) prefixes.add(m[1]!);
    if (/data-ui=\{uiId\}/.test(text)) for (const m of text.matchAll(/,\s*"([a-z][a-z0-9]*(?:-[a-z0-9]+)+)"\s*[,)]/g)) found.add(m[1]!);
  }
  for (const prefix of prefixes) for (const suffix of suffixes) found.add(prefix + suffix);
  return found;
}

function anchorsOf(chapters: readonly ChapterDefinition[]): { where: string; anchor: TutorialAnchor }[] {
  const out: { where: string; anchor: TutorialAnchor }[] = [];
  for (const c of chapters)
    for (const s of c.steps) {
      for (const a of s.anchors) {
        out.push({ where: s.id, anchor: a });
        if (a.within) out.push({ where: `${s.id} (within)`, anchor: a.within });
      }
      for (const a of s.browser?.anchors ?? []) out.push({ where: `${s.id} (browser)`, anchor: a });
    }
  return out;
}

/** The problems of a set of anchors; empty when every anchor is sound. */
function anchorProblems(anchors: { where: string; anchor: TutorialAnchor }[], identifiers: Set<string>): string[] {
  const problems: string[] = [];
  for (const { where, anchor } of anchors) {
    if (!identifiers.has(anchor.ui)) problems.push(`${where}: data-ui "${anchor.ui}" is not in the product source`);
    if (REPEATED.has(anchor.ui) && anchor.key === undefined && anchor.scope === undefined) problems.push(`${where}: "${anchor.ui}" names repeated instances and needs a key`);
    const values = ENUM_KEYS[anchor.ui];
    if (values && anchor.key !== undefined && !values.includes(anchor.key)) problems.push(`${where}: "${anchor.ui}" has no instance "${anchor.key}"`);
  }
  return problems;
}

describe("tutorial anchors stay in the product source", () => {
  const identifiers = productIdentifiers();
  it("every rung of every registered step and the L3 signals are written in packages/web/src", () => {
    const all = [...anchorsOf(CHAPTERS), ...L3_SIGNALS.map((anchor) => ({ where: "observation", anchor }))];
    expect(all.length).toBeGreaterThan(10);
    expect(anchorProblems(all, identifiers)).toEqual([]);
  });
  it("the guard fails a renamed identifier, a repeated identifier without key, and an enum key with no instance", () => {
    const bad = [
      { where: "x", anchor: { ui: "no-such-control" } },
      { where: "y", anchor: { ui: "pane-header" } },
      { where: "z", anchor: { ui: "settings-group", key: "nope" } },
    ];
    expect(anchorProblems(bad, identifiers)).toHaveLength(3);
  });
  it("step ids are unique, prefixed by their chapter id, and every chapter has steps", () => {
    const ids = CHAPTERS.flatMap((c) => c.steps.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CHAPTERS) {
      expect(c.steps.length).toBeGreaterThan(0);
      for (const s of c.steps) expect(s.id.startsWith(`${c.id}.`)).toBe(true);
    }
  });
  it("sees identifiers a shared component builds from its ui prefix (the argument graph's nodes)", () => {
    expect(identifiers.has("argument-node")).toBe(true);
    expect(identifiers.has("argument-canvas")).toBe(true);
    expect(identifiers.has("nonexistent-node")).toBe(false);
    expect(identifiers.has("add-argument-use")).toBe(true);
  });
  it("reports where it looked (sanity: the scan sees the Shell)", () => {
    expect(identifiers.has("app-shell")).toBe(true);
    expect(relative(SRC, TUTORIAL_DIR)).toBe("tutorial");
  });
});
