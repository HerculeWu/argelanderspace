/**
 * The project intake skill (project intake ticket 04, ADR 0014) checks itself against the code. It reads the skill's
 * own text: the calls it shows are parsed out of SKILL.md and handed to the real zod schemas, the parameter lists it
 * writes in prose are compared with those schemas' fields, and every snake_case name it puts in code must be a real
 * action, reason or result field. Changing a name in SKILL.md (or in the code) without the other turns a test red.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DATA_DIR,
  LIBRARY_OPERATION_ACTIONS,
  LibraryAcquireArxivPdfSchema,
  LibraryAttachLocalPdfSchema,
  LibraryImportWorksSchema,
  LibraryListAdsLibrariesSchema,
  LibraryReadAdsLibrarySchema,
  LibraryReadJobsSchema,
  LibraryRefSummarySchema,
  ManualBibcodeReasonSchema,
  ManualWorkResultSchema,
  PLAN_OPERATION_ACTIONS,
  PlanOperationSchema,
  PlanReadOperationSchema,
  PlanWriteOperationSchema,
} from "@argelanderspace/contracts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { basePrompt } from "../src/copilot.js";
import { LIBRARY_TOOL_NAME } from "../src/copilot-library-tool.js";
import { PLAN_TOOL_NAME } from "../src/copilot-plan-tool.js";
import { COPILOT_SKILL_NAMES } from "../src/copilot-resources.js";
import { ADS_FAILURE_TEXT, LOCAL_PDF_REASONS } from "../src/library-actions.js";

const file = fileURLToPath(
  new URL("../../../skills/argelander-project-intake/SKILL.md", import.meta.url)
);
const skill = readFileSync(file, "utf8");

interface Shaped {
  shape: Record<string, unknown>;
}
/** The schema of each library action the skill uses. */
const LIBRARY_SCHEMAS: Record<string, { safeParse(v: unknown): { success: boolean } } & Shaped> = {
  list_ads_libraries: LibraryListAdsLibrariesSchema,
  read_ads_library: LibraryReadAdsLibrarySchema,
  import_works: LibraryImportWorksSchema,
  attach_local_pdf: LibraryAttachLocalPdfSchema,
  acquire_arxiv_pdf: LibraryAcquireArxivPdfSchema,
  read_jobs: LibraryReadJobsSchema,
};
/** The fields of each plan action. */
const PLAN_SHAPES: Record<string, Record<string, unknown>> = Object.fromEntries([
  ...PlanWriteOperationSchema.options.map(
    (o) => [(o.shape.action as { value: string }).value, o.shape] as const
  ),
  ["read", PlanReadOperationSchema.shape] as const,
]);
const toolNames = new Set([LIBRARY_TOOL_NAME, PLAN_TOOL_NAME]);

/** The calls shown in SKILL.md, one per line: `<tool> {json}`. */
const calls = [...skill.matchAll(/^([a-z]+) (\{.*\})$/gm)].map((m) => ({
  tool: m[1] as string,
  args: JSON.parse(m[2] as string) as Record<string, unknown> & { action: string },
}));

test("the skill is on the Copilot's list and has the frontmatter Pi needs", () => {
  expect(COPILOT_SKILL_NAMES).toContain("argelander-project-intake");
  expect(skill).toMatch(/^---\nname: argelander-project-intake\ndescription: .{40,}\n---\n/);
});

test("every call SKILL.md shows is accepted by the real schema of that tool and action", () => {
  expect(calls.length).toBeGreaterThanOrEqual(12);
  for (const { tool, args } of calls) {
    expect(toolNames.has(tool), `tool ${tool}`).toBe(true);
    if (tool === LIBRARY_TOOL_NAME) {
      const schema = LIBRARY_SCHEMAS[args.action];
      expect(schema, `library action ${args.action}`).toBeDefined();
      expect(schema?.safeParse(args).success, JSON.stringify(args)).toBe(true);
    } else {
      expect(PlanOperationSchema.safeParse(args).success, JSON.stringify(args)).toBe(true);
    }
  }
  // the migration imports carry batch:true, as the skill says; bib mode takes none
  const imports = calls.filter((c) => c.args.action === "import_works");
  expect(imports.map((c) => [c.args.mode, c.args.batch ?? null])).toEqual([
    ["bibcode", true],
    ["identifier", true],
    ["bib", null],
  ]);
  expect(
    LibraryImportWorksSchema.safeParse({
      action: "import_works",
      mode: "bib",
      text: "@a{b,}",
      batch: true,
    }).success
  ).toBe(false);
});

test("the parameter lists the skill writes in prose are fields of the real schemas", () => {
  const listed = [...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)\{([^}`]*)\}`/g)];
  expect(listed.length).toBeGreaterThanOrEqual(7);
  const seen = new Set<string>();
  for (const [, action, params] of listed) {
    const shape = LIBRARY_SCHEMAS[action as string]?.shape ?? PLAN_SHAPES[action as string];
    expect(shape, `action ${action}`).toBeDefined();
    for (const raw of (params as string).split(",")) {
      const name = raw.trim().replace(/\?$/, "");
      expect(Object.keys(shape ?? {}), `${action}{${name}}`).toContain(name);
    }
    seen.add(action as string);
  }
  for (const action of [
    "read_ads_library",
    "attach_local_pdf",
    "acquire_arxiv_pdf",
    "read_jobs",
    "create_plan",
    "create_task",
    "add_task_link",
  ])
    expect(seen.has(action), action).toBe(true);
});

test("every snake_case name the skill puts in code is a real action, reason or result field", () => {
  const actions = new Set<string>([...LIBRARY_OPERATION_ACTIONS, ...PLAN_OPERATION_ACTIONS]);
  const reasons = new Set<string>([
    ...ManualBibcodeReasonSchema.options,
    ...Object.keys(ADS_FAILURE_TEXT),
    ...LOCAL_PDF_REASONS,
  ]);
  const fields = new Set<string>(Object.keys(LibraryRefSummarySchema.shape));
  const prose = skill.replace(/^(library|plan) \{.*\}$/gm, "");
  const names = new Set(
    [
      ...prose.matchAll(/`"?([a-z]+(?:_[a-z]+)+)\b/g),
      ...prose.matchAll(/\breason:"([a-z]+(?:_[a-z]+)+)"/g),
    ].map((m) => m[1] as string)
  );
  expect(names.size).toBeGreaterThan(20);
  for (const name of names) {
    if (name === "data_dir") continue; // the config.toml key, checked below
    expect(actions.has(name) || reasons.has(name) || fields.has(name), name).toBe(true);
  }
  // names that must be there, by kind
  for (const reason of [
    "merge_refused",
    "batch_refused",
    "no_token",
    "invalid_response",
    "file_tools_off",
    "too_large",
  ])
    expect(names.has(reason), reason).toBe(true);
  expect(DEFAULT_DATA_DIR).toBe("./literatures");
  expect(skill).toMatch(/`data_dir` in config\.toml, default `literatures\/`/);
});

test("the skill teaches no command-line write and no ingest, label or note", () => {
  expect(skill).not.toMatch(/library build/);
  expect(skill).not.toMatch(/argument put/);
  expect(skill).not.toMatch(/\bingest(ed|ion)?\b/i);
  expect(skill).not.toMatch(/\bnote\b/);
  expect(skill).not.toMatch(/\blabel\b/);
  // `acquire` the command: only `acquire_arxiv_pdf` (the tool action) may appear
  expect(skill).not.toMatch(/\bacquire\b(?!_arxiv_pdf)/);
  expect(skill).not.toMatch(/--dry-run/);
  // no file-size figure of its own for reading a .bib: Pi's read window decides
  expect(skill).not.toMatch(/800,000|1 MB/);
});

test("the checklist template keeps the five fixed sections in order, and credentials stay out", () => {
  const sections = ["## 状态", "## 来源", "## 已带入", "## 待定与跳过", "## 留在原处的材料"].map(
    (heading) => skill.indexOf(heading)
  );
  expect(sections.every((at) => at >= 0)).toBe(true);
  expect([...sections].sort((a, b) => a - b)).toEqual(sections);
  expect(skill).toContain("argelanderspace-intake.md");
  expect(skill).toContain("intake-inbox/");
  expect(skill).toMatch(/never enter the conversation, a command line or the checklist/);
  expect(skill).toContain("## Preparation mode");
});

const actionsSource = readFileSync(
  fileURLToPath(new URL("../src/library-actions.ts", import.meta.url)),
  "utf8"
);
const inSource = (word: string) => new RegExp(`\\b${word}\\b`).test(actionsSource);

test("the single-word names in code (camelCase result fields, status values, reasons) are real", () => {
  const prose = skill.replace(/^(library|plan) \{.*\}$/gm, "");
  const words = new Set([...prose.matchAll(/`([A-Za-z]+)(?=[`{])/g)].map((m) => m[1] as string));
  // result fields the tools return: all but the schema's own are looked up in the code that builds them
  const resultFields = [
    "results",
    "entries",
    "ref",
    "key",
    "reason",
    "reasons",
    "works",
    "status",
    "total",
    "nextOffset",
    "docId",
    "error",
  ];
  for (const field of resultFields) expect(inSource(field), `result field ${field}`).toBe(true);
  for (const field of ["ref", "key", "reason", "works", "status", "error"])
    expect(Object.keys(ManualWorkResultSchema.shape), field).toContain(field);
  // status values, with no underscore to give them away
  const statuses = [...ManualWorkResultSchema.shape.status.options, "ok", "noop", "pending"];
  for (const status of statuses.filter((x) => !(x in { created: 1, exists: 1, error: 1 })))
    expect(actionsSource, `status ${status}`).toContain(`"${status}"`);
  const reasonWords = [
    ...ManualBibcodeReasonSchema.options,
    ...Object.keys(ADS_FAILURE_TEXT),
    ...LOCAL_PDF_REASONS,
  ];
  const known = new Set<string>([
    ...resultFields,
    ...statuses,
    ...reasonWords,
    // field names of the schemas the parameter lists use, and the shell and tool words
    "batch",
    "text",
    "rev",
    "file",
    ...["argelanderspace", "cp", "edit", "ls", "library", "plan", "pdftotext", "read"],
    ...["rsync", "scp", "unzip", "write"],
  ]);
  for (const word of words) expect(known.has(word), `unknown name \`${word}\``).toBe(true);
  for (const word of [
    "nextOffset",
    "docId",
    "total",
    "entries",
    "pending",
    "noop",
    "exists",
    "created",
  ])
    expect(words.has(word), word).toBe(true);
});

test("the read window the skill quotes is Pi's own", () => {
  const quoted = skill.match(/at most ([\d,]+) lines or (\d+) KB/);
  expect(quoted).not.toBeNull();
  expect(Number(quoted?.[1]?.replace(/,/g, ""))).toBe(DEFAULT_MAX_LINES);
  expect(Number(quoted?.[2]) * 1024).toBe(DEFAULT_MAX_BYTES);
});

test("the PDF folder step reads every first page with one loop, the command the acceptance runs", () => {
  expect(skill).toContain(
    `for f in '<folder>'/*.[pP][dD][fF]; do printf '=== %s\\n' "$f"; pdftotext -l 1 "$f" - | head -c 2000; done`
  );
  expect(skill).not.toMatch(/pdftotext -l 1 <file>/);
  // The shell tool keeps only the tail of a long output: the skill must say how to read what was cut off.
  expect(skill).toMatch(/output was truncated[^\n]*`read` that file in windows/);
});

// ---- follow-ups of the second recording (project intake ticket 13) ------------------------------------- //

/** The checklist template: the one ```markdown block of the skill. */
const template = /```markdown\n([\s\S]*?)\n```/.exec(skill)?.[1] ?? "";
const preparation = skill.slice(skill.indexOf("## Preparation mode"));
const intakeMode = skill.slice(0, skill.indexOf("## Preparation mode"));

test("the date comes from the system prompt's own line, never from a command", () => {
  // the sentence the skill quotes is the one the Copilot's base prompt really carries
  const quoted = /\("(Today's date on this machine)[^"]*"\)/.exec(skill)?.[1];
  expect(quoted).toBeDefined();
  expect(basePrompt(false, false, false, false, undefined, "2031-03-04")).toContain(
    `${quoted} (local time) is 2031-03-04.`
  );
  expect(skill).toMatch(/Never run a command, the date command included, to learn it/);
  expect(skill).toMatch(/system prompt has no date sentence[^\n]*日期未知/);
  // the old wording left the date open and the model ran a command for it
  expect(skill).not.toMatch(/`date\b/);
});

test("the checklist keeps exactly five sections; the next step is one line under 状态, never a sixth section", () => {
  const headings = template.split("\n").filter((l) => /^## /.test(l));
  expect(headings).toEqual([
    "## 状态",
    "## 来源",
    "## 已带入",
    "## 待定与跳过",
    "## 留在原处的材料",
  ]);
  const status = template.slice(template.indexOf("## 状态"), template.indexOf("## 来源"));
  expect(status).toMatch(/^- 下一步：/m);
  expect(skill).toMatch(/never a sixth/);
  expect(skill).toMatch(/not into a new section/);
  // no confirmation that did not happen
  expect(skill).toMatch(
    /Do not write that[^\n]*confirmed, agreed or checked with the user unless the user said so/
  );
});

test("the PDF line, the stops and the way to continue are written down", () => {
  // attaching never changes a row; the fixed line sits after the table of Zotero, PDF folder and server-copy batches
  expect(skill).toContain("A PDF that was attached successfully changes no row");
  expect(skill).toContain("`挂上 PDF：n（其中同文件已存在 m）`");
  expect(skill).toMatch(/m those that returned `noop`/);
  // stops: after each source's table, before step 5 and before step 6; no draft of the next step in a stop message
  expect(skill).toMatch(/after each source: show the summary table/);
  expect(skill).toMatch(/before step 5 \(arXiv full text\) and before step 6 \(Plans and Tasks\)/);
  expect(skill).toMatch(/the only question is whether to start that step/);
  expect(skill).toMatch(/holds nothing from the next step: no draft/);
  expect(skill).toMatch(/Do not decide on your own that a step can be skipped/);
  // the way to continue: the button of the entry, or telling the Copilot, at every stop and at the end
  for (const part of [intakeMode, preparation]) {
    expect(part).toContain("「继续迁入」");
    expect(part).toMatch(/button/);
  }
  expect(intakeMode).toMatch(/Every time you stop, and when you wrap up/);
});

test("preparation mode has no system-prompt date to count on and still gives the next step", () => {
  expect(preparation).toContain("日期未知，外部 agent");
  expect(preparation).toMatch(/do not run a command for it/);
  expect(preparation).toContain("- 下一步：在工作台让 Copilot 继续迁入");
});

test("the button the skill names is the one the entry shows, in both interface languages", () => {
  const label = (name: string) =>
    (
      JSON.parse(
        readFileSync(new URL(`../../web/src/locales/${name}.json`, import.meta.url), "utf8")
      ) as { library: { intake: { resume: string } } }
    ).library.intake.resume;
  // zh-CN is quoted as it is, English as the interface language's own wording
  expect(skill).toContain(`「${label("zh-CN")}」`);
  expect(skill).toContain(`"${label("en")}"`);
  // every place that names the button also gives the English wording once, in the interface sentence
  expect(skill.split("(in the English interface").length - 1).toBe(2);
});

test("the PDF line covers the sources that attach PDFs, and a file left unattached is its own 待定 item", () => {
  expect(skill).toMatch(
    /every source in which you attach PDFs \(Zotero, a PDF folder, a server copy, a `\.bib` file with a PDF folder the user named\)/
  );
  expect(skill).toMatch(/A PDF that was attached successfully changes no row/);
  expect(skill).toMatch(/is one item under 待定/);
  expect(skill).toMatch(/they are different objects/);
  expect(skill).not.toContain("Attaching a PDF never changes a row");
  // one table per source, rows summed over its batches; the PDF line is defined where it is first used
  expect(skill).toMatch(/summary table for the whole source \(the rows summed over its batches\)/);
  expect(skill.indexOf("described under Summary tables")).toBeLessThan(
    skill.indexOf("add one fixed line")
  );
  expect(skill).toMatch(/"继续迁入", or when/);
});
