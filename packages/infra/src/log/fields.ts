/**
 * The values a log record may carry. A record is a fixed event name plus named fields, and a field value is one
 * of seven kinds: identifier, enum value, number, duration, path, URL, error. There is no kind that takes a
 * sentence: a field can only be made by one of the constructors in `f`, each of which reduces what it is given to
 * what its kind allows — so what a record can say is decided here, not at the place that logs. Three kinds are
 * still strings whose content the caller chooses within limits (identifier, path, the host of a URL); the limits
 * are below, and what they do not stop is said where each is rendered.
 *
 *   id      a short ASCII token without spaces or `@`; anything else is written as `<invalid-id>`. An id of one of
 *           the shapes that are made from a title or a folder name is written as a hash (see workId / docId)
 *   workId  a Work id: written as it is when it is made of a DOI, an arXiv number or an OpenAlex number, otherwise
 *           as `work:#<hash>`
 *   docId   a Doc id: written as it is when it is made of an arXiv number or a random number (or belongs to a
 *           Work whose id is one of the three above), otherwise as `<kind>-#<hash>`
 *   oneOf   a member of a list written in code; anything else is written as `<invalid-enum>`
 *   num     a finite number
 *   ms      a duration in milliseconds
 *   path    an absolute file path, with the user's home directory written as `~` and every folder or file name
 *           that has the shape of a title-made Work / Doc id written as that id's hash; anything that is not an
 *           absolute path is written as `<invalid-path>`
 *   url     scheme, host and port only, for a scheme from a fixed list; anything else is written as
 *           `<invalid-url>`
 *   error   name, code (written like an `id`), the system call and path of a system error, the file:line:column
 *           of each stack frame, and the cause; the message is dropped unless the error's class declares
 *           `LOG_SAFE_MESSAGE`. The call site may ask for less: `omitSystemPath` leaves out the path of a system
 *           error, at every depth of the cause chain
 *
 * `ids` and `someOf` are lists. Rendering never throws.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const MADE_HERE = Symbol("log field");

type FieldSpec =
  | { kind: "id"; value: unknown }
  | { kind: "ids"; value: unknown }
  | { kind: "work"; value: unknown }
  | { kind: "doc"; value: unknown }
  | { kind: "enum"; allowed: readonly string[]; value: unknown }
  | { kind: "enums"; allowed: readonly string[]; value: unknown }
  | { kind: "num"; value: unknown }
  | { kind: "ms"; value: unknown }
  | { kind: "path"; value: unknown }
  | { kind: "url"; value: unknown }
  | { kind: "error"; value: unknown; omitSystemPath: boolean };

/** An opaque field value. Only the constructors in `f` make one; a logger ignores anything else. */
export class LogField {
  // A private member makes the type nominal: an object literal of the same shape is not a LogField.
  readonly #spec: FieldSpec;
  constructor(token: typeof MADE_HERE, spec: FieldSpec) {
    if (token !== MADE_HERE) throw new TypeError("a LogField is made by the constructors in `f`");
    this.#spec = spec;
  }
  /** @internal The JSON value this field is written as. */
  render(context: RenderContext): LogJson {
    try {
      return render(this.#spec, context);
    } catch {
      return INVALID;
    }
  }
}

export type LogJson = string | number | null | LogJson[] | { [key: string]: LogJson };

/** What rendering needs to know about the machine: the home directory in each spelling it may appear in. */
export interface RenderContext {
  homes: readonly string[];
}

/**
 * Declares that every message an error class produces is fixed text or values written in code — never a runtime
 * value (a path, a file's content, a server's reply, user input). Only then does a log record keep the message:
 *
 *   class RevMismatch extends Error {
 *     static readonly [LOG_SAFE_MESSAGE] = true;
 *   }
 *
 * The declaration covers exactly the class that carries it, not its subclasses.
 */
export const LOG_SAFE_MESSAGE: unique symbol = Symbol.for("argelanderspace.log.safe-message");

export const LOG_ID_MAX = 128;
export const LOG_LIST_MAX = 64;
export const LOG_PATH_MAX = 1024;
export const LOG_MESSAGE_MAX = 500;
export const LOG_STACK_FRAMES_MAX = 40;
const ENUM_MAX = 200;
const CAUSE_DEPTH_MAX = 3;

const INVALID = "<invalid>";
const INVALID_ID = "<invalid-id>";
const INVALID_ENUM = "<invalid-enum>";
const INVALID_URL = "<invalid-url>";
const INVALID_PATH = "<invalid-path>";
export const LOG_HOST_MAX = 255;
/** Hex digits of the hash a title-made id is written as. */
export const LOG_ID_HASH_LENGTH = 12;
// Longer than any id the library makes; beyond it the value is not even hashed.
const HASHED_ID_INPUT_MAX = 4096;

// No whitespace (a title has some), no `@` (a mail address has one), nothing outside ASCII.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/+()-]*$/;
const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SYSCALL = /^[a-z0-9_]{1,32}$/;
// Control characters, the two Unicode line separators, the bidi marks and controls (U+061C, U+200E / U+200F,
// U+202A–U+202E, U+2066–U+2069, the same set the CLI escapes), and the characters that take no room (U+200B–U+200D,
// U+2060, U+FEFF, and the soft hyphen U+00AD): none may end up inside a record — the first two could break the line,
// the bidi ones could change the order in which a path or a message is shown, the last could hide in it.
function withoutControl(text: string, replacement: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const control =
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x061c ||
      code === 0x00ad ||
      (code >= 0x200b && code <= 0x200f) ||
      code === 0x2060 ||
      code === 0xfeff ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    out += control ? replacement : ch;
  }
  return out;
}

/** What a call site may ask `f.error` to leave out. Every option writes less than the default. */
export interface LogErrorOptions {
  /** Do not write the `path` of a system error, at any depth of the cause chain. */
  omitSystemPath?: boolean;
}

function field(spec: FieldSpec): LogField {
  return new LogField(MADE_HERE, spec);
}

export const f = {
  /**
   * A stable identifier: a job id, an account id, an error code, a version. Not a title, a name or an address —
   * and for a Work id or a Doc id use `workId` / `docId`, which know which of them are made from a title.
   */
  id: (value: string): LogField => field({ kind: "id", value }),
  /** A Work id. One made from the Work's title is written as a hash, the same hash every time. */
  workId: (value: string): LogField => field({ kind: "work", value }),
  /** A Doc id. One made from a title or from the name of a local folder is written as a hash. */
  docId: (value: string): LogField => field({ kind: "doc", value }),
  /** Several identifiers (at most `LOG_LIST_MAX` are written). */
  ids: (values: readonly string[]): LogField => field({ kind: "ids", value: values }),
  /** One of the values listed in code. `allowed` is a list written in the source, never built from runtime data. */
  oneOf: <const A extends readonly string[]>(
    allowed: A,
    value: A[number] | (string & {})
  ): LogField => field({ kind: "enum", allowed, value }),
  /** Several of the values listed in code. */
  someOf: <const A extends readonly string[]>(allowed: A, values: readonly string[]): LogField =>
    field({ kind: "enums", allowed, value: values }),
  num: (value: number): LogField => field({ kind: "num", value }),
  /** A duration in milliseconds. */
  ms: (value: number): LogField => field({ kind: "ms", value }),
  /** An absolute path. A folder or file name in it that is a title-made Work / Doc id is written as its hash. */
  path: (value: string): LogField => field({ kind: "path", value }),
  /** Only the scheme, the host and the port are written. */
  url: (value: string | URL): LogField => field({ kind: "url", value }),
  /**
   * Whatever was thrown. `omitSystemPath` writes less, never more: the path a system error names (the file it
   * could not open) is left out, here and in every cause — for an error raised while working on the user's own
   * files, whose folder may be named after a paper. The frames of the stack are still written: they are the
   * locations of code.
   */
  error: (value: unknown, options?: LogErrorOptions): LogField =>
    field({ kind: "error", value, omitSystemPath: options?.omitSystemPath === true }),
} as const;

function render(spec: FieldSpec, context: RenderContext): LogJson {
  switch (spec.kind) {
    case "id":
      return renderId(spec.value);
    case "ids":
      return list(spec.value, renderId);
    case "work":
      return renderWorkId(spec.value);
    case "doc":
      return renderDocId(spec.value);
    case "enum":
      return renderEnum(spec.allowed, spec.value);
    case "enums":
      return list(spec.value, (v) => renderEnum(spec.allowed, v));
    case "num":
      return typeof spec.value === "number" && Number.isFinite(spec.value) ? spec.value : null;
    case "ms":
      return typeof spec.value === "number" && Number.isFinite(spec.value) && spec.value >= 0
        ? Math.round(spec.value * 10) / 10
        : null;
    case "path":
      return renderPath(spec.value, context);
    case "url":
      return renderUrl(spec.value);
    case "error":
      return renderError(spec.value, context, 0, spec.omitSystemPath);
  }
}

function list(value: unknown, each: (item: unknown) => LogJson): LogJson {
  return Array.isArray(value) ? value.slice(0, LOG_LIST_MAX).map(each) : INVALID;
}

function plainId(value: string): boolean {
  return value.length <= LOG_ID_MAX && ID.test(value);
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// A job id is `<kind>-<uuid>`, and one kind is `upload`: not an upload Doc id.
const UPLOAD_JOB_ID = new RegExp(`^upload-${UUID}$`);

function renderId(value: unknown): string {
  if (typeof value !== "string") return INVALID_ID;
  // The shapes the library gives an id it makes from a title or a folder name. Whoever passes one here meant
  // `workId` / `docId`; it is written the way they would write it, so the same object reads the same everywhere.
  if (value.startsWith("work:")) return renderWorkId(value);
  if (value.startsWith("latex-")) return renderDocId(value);
  if (value.startsWith("upload-") && !UPLOAD_JOB_ID.test(value)) return renderDocId(value);
  return plainId(value) ? value : INVALID_ID;
}

/** A hash of the whole id: the same id is the same hash in every record of every run (nothing else goes in). */
function hashed(prefix: string, value: string): string {
  if (value.length > HASHED_ID_INPUT_MAX) return INVALID_ID;
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `${prefix}#${digest.slice(0, LOG_ID_HASH_LENGTH)}`;
}

// What core's `canonicalId` makes (library/store.ts): `doi:<DOI>`, `arxiv:<number>`, `openalex:<number>`, and —
// when a Work has none of the three — `work:<slug of the title>[-<year>]`. Only the first three are written as
// they are, and only in their real shape: a DOI starts with its registrant prefix `10.<digits>/`, an arXiv number
// is `YYMM.NNNNN` or the old `archive[.XX]/NNNNNNN`, an OpenAlex number is a letter and digits.
//
// The old arXiv number is the shape core recognizes one by (`documents/references.ts`, `pipelines/tex/facts/bbl.ts`:
// `[a-z-]+(?:\.[A-Z]{2})?\/\d{7}`, letters in either case): an archive is letters and hyphens — `q-bio`, `q-alg`,
// `hep-th`, `alg-geom`, `cs` — with an optional two-letter subject class. What makes it a number and not a title
// is the seven digits.
const OLD_ARXIV_ARCHIVE = String.raw`[A-Za-z-]+(?:\.[A-Za-z]{2})?`;
const WORK_ID_AS_IS = [
  /^doi:10\.\d{4,9}\/\S+$/,
  /^arxiv:\d{4}\.\d{4,5}$/,
  new RegExp(`^arxiv:${OLD_ARXIV_ARCHIVE}/\\d{7}$`),
  /^openalex:[A-Za-z]\d+$/,
];

function renderWorkId(value: unknown): string {
  if (typeof value !== "string") return INVALID_ID;
  if (plainId(value) && WORK_ID_AS_IS.some((shape) => shape.test(value))) return value;
  return hashed("work:", value);
}

// The Doc ids the workbench makes:
//   arxiv-<number>                 infra `docIdFor`, core `arxivDocId` (a `/` in an old number becomes `-`)
//   pdf-<uuid>, text-<uuid>        core pdf-storage / text-docs, server acquisition
//   upload-<slug of the Work id, at most 44 characters>-<6 hex>   core `uploadDocId`
//   latex-<name of the local file or folder>                      infra `docIdFor`
// A `latex-` id is the user's folder name; an `upload-` id carries its Work's id, so it is written as it is only
// when that Work id is a DOI, an arXiv number or an OpenAlex number (the slug then starts `doi-10-`, `arxiv-` or
// `openalex-`; the slug of a title-made Work id starts `work-`). Everything else is hashed.
const DOC_ID_AS_IS = [
  /^arxiv-\d{4}\.\d{4,5}(?:v\d+)?$/,
  new RegExp(`^arxiv-${OLD_ARXIV_ARCHIVE}-\\d{7}(?:v\\d+)?$`),
  new RegExp(`^(?:pdf|text)-${UUID}$`),
  /^upload-doi-10-\d{4,9}-[a-z0-9-]*-[0-9a-f]{6}$/,
  /^upload-arxiv-\d{4}-\d{4,5}-[0-9a-f]{6}$/,
  // The slug of `arxiv:<archive[.xx]>/<number>`: lower case, and the dot and the slash are hyphens.
  /^upload-arxiv-[a-z-]+-\d{7}-[0-9a-f]{6}$/,
  /^upload-openalex-[a-z]\d+-[0-9a-f]{6}$/,
];

function renderDocId(value: unknown): string {
  if (typeof value !== "string") return INVALID_ID;
  if (plainId(value) && DOC_ID_AS_IS.some((shape) => shape.test(value))) return value;
  // The kind is kept when it is one of the two title-made ones; any other shape says nothing about itself.
  const kind = value.startsWith("latex-")
    ? "latex-"
    : value.startsWith("upload-")
      ? "upload-"
      : "doc-";
  return hashed(kind, value);
}

function renderEnum(allowed: readonly string[], value: unknown): string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= ENUM_MAX &&
    !/\s/.test(value) &&
    Array.isArray(allowed) &&
    allowed.includes(value)
    ? value
    : INVALID_ENUM;
}

/** Every spelling of the home directory in `text` becomes `~`. */
function withoutHome(text: string, context: RenderContext): string {
  let out = text;
  for (const home of context.homes) {
    if (home.length < 2) continue; // "/" as a home directory would turn every path into "~"
    for (const spelling of new Set([home, home.replaceAll("\\", "/")])) {
      let from = 0;
      for (;;) {
        const at = out.indexOf(spelling, from);
        if (at < 0) break;
        const next = out[at + spelling.length];
        // Only a whole directory name: /home/ann must not shorten /home/anna.
        if (next === undefined || next === "/" || next === "\\" || !/[A-Za-z0-9._-]/.test(next)) {
          out = `${out.slice(0, at)}~${out.slice(at + spelling.length)}`;
          from = at + 1;
        } else {
          from = at + spelling.length;
        }
      }
    }
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// `/…`, `X:\…` or `X:/…`, `\\server\…`, and a path already written with `~` for the home directory.
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\|~(?:[\\/]|$))/;

// A Work id as it stands in a file name (core `encodeWorkIdForFile` writes every byte outside `[A-Za-z0-9_-]` as
// `%XX`) is read back before it is looked at; a name that is not such an encoding is looked at as it is.
function decoded(segment: string): string {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// The names the workbench gives a Work or a Doc: `work:` (and the three Work ids that are written as they are
// when they have their real shape), `latex-`, `upload-`. In either case of letters: a name that only looks like
// one is hashed too.
const ID_SEGMENT = /^(?:(work|doi|arxiv|openalex):|latex-|upload-)/i;
// What the workbench (or its build) puts after an id to name a file: `<id>.json`, `<id>.json.tmp`,
// `<id>.json.tmp-<uuid>`. The list is written here; any other ending may be part of a folder's name (`latex-` is
// followed by one, dots included) and is hashed with it.
const ID_FILE_ENDING =
  /^(.*?)((?:\.(?:json|jsonl|tmp(?:-[0-9a-f-]{1,36})?|bak|lock|pdf|tex|bib|zip|gz|tgz|tar|js|mjs|cjs|ts|map))*)$/is;

/**
 * One folder or file name of a path. A name that is a Work or Doc id of a shape the identifier fields write as a
 * hash is written as that hash — the same one, so a record that names the object and a record that names its file
 * can be matched — and keeps its file ending. Every other name is returned as it was given.
 *
 * Only a name that begins the way an id begins is looked at, so the folders and files of code are untouched —
 * except one whose own name begins `latex-` or `upload-` (a package, a source file, a project folder), which is
 * hashed like an id. That is the side this errs on: such a name cannot be told from the Doc id of a folder called
 * the same, and its hash is the same every time, so it can still be matched.
 */
function renderSegment(segment: string): string {
  const name = decoded(segment);
  const kind = ID_SEGMENT.exec(name);
  if (!kind) return segment;
  const parts = ID_FILE_ENDING.exec(name);
  const id = parts?.[1] ?? name;
  const ending = parts?.[2] ?? "";
  const written =
    kind[1] !== undefined ? renderWorkId(id) : UPLOAD_JOB_ID.test(id) ? id : renderDocId(id);
  return written === id ? segment : `${written}${ending}`;
}

/**
 * Only an absolute path is written: a sentence, a title, a bare file name or a relative path is not one. What this
 * cannot stop is text that begins like an absolute path, and it does not hide the names of the folders in the path
 * (a project folder is named by its user) — only the home directory is replaced, and a name that is a title-made
 * Work / Doc id is written as its hash (`renderSegment`). Every path a record carries is written here: a path
 * field, the path of a system error at any depth of the cause chain, and the file of a stack frame.
 */
function renderPath(value: unknown, context: RenderContext): string {
  if (typeof value !== "string" || !ABSOLUTE_PATH.test(value)) return INVALID_PATH;
  const names = withoutHome(value, context)
    .split(/([\\/])/)
    .map((part) => (part === "/" || part === "\\" ? part : renderSegment(part)));
  return clip(withoutControl(names.join(""), "?"), LOG_PATH_MAX);
}

// Written in code: a word in front of a colon is a scheme only if it is one of these.
const URL_SCHEMES = new Set([
  "http:",
  "https:",
  "ws:",
  "wss:",
  "ftp:",
  "file:",
  "mailto:",
  "data:",
  "blob:",
  "about:",
  "imap:",
  "imaps:",
  "smtp:",
  "smtps:",
  "tauri:",
]);

function renderUrl(value: unknown): string {
  try {
    if (typeof value !== "string" && !(value instanceof URL)) return INVALID_URL;
    const url = value instanceof URL ? value : new URL(value);
    if (!URL_SCHEMES.has(url.protocol)) return INVALID_URL;
    // `host` leaves out the user name and password; a scheme without a host (mailto:, data:, blob:, file:) keeps
    // the scheme alone.
    if (!url.host) return url.protocol;
    if (url.host.length > LOG_HOST_MAX) return INVALID_URL;
    return `${url.protocol}//${withoutControl(url.host, "?")}`;
  } catch {
    return INVALID_URL;
  }
}

function declaredSafe(error: Error): boolean {
  const type = (error as { constructor?: unknown }).constructor;
  return (
    typeof type === "function" &&
    Object.hasOwn(type, LOG_SAFE_MESSAGE) &&
    (type as unknown as Record<symbol, unknown>)[LOG_SAFE_MESSAGE] === true
  );
}

// "    at name (location)" or "    at location", either after `async `; the location ends in :line:column. A line
// without one (`at async Promise.all (index 0)`, `at <anonymous>`) is no frame.
const FRAME = /^\s*at (?:async )?(?:.* \()?(.+?):(\d+):(\d+)\)?$/;
const NODE_MODULE = /^node:[A-Za-z0-9_/.-]{1,200}$/;
const LOCATION_START = /^(?:\/|\\\\|[A-Za-z]:[\\/]|file:|node:)/;

// What V8 puts in front of the message on the first line: the name the error had when the stack was made, and
// Node's ` [CODE]` for its own errors.
const STACK_HEAD_NAME = /^[A-Za-z_$][A-Za-z0-9_$.]*(?: \[[A-Za-z0-9_.]+\])?/;

/**
 * The part of a stack after its first "line" — which is `name: message`, and the message may have lines of its own,
 * any of which may look like a frame. So the message is cut off as the exact text it is, not by looking for where
 * the frames seem to start. Returns null when the stack does not begin with this error's message in the way V8
 * writes it (the message was changed later, the stack was replaced, `Error.prepareStackTrace` made something
 * else): then nothing of it can be told apart from message text, and no frame is written.
 */
function framesPart(error: Error): string | null {
  const { stack, message, name } = error as { stack?: unknown; message?: unknown; name?: unknown };
  if (typeof stack !== "string" || typeof message !== "string") return null;
  // A name with a line of its own (possible when the stack is captured after the name was set) is the same problem.
  if (typeof name === "string" && name.includes("\n")) return null;
  const afterHead = (rest: string): string | null =>
    rest === "" ? "" : rest.startsWith("\n") ? rest.slice(1) : null;
  // `message` alone (an error without a name) …
  if (message !== "" && stack.startsWith(message)) {
    const rest = afterHead(stack.slice(message.length));
    if (rest !== null) return rest;
  }
  const head = STACK_HEAD_NAME.exec(stack);
  if (!head) return null;
  // … or `name: message` …
  if (stack.startsWith(`: ${message}`, head[0].length)) {
    return afterHead(stack.slice(head[0].length + 2 + message.length));
  }
  // … or, without a message, the name alone.
  return message === "" ? afterHead(stack.slice(head[0].length)) : null;
}

/** The frames of a stack as `file:line:column`. The first line (name and message) and function names are left out. */
function renderStack(error: Error, context: RenderContext): string[] {
  const part = framesPart(error);
  if (part === null) return [];
  const frames: string[] = [];
  for (const line of part.split("\n")) {
    if (frames.length >= LOG_STACK_FRAMES_MAX) break;
    const match = FRAME.exec(line);
    if (!match) continue;
    let file = match[1] as string;
    if (!LOCATION_START.test(file)) continue;
    if (file.startsWith("file:")) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    // A module of the runtime (`node:internal/…`) is not a path on this machine and is written as it is.
    const where = NODE_MODULE.test(file) ? file : renderPath(file, context);
    frames.push(`${where}:${match[2]}:${match[3]}`);
  }
  return frames;
}

function renderError(
  value: unknown,
  context: RenderContext,
  depth: number,
  omitSystemPath: boolean
): LogJson {
  if (!(value instanceof Error)) {
    // A thrown string or object may be anything; only what kind of thing it was is recorded.
    return { name: "NonError", thrown: value === null ? "null" : typeof value };
  }
  const out: { [key: string]: LogJson } = {};
  const name = value.name;
  out.name = typeof name === "string" && ERROR_NAME.test(name) ? name : "Error";
  const extra = value as { code?: unknown; syscall?: unknown; path?: unknown; cause?: unknown };
  // A code is an identifier and is written like one: a Work / Doc id put there is not written as it is.
  if (typeof extra.code === "string" && ERROR_CODE.test(extra.code))
    out.code = renderId(extra.code);
  else if (typeof extra.code === "number" && Number.isFinite(extra.code)) out.code = extra.code;
  // A system error (it names its system call) says which file; `path` on any other error could be anything.
  if (typeof extra.syscall === "string" && SYSCALL.test(extra.syscall)) {
    out.syscall = extra.syscall;
    if (extra.path !== undefined && !omitSystemPath) out.path = renderPath(extra.path, context);
  }
  if (declaredSafe(value) && typeof value.message === "string") {
    out.message = clip(withoutControl(withoutHome(value.message, context), " "), LOG_MESSAGE_MAX);
  }
  out.stack = renderStack(value, context);
  if (extra.cause !== undefined && depth < CAUSE_DEPTH_MAX) {
    out.cause = renderError(extra.cause, context, depth + 1, omitSystemPath);
  }
  return out;
}
