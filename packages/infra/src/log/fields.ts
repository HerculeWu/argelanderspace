/**
 * The values a log record may carry. A record is a fixed event name plus named fields, and a field value is one
 * of seven kinds: identifier, enum value, number, duration, path, URL, error. There is no text kind: a field can
 * only be made by one of the constructors in `f`, each of which reduces what it is given to something that is safe
 * to publish — so what a record can say is decided here, not at the place that logs.
 *
 *   id      a short ASCII token without spaces or `@`; anything else is written as `<invalid-id>`
 *   oneOf   a member of a list written in code; anything else is written as `<invalid-enum>`
 *   num     a finite number
 *   ms      a duration in milliseconds
 *   path    a file path, with the user's home directory written as `~`
 *   url     scheme and host only
 *   error   name, code and the file:line:column of each stack frame; the message is dropped unless the error's
 *           class declares `LOG_SAFE_MESSAGE`
 *
 * `ids` and `someOf` are lists of the first two. Rendering never throws.
 */

import { fileURLToPath } from "node:url";

const MADE_HERE = Symbol("log field");

type FieldSpec =
  | { kind: "id"; value: unknown }
  | { kind: "ids"; value: unknown }
  | { kind: "enum"; allowed: readonly string[]; value: unknown }
  | { kind: "enums"; allowed: readonly string[]; value: unknown }
  | { kind: "num"; value: unknown }
  | { kind: "ms"; value: unknown }
  | { kind: "path"; value: unknown }
  | { kind: "url"; value: unknown }
  | { kind: "error"; value: unknown };

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

// No whitespace (a title has some), no `@` (a mail address has one), nothing outside ASCII.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/+()-]*$/;
const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SYSCALL = /^[a-z0-9_]{1,32}$/;
// Control characters and the two Unicode line separators: none may end up inside a record.
function withoutControl(text: string, replacement: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const control =
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? replacement : ch;
  }
  return out;
}

function field(spec: FieldSpec): LogField {
  return new LogField(MADE_HERE, spec);
}

export const f = {
  /** A stable identifier: a Doc id, a Work id, a job id, a version. Not a title, a name or an address. */
  id: (value: string): LogField => field({ kind: "id", value }),
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
  path: (value: string): LogField => field({ kind: "path", value }),
  url: (value: string | URL): LogField => field({ kind: "url", value }),
  /** Whatever was thrown. */
  error: (value: unknown): LogField => field({ kind: "error", value }),
} as const;

function render(spec: FieldSpec, context: RenderContext): LogJson {
  switch (spec.kind) {
    case "id":
      return renderId(spec.value);
    case "ids":
      return list(spec.value, renderId);
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
      return typeof spec.value === "string" ? renderPath(spec.value, context) : INVALID;
    case "url":
      return renderUrl(spec.value);
    case "error":
      return renderError(spec.value, context, 0);
  }
}

function list(value: unknown, each: (item: unknown) => LogJson): LogJson {
  return Array.isArray(value) ? value.slice(0, LOG_LIST_MAX).map(each) : INVALID;
}

function renderId(value: unknown): string {
  return typeof value === "string" && value.length <= LOG_ID_MAX && ID.test(value)
    ? value
    : INVALID_ID;
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

function renderPath(value: string, context: RenderContext): string {
  return clip(withoutControl(withoutHome(value, context), "?"), LOG_PATH_MAX);
}

function renderUrl(value: unknown): string {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    // `host` leaves out the user name and password; a scheme without a host (mailto:) keeps the scheme alone.
    return url.host ? `${url.protocol}//${url.host}` : url.protocol;
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

// "    at name (location)" or "    at location"; the location ends in :line:column.
const FRAME = /^\s*at (?:.* \()?(.+?):(\d+):(\d+)\)?$/;
const LOCATION_START = /^(?:\/|\\\\|[A-Za-z]:[\\/]|file:|node:)/;

/** The frames of a stack as `file:line:column`. The first line (name and message) and function names are left out. */
function renderStack(stack: unknown, context: RenderContext): string[] {
  if (typeof stack !== "string") return [];
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
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
    frames.push(`${renderPath(file, context)}:${match[2]}:${match[3]}`);
  }
  return frames;
}

function renderError(value: unknown, context: RenderContext, depth: number): LogJson {
  if (!(value instanceof Error)) {
    // A thrown string or object may be anything; only what kind of thing it was is recorded.
    return { name: "NonError", thrown: value === null ? "null" : typeof value };
  }
  const out: { [key: string]: LogJson } = {};
  const name = value.name;
  out.name = typeof name === "string" && ERROR_NAME.test(name) ? name : "Error";
  const extra = value as { code?: unknown; syscall?: unknown; path?: unknown; cause?: unknown };
  if (typeof extra.code === "string" && ERROR_CODE.test(extra.code)) out.code = extra.code;
  else if (typeof extra.code === "number" && Number.isFinite(extra.code)) out.code = extra.code;
  // A system error (it names its system call) says which file; `path` on any other error could be anything.
  if (typeof extra.syscall === "string" && SYSCALL.test(extra.syscall)) {
    out.syscall = extra.syscall;
    if (typeof extra.path === "string") out.path = renderPath(extra.path, context);
  }
  if (declaredSafe(value) && typeof value.message === "string") {
    out.message = clip(withoutControl(withoutHome(value.message, context), " "), LOG_MESSAGE_MAX);
  }
  out.stack = renderStack(value.stack, context);
  if (extra.cause !== undefined && depth < CAUSE_DEPTH_MAX) {
    out.cause = renderError(extra.cause, context, depth + 1);
  }
  return out;
}
