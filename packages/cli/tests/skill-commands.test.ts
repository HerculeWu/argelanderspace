/**
 * The drift check of the bundled operation guides (release-0.2 ticket 12): every `argelanderspace …` command in
 * `skills/<name>/SKILL.md` and `skills/README.md` is a command the program really has, with options it really takes, and every
 * operation id the guides name is in the catalog (on a table row whose command is the operation's own). The extraction
 * is `src/skill-commands.ts`, which ticket 15's e2e reuses to run the same commands.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  buildProgram,
  checkSkillCommand,
  checkSkillGuide,
  extractOperationIds,
  extractSkillCommands,
} from "../src/index.js";

const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));

/**
 * Commands a guide names before the CLI has them: release-0.2 ticket 14 adds `agent-plugin`, and the README points at it
 * (ticket 12). Remove the entry when the command exists; the test after the main one fails until then.
 */
const PLANNED = ["agent-plugin"];

const guides = (): { file: string; text: string }[] => {
  const files = [
    "README.md",
    ...readdirSync(SKILLS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(d.name, "SKILL.md")),
  ];
  return files.map((file) => ({ file, text: readFileSync(join(SKILLS, file), "utf8") }));
};

test("every command and option the guides show exists in the CLI, every operation id in the catalog", () => {
  const found = guides();
  expect(found.length).toBeGreaterThanOrEqual(7);
  const problems = found.flatMap(({ file, text }) =>
    checkSkillGuide(buildProgram(), text)
      .filter((p) => !PLANNED.some((name) => p.includes(`unknown command "${name}"`)))
      .map((p) => `${file}: ${p}`)
  );
  expect(problems).toEqual([]);
});

test("a planned command is removed from the exemption once the CLI has it", () => {
  const program = buildProgram();
  for (const name of PLANNED)
    expect(
      program.commands.some((c) => c.name() === name),
      `${name} exists now: drop it from PLANNED`
    ).toBe(false);
});

test("the guides carry real commands, so the check above is not vacuous", () => {
  for (const name of [
    "argelander-paper-ingest",
    "argelander-read-paper",
    "argelander-query-paper-library",
    "argelander-find-papers",
    "argelander-argument-graph",
    "argelander-project-intake",
  ]) {
    const file = join(SKILLS, name, "SKILL.md");
    expect(existsSync(file), name).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(extractSkillCommands(text).length, name).toBeGreaterThanOrEqual(2);
    expect(extractOperationIds(text).length, name).toBeGreaterThanOrEqual(1);
  }
});

test("find-papers searches through the catalog, not a script that reads a key file", () => {
  const text = readFileSync(join(SKILLS, "argelander-find-papers", "SKILL.md"), "utf8");
  expect(text).toContain("argelanderspace discovery search-ads");
  expect(text).not.toContain("ads.mjs");
  expect(text).not.toMatch(/\bnode [^\n`]*\.mjs/);
  expect(existsSync(join(SKILLS, "argelander-find-papers", "scripts"))).toBe(false);
});

test("the extraction reads fenced blocks (continuations, comments, pipes) and inline code, and nothing else", () => {
  const md = [
    "Run `argelanderspace library read-jobs --ref-id <id>` or `argelanderspace` alone.",
    "Install with `npm i -g argelanderspace`; the folder is argelanderspace-intake.md.",
    "```bash",
    "argelanderspace search | head -3",
    "argelanderspace argument replace \\",
    "  --json /tmp/g.json   # a comment",
    "cat g.json | argelanderspace argument put <workId> - --rev 3 [--replace]",
    "node /repo/bin.js search",
    "```",
    "| `argelanderspace read <docId> [--manifest refs\\|bib]` | markdown |",
  ].join("\n");
  expect(extractSkillCommands(md).map((c) => c.argv)).toEqual([
    ["library", "read-jobs", "--ref-id", "<id>"],
    ["search"],
    ["argument", "replace", "--json", "/tmp/g.json"],
    ["argument", "put", "<workId>", "-", "--rev", "3", "--replace"],
    ["read", "<docId>", "--manifest", "refs|bib"],
  ]);
});

test("a command that does not exist is reported: unknown command, option, choice, argument count", () => {
  const program = buildProgram();
  const check = (line: string) =>
    checkSkillCommand(program, extractSkillCommands(line)[0]?.argv ?? []);
  expect(check("`argelanderspace library read-jobs --ref-id <id> --limit 5`")).toEqual([]);
  expect(
    check("`argelanderspace discovery search-ads --query q --limit 5 --fields title`")
  ).toEqual([]);
  expect(check("`argelanderspace argument put <workId> g.json --rev 0 --replace`")).toEqual([]);
  expect(check("`argelanderspace library --help`")).toEqual([]);
  expect(check("`argelanderspace <group> --help`")).toEqual([]);
  expect(check("`argelanderspace library nope`")[0]).toContain('unknown command "nope"');
  expect(check("`argelanderspace discovery similar --bibcode x`")[0]).toContain(
    'unknown command "similar"'
  );
  expect(check("`argelanderspace discovery search-ads --rows 5`")[0]).toContain(
    "unknown option --rows"
  );
  expect(check("`argelanderspace annotation create-pdf --kind circle`")[0]).toContain("takes");
  expect(check("`argelanderspace read`")[0]).toContain("needs 1 argument");
  expect(check("`argelanderspace list extra`")[0]).toContain("takes 0 argument");
  expect(check("`argelanderspace note w1 some words here`")).toEqual([]);
});

test("an operation id must exist, and its row must show its own command", () => {
  const program = buildProgram();
  const guide = (row: string) => checkSkillGuide(program, row);
  expect(guide("| `library.read_jobs` | `argelanderspace library read-jobs` |")).toEqual([]);
  expect(guide("| `workspace.open_doc` | `argelanderspace open doc --doc-id d` |")).toEqual([]);
  expect(
    guide("| `reader.create_pdf_annotation` | `argelanderspace annotation create-pdf` |")
  ).toEqual([]);
  expect(guide("| `library.nope` | x |")[0]).toContain("not in the catalog");
  expect(
    guide("| `library.read_jobs` | `argelanderspace library read-ads-library` |")[0]
  ).toContain("is the command of library.read_ads_library");
  // the older commands beside an operation are not another operation's
  expect(guide("| `argument.read` | `argelanderspace argument get <workId>` |")).toEqual([]);
  // a dotted name that is not a domain (a file name, a version) is prose
  expect(guide("see `config.toml` and `ads.mjs`")).toEqual([]);
});
