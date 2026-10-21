import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CHAPTERS } from "../src/tutorial/chapters";

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
