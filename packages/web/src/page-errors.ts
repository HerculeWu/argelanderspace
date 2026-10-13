/**
 * The page's own errors, reported to the server's user-level log (`POST /api/page-errors`): an unhandled error, an
 * unhandled promise rejection, and a render error caught by the top-level boundary (PageErrorBoundary.tsx).
 *
 * Only four things leave the page, and each is cut down here, before sending: the kind of event, the error's
 * `name`, the frames of its stack as `file:line:column` — the file's name alone, without the address it was loaded
 * from, its query, its fragment or the function's name — and the name of the pane that is open. The error's
 * message is never read; nothing of the document or of the address bar is. The server checks all of it again.
 *
 * Reporting never causes more reporting: a report that fails is dropped silently, an error raised while one is being
 * put together is not reported, and a page that keeps failing stops after {@link REPORTS_PER_PAGE_LOAD} reports
 * (the server has its own limits; this one keeps the page from asking).
 */

export const PAGE_ERROR_KINDS = ["error", "unhandledrejection", "render"] as const;
export type PageErrorKind = (typeof PAGE_ERROR_KINDS)[number];

export interface PageErrorReport {
  kind: PageErrorKind;
  name: string;
  stack: string[];
  pane: string;
}

/** What became of a report: written to the log, or not (dropped by a limit, refused, or the server not reached). */
export type PageErrorOutcome = "recorded" | "not_recorded";

export const REPORTS_PER_PAGE_LOAD = 30;
const FRAMES_MAX = 30;
const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
// The location at the end of a stack line, in V8's (`at f (https://host/assets/a.js:1:2)`, `at https://…:1:2`) and
// in Firefox's / Safari's (`f@https://host/assets/a.js:1:2`) spelling: an address, a line, a column.
const LOCATION = /([^\s()@]+):(\d+):(\d+)\)?\s*$/;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.m?js$/;

let currentPane = "none";

/** The pane that is open now; the shell says so whenever it changes. */
export function notePane(view: string): void {
  currentPane = view;
}

export function currentPaneName(): string {
  return currentPane;
}

/** The error's class name as shown and reported: `name` when it has the shape of one, `NonError` for anything else. */
export function errorNameOf(thrown: unknown): string {
  try {
    if (!(thrown instanceof Error)) return "NonError";
    const name = thrown.name;
    return typeof name === "string" && NAME.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

function fileOf(address: string): string | null {
  // Without its query and fragment, then the last segment of what is left.
  const bare = address.split(/[?#]/, 1)[0] ?? "";
  const file = bare.slice(bare.lastIndexOf("/") + 1);
  return SCRIPT_NAME.test(file) ? file : null;
}

/** `file:line:column` for each stack line that ends in a script's location; every other line is left out. */
export function framesOf(thrown: unknown): string[] {
  const frames: string[] = [];
  try {
    const stack = thrown instanceof Error ? thrown.stack : undefined;
    if (typeof stack !== "string") return frames;
    for (const line of stack.split("\n")) {
      if (frames.length >= FRAMES_MAX) break;
      const m = LOCATION.exec(line);
      if (!m || m[1] === undefined) continue;
      const file = fileOf(m[1]);
      if (file !== null) frames.push(`${file}:${m[2]}:${m[3]}`);
    }
  } catch {
    /* an error whose stack cannot be read is reported without one */
  }
  return frames;
}

export function reduceError(kind: PageErrorKind, thrown: unknown): PageErrorReport {
  return { kind, name: errorNameOf(thrown), stack: framesOf(thrown), pane: currentPane };
}

let sent = 0;
let reporting = false;

/** Sends one report. Never throws and never rejects. */
export async function reportPageError(
  kind: PageErrorKind,
  thrown: unknown
): Promise<PageErrorOutcome> {
  // An error raised while a report is being put together (a getter on the thrown value, say) is not reported.
  if (reporting || sent >= REPORTS_PER_PAGE_LOAD) return "not_recorded";
  let body: string;
  reporting = true;
  try {
    body = JSON.stringify(reduceError(kind, thrown));
  } catch {
    return "not_recorded";
  } finally {
    reporting = false;
  }
  sent += 1;
  try {
    const response = await fetch("/api/page-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
    if (!response.ok) return "not_recorded";
    const answer = (await response.json()) as { recorded?: unknown };
    return answer.recorded === true ? "recorded" : "not_recorded";
  } catch {
    // The server was not reached, or answered something else: dropped, and not an error of the page.
    return "not_recorded";
  }
}

/** Watches the window for errors nothing handled. Returns the function that stops watching. */
export function installPageErrorReporting(target: Window = window): () => void {
  const onError = (event: ErrorEvent): void => {
    void reportPageError("error", event.error);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    void reportPageError("unhandledrejection", event.reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/** Test seam: a fresh page load. */
export function resetPageErrorReportingForTests(): void {
  sent = 0;
  reporting = false;
  currentPane = "none";
}
