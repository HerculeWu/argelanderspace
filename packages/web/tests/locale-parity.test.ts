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

// A zh-CN value identical to its en value is either a forgotten translation or
// deliberately the same. The deliberate ones are listed here, each with its
// reason; anything else equal across the two files fails, so an English string
// pasted into zh-CN.json is caught.
const SAME_IN_BOTH: Record<string, string> = {
  // Proper names and product names
  "shell.tweaks.language.zhCN": "language-picker endonym",
  "shell.tweaks.language.en": "language-picker endonym",
  "copilot.title": "product name",
  "settings.groups.copilot": "product name",
  "tutorial.chapters.copilot.title": "product name",
  "mail.add.gmail": "service name",
  "mail.add.icloud": "service name",
  "library.detail.tabs.bib": "format name BibTeX",
  "library.importDialog.bibcodeLabel": "ADS term bibcode",
  // Abbreviations, protocol and format names, code tokens
  "shell.palette.esc": "key name shown as a keycap",
  "mail.add.tls": "protocol name",
  "mail.add.starttls": "protocol name",
  "mail.add.protocolImap": "protocol name",
  "mail.add.protocolSmtp": "protocol name",
  "writer.types.latex": "format name LaTeX",
  "writer.field.latexSource": "format name LaTeX",
  "argument.edit.sourceDocFormat.pdf": "format name PDF",
  "argument.edit.sourceDocFormat.latex": "format name LaTeX",
  "settings.tex.source.path": "the PATH environment variable",
  "providers.apiKey": "technical term, kept in English in neighbouring zh strings",
  "providers.baseUrl": "technical field name matching the provider config",
  "providers.modelId": "technical field name matching the provider config",
  "settings.ads.token": "technical term, kept in English in neighbouring zh strings",
  "settings.cli.skills": "the skills folder name agents look for",
  // Placeholders and format strings with nothing to translate
  "library.importDialog.bibcodePlaceholder": "example bibcode",
  "library.importDialog.bibPlaceholder": "example BibTeX entry",
  "settings.services.contactPlaceholder": "example e-mail address",
  "writer.comments.forCell": "format string: separator and {{type}}",
  "copilot.tools.result.diff": "format string: +added −removed",
  "argument.view.audit.cycleArrow": "format string: arrow",
  "argument.view.panel.untitled": "placeholder dash",
  "argument.edit.issue.other": "format string: {{message}} only",
  "tutorial.ui.rail.chapterLabel": "format string of interpolations",
  "tutorial.ui.rail.stepRow": "format string of interpolations",
  "tutorial.steps.prepare.agent.skill": "skill names, code tokens",
  "tutorial.steps.prepare.agent.promptBrowser": "URL",
  "tutorial.steps.copilot.agent.skill": "skill names, code tokens",
  // Toulmin-model terms the domain language keeps in English (CONTEXT.md)
  "argument.canvas.kindNative": "domain term Native",
  "argument.canvas.kindEnd": "domain term End",
  "argument.canvas.roleGrounds": "Toulmin term",
  "argument.canvas.roleWarrant": "Toulmin term",
  "argument.canvas.roleBacking": "Toulmin term",
  "argument.canvas.roleRebuttal": "Toulmin term",
  "argument.view.kind.native": "domain term Native",
  "argument.view.kind.end": "domain term End",
  // Manuscript content: English-language paper structure written into the output
  "writer.abstract.context": "A&A structured-abstract heading, goes into the paper",
  "writer.abstract.aims": "A&A structured-abstract heading, goes into the paper",
  "writer.abstract.methods": "A&A structured-abstract heading, goes into the paper",
  "writer.abstract.results": "A&A structured-abstract heading, goes into the paper",
  "writer.abstract.conclusions": "A&A structured-abstract heading, goes into the paper",
  "writer.ackTitle": "heading of the English paper preview",
  "writer.appendixMarker": "marker of the English paper preview",
  "writer.field.caption": "LaTeX \\caption field",
  "writer.field.label": "LaTeX \\label field",
  "writer.list.untitled": "default manuscript title stored as data; changing it is a separate decision",
  "writer.newModal.namePlaceholder": "same default manuscript title",
};

it("every zh-CN value equal to its en value is on the allowlist", () => {
  const same = Object.keys(zh).filter((k) => k in en && zh[k] === en[k]);
  const untranslated = same.filter((k) => !(k in SAME_IN_BOTH));
  expect(untranslated).toEqual([]);
});

it("the same-in-both allowlist has no stale entries", () => {
  const stale = Object.keys(SAME_IN_BOTH).filter((k) => !(k in zh && k in en && zh[k] === en[k]));
  expect(stale).toEqual([]);
});
