/**
 * The desktop shell's events (desktop-app ticket 20): the one table both the desktop host and the server's log catalog
 * read. The host writes a `shell_event` line from the shell by it (desktop-host.ts: the event must be here, and each
 * field goes through the constructor its entry names); the server's log catalog (log.ts) takes these events and their
 * fields from it rather than listing them again. It holds only the table and the lists it names, so both can import
 * it: the host imports the server, and the log catalog may not import the host.
 *
 * The Rust shell writes the same events, with the same fields, while no host runs (contracts 「Rust 侧不放业务逻辑；
 * 桌面壳不进四门」).
 */

import { HOST_REQUEST_KINDS } from "@argelanderspace/contracts";

const YES_NO = ["yes", "no"] as const;
const SIGNALS = [
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
  "SIGQUIT",
  "SIGABRT",
  "SIGSEGV",
  "SIGBUS",
  "SIGILL",
  "SIGFPE",
  "SIGPIPE",
  "other",
] as const;

/** How one field of a shell event is written: by one of the log's field constructors. */
export type ShellFieldKind = "id" | "num" | "ms" | readonly string[];
export interface ShellEventSpec {
  /** The level; `warn` instead when the field `warnWhen` names has its value (`shell.host_exited` not expected). */
  level: "info" | "warn";
  fields: Readonly<Record<string, ShellFieldKind>>;
  warnWhen?: { field: string; value: string };
}

/**
 * The shell's events (spec 「日志」: its start, the host's starts and exits with their exit codes, the answers to its
 * native dialogs) and how each field is written. A field of another name, or of the wrong type, is not written.
 */
export const SHELL_EVENTS = {
  "shell.started": { level: "info", fields: { version: "id", webview: "id" } },
  "shell.host_started": { level: "info", fields: { pid: "num", attempt: "num" } },
  "shell.host_exited": {
    level: "info",
    fields: { exit_code: "num", signal: SIGNALS, expected: YES_NO, duration_ms: "ms" },
    warnWhen: { field: "expected", value: "no" },
  },
  // Closing the crash dialog without a button is a quit (user ruling 3, desktop-app ticket 20): no answer of its own.
  "shell.dialog_answered": {
    level: "info",
    fields: { dialog: ["host_crashed"], choice: ["restart", "show_log_folder", "quit"] },
  },
  "shell.request_failed": { level: "warn", fields: { request: HOST_REQUEST_KINDS, code: "id" } },
  // The window could not be made (`create`) or Tauri's entry points could not be taken out of it (`guard`): the shell
  // does not load the page and ends as after a crash.
  "shell.window_failed": { level: "warn", fields: { stage: ["create", "guard"] } },
  // The page tried to go to an address other than the local page's origin: stopped (desktop-app ticket 21 hands such
  // addresses to the system browser).
  // Desktop-app ticket 21: an http(s) address goes to the system browser instead (`shell.link_opened`); what is stopped
  // is any other scheme, from a navigation of the window or a request for a new one (`source`).
  "shell.navigation_blocked": {
    level: "warn",
    fields: { scheme: ["http", "https", "other"], source: ["navigation", "new_window"] },
  },
  // Desktop-app ticket 21: a link of the page handed to the system browser (never its address).
  "shell.link_opened": {
    level: "info",
    fields: { source: ["navigation", "new_window"], outcome: ["opened", "open_failed"] },
  },
  // Desktop-app ticket 21: a download of the page, through the shell's save dialog (never the file's name or folder).
  "shell.download": {
    level: "info",
    fields: { outcome: ["saved", "cancelled", "failed"] },
    warnWhen: { field: "outcome", value: "failed" },
  },
  // Desktop-app ticket 21: an item of the shell's menu was chosen.
  "shell.menu_chosen": {
    level: "info",
    fields: {
      item: ["open_folder", "open_recent", "quit", "open_in_browser", "open_devtools", "about"],
    },
  },
  // A line from the host the shell could not read: longer than the limit, or not UTF-8. Dropped; reading goes on.
  "shell.line_rejected": { level: "warn", fields: { reason: ["too_long", "not_utf8"] } },
  // The shell runs without the single-instance guard: no socket to be had, or the socket's owner is another user.
  "shell.instance_unguarded": {
    level: "warn",
    fields: { reason: ["unavailable", "foreign_owner"] },
  },
} as const satisfies Record<string, ShellEventSpec>;
export type ShellEvent = keyof typeof SHELL_EVENTS;
