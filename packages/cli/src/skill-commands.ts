/**
 * The commands the bundled operation guides (`skills/<name>/SKILL.md` and `skills/README.md`) tell an agent to run, pulled out
 * of the Markdown and checked against the real CLI program (release-0.2 ticket 12).
 *
 * Two readers share this module:
 *  - the drift test (`tests/skill-commands.test.ts`): every `argelanderspace …` command in a guide, with its
 *    sub-commands, options and argument count, must exist in `buildProgram()`, and every operation id a guide names
 *    (`library.read_jobs`) must be in the catalog, on a table row whose command is that operation's own;
 *  - ticket 15's e2e: `extractSkillCommands` gives the argv of each command so it can be run for real after its
 *    placeholders (`<docId>`, `WORK_ID`) are filled in (`isPlaceholder`).
 *
 * A guide writes a command either in a fenced code block (one command per line, `\` continues it, `#` starts a
 * comment, `|`, `&&`, `;` and redirections end it) or in an inline code span. Brackets mark an optional part
 * (`[--replace]`) and are dropped; `<name>` is a value to fill in. Only text that starts at the program name
 * `argelanderspace` is read; `node …/bin.js …` and prose are not.
 */
import {
  OPERATION_CATALOG,
  type OperationDef,
  operationCliGroup,
  operationCliName,
} from "@argelanderspace/contracts";
import type { Command, Option } from "commander";

export interface SkillCommand {
  /** 1-based line of the Markdown where the command starts. */
  line: number;
  /** The command as written (one line, brackets kept). */
  text: string;
  /** Everything after `argelanderspace`, shell-split, brackets and ellipses dropped. */
  argv: string[];
}

/** A value the reader fills in: `<docId>`, `WORK_ID`, `<a|b>` is a choice and counts as one too. */
export function isPlaceholder(token: string): boolean {
  return /^<.*>$/.test(token) || /^[A-Z][A-Z0-9_]*$/.test(token) || token.includes("<");
}

const PROGRAM = "argelanderspace";
const START = new RegExp(`(?:^|[\\s;&|(\`"'])${PROGRAM}(?=\\s|$)`, "g");
const STOPPERS = new Set(["|", "||", "&&", ";", "&", ">", ">>", "<", "2>", "2>&1", ")"]);

/** Shell-like split: whitespace separates, single and double quotes group (and are removed). */
function shellSplit(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "<" && /\S/.test(text[i + 1] ?? " ") && text.indexOf(">", i) > i) {
      // a value to fill in may hold spaces: <absolute path>
      const end = text.indexOf(">", i);
      current += text.slice(i, end + 1);
      has = true;
      i = end;
    } else if (/\s/.test(c)) {
      if (has || current) out.push(current);
      current = "";
      has = false;
    } else {
      current += c;
      has = true;
    }
  }
  if (has || current) out.push(current);
  return out;
}

/** Drop a trailing shell comment (` # …`) that is not inside quotes. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(text[i - 1] as string))) return text.slice(0, i);
  }
  return text;
}

function commandsIn(text: string, line: number): SkillCommand[] {
  const found: SkillCommand[] = [];
  const clean = stripComment(text.replaceAll("\\|", "|"));
  for (const match of clean.matchAll(START)) {
    const from = (match.index ?? 0) + match[0].length;
    const tokens: string[] = [];
    for (const raw of shellSplit(clean.slice(from))) {
      if (STOPPERS.has(raw)) break;
      // optional parts are written [--x <v>]; the brackets are notation, and `…` / `...` only mean "and more"
      const token = raw.replace(/[[\]]/g, "");
      if (token === "" || token === "..." || token === "…") continue;
      tokens.push(token);
    }
    if (tokens.length === 0) continue; // the bare program name is not a command
    found.push({ line, text: `${PROGRAM} ${tokens.join(" ")}`, argv: tokens });
  }
  return found;
}

/** Every `argelanderspace …` command a guide shows, in order (fenced blocks and inline code spans). */
export function extractSkillCommands(markdown: string): SkillCommand[] {
  const out: SkillCommand[] = [];
  const lines = markdown.split("\n");
  let fence: string | null = null;
  let pending: { text: string; line: number } | null = null;
  const flush = () => {
    if (pending) out.push(...commandsIn(pending.text, pending.line));
    pending = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMark) {
      flush();
      fence = fence ? null : (fenceMark[1] as string);
      continue;
    }
    if (fence) {
      const body = line.replace(/^\s*\$ /, "");
      if (pending) pending.text += ` ${body.trim()}`;
      else pending = { text: body, line: i + 1 };
      if (/\\\s*$/.test(pending.text)) pending.text = pending.text.replace(/\\\s*$/, "");
      else flush();
      continue;
    }
    for (const span of line.matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g))
      out.push(...commandsIn(span[2] as string, i + 1));
  }
  flush();
  return out;
}

function optionTakesValue(option: Option): boolean {
  return option.required || option.optional;
}

/** The fixed values of an option: commander's own choices, or the `<a|b|c>` its flag text lists. */
function choicesOf(option: Option): string[] | undefined {
  if (option.argChoices) return option.argChoices;
  const listed = /<([^<>]+)>/.exec(option.flags)?.[1];
  const values = listed?.split("|");
  // `<file|->` is a source, not a choice: every value of a real list is a word or a colour
  return values && values.length > 1 && values.every((v) => /^[#\w.-]{2,}$/.test(v))
    ? values
    : undefined;
}

function longName(option: Option): string | undefined {
  return option.long;
}

function findSub(command: Command, name: string): Command | undefined {
  return command.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

/**
 * The problems of one command against the program (empty = it exists as written): an unknown (sub)command, an unknown
 * option, a value outside an option's fixed choices, too few or too many arguments. A placeholder where a sub-command
 * would be (`argelanderspace <group> --help`) ends the check there.
 */
export function checkSkillCommand(program: Command, argv: string[]): string[] {
  const problems: string[] = [];
  let command = program;
  let index = 0;
  const path: string[] = [];
  while (index < argv.length) {
    const token = argv[index] as string;
    if (token.startsWith("-")) break;
    if (command.commands.length === 0) break;
    if (token === "help") return problems;
    const sub = findSub(command, token);
    if (!sub) {
      if (isPlaceholder(token)) return problems;
      problems.push(`unknown command "${token}" under "${[PROGRAM, ...path].join(" ")}"`);
      return problems;
    }
    command = sub;
    path.push(token);
    index++;
  }
  const where = [PROGRAM, ...path].join(" ");
  const known = new Map<string, Option>();
  for (const option of [...program.options, ...command.options]) {
    const name = longName(option);
    if (name) known.set(name, option);
  }
  let positionals = 0;
  let helpAsked = false;
  for (; index < argv.length; index++) {
    const token = argv[index] as string;
    if (token === "--help" || token === "-h" || token === "--version" || token === "-V") {
      helpAsked = true;
      continue;
    }
    if (token.startsWith("--")) {
      const [name, inline] = token.split("=", 2) as [string, string | undefined];
      const option = known.get(name);
      if (!option) {
        problems.push(`unknown option ${name} for "${where}"`);
        continue;
      }
      if (!optionTakesValue(option)) continue;
      let value = inline;
      const next = argv[index + 1];
      if (value === undefined && next !== undefined && !(option.optional && next.startsWith("-"))) {
        if (!(next.startsWith("--") && option.optional)) {
          value = next;
          index++;
        }
      }
      const choices = choicesOf(option);
      if (
        choices &&
        value !== undefined &&
        !isPlaceholder(value) &&
        !value.includes("|") &&
        !choices.includes(value)
      )
        problems.push(`${name} of "${where}" takes ${choices.join("|")}, not "${value}"`);
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      problems.push(`unknown short option ${token} for "${where}"`);
      continue;
    }
    positionals++;
  }
  if (helpAsked) return problems;
  if (command.commands.length > 0 && path.length > 0 && positionals > 0) {
    problems.push(`"${where}" takes a sub-command, not "${argv[path.length]}"`);
    return problems;
  }
  const declared = command.registeredArguments;
  const required = declared.filter((a) => a.required).length;
  const variadic = declared.some((a) => a.variadic);
  if (command.commands.length === 0 || command.registeredArguments.length > 0) {
    if (positionals < required)
      problems.push(`"${where}" needs ${required} argument(s), ${positionals} given`);
    if (!variadic && positionals > declared.length)
      problems.push(`"${where}" takes ${declared.length} argument(s), ${positionals} given`);
  }
  return problems;
}

/** Operation ids (`library.read_jobs`) a guide names in inline code, with their line. */
export function extractOperationIds(markdown: string): { line: number; id: string }[] {
  const out: { line: number; id: string }[] = [];
  const domains = new Set<string>(OPERATION_CATALOG.map((op) => op.domain));
  const lines = markdown.split("\n");
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    for (const span of line.matchAll(/`([a-z]+\.[a-z_]+)`/g)) {
      const id = span[1] as string;
      if (domains.has(id.split(".")[0] as string)) out.push({ line: i + 1, id });
    }
  }
  return out;
}

/** `["library", "read-jobs"]` for `library.read_jobs`; `["open", "doc"]` for `workspace.open_doc`. */
export function operationCliPath(op: OperationDef): [string, string] {
  return [operationCliGroup(op), op.cli?.name ?? operationCliName(op.name)];
}

/**
 * The drift problems of one guide (empty = none): commands that do not exist, operation ids that are not in the
 * catalog, and a line that names exactly one operation next to the command of a different operation. (Other commands
 * on the line, such as the older `search` or `argument get` beside `library.read` or `argument.read`, are fine.)
 */
export function checkSkillGuide(program: Command, markdown: string): string[] {
  const problems: string[] = [];
  const commands = extractSkillCommands(markdown);
  for (const command of commands)
    for (const problem of checkSkillCommand(program, command.argv))
      problems.push(`line ${command.line}: ${command.text}: ${problem}`);
  const byId = new Map(OPERATION_CATALOG.map((op) => [op.id as string, op]));
  const idsByLine = new Map<number, string[]>();
  for (const { line, id } of extractOperationIds(markdown)) {
    if (!byId.has(id)) problems.push(`line ${line}: operation ${id} is not in the catalog`);
    idsByLine.set(line, [...(idsByLine.get(line) ?? []), id]);
  }
  const ownerOfPath = new Map<string, OperationDef>();
  for (const op of OPERATION_CATALOG) ownerOfPath.set(operationCliPath(op).join(" "), op);
  for (const [line, ids] of idsByLine) {
    const unique = [...new Set(ids)];
    const op = unique.length === 1 ? byId.get(unique[0] as string) : undefined;
    if (!op) continue;
    for (const command of commands.filter((c) => c.line === line)) {
      const other = ownerOfPath.get(`${command.argv[0]} ${command.argv[1]}`);
      if (other && other.id !== op.id)
        problems.push(
          `line ${line}: "${command.text}" is the command of ${other.id}, the line is about ${op.id} ("${PROGRAM} ${operationCliPath(op).join(" ")}")`
        );
    }
  }
  return problems;
}
