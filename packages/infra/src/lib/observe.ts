/**
 * What a caller may watch of the calls infra makes to things outside the process: the external programs it runs and
 * the web services it asks. An observer is handed in by whoever composes the adapters (the server, for its user-level
 * log); there is no process-wide one, so code that hands none in — every CLI command — is observed by nobody.
 *
 * What an observer is told is deliberately little: which program or service (a name from the lists below, written in
 * code), how it ended, how long it took. Never an argument, a request or an answer. The URL of a service call is
 * passed whole because only the receiver knows what it keeps of it (the log keeps scheme, host and port).
 *
 * An observer must not throw; if it does, the throw is swallowed here and the observed call is unaffected.
 */

import type { FetchImpl } from "./http.js";

/** The programs infra runs. */
export const EXTERNAL_PROGRAMS = ["latexmk", "pdftocairo", "gs", "bwrap"] as const;
export type ExternalProgram = (typeof EXTERNAL_PROGRAMS)[number];

/** The web services infra asks. */
export const EXTERNAL_SERVICES = ["ads", "crossref", "openalex", "arxiv"] as const;
export type ExternalService = (typeof EXTERNAL_SERVICES)[number];

export interface ExternalProgramCall {
  program: ExternalProgram;
  /** Run inside the bubblewrap sandbox (the Writer's compile). */
  sandboxed: boolean;
  /** Null when the program was killed or could not be started. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Set when the program could not be started at all. */
  error?: unknown;
}

export interface ExternalServiceCall {
  service: ExternalService;
  /** The requested URL; the receiver keeps only what it may. */
  url: string;
  /** The HTTP status of the answer; null when there was none. */
  status: number | null;
  durationMs: number;
  /** Set when the request ended without an answer (network failure, timeout, abort). */
  error?: unknown;
}

export interface ExternalObserver {
  program?(call: ExternalProgramCall): void;
  service?(call: ExternalServiceCall): void;
}

export function reportProgram(
  observer: ExternalObserver | undefined,
  call: ExternalProgramCall
): void {
  try {
    observer?.program?.(call);
  } catch {
    /* watching a call never changes it */
  }
}

function requestUrl(input: Parameters<FetchImpl>[0]): string {
  try {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
  } catch {
    return "";
  }
}

/**
 * `impl`, with every request reported to `observer`. The answer (or the error) is the one `impl` gave, untouched: its
 * body is not read, and nothing is retried or delayed. Without an observer this is `impl` itself.
 */
export function observedFetch(
  impl: FetchImpl,
  service: ExternalService,
  observer: ExternalObserver | undefined
): FetchImpl {
  if (observer?.service === undefined) return impl;
  const report = (call: ExternalServiceCall): void => {
    try {
      observer.service?.(call);
    } catch {
      /* watching a call never changes it */
    }
  };
  return (async (input, init) => {
    const started = performance.now();
    const url = requestUrl(input);
    let response: Response;
    try {
      response = await impl(input, init);
    } catch (error) {
      report({ service, url, status: null, durationMs: performance.now() - started, error });
      throw error;
    }
    report({ service, url, status: response.status, durationMs: performance.now() - started });
    return response;
  }) as FetchImpl;
}
