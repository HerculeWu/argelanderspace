/**
 * Copilot's file and command tools (copilot ticket 57, ADR 0011): what one call of read / grep / find / ls / bash
 * (powershell on Windows) / edit / write is, as the conversation shows it (the tool card) and as the real user is
 * asked about it (the confirmation card). Pure data; the commands and the file contents are conversation content,
 * so they live in the conversation record only and never in the user log.
 */
import { z } from "zod";

/** The names the tools are registered under (`powershell` instead of `bash` on Windows). */
export const FILE_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "powershell",
  "edit",
  "write",
] as const;
export type FileToolName = (typeof FILE_TOOL_NAMES)[number];

/** The three kinds of confirmation card these tools can raise. */
export const FILE_TOOL_CONFIRMATION_ACTIONS = ["run_command", "edit_file", "write_file"] as const;
export type FileToolConfirmationAction = (typeof FILE_TOOL_CONFIRMATION_ACTIONS)[number];

/** The two classes "allow for this session" is given for. */
export const FILE_TOOL_ALLOW_CLASSES = ["command", "write"] as const;
export type FileToolAllowClass = (typeof FILE_TOOL_ALLOW_CLASSES)[number];

/** Limits of what a record keeps; the full output goes to the model only. */
export const FILE_TOOL_LIMITS = {
  /** The longest command or path a confirmation card shows whole; a longer one is refused, never cut and then asked. */
  command: 20_000,
  path: 500,
  line: 500,
  /** The longest single line of a changed text the card shows whole (a .bib has long lines), and the most it shows in all. */
  cardLine: 100_000,
  changeTotal: 60_000,
  /** The most changed lines (old and new) a card shows; more is refused. */
  changeLines: 600,
  head: 40,
  tail: 20,
  diff: 2000,
  preview: 5,
} as const;

export const FileToolDiffLineSchema = z
  .object({
    k: z.enum(["add", "del", "ctx", "hunk"]),
    s: z.string().max(FILE_TOOL_LIMITS.cardLine),
  })
  .strict();
export type FileToolDiffLine = z.infer<typeof FileToolDiffLineSchema>;

/** What a write would do (confirmation card) or did (tool card). */
export const FileToolChangeSchema = z
  .object({
    /** `edit`: replacements, lines added/removed and lines left alone. */
    edits: z.number().int().nonnegative().optional(),
    added: z.number().int().nonnegative().optional(),
    removed: z.number().int().nonnegative().optional(),
    unchanged: z.number().int().nonnegative().optional(),
    /** `write`: the new content's size and lines; `oldBytes` when a file is overwritten. */
    bytes: z.number().int().nonnegative().optional(),
    oldBytes: z.number().int().nonnegative().optional(),
    lines: z.number().int().nonnegative().optional(),
    overwrite: z.boolean().optional(),
    diff: z.array(FileToolDiffLineSchema).max(FILE_TOOL_LIMITS.diff).optional(),
    /** The first lines of a written file, and how many more there are. */
    preview: z
      .array(z.string().max(FILE_TOOL_LIMITS.cardLine))
      .max(FILE_TOOL_LIMITS.preview)
      .optional(),
    previewMore: z.number().int().nonnegative().optional(),
    /** An edit of a file too big to read for the card: what is added and removed is shown, the lines around it are not. */
    contextOmitted: z.boolean().optional(),
  })
  .strict();
export type FileToolChange = z.infer<typeof FileToolChangeSchema>;

const ConfirmationBase = {
  id: z.string().uuid(),
  runId: z.string().uuid(),
  toolCallId: z.string().min(1),
  baseRev: z.number().int().nonnegative(),
};

/** Running one command (bash, or powershell on Windows). */
export const CopilotCommandConfirmationSchema = z
  .object({
    ...ConfirmationBase,
    action: z.literal("run_command"),
    object: z.object({ kind: z.literal("command"), id: z.string().min(1) }).strict(),
    shell: z.enum(["bash", "powershell"]),
    command: z.string().max(FILE_TOOL_LIMITS.command),
    cwd: z.string(),
  })
  .strict();
const fileCardFields = {
  ...ConfirmationBase,
  object: z.object({ kind: z.literal("file"), id: z.string().min(1) }).strict(),
  cwd: z.string(),
  /** As the model gave it (relative to `cwd` or absolute). */
  path: z.string(),
  /** Where it really lands: the absolute path with `~`, `..` and symbolic links resolved, as the page shows paths. */
  resolved: z.string(),
  change: FileToolChangeSchema,
};
/** One edit of a file (the diff it would make). */
export const CopilotEditFileConfirmationSchema = z
  .object({ ...fileCardFields, action: z.literal("edit_file") })
  .strict();
/** Creating or overwriting a file. */
export const CopilotWriteFileConfirmationSchema = z
  .object({ ...fileCardFields, action: z.literal("write_file") })
  .strict();
export type CopilotCommandConfirmation = z.infer<typeof CopilotCommandConfirmationSchema>;
export type CopilotEditFileConfirmation = z.infer<typeof CopilotEditFileConfirmationSchema>;
export type CopilotWriteFileConfirmation = z.infer<typeof CopilotWriteFileConfirmationSchema>;

/** How a call was allowed: this one call, the session's standing allowance for its class, or the automatic setting. */
export const FILE_TOOL_APPROVALS = ["once", "session", "auto"] as const;

/** The one-word result of a call that has no exit code. */
export const FileToolResultSchema = z
  .object({
    unit: z.enum(["lines", "matches", "files", "entries", "diff", "created", "overwritten"]),
    n: z.number().int().nonnegative().optional(),
    added: z.number().int().nonnegative().optional(),
    removed: z.number().int().nonnegative().optional(),
  })
  .strict();

/** The target of a refused write was inside the application's data. */
export const FileToolGuardSchema = z
  .object({
    /** The project data folder, the global data folder, the folder of config.toml, or the global cache folder. */
    inside: z.enum(["data_dir", "global_dir", "config_dir", "cache_dir", "tools_dir"]),
    /** A plain path, a symbolic link on the way, or `..` in the path. */
    via: z.enum(["direct", "symlink", "parent_ref"]),
    /** The folder it fell into and where the link led, as the page shows paths (home written `~`). */
    folder: z.string(),
    resolved: z.string(),
  })
  .strict();

/** The tool card of one call. Part of the operation row, so it is saved with the tool result. */
export const FileToolRecordSchema = z
  .object({
    kind: z.enum(["read", "grep", "find", "ls", "command", "edit", "write"]),
    shell: z.enum(["bash", "powershell"]).optional(),
    /** One line: the command's first line, the path, or pattern and folder. */
    target: z.string().max(FILE_TOOL_LIMITS.line),
    command: z.string().max(FILE_TOOL_LIMITS.command).optional(),
    cwd: z.string(),
    path: z.string().optional(),
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    /** While the call runs: when it started, so the card can count. */
    startedAt: z.string().optional(),
    approval: z.enum(FILE_TOOL_APPROVALS).optional(),
    result: FileToolResultSchema.optional(),
    output: z
      .object({
        head: z.array(z.string().max(FILE_TOOL_LIMITS.line)).max(FILE_TOOL_LIMITS.head),
        tail: z.array(z.string().max(FILE_TOOL_LIMITS.line)).max(FILE_TOOL_LIMITS.tail),
        omitted: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    change: FileToolChangeSchema.optional(),
    guard: FileToolGuardSchema.optional(),
    /** Why a call that is not a shell command failed (a missing file, a timeout), as the tool said it. */
    error: z.string().max(FILE_TOOL_LIMITS.line).optional(),
    /** The call ended before it ran (Stop while waiting for the user) rather than while it ran. */
    beforeRun: z.boolean().optional(),
  })
  .strict();
export type FileToolRecord = z.infer<typeof FileToolRecordSchema>;
