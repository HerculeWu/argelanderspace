/**
 * Records what kills a long-running process: an uncaught exception or an unhandled Promise rejection.
 *
 * It only watches. `uncaughtExceptionMonitor` runs before Node deals with the error and leaves that dealing alone,
 * so the process still prints what it always printed and exits with the code it always did. (An unhandled rejection
 * reaches the monitor as an uncaught exception whose origin says so; a listener for `unhandledRejection` itself
 * would stop Node from ending the process.) The sink writes synchronously, so the record is on disk first.
 */

import { f } from "./fields.js";
import type { Logger } from "./logger.js";

/** Returns the function that stops watching. */
export function installProcessLogging<E extends string>(
  log: Logger<E>,
  events: { uncaughtException: E; unhandledRejection: E }
): () => void {
  const monitor = (error: unknown, origin: string): void => {
    log.error(
      origin === "unhandledRejection" ? events.unhandledRejection : events.uncaughtException,
      { error: f.error(error) }
    );
  };
  process.on("uncaughtExceptionMonitor", monitor);
  return () => void process.off("uncaughtExceptionMonitor", monitor);
}
