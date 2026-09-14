import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { expect, it } from "vitest";

// Stage 9 M3: zh-CN.json is the single source of truth for UI copy; en.json
// must mirror it exactly — same key set, non-empty leaves, and the same
// {{placeholder}} variable names per key.
// (node:url's URL, not happy-dom's, so fileURLToPath accepts it.)
const LOCALES = fileURLToPath(new NodeURL("../src/locales", import.meta.url));

type Tree = { [key: string]: Tree | string };

function load(name: string): Tree {
  return JSON.parse(readFileSync(`${LOCALES}/${name}`, "utf8")) as Tree;
}

function flatten(tree: Tree, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(tree)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[p] = v;
    else flatten(v, p, out);
  }
  return out;
}

const VAR_RE = /\{\{(\w+)\}\}/g;

function vars(s: string): string[] {
  return [...new Set([...s.matchAll(VAR_RE)].map((m) => m[1]))].sort();
}

const zh = flatten(load("zh-CN.json"));
const en = flatten(load("en.json"));

it("zh-CN and en have identical key sets", () => {
  const missing = Object.keys(zh).filter((k) => !(k in en));
  const extra = Object.keys(en).filter((k) => !(k in zh));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});

it("every zh-CN leaf is a non-empty string", () => {
  const empty = Object.entries(zh)
    .filter(([, v]) => v.trim() === "")
    .map(([k]) => k);
  expect(empty).toEqual([]);
});

it("every en leaf is a non-empty string", () => {
  const empty = Object.entries(en)
    .filter(([, v]) => v.trim() === "")
    .map(([k]) => k);
  expect(empty).toEqual([]);
});

it("placeholder variables match between zh-CN and en", () => {
  const mismatches = Object.keys(zh)
    .filter((k) => k in en)
    .map((k) => ({ k, zhVars: vars(zh[k]), enVars: vars(en[k]) }))
    .filter(({ zhVars, enVars }) => zhVars.join(" ") !== enVars.join(" "))
    .map(({ k, zhVars, enVars }) => `${k}: zh {${zhVars.join(", ")}} vs en {${enVars.join(", ")}}`);
  expect(mismatches).toEqual([]);
});
