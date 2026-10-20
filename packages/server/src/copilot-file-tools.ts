/**
 * Copilot's file and command tools (copilot ticket 57, ADR 0011): Pi's own read / grep / find / ls / bash (powershell
 * on Windows) / edit / write, each wrapped so that
 *
 *  - the permission setting is read fresh at every call (`off` registers nothing for a new run and refuses a call that
 *    was already registered; `ask` asks the real user before a command and before a write; `auto` never asks);
 *  - an edit or a write whose target (symbolic links and `..` resolved, the nearest existing ancestor for a file that
 *    does not exist yet) lies inside one of the five protected folders (the project data folder, the global data
 *    folder, the folder of config.toml, the global cache folder, and Pi's program folder with the downloaded rg / fd)
 *    is refused before anything is asked, and the refusal points at the business tools or the settings page. `bash` is not guarded (ADR 0011);
 *  - every call becomes one operation row with a `fileTool` record, which is what the conversation shows as a tool card.
 *    A command's full output goes to the model only: the record keeps its first and last lines;
 *  - Stop (the tool's abort signal) ends the command and its whole process group (Pi kills `-pid` on POSIX and uses
 *    `taskkill /T` on Windows), and the call reports `interrupted`. Nothing is rerun after a restart: a call with no
 *    result is settled as interrupted by the host.
 *
 * The tool can only ASK: the answer comes from the host's confirmation port, which only a real view's HTTP click
 * resolves. Nothing a model writes (an argument, a message) can approve anything, and the standing "allow for this
 * session" is host state set by that click, which the tool can only read.
 *
 * Commands and file contents are conversation content: they go into the operation record and the model's transcript,
 * never into the user log (the host logs the tool's name, how the call ended, the exit code and the duration).
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, posix, resolve, sep, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type {
  CopilotFileToolsSetting,
  CopilotOperation,
  FileToolAllowClass,
  FileToolChange,
  FileToolDiffLine,
  FileToolName,
  FileToolRecord,
} from "@argelanderspace/contracts";
import { FILE_TOOL_LIMITS } from "@argelanderspace/contracts";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createLocalPowerShellOperations,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ConfirmationPort, ToolHostContext } from "./copilot-tool-kit.js";
import { shownPath } from "./settings.js";

/** The tool names a run is given for one permission setting and platform (`off`: none). */
export function fileToolNames(
  permission: CopilotFileToolsSetting,
  platform: NodeJS.Platform = process.platform
): FileToolName[] {
  if (permission === "off") return [];
  return [
    "read",
    platform === "win32" ? "powershell" : "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
  ];
}

/** Whether a tool name is one of these tools. */
export function isFileToolName(name: string): name is FileToolName {
  return ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write"].includes(name);
}

/** A folder edit and write may not reach into, and which of the five it is (data_dir, global_dir, config_dir, cache_dir, tools_dir). */
export interface ProtectedFolder {
  inside: "data_dir" | "global_dir" | "config_dir" | "cache_dir" | "tools_dir";
  folder: string;
}

/**
 * What the host gives the tools: of the run's shared host context only `admitting` (false once the host stopped
 * admitting work: shutdown, Stop), `track` (counts the running command as in flight until it settles, so a terminal
 * run state waits for it) and `confirm` (present in the real host: confirmations wait there for the user; without it
 * an `ask` call is refused) — never a journal.
 */
export interface FileToolsContext extends Pick<ToolHostContext, "admitting" | "track" | "confirm"> {
  /** The Project folder: where commands run and relative paths start. */
  cwd: string;
  /** Read at every call. */
  permission: () => CopilotFileToolsSetting;
  /**
   * The folders an edit or write may not reach into, as they are now: the project data folder, the global data
   * folder, the folder of config.toml and the global cache folder (so a write permission cannot rewrite the settings);
   * Pi's program folder is added by the tool itself (`piBinDir`), making five.
   */
  protectedFolders: () => ProtectedFolder[];
  /** The standing "allow for this session" of this conversation: read-only here; only a real click sets it. */
  allowed: (kind: FileToolAllowClass) => boolean;
  /** A call began to run / ended: the host shows a running call with its start time. */
  lifecycle?: {
    started(toolCallId: string, startedAt: string): void;
    ended(toolCallId: string): void;
  };
  platform?: NodeJS.Platform;
}

// biome-ignore lint/suspicious/noExplicitAny: Pi's content parts (text and images) are handed back as they came
type Result = { content: any[]; details: CopilotOperation; isError?: boolean };

const LIMIT = FILE_TOOL_LIMITS;
const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
// Everything except tab, newline and carriage return among the control characters (Pi's own sanitising of output).
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const plain = (text: string): string => text.replace(CONTROL, "");

/**
 * The head and tail of an output, kept while it streams in, so a long output never has to be held whole. Memory and
 * time are bounded however long a single line is: the unfinished line keeps only its first `LIMIT.line` characters and
 * a count of the rest; bytes are counted as they arrive; bytes of a multi-byte character split between two chunks are
 * joined again (`StringDecoder`).
 */
export class LineSampler {
  private carry = "";
  private carryLength = 0;
  private count = 0;
  private bytes = 0;
  private pendingCR = false;
  private readonly head: string[] = [];
  private readonly tail: string[] = [];
  private readonly decoder = new StringDecoder("utf8");
  /** Bytes of output seen. */
  get totalBytes(): number {
    return this.bytes;
  }
  feed(chunk: string | Buffer): void {
    let text: string;
    if (typeof chunk === "string") {
      this.bytes += Buffer.byteLength(chunk);
      text = chunk;
    } else {
      this.bytes += chunk.length;
      text = this.decoder.write(chunk);
    }
    text = plain(text);
    if (this.pendingCR) {
      // A line break written as CR LF across two chunks is one break.
      this.pendingCR = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    const endsWithCR = text.endsWith("\r");
    text = text.replace(/\r\n?/g, "\n");
    this.pendingCR = endsWithCR;
    let start = 0;
    for (;;) {
      const at = text.indexOf("\n", start);
      if (at < 0) break;
      this.extend(text.slice(start, at));
      this.finishLine();
      start = at + 1;
    }
    this.extend(text.slice(start));
  }
  private extend(piece: string): void {
    if (piece === "") return;
    this.carryLength += piece.length;
    if (this.carry.length < LIMIT.line)
      this.carry += piece.slice(0, LIMIT.line - this.carry.length);
  }
  private finishLine(): void {
    const line =
      this.carryLength > LIMIT.line ? `${this.carry.slice(0, LIMIT.line - 1)}…` : this.carry;
    this.carry = "";
    this.carryLength = 0;
    this.count++;
    if (this.head.length < LIMIT.head) this.head.push(line);
    else {
      this.tail.push(line);
      if (this.tail.length > LIMIT.tail) this.tail.shift();
    }
  }
  result(): NonNullable<FileToolRecord["output"]> | undefined {
    const rest = this.decoder.end();
    if (rest) this.extend(plain(rest));
    if (this.carryLength > 0) this.finishLine();
    if (this.count === 0) return undefined;
    const kept = this.head.length + this.tail.length;
    return { head: [...this.head], tail: [...this.tail], omitted: this.count - kept };
  }
}

/** Where an edit or a write lands: the path as Pi would resolve it, and the real place it reaches. */
export interface ResolvedTarget {
  /** The absolute path with `~` and `..` resolved lexically, normalised exactly as Pi does. */
  absolute: string;
  /** The same with every symbolic link followed, dangling ones too; null when that cannot be told (a loop, no access). */
  real: string | null;
  /** The path had a `..` segment. */
  parentRef: boolean;
}

/** Whether `child` is `root` or lies below it, by the path rules of the platform (names compare after NFC on macOS). */
export function isInside(
  child: string,
  root: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const P = platform === "win32" ? win32 : posix;
  const fold = (value: string) => {
    const normalized = P.normalize(value);
    return platform === "darwin"
      ? normalized.normalize("NFC").toLowerCase()
      : platform === "win32"
        ? normalized.toLowerCase()
        : normalized;
  };
  const rel = P.relative(fold(root), fold(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${P.sep}`) && !P.isAbsolute(rel));
}

// The rules of Pi's `resolveToCwd` (`utils/paths.js` of pi-coding-agent 1.0.0, not exported): for the path the model
// gave, Unicode spaces become a plain space and a leading `@` is dropped; for it and for the working directory alike
// Windows shell drive paths are converted, `~` is expanded and a `file://` URL is converted; the result is resolved
// against the working directory, which gets no space replacement. Kept equal by `tests/copilot-file-tools.test.ts`,
// which writes through Pi itself, compares where the file lands, and pins the Pi version.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
function windowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\"))
    return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  return `${(match[1] as string).toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}`;
}
function piNormalize(input: string, modelPath: boolean, platform: NodeJS.Platform): string {
  let out = modelPath ? input.replace(UNICODE_SPACES, " ") : input;
  if (modelPath && out.startsWith("@")) out = out.slice(1);
  if (platform === "win32") out = windowsShellPath(out);
  if (out === "~") return homedir();
  if (out.startsWith("~/") || (platform === "win32" && out.startsWith("~\\")))
    return join(homedir(), out.slice(2));
  if (/^file:\/\//.test(out)) return fileURLToPath(out);
  return out;
}
/** The absolute path Pi's edit and write act on for this text and working directory. */
export function piResolve(
  raw: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalized = piNormalize(raw, true, platform);
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(piNormalize(cwd, false, platform), normalized);
}

/**
 * Windows names that reach a place by another road than the plain path the guard compares: device and extended
 * prefixes (`\\?\`, `\\.\`), and UNC paths to this computer or to an administrative share. Refused outright.
 * (Written for the Windows rules with `path.win32`; this machine has no Windows to run it on.)
 */
export function windowsPathRefusal(raw: string, host: string = hostname()): boolean {
  const text = raw.replace(/\//g, "\\");
  if (/^\\\\[?.]\\/.test(text)) return true;
  const unc = /^\\\\([^\\]+)\\([^\\]*)/.exec(text);
  if (!unc) return false;
  const name = (unc[1] as string).toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1", "[::1]", host.toLowerCase()];
  return local.includes(name) || (unc[2] as string).endsWith("$");
}

/** The folder Pi keeps its downloaded helper programs in; grep and find may run what is there. */
export function piBinDir(): string {
  // Pi's getAgentDir: a set (non-empty) PI_CODING_AGENT_DIR has its `~` expanded like any Pi path.
  const env = process.env.PI_CODING_AGENT_DIR;
  const dir = env ? piNormalize(env, false, process.platform) : join(homedir(), ".pi", "agent");
  return join(dir, "bin");
}

const MAX_LINKS = 40;
/**
 * The place a write to `absolute` would really reach, walked the way the kernel does: every component is looked at,
 * a symbolic link is read and its target put in front of what is left (so a `..` in a target goes up from the
 * already-resolved folder, not from the text), a dangling link is followed to where a write would create its target,
 * and the part that does not exist yet follows as written. null: a loop or more than `MAX_LINKS` links, or a
 * component that cannot be looked at.
 */
export async function resolveReal(absolute: string): Promise<string | null> {
  const { root } = parse(absolute);
  const split = (path: string) =>
    path
      .slice(parse(path).root.length)
      .split(sep)
      .filter((part) => part !== "" && part !== ".")
      .reverse();
  const pending = split(absolute);
  let current = root;
  let missing = false;
  let links = 0;
  while (pending.length) {
    const part = pending.pop() as string;
    if (part === "..") {
      current = parse(current).dir || current;
      continue;
    }
    const next = join(current, part);
    if (missing) {
      current = next;
      continue;
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Nothing there (or a file where a folder is needed): what follows is only text.
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      missing = true;
      current = next;
      continue;
    }
    if (!info.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++links > MAX_LINKS) return null;
    let target: string;
    try {
      target = await readlink(next);
    } catch {
      return null;
    }
    if (isAbsolute(target)) current = parse(target).root;
    pending.push(...split(target));
  }
  return process.platform === "win32" ? await nativeNearest(current) : current;
}

/** On Windows the names of the existing part are put in their long, canonical form (8.3 short names, junctions). */
async function nativeNearest(path: string): Promise<string> {
  const rest: string[] = [];
  let existing = path;
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...rest);
    } catch {
      const up = parse(existing);
      if (existing === up.root) return path;
      rest.unshift(up.base);
      existing = up.dir;
    }
  }
}

export async function resolveTarget(
  raw: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): Promise<ResolvedTarget> {
  const absolute = piResolve(raw, cwd, platform);
  return {
    absolute,
    real: await resolveReal(absolute),
    parentRef: raw.split(/[\\/]+/).includes(".."),
  };
}

type Guard = NonNullable<FileToolRecord["guard"]>;
/** Whether a write to this target must be refused, and why; `"unresolved"` when where it lands cannot be told. */
export async function guardTarget(
  target: ResolvedTarget,
  folders: ProtectedFolder[],
  platform: NodeJS.Platform = process.platform
): Promise<Guard | "unresolved" | null> {
  // Where a write lands cannot be told: refused (it may be a loop of links that ends in a protected folder).
  if (target.real === null) return "unresolved";
  for (const root of folders) {
    const folder = resolve(root.folder);
    const realRoot = (await resolveReal(folder)) ?? folder;
    const hitReal =
      isInside(target.real, realRoot, platform) || isInside(target.real, folder, platform);
    // The folder itself may be reached through a link that is not in the path (a symlinked project): the lexical
    // path inside the folder as named also counts.
    if (!hitReal && !isInside(target.absolute, folder, platform)) continue;
    const lexicalHit =
      isInside(target.absolute, folder, platform) || isInside(target.absolute, realRoot, platform);
    const via: Guard["via"] = !lexicalHit ? "symlink" : target.parentRef ? "parent_ref" : "direct";
    return {
      inside: root.inside,
      via,
      folder: shownPath(folder).display,
      resolved: shownPath(target.real).display,
    };
  }
  return null;
}

const MAX_DIFF_FILE = 4_000_000;
const lineCount = (text: string): number =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** What a card can show of a change: the change, or why it is refused (nothing is ever shown cut). */
export type ChangeAccount = { change: FileToolChange } | { refusal: string };

/**
 * The card's account of an edit: the replacements with every changed line whole (a .bib line may be long) and, when the
 * file could be read, two lines of context around each. A change with more changed text than the card can show is
 * refused, not cut. `content` null: the file is too big to read for the card, the numbers still come from the edits.
 */
export function editChange(
  content: string | null,
  edits: { oldText: string; newText: string }[],
  path: string
): ChangeAccount {
  let chars = 0;
  let changedLines = 0;
  for (const edit of edits) {
    chars += edit.oldText.length + edit.newText.length;
    changedLines += edit.oldText.split("\n").length + edit.newText.split("\n").length;
  }
  if (chars > LIMIT.changeTotal || changedLines > LIMIT.changeLines)
    return {
      refusal: `this edit changes ${chars} characters on ${changedLines} lines, more than the ${LIMIT.changeTotal} characters / ${LIMIT.changeLines} lines the confirmation card can show whole, so nothing was changed. Split it into smaller edits`,
    };
  const lines = content === null ? [] : content.split("\n");
  const diff: FileToolDiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    const at = content === null ? -1 : content.indexOf(edit.oldText);
    const oldLines = edit.oldText.split("\n");
    const newLines = edit.newText.split("\n");
    const first = at < 0 || content === null ? 0 : content.slice(0, at).split("\n").length; // 1-based line of the first old line
    const last = first + oldLines.length - 1;
    diff.push({
      k: "hunk",
      s: at < 0 ? `@@ ${clip(path, 160)} @@` : `@@ ${clip(path, 160)} · ${first}–${last} @@`,
    });
    if (at >= 0)
      for (const line of lines.slice(Math.max(0, first - 3), first - 1))
        diff.push({ k: "ctx", s: clip(line, LIMIT.line) });
    for (const line of oldLines) diff.push({ k: "del", s: line });
    for (const line of newLines) diff.push({ k: "add", s: line });
    if (at >= 0)
      for (const line of lines.slice(last, last + 2))
        diff.push({ k: "ctx", s: clip(line, LIMIT.line) });
    removed += oldLines.length;
    added += newLines.length;
  }
  if (diff.length > LIMIT.diff)
    return {
      refusal: `this edit has ${edits.length} replacements, more than the card can show whole, so nothing was changed. Split it into smaller edits`,
    };
  return {
    change: {
      edits: edits.length,
      added,
      removed,
      ...(content === null
        ? { contextOmitted: true }
        : { unchanged: Math.max(0, lineCount(content) - removed) }),
      diff,
    },
  };
}

/** The card's account of a write: size and lines, the first lines whole, and whether it replaces a file. */
export function writeChange(content: string, existing: { bytes: number } | null): ChangeAccount {
  const lines = content === "" ? [] : content.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const shown = lines.slice(0, LIMIT.preview);
  const chars = shown.reduce((sum, line) => sum + line.length, 0);
  if (chars > LIMIT.changeTotal)
    return {
      refusal: `the first lines of this file are ${chars} characters long, more than the ${LIMIT.changeTotal} the confirmation card can show whole, so nothing was written. Break up the long lines`,
    };
  return {
    change: {
      bytes: Buffer.byteLength(content),
      lines: lines.length,
      overwrite: existing !== null,
      ...(existing ? { oldBytes: existing.bytes } : {}),
      preview: shown,
      ...(lines.length > shown.length ? { previewMore: lines.length - shown.length } : {}),
    },
  };
}

const firstLine = (command: string): string => {
  const lines = command.split("\n").filter((line) => line.trim() !== "");
  const head = (lines[0] ?? command).trim();
  return clip(lines.length > 1 ? `${head} ⏎ …` : head, 200);
};

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: string }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : ""
    )
    .join("\n");
}

const NOTICE = /^\s*\[.*\]\s*$/;
/** The result words of a read-like call, from what it returned. */
function summaryOf(
  kind: FileToolRecord["kind"],
  text: string
): FileToolRecord["result"] | undefined {
  const lines = text.split("\n").filter((line) => line.trim() !== "" && !NOTICE.test(line));
  if (kind === "read") return { unit: "lines", n: lineCount(text) };
  if (kind === "grep") return { unit: "matches", n: lines.length };
  if (kind === "find") return { unit: "files", n: lines.length };
  if (kind === "ls") return { unit: "entries", n: lines.length };
  return undefined;
}

type Args = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The record a call has before it ran: what its card shows from the arguments alone. Also used for a call with no result. */
export function fileToolRowFor(
  name: string,
  args: unknown,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): FileToolRecord | null {
  if (!isFileToolName(name)) return null;
  const a = (args && typeof args === "object" ? args : {}) as Args;
  const cwdShown = shownPath(cwd).display;
  switch (name) {
    case "bash":
    case "powershell": {
      const command = clip(str(a.command), LIMIT.command);
      return { kind: "command", shell: name, target: firstLine(command), command, cwd: cwdShown };
    }
    case "read":
      return {
        kind: "read",
        target: clip(str(a.path), LIMIT.line),
        path: clip(str(a.path), LIMIT.line),
        cwd: cwdShown,
      };
    case "grep":
      return {
        kind: "grep",
        target: clip(`${str(a.pattern)}  ${str(a.path) || "."}`, LIMIT.line),
        path: clip(str(a.path) || ".", LIMIT.line),
        cwd: cwdShown,
      };
    case "find":
      return {
        kind: "find",
        target: clip(`${str(a.pattern)}  ${str(a.path) || "."}`, LIMIT.line),
        path: clip(str(a.path) || ".", LIMIT.line),
        cwd: cwdShown,
      };
    case "ls":
      return {
        kind: "ls",
        target: clip(str(a.path) || ".", LIMIT.line),
        path: clip(str(a.path) || ".", LIMIT.line),
        cwd: cwdShown,
      };
    case "edit":
    case "write":
      return {
        kind: name,
        target: clip(str(a.path), LIMIT.line),
        path: clip(str(a.path), LIMIT.line),
        cwd: cwdShown,
      };
  }
  void platform;
}

/**
 * A call that has no result and will never get one (the process ended while it waited or ran, or the user declined and
 * the process ended before the answer was recorded): what the host settles it as. Nothing is rerun.
 */
export function settledFileToolCall(
  id: string,
  name: string,
  args: unknown,
  cwd: string,
  how: "interrupted" | "not_started" | "declined"
): { operation: CopilotOperation; payload: Record<string, unknown> } | null {
  const row = fileToolRowFor(name, args, cwd);
  if (!row) return null;
  const nothing = row.kind === "command" ? "run" : "changed";
  const operation = (status: CopilotOperation["status"], beforeRun: boolean): CopilotOperation => ({
    id,
    tool: name,
    action: row.kind,
    status,
    fileTool: { ...row, beforeRun },
  });
  if (how === "declined")
    return {
      operation: operation("declined", true),
      payload: {
        ok: false,
        status: "declined",
        detail: `the user declined; nothing was ${nothing}`,
      },
    };
  if (how === "not_started")
    return {
      operation: operation("interrupted", true),
      payload: {
        ok: false,
        status: "interrupted",
        detail: `the run ended before the user decided; nothing was ${nothing} and the request is no longer valid. Ask again only if the user still wants it`,
      },
    };
  return {
    operation: operation("interrupted", false),
    payload: {
      ok: false,
      status: "interrupted",
      detail:
        row.kind === "command"
          ? "the server stopped while this command was running; it may have run partly or not at all, and it is NOT rerun automatically. Check what it did before running anything again"
          : row.kind === "edit" || row.kind === "write"
            ? "the server stopped while this call was running; the file may or may not have been written. Read it to find out before writing again"
            : "the server stopped while this call was running; run it again if you still need it",
    },
  };
}

const modelText = (payload: Record<string, unknown>) => [
  { type: "text" as const, text: JSON.stringify(payload) },
];

/** Build the tools for one run. `names` is exactly what the session must report as active. */
export function createFileTools(context: FileToolsContext): {
  names: FileToolName[];
  tools: ToolDefinition[];
} {
  const platform = context.platform ?? process.platform;
  const names = fileToolNames(context.permission(), platform);
  const cwdShown = shownPath(context.cwd).display;
  const shellName: "bash" | "powershell" = platform === "win32" ? "powershell" : "bash";

  const row = (
    toolName: string,
    id: string,
    status: CopilotOperation["status"],
    fileTool: FileToolRecord
  ): CopilotOperation => ({
    id,
    tool: toolName,
    action: fileTool.kind,
    status,
    fileTool,
  });
  const refuse = (
    toolName: string,
    id: string,
    status: "rejected" | "declined" | "interrupted" | "error" | "unsupported" | "expired",
    base: FileToolRecord,
    detail: string,
    extra: Partial<FileToolRecord> = {}
  ): Result => ({
    content: modelText({ ok: false, status, detail }),
    details: row(toolName, id, status, { ...base, ...extra }),
  });

  /** The gate every call passes. null: run it; otherwise the finished result. */
  const gate = async (
    toolName: FileToolName,
    id: string,
    base: FileToolRecord,
    cls: FileToolAllowClass | null,
    request: () => Parameters<ConfirmationPort["request"]>[0]
  ): Promise<{ approval: FileToolRecord["approval"] } | Result> => {
    const mode = context.permission();
    if (mode === "off")
      return refuse(
        toolName,
        id,
        "rejected",
        base,
        "file and command tools are turned off in the settings; nothing ran"
      );
    if (!context.admitting())
      return refuse(
        toolName,
        id,
        "interrupted",
        base,
        "the run was stopped before this call began; nothing ran",
        { beforeRun: true }
      );
    if (cls === null) return { approval: mode === "auto" ? "auto" : undefined };
    if (mode === "auto") return { approval: "auto" };
    if (context.allowed(cls)) return { approval: "session" };
    if (!context.confirm)
      return refuse(
        toolName,
        id,
        "unsupported",
        base,
        "this call needs the user's confirmation and none is available here; nothing ran"
      );
    const nothing = cls === "command" ? "run" : "changed";
    let decision: Awaited<ReturnType<ConfirmationPort["request"]>>;
    try {
      decision = await context.confirm.request(request());
    } catch {
      return refuse(
        toolName,
        id,
        "error",
        base,
        `the confirmation could not be saved; nothing was ${nothing}`
      );
    }
    if (decision.outcome === "approved") {
      // The user may have switched the setting off, or Stop may have come, while the card was open.
      if (context.permission() === "off")
        return refuse(
          toolName,
          id,
          "rejected",
          base,
          "file and command tools were turned off before the call began; nothing ran"
        );
      if (!context.admitting())
        return refuse(
          toolName,
          id,
          "interrupted",
          base,
          "the run was stopped before this call began; nothing ran",
          { beforeRun: true }
        );
      return { approval: decision.remember ? "session" : "once" };
    }
    if (decision.outcome === "declined")
      return refuse(
        toolName,
        id,
        "declined",
        base,
        `the user declined; nothing was ${nothing}. Do not ask again unless the user wants it`
      );
    if (decision.reason === "error")
      return refuse(
        toolName,
        id,
        "error",
        base,
        `the check made when the user confirmed found a system error (${decision.detail}); nothing was ${nothing}`
      );
    // Stop, a restart or a closing server ended the wait: nothing ran.
    return refuse(
      toolName,
      id,
      "interrupted",
      base,
      `the request ended before the user decided; nothing was ${nothing}`,
      {
        beforeRun: true,
      }
    );
  };

  /** Whether an edit or a write may touch this target; otherwise the refusal's wording and guard record. */
  const checkTarget = async (
    raw: string,
    target: ResolvedTarget
  ): Promise<{ detail: string; extra: Partial<FileToolRecord> } | null> => {
    if (platform === "win32" && (windowsPathRefusal(raw) || windowsPathRefusal(target.absolute)))
      return {
        detail: `${raw} names its place by a device prefix or an administrative or local network share, which edit and write do not accept. Use a plain path`,
        extra: {},
      };
    const folders = [
      ...context.protectedFolders(),
      { inside: "tools_dir" as const, folder: piBinDir() },
    ];
    const hit = await guardTarget(target, folders, platform);
    if (hit === null) return null;
    if (hit === "unresolved")
      return {
        detail: `${raw} could not be resolved (a loop of symbolic links, or a folder on the way that cannot be looked at), so it is refused and nothing was changed. Use another path`,
        extra: {},
      };
    const where = {
      data_dir: "the project's data folder",
      global_dir: "the global data folder",
      config_dir: "the folder of the application's config.toml",
      cache_dir: "the global cache folder",
      tools_dir: "the folder of the helper programs grep and find run",
    }[hit.inside];
    const why =
      hit.inside === "data_dir" || hit.inside === "global_dir"
        ? "Library, annotations, argument graphs, plans, manuscripts and mail are only changed through the business tools (library, reader, argument, plan, writer, mail); use those"
        : hit.inside === "tools_dir"
          ? "Programs that grep and find run must not be written by the model"
          : "The application's settings and caches are changed by the application and on its settings page, not through edit or write";
    return {
      detail: `${raw} reaches into ${where} (${hit.folder}), which edit and write do not change. ${why}`,
      extra: { guard: hit },
    };
  };

  const wrap = (definition: ToolDefinition, kind: FileToolRecord["kind"]): ToolDefinition => ({
    ...definition,
    executionMode: "sequential",
    execute: async (
      toolCallId: string,
      // biome-ignore lint/suspicious/noExplicitAny: each tool has its own schema
      params: any,
      signal: AbortSignal | undefined,
      // biome-ignore lint/suspicious/noExplicitAny: Pi's update callback and context are passed through
      onUpdate: any,
      // biome-ignore lint/suspicious/noExplicitAny: see above
      ctx: any
    ) => {
      const toolName = definition.name as FileToolName;
      const base = fileToolRowFor(toolName, params, context.cwd, platform);
      if (!base) throw new Error("unknown file tool");
      const approvalOf = async (): Promise<
        { approval: FileToolRecord["approval"]; params: Args; change?: FileToolChange } | Result
      > => {
        if (kind === "command") {
          // The card shows the whole command or none: a longer one is refused, never cut and then asked.
          if (str(params.command).length > LIMIT.command)
            return refuse(
              toolName,
              toolCallId,
              "rejected",
              base,
              `the command is ${str(params.command).length} characters long, over the ${LIMIT.command} the confirmation card can show whole, so nothing ran. Split it into shorter commands, or write the script to a file with the write tool and run that`
            );
          const g = await gate(toolName, toolCallId, base, "command", () => ({
            toolCallId,
            action: "run_command",
            shell: shellName,
            command: str(params.command),
            cwd: cwdShown,
            baseRev: 0,
          }));
          return "approval" in g ? { approval: g.approval, params } : g;
        }
        if (kind === "edit" || kind === "write") {
          const raw = str(params.path);
          if (raw.length > LIMIT.path)
            return refuse(
              toolName,
              toolCallId,
              "rejected",
              base,
              `the path is ${raw.length} characters long, over the ${LIMIT.path} the confirmation card can show whole, so nothing was changed. Use a shorter path`
            );
          const target = await resolveTarget(raw, context.cwd, platform);
          const blocked = await checkTarget(raw, target);
          if (blocked)
            return refuse(toolName, toolCallId, "rejected", base, blocked.detail, blocked.extra);
          const real = target.real as string;
          let existing: { bytes: number } | null = null;
          try {
            const info = await lstat(real);
            existing = info.isFile() ? { bytes: info.size } : null;
          } catch {
            existing = null;
          }
          let account: ChangeAccount;
          if (kind === "write") account = writeChange(str(params.content), existing);
          else {
            const edits = Array.isArray(params.edits)
              ? (params.edits as { oldText?: unknown; newText?: unknown }[])
              : [];
            const clean = edits.map((e) => ({ oldText: str(e.oldText), newText: str(e.newText) }));
            // An edit of a file that is not there cannot write anything: Pi reports it, nobody is asked.
            if (!existing) {
              const mode = context.permission();
              if (mode === "off")
                return refuse(
                  toolName,
                  toolCallId,
                  "rejected",
                  base,
                  "file and command tools are turned off in the settings; nothing ran"
                );
              return { approval: mode === "auto" ? "auto" : undefined, params };
            }
            let content: string | null = null;
            if (existing.bytes <= MAX_DIFF_FILE) {
              try {
                content = await readFile(real, "utf8");
              } catch {
                content = null;
              }
            }
            account = editChange(content, clean, raw);
          }
          if ("refusal" in account)
            return refuse(toolName, toolCallId, "rejected", base, account.refusal);
          const change = account.change;
          const g = await gate(toolName, toolCallId, { ...base, change }, "write", () => ({
            toolCallId,
            action: kind === "write" ? "write_file" : "edit_file",
            path: raw,
            resolved: shownPath(real).display,
            cwd: cwdShown,
            change,
            baseRev: 0,
          }));
          if (!("approval" in g)) return g;
          // Pi gets the model's own text, and `piResolve` is Pi's own rule for it, so what was judged is what Pi acts on.
          // Checked again now: the answer may have taken a while, and a link may have been moved meanwhile.
          const again = await resolveTarget(raw, context.cwd, platform);
          const blockedNow = await checkTarget(raw, again);
          if (blockedNow || again.absolute !== target.absolute || again.real !== target.real)
            return refuse(
              toolName,
              toolCallId,
              "rejected",
              base,
              blockedNow?.detail ?? `${raw} resolves somewhere else now; nothing was changed`,
              blockedNow?.extra ?? {}
            );
          return { approval: g.approval, params, change };
        }
        if (kind === "grep" || kind === "find") {
          // grep and find START A PROGRAM (ripgrep, fd) that may be a file a write replaced: they are command-class, shown
          // with the program's path and arguments and bound by the session's command allowance (read and ls start none).
          const program = findProgram(kind === "grep" ? "rg" : "fd");
          if (program === null) {
            // Nothing to run: the call answers with its plain error, and nobody is asked.
            const g = await gate(toolName, toolCallId, base, null, () => {
              throw new Error("no confirmation");
            });
            return "approval" in g ? { approval: g.approval, params } : g;
          }
          const command = searchCommand(kind, program, params, context.cwd, platform);
          if (command.length > LIMIT.command)
            return refuse(
              toolName,
              toolCallId,
              "rejected",
              base,
              `the search would run a ${command.length}-character command line, over the ${LIMIT.command} the confirmation card can show whole, so nothing ran. Use a shorter pattern`
            );
          const g = await gate(toolName, toolCallId, base, "command", () => ({
            toolCallId,
            action: "run_command",
            shell: shellName,
            command,
            cwd: cwdShown,
            baseRev: 0,
          }));
          return "approval" in g ? { approval: g.approval, params } : g;
        }
        const g = await gate(toolName, toolCallId, base, null, () => {
          throw new Error("no confirmation for a read");
        });
        return "approval" in g ? { approval: g.approval, params } : g;
      };

      // Pi resolves paths and runs commands in the context's working directory when it has one (the session's own,
      // the Copilot runtime folder): every call is given the Project folder instead.
      const toolCtx = Object.create(ctx ?? null, { cwd: { value: context.cwd, enumerable: true } });
      const decided = await approvalOf();
      if (!("params" in decided)) return decided;
      const { approval, params: toRun, change } = decided;
      if (context.permission() === "off")
        return refuse(
          toolName,
          toolCallId,
          "rejected",
          base,
          "file and command tools are turned off in the settings; nothing ran"
        );

      const sampler = new LineSampler();
      let exit: number | undefined;
      const startedMs = Date.now();
      context.lifecycle?.started(toolCallId, new Date(startedMs).toISOString());
      const work = (async (): Promise<Result> => {
        // A definition per call: its operations remember this call's exit code and output.
        let definition2: ToolDefinition;
        if (kind === "command") {
          const inner =
            platform === "win32" ? createLocalPowerShellOperations() : createLocalBashOperations();
          const operations = {
            exec: async (
              command: string,
              cwd: string,
              options: {
                onData: (data: Buffer) => void;
                signal?: AbortSignal;
                timeout?: number;
                env?: NodeJS.ProcessEnv;
              }
            ) => {
              const outcome = await inner.exec(command, cwd, {
                ...options,
                onData: (data: Buffer) => {
                  sampler.feed(data);
                  options.onData(data);
                },
              });
              exit = outcome.exitCode ?? undefined;
              return outcome;
            },
          };
          definition2 =
            platform === "win32"
              ? (createPowerShellToolDefinition(context.cwd, {
                  operations,
                }) as unknown as ToolDefinition)
              : (createBashToolDefinition(context.cwd, {
                  operations,
                }) as unknown as ToolDefinition);
        } else definition2 = definition;
        const interrupted = () => signal?.aborted === true || !context.admitting();
        try {
          const result = (await definition2.execute(
            toolCallId,
            toRun,
            signal,
            onUpdate,
            toolCtx
          )) as { content: unknown[] };
          const durationMs = Math.max(0, Date.now() - startedMs);
          const text = textOf(result.content);
          if (kind !== "command") for (const piece of [text]) sampler.feed(`${piece}\n`);
          const output = sampler.result();
          const record: FileToolRecord = {
            ...base,
            ...(kind === "command" && exit !== undefined ? { exitCode: exit } : {}),
            durationMs,
            ...(approval ? { approval } : {}),
            // An edit or a write is shown by its change, not by Pi's one-line confirmation.
            ...(output && kind !== "edit" && kind !== "write" ? { output } : {}),
            ...(kind === "edit" || kind === "write"
              ? {
                  result:
                    kind === "edit"
                      ? {
                          unit: "diff" as const,
                          added: change?.added ?? 0,
                          removed: change?.removed ?? 0,
                        }
                      : { unit: "created" as const },
                }
              : { result: summaryOf(kind, text) }),
          };
          // Pi answers a command that exits non-zero with its output and the exit code. It is an error row here, but not
          // a thrown one (the user log tells the two apart).
          const failed = kind === "command" && exit !== undefined && exit !== 0;
          return {
            content: result.content,
            details: row(toolName, toolCallId, failed ? "error" : "ok", {
              ...record,
              ...(change ? { change } : {}),
            }),
          };
        } catch (error) {
          const durationMs = Math.max(0, Date.now() - startedMs);
          const output = sampler.result();
          if (interrupted()) {
            return refuse(
              toolName,
              toolCallId,
              "interrupted",
              base,
              kind === "command"
                ? "stopped (by the user, or because the service was closing): the command and the processes it started were terminated, so what it did is unknown. It will not be run again automatically"
                : "stopped (by the user, or because the service was closing) before the call finished; the result is unknown",
              { durationMs, ...(approval ? { approval } : {}), ...(output ? { output } : {}) }
            );
          }
          const message = clip(plain(error instanceof Error ? error.message : String(error)), 4000);
          const record: FileToolRecord = {
            ...base,
            ...(exit !== undefined ? { exitCode: exit } : {}),
            durationMs,
            ...(approval ? { approval } : {}),
            ...(output ? { output } : {}),
            ...(kind === "command" && exit !== undefined && exit !== 0
              ? {}
              : { error: clip(message, 500) }),
          };
          return {
            // The model reads what Pi said (for a command: its output and the exit code), as Pi would have given it.
            content: [{ type: "text" as const, text: message }],
            details: row(toolName, toolCallId, "error", record),
          };
        }
      })().finally(() => context.lifecycle?.ended(toolCallId));
      return context.track ? context.track(work) : work;
    },
  });

  const cwd = context.cwd;
  const make = (name: FileToolName): ToolDefinition => {
    switch (name) {
      case "read":
        return wrap(createReadToolDefinition(cwd) as unknown as ToolDefinition, "read");
      case "grep":
        return wrap(
          guardSearch(createGrepToolDefinition(cwd) as unknown as ToolDefinition, "rg"),
          "grep"
        );
      case "find":
        return wrap(
          guardSearch(createFindToolDefinition(cwd) as unknown as ToolDefinition, "fd"),
          "find"
        );
      case "ls":
        return wrap(createLsToolDefinition(cwd) as unknown as ToolDefinition, "ls");
      case "bash":
        return wrap(createBashToolDefinition(cwd) as unknown as ToolDefinition, "command");
      case "powershell":
        return wrap(createPowerShellToolDefinition(cwd) as unknown as ToolDefinition, "command");
      case "edit":
        return wrap(createEditToolDefinition(cwd) as unknown as ToolDefinition, "edit");
      case "write":
        return wrap(createWriteToolDefinition(cwd) as unknown as ToolDefinition, "write");
    }
  };
  return { names, tools: names.map(make) };
}

/** Where the program Pi would run for grep (`rg`) or find (`fd`) is, or null: Pi's own bin folder first, then the PATH. */
export function findProgram(program: "rg" | "fd"): string | null {
  const names = program === "fd" ? ["fd", "fdfind"] : ["rg"];
  const exe = process.platform === "win32" ? ".exe" : "";
  const local = join(piBinDir(), `${program}${exe}`);
  if (existsSync(local)) return local;
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of names)
    for (const dir of dirs) {
      const candidate = join(dir, `${name}${exe}`);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  return null;
}

const quoteArg = (arg: string): string =>
  /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;

/** The command line Pi runs for a grep or find call (as its source builds it), for the card: the program and its arguments. */
export function searchCommand(
  kind: "grep" | "find",
  program: string,
  params: Args,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): string {
  const where = piResolve(str(params.path) || ".", cwd, platform);
  const args: string[] = [];
  if (kind === "grep") {
    args.push("--json", "--line-number", "--color=never", "--hidden");
    if (params.ignoreCase === true) args.push("--ignore-case");
    if (params.literal === true) args.push("--fixed-strings");
    if (str(params.glob)) args.push("--glob", str(params.glob));
    args.push("--", str(params.pattern), where);
  } else {
    // Pi 1.0.0 find.js: --no-require-git outside any git repository (a `.git` in the folder or an ancestor), then the
    // limit, then a pattern with `/` as a full-path match, given `**/` in front unless it is already anchored.
    let insideGitRepo = false;
    for (let current = where; ; ) {
      if (existsSync(join(current, ".git"))) {
        insideGitRepo = true;
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    args.push("--glob", "--color=never", "--hidden");
    if (!insideGitRepo) args.push("--no-require-git");
    args.push("--max-results", String(typeof params.limit === "number" ? params.limit : 1000));
    let pattern = str(params.pattern);
    if (pattern.includes("/")) {
      args.push("--full-path");
      if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**")
        pattern = `**/${pattern}`;
      if (platform === "win32") pattern = pattern.replaceAll("/", String.raw`[/\\]`);
    }
    args.push("--", pattern, where);
  }
  return [program, ...args].map(quoteArg).join(" ");
}

/**
 * Pi's grep and find fetch ripgrep / fd from the internet into the user's `~/.pi` when the program is not on the
 * PATH. The workbench does not download programs behind the user's back: without the program the call answers with a
 * plain error that points at the shell tool.
 */
function guardSearch(definition: ToolDefinition, program: "rg" | "fd"): ToolDefinition {
  return {
    ...definition,
    execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
      if (findProgram(program) === null)
        throw new Error(
          `${program === "rg" ? "ripgrep (rg)" : "fd"} is not installed on this computer, so this tool cannot search; use the shell tool instead (grep -rn, find)`
        );
      return definition.execute(...args);
    },
  };
}
