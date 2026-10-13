/**
 * The logger: one record = one event name from a fixed catalog + fields made by `f` (fields.ts). It has no method
 * that takes text, so there is no way to hand it a sentence built from runtime values. Where the records go is the
 * sink, which is injected: a file per process run in production (files.ts); tests bring their own.
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

export type LogFields = Readonly<Record<string, LogField | undefined>>;

/** `E` is the catalog: the event names this logger accepts. */
export interface Logger<E extends string> {
  debug(event: E, fields?: LogFields): void;
  info(event: E, fields?: LogFields): void;
  warn(event: E, fields?: LogFields): void;
  error(event: E, fields?: LogFields): void;
  /** The lowest level that is written. */
  level(): LogLevel;
  /** Takes effect from the next record; a value that is not a level is ignored. */
  setLevel(level: LogLevel): void;
}

/** Rejects a catalog whose type has widened to `string`: event names are literals written in code. */
type Literal<E extends string> = string extends E ? never : E;

export interface LoggerOptions<E extends string> {
  /** Every event name this logger may write: lower-case words joined by dots, such as `request.failed`. */
  events: readonly Literal<E>[];
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

export function createLogger<E extends string>(options: LoggerOptions<E>): Logger<E> {
  for (const name of options.events) {
    if (!EVENT_NAME.test(name))
      throw new TypeError("a log event name is lower-case words joined by dots");
  }
  const events = new Set<string>(options.events);
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

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    level: () => LOG_LEVELS[threshold] as LogLevel,
    setLevel: (level) => {
      if (isLogLevel(level)) threshold = LOG_LEVELS.indexOf(level);
    },
  };
}
