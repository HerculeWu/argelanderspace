/**
 * Records what kills a long-running process: an uncaught exception or an unhandled Promise rejection.
 *
 * It only watches. `uncaughtExceptionMonitor` runs before Node deals with the error and leaves that dealing alone,
 * so the process still prints what it always printed and exits with the code it always did. (An unhandled rejection
 * reaches the monitor as an uncaught exception whose origin says so; a listener for `unhandledRejection` itself
 * would stop Node from ending the process.) The sink writes synchronously, so the record is on disk first.
 */

import { f, type LogField } from "./fields.js";
import type { LogEvent, LogEventTable, Logger } from "./logger.js";

/** The events of a catalog whose fields include `error`, made by `f.error`: what this watch writes. */
export type LogEventTakingError<T extends LogEventTable> = {
  [E in LogEvent<T>]: T[E] extends { readonly error: (...args: never) => LogField<"error"> }
    ? E
    : never;
}[LogEvent<T>];

/** Returns the function that stops watching. */
export function installProcessLogging<T extends LogEventTable>(
  log: Logger<T>,
  events: { uncaughtException: LogEventTakingError<T>; unhandledRejection: LogEventTakingError<T> }
): () => void {
  // The two events take `error` (the signature says so); the types cannot follow that through a generic catalog.
  const errorLog = log as unknown as Logger<
    Readonly<Record<string, { readonly error: typeof f.error }>>
  >;
  const monitor = (error: unknown, origin: string): void => {
    const event: string =
      origin === "unhandledRejection" ? events.unhandledRejection : events.uncaughtException;
    errorLog.error(event, { error: f.error(error) });
  };
  process.on("uncaughtExceptionMonitor", monitor);
  return () => void process.off("uncaughtExceptionMonitor", monitor);
}
