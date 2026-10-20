import type { ConfirmationKind } from "./kind.js";

/** One shell command of the Copilot's bash/powershell tool (copilot ticket 57). Nothing on disk to recheck. */
export const runCommandKind = {
  action: "run_command",
  // The tool call is the object: a command names nothing else.
  object: (entry) => ({ kind: "command", id: entry.toolCallId }),
  // The record keeps neither the command nor a path: those are shown on the card and in the tool's own call.
  record: (card) => ({ action: card.action }),
  askedLine: (entry) => entry.action,
  check: () => Promise.resolve("valid"),
  revalidateOn: null,
  boundToNavView: false,
  remembers: "command",
} satisfies ConfirmationKind<"run_command">;

/** One edit of a file. */
export const editFileKind = {
  action: "edit_file",
  object: (entry) => ({ kind: "file", id: entry.toolCallId }),
  record: (card) => ({ action: card.action }),
  askedLine: (entry) => entry.action,
  check: () => Promise.resolve("valid"),
  revalidateOn: null,
  boundToNavView: false,
  remembers: "write",
} satisfies ConfirmationKind<"edit_file">;

/** Creating or overwriting a file. */
export const writeFileKind = {
  action: "write_file",
  object: (entry) => ({ kind: "file", id: entry.toolCallId }),
  record: (card) => ({ action: card.action }),
  askedLine: (entry) => entry.action,
  check: () => Promise.resolve("valid"),
  revalidateOn: null,
  boundToNavView: false,
  remembers: "write",
} satisfies ConfirmationKind<"write_file">;
