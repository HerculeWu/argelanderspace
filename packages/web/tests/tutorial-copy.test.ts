import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CHAPTER_STATUSES } from "../src/tutorial/machine";
import { CHAPTERS } from "../src/tutorial/chapters";
import { NEXT_LABELS } from "../src/tutorial/StepCard";
import { WHERE_KEYS } from "../src/tutorial/types";

// Every copy key a registered step's card asks for exists in both locales (keys are built from step ids at run time,
// so the i18n types cannot check them).
const LOCALES = fileURLToPath(new NodeURL("../src/locales", import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(`${LOCALES}/${name}`, "utf8")) as Record<string, unknown>;
const get = (tree: unknown, path: string): unknown => path.split(".").reduce<unknown>((node, k) => (node && typeof node === "object" ? (node as Record<string, unknown>)[k] : undefined), tree);

function keysOf(): string[] {
  const keys: string[] = [];
  for (const c of CHAPTERS) {
    keys.push(`tutorial.chapters.${c.id}.title`);
    for (const s of c.steps) {
      const k = `tutorial.steps.${s.id}`;
      keys.push(`${k}.title`);
      if (s.kind === "agent") keys.push(`${k}.intro`, `${k}.prompt`, `${k}.skill`);
      else keys.push(`${k}.body`);
      if (s.browser) keys.push(`${k}.introBrowser`, `${k}.promptBrowser`);
      if (s.gate) keys.push(`${k}.waiting`);
      if (s.needsTex) keys.push(`${k}.alt`);
      if (s.preparedText !== undefined) keys.push(`${k}.prepared.label`);
      if (s.preparedCopy) keys.push(`${k}.prepared.label`, `${k}.prepared.text`);
      if (s.requires) keys.push(`tutorial.ui.where.${s.requires.where}`);
    }
  }
  // The keys the cards and the rail build at run time from a closed set (tk() / template keys): every value of the set.
  for (const where of WHERE_KEYS) keys.push(`tutorial.ui.where.${where}`);
  for (const status of [...CHAPTER_STATUSES, "needsTex"]) keys.push(`tutorial.ui.rail.status.${status}`);
  for (const label of NEXT_LABELS) keys.push(`tutorial.ui.${label}`);
  return keys;
}

describe("tutorial copy keys", () => {
  for (const locale of ["zh-CN.json", "en.json"]) {
    it(`every key the registered steps use is a non-empty string in ${locale}`, () => {
      const tree = load(locale);
      const missing = keysOf().filter((k) => typeof get(tree, k) !== "string" || !(get(tree, k) as string).trim());
      expect(missing).toEqual([]);
    });
  }
});

// The polish round (in-app-tutorial tickets 19/21/22/23 rulings): copy that described the product or the sample wrongly.
describe("tutorial copy says what the product and the sample really do", () => {
  const zh = load("zh-CN.json");
  const en = load("en.json");
  const both = (path: string) => [String(get(zh, path)), String(get(en, path))] as const;
  /** zh length by the copy file's rule: CJK and full-width punctuation 1, Latin letters, digits, half-width marks 0.5. */
  const zhLength = (text: string) => [...text].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) <= 0xff ? 0.5 : 1), 0);

  it("0.3: the tutorial is not offline throughout; the ADS token is optional and only for chapter 4's exploration", () => {
    const [z, e] = both("tutorial.steps.prepare.ads.body");
    expect(z).not.toContain("离线");
    expect(z).toContain("第 4 章");
    expect(e).not.toMatch(/offline/i);
    expect(e).toContain("chapter 4");
    expect(zhLength(z)).toBeLessThanOrEqual(80);
  });
  it("3.4: two clicks — the list entry jumps to it, the highlighted text (or the margin count) opens it", () => {
    const [z, e] = both("tutorial.steps.reading.open-annotation.body");
    expect(z).toContain("高亮");
    expect(z).not.toContain("并弹出");
    expect(e).toMatch(/highlighted/i);
    expect(zhLength(z)).toBeLessThanOrEqual(80);
  });
  it("4.4: a look-style explanation of the graph view (it is already the default)", () => {
    const [z, e] = both("tutorial.steps.discovery.graph.body");
    expect(z.startsWith("这是")).toBe(true);
    expect(e.startsWith("This is")).toBe(true);
    expect(zhLength(z)).toBeLessThanOrEqual(80);
  });
  it("5.6: End is found only with “Show all arguments” ticked, named as the product names it", () => {
    const [z, e] = both("tutorial.steps.argument.link-end.body");
    expect(z).toContain(`「${String(get(zh, "argument.edit.pickAll"))}」`);
    expect(e).toContain(`“${String(get(en, "argument.edit.pickAll"))}”`);
    expect(zhLength(z)).toBeLessThanOrEqual(80);
  });
  it("6.3: copy the task title first, then open the New task dialog (the card steps aside under it)", () => {
    const [z, e] = both("tutorial.steps.plan.create-task.body");
    expect(z.startsWith("先复制")).toBe(true);
    expect(e.startsWith("Copy")).toBe(true);
  });
  it("7.5 without TeX: no pre-rendered result is promised (the sample ships none)", () => {
    for (const path of ["tutorial.ui.noTexBody", "tutorial.steps.writer.render.alt"]) {
      const [z, e] = both(path);
      expect(z).not.toContain("预置结果");
      expect(e).not.toMatch(/prepared result/i);
    }
    expect(zhLength(String(get(zh, "tutorial.steps.writer.render.alt")))).toBeLessThanOrEqual(40);
  });
});
