import type { ConfirmationKind } from "./kind.js";

/** One shell command of the Copilot's bash/powershell tool (copilot ticket 57). Nothing on disk to recheck. */
export const runCommandKind: ConfirmationKind<"run_command"> = {
  action: "run_command",
  card: (id, runId, entry) => ({
    id,
    runId,
    toolCallId: entry.toolCallId,
    baseRev: entry.baseRev,
    action: entry.action,
    object: { kind: "command", id: entry.toolCallId },
    shell: entry.shell,
    command: entry.command,
    cwd: entry.cwd,
  }),
  // The record keeps neither the command nor a path: those are shown on the card and in the tool's own call.
  requestedFields: (entry) => ({ action: entry.action }),
  resolvedFields: (card) => ({ action: card.action }),
  askedLine: (entry) => entry.action,
  check: () => Promise.resolve("valid"),
  revalidateOn: null,
  boundToNavView: false,
  remembers: "command",
};

/** One edit of a file. */
export const editFileKind: ConfirmationKind<"edit_file"> = {
  action: "edit_file",
  card: (id, runId, entry) => ({
    id,
    runId,
    toolCallId: entry.toolCallId,
    baseRev: entry.baseRev,
    action: entry.action,
    object: { kind: "file", id: entry.toolCallId },
    cwd: entry.cwd,
    path: entry.path,
    resolved: entry.resolved,
    change: entry.change,
  }),
  requestedFields: (entry) => ({ action: entry.action }),
  resolvedFields: (card) => ({ action: card.action }),
  askedLine: (entry) => entry.action,
  check: () => Promise.resolve("valid"),
  revalidateOn: null,
  boundToNavView: false,
  remembers: "write",
};

/** Creating or overwriting a file. */
export const writeFileKind: ConfirmationKind<"write_file"> = {
  action: "write_file",
  card: (id, runId, entry) => ({
    id,
    runId,
    toolCallId: entry.toolCallId,
    baseRev: entry.baseRev,
    action: entry.action,
    object: { kind: "file", id: entry.toolCallId },
    cwd: entry.cwd,
    path: entry.path,
    resolved: entry.resolved,
    change: entry.change,
  }),
  requestedFields: (entry) => ({ action: entry.action }),
  resolvedFields: (card) => ({ action: card.action }),
  askedLine: (entry) => entry.action,
  check: () => Promise.resolve("valid"),
  revalidateOn: null,
  boundToNavView: false,
  remembers: "write",
};
