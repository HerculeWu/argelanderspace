/**
 * The logger: one record = one event name from a fixed catalog + fields made by `f` (fields.ts). It has no method
 * that takes text, so there is no way to hand it a sentence built from runtime values. Where the records go is the
 * sink, which is injected: a file per process run in production (files.ts); tests bring their own.
 *
 * The catalog is a table: each event names its fields and the constructor each is made by, so the types refuse a
 * field the event does not have, or one of another kind, wherever the fields object was put together. The run-time
 * checks do not rely on that: they are the same whatever the types let through.
 *
 * Logging never throws and never fails its caller: an unknown event, a malformed field or a sink that cannot write
 * costs at most the record.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { SETTINGS_LOG_LEVELS } from "@argelanderspace/contracts";
import { LogField, type LogJson, type RenderContext } from "./fields.js";

/** Lowest first. The list is the Settings schema's: `log_level` in config.toml takes exactly these. */
export const LOG_LEVELS = SETTINGS_LOG_LEVELS;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Receives one JSON document per record, without a line break. */
export interface LogSink {
  write(line: string): void;
}

/** A sink that keeps nothing; a logger on it does no work at all. */
export const discardSink: LogSink = { write() {} };

/** What a record's fields are at run time: any names, each a field or left out. */
export type LogFields = Readonly<Record<string, LogField | undefined>>;

/** One of the constructors of `f`. */
export type LogFieldConstructor = (...args: never) => LogField;
/**
 * The fields of one event: each name with the constructor of `f` it is made by, or several when either makes it. A
 * table whose names are not listed (typed `Record<string, …>`) takes any name.
 */
export type LogFieldTable = Readonly<
  Record<string, LogFieldConstructor | readonly LogFieldConstructor[]>
>;
/** The catalog: every event name a logger accepts, with its fields. */
export type LogEventTable = Readonly<Record<string, LogFieldTable>>;
/** The event names of a catalog. */
export type LogEvent<T extends LogEventTable> = Extract<keyof T, string>;

// Not `ReturnType`: a constructor here has `never` parameters, and `ReturnType` asks for `any` ones, which they are not.
type Made<C> = C extends (...args: never) => infer R ? R : never;
type FieldMadeBy<C> = C extends readonly LogFieldConstructor[] ? Made<C[number]> : Made<C>;
/** The fields an event of the catalog takes, each optional; for several events, those of any one of them. */
export type LogEventFields<T extends LogEventTable, E extends LogEvent<T>> = E extends unknown
  ? { readonly [N in keyof T[E]]?: FieldMadeBy<T[E][N]> | undefined }
  : never;

// Every key of every member of a union: `keyof` of a union has only the keys all members share, so a name that only
// one branch of a conditional spread has would get past a plain `keyof`.
type KeysOf<F> = F extends unknown ? keyof F : never;
/** `F` itself when it has no name `A` lacks; otherwise each such name is required to be `never`, which no field is. */
type Listed<F, A> = [Exclude<KeysOf<F>, KeysOf<A>>] extends [never]
  ? F
  : F & { readonly [N in Exclude<KeysOf<F>, KeysOf<A>>]: never };

/** `T` is the catalog: the event names this logger accepts, and the fields each of them takes. */
export interface Logger<T extends LogEventTable> {
  debug<E extends LogEvent<T>, F extends LogEventFields<T, E>>(
    event: E,
    fields?: Listed<F, LogEventFields<T, E>>
  ): void;
  info<E extends LogEvent<T>, F extends LogEventFields<T, E>>(
    event: E,
    fields?: Listed<F, LogEventFields<T, E>>
  ): void;
  warn<E extends LogEvent<T>, F extends LogEventFields<T, E>>(
    event: E,
    fields?: Listed<F, LogEventFields<T, E>>
  ): void;
  error<E extends LogEvent<T>, F extends LogEventFields<T, E>>(
    event: E,
    fields?: Listed<F, LogEventFields<T, E>>
  ): void;
  /** The lowest level that is written. */
  level(): LogLevel;
  /** Takes effect from the next record; a value that is not a level is ignored. */
  setLevel(level: LogLevel): void;
}

/** Rejects a catalog whose names have widened to `string`: event names are literals written in code. */
type Literal<T extends LogEventTable> = string extends keyof T ? never : T;

export interface LoggerOptions<T extends LogEventTable> {
  /**
   * Every event name this logger may write — lower-case words joined by dots, such as `request.failed` — with the
   * fields it takes. At run time only the names are checked against it.
   */
  events: Literal<T>;
  sink: LogSink;
  /** Default `info`. */
  level?: LogLevel;
  /** The home directory that paths are shortened against; default the current user's. */
  home?: string;
  now?: () => Date;
}

const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set(["t", "level", "event", "dropped_fields"]);
/** Written in place of a record whose event name is not in the catalog. */
const REJECTED_EVENT = "log.rejected";

function homes(home: string): string[] {
  const out = [home];
  try {
    const real = realpathSync(home);
    if (real !== home) out.push(real);
  } catch {
    /* a home directory that cannot be resolved is matched by its given spelling only */
  }
  return out.filter((h) => h.length > 0);
}

export function createLogger<T extends LogEventTable>(options: LoggerOptions<T>): Logger<T> {
  const names = Object.keys(options.events);
  for (const name of names) {
    if (!EVENT_NAME.test(name))
      throw new TypeError("a log event name is lower-case words joined by dots");
  }
  const events = new Set<string>(names);
  const sink = options.sink;
  const now = options.now ?? (() => new Date());
  let context: RenderContext | undefined;
  let threshold = LOG_LEVELS.indexOf(isLogLevel(options.level) ? options.level : DEFAULT_LOG_LEVEL);

  function write(level: LogLevel, event: string, fields: LogFields | undefined): void {
    if (sink === discardSink || LOG_LEVELS.indexOf(level) < threshold) return;
    try {
      context ??= { homes: homes(options.home ?? homedir()) };
      const known = typeof event === "string" && events.has(event);
      const record: Record<string, LogJson> = {
        t: now().toISOString(),
        level: known ? level : "error",
        event: known ? event : REJECTED_EVENT,
      };
      let dropped = 0;
      if (known && fields !== undefined && fields !== null) {
        for (const [name, value] of Object.entries(fields)) {
          if (value === undefined) continue;
          if (!FIELD_NAME.test(name) || RESERVED.has(name) || !(value instanceof LogField)) {
            dropped += 1;
            continue;
          }
          record[name] = value.render(context);
        }
      }
      if (dropped > 0) record.dropped_fields = dropped;
      sink.write(JSON.stringify(record));
    } catch {
      /* a record that cannot be written is lost; the caller carries on */
    }
  }

  // The fields arrive as whatever the caller built; at run time they are only a record of names (`LogFields`).
  return {
    debug: (event, fields) => write("debug", event, fields as LogFields | undefined),
    info: (event, fields) => write("info", event, fields as LogFields | undefined),
    warn: (event, fields) => write("warn", event, fields as LogFields | undefined),
    error: (event, fields) => write("error", event, fields as LogFields | undefined),
    level: () => LOG_LEVELS[threshold] as LogLevel,
    setLevel: (level) => {
      if (isLogLevel(level)) threshold = LOG_LEVELS.indexOf(level);
    },
  };
}
