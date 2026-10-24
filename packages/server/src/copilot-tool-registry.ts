/**
 * The Copilot's tool registry (architecture-deepening ticket 06): one table of the tools a run can be given. Each
 * entry says when the tool is offered (its gate, read from the workbench and the run's mail mount decision, and the
 * tools it requires), which fields of the run's one shared host context it gets, which paragraph of the base
 * instruction it switches on, and how its own context is built. Everything that used to be listed tool by tool in
 * the host is derived from here: the session's `tools` and `customTools` (and the list Pi's active tools are checked
 * against), the footprint's measured tool set, the closed tool-name enum of `copilot.tool_called`, and the prompt
 * switches handed to the resource loader. Adding a tool is one entry here plus the tool's own file.
 *
 * The registry only registers and assembles: operation ids, the journal's three states and the confirmation flow
 * stay in `copilot-tool-kit` (`runOperation` / `askUser`); the shared context's `confirm` and `journal` are passed
 * through untouched.
 */
import {
  type CopilotViewAction,
  FILE_TOOL_NAMES,
  type FileToolAllowClass,
  type PageContext,
} from "@argelanderspace/contracts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FilePromptContext, Workbench } from "./copilot.js";
import { ARGUMENT_TOOL_NAME, createArgumentTool } from "./copilot-argument-tool.js";
import { createFileTools, type FileToolsContext } from "./copilot-file-tools.js";
import { createLibraryTool, LIBRARY_TOOL_NAME } from "./copilot-library-tool.js";
import { createMailTool, MAIL_TOOL_NAME } from "./copilot-mail-tool.js";
import { createPlanTool, PLAN_TOOL_NAME, type PlanToolContext } from "./copilot-plan-tool.js";
import { createReaderTool, READER_TOOL_NAME } from "./copilot-reader-tool.js";
import type { ApplicationResourceLoader } from "./copilot-resources.js";
import { createShelfTool, SHELF_TOOL_NAME } from "./copilot-shelf-tool.js";
import { createTextTool, TEXT_TOOL_NAME, type TextToolContext } from "./copilot-text-tool.js";
import type { ToolHostContext } from "./copilot-tool-kit.js";
import {
  createWorkspaceTool,
  type ViewActionOutcome,
  WORKSPACE_TOOL_NAME,
  type WorkspaceToolContext,
} from "./copilot-workspace-tool.js";
import { createWriterTool, WRITER_TOOL_NAME } from "./copilot-writer-tool.js";
import type { TaskUndoRegistry } from "./plans-undo.js";

/** What decides which tools a run has: the workbench, and whether Mail is mounted for this run (decided at its start). */
export interface ToolGates {
  workbench: Workbench | undefined;
  mailMount: "on" | "off" | "unavailable";
}
/** The optional paragraphs of the base instruction (`basePrompt`). */
export type PromptSwitch = "writer" | "text" | "mail" | "argument";
export type PromptSwitches = Record<PromptSwitch, boolean>;
/**
 * Which fields of the shared host context a tool gets: all five, `admitting` only (workspace and reader, which
 * neither journal, track nor confirm), or `admitting` / `track` / `confirm` (the file tools: never a journal).
 */
export type HostShare = "full" | "admitting" | "file";

/**
 * The run's own dependencies, implemented by the host once per run. Each tool's entry picks what it needs; nothing
 * here is shared state, and nothing here reaches around a business seam of the workbench.
 */
export interface RunToolDeps {
  conversationId: string;
  /** Navigation of this run: carries the run id, so a Stop cancels its wait. */
  viewAction(
    action: CopilotViewAction,
    options?: { reportMs?: number }
  ): Promise<ViewActionOutcome>;
  /** State sync after a committed write, not navigation: no run id, so a later Stop does not cancel it. */
  shellSync(action: CopilotViewAction): void;
  /** The page the run's navigation view shows now. */
  page(): PageContext | undefined;
  providerStatus: WorkspaceToolContext["providerStatus"];
  selectModel: WorkspaceToolContext["selectModel"];
  /** Whether the model the run started with takes images. */
  modelAcceptsImages(): boolean;
  /** The room left in the model's window. */
  budget(): number;
  /** Take earlier readings out of the conversation, then the room left. */
  reclaim(): number;
  imageBytesUsed(): number;
  taskUndo: TaskUndoRegistry;
  taskDeleted: NonNullable<PlanToolContext["taskDeleted"]>;
  sourceCoverage: NonNullable<TextToolContext["sourceCoverage"]>;
  /** The model wrote this revision of an argument graph (it learns it from the tool result). */
  wrote(workId: string, rev: number): void;
  /** The conversation's standing "allow for this session", read-only: only a real click sets it (`decide`). */
  fileAllow(kind: FileToolAllowClass): boolean;
  fileLifecycle: NonNullable<FileToolsContext["lifecycle"]>;
}
/** What an entry's context may read besides the shared host context and the run's dependencies. */
export interface RunScope {
  /** The workbench the run started with (an entry is only built when its gate held on it). */
  workbench: Workbench;
  /** The run's one resource loader (the text tool's instructions come from it). */
  loader: ApplicationResourceLoader;
}

export interface ToolEntry<C> {
  /** The entry's id: a business tool's name; `files` for the file and command tools. `requires` names these. */
  readonly id: string;
  /** Every name this entry can register under (the file tools: all of the contracts' names, `powershell` too). */
  readonly names: readonly string[];
  /** Whether the run is offered this entry, on its own terms. */
  readonly gate: (g: ToolGates) => boolean;
  /** Entries that must be offered too (earlier in the table). */
  readonly requires: readonly string[];
  readonly host: HostShare;
  /** The paragraph of the base instruction that describes this tool. */
  readonly prompt?: PromptSwitch;
  /** The tool's full context: the projected shared fields, plus its own dependencies written out here. */
  readonly context: (host: ToolHostContext, deps: RunToolDeps, run: RunScope) => C;
  /** The tools this entry registers for one run, under exactly these names. */
  readonly create: (context: C) => { names: readonly string[]; tools: ToolDefinition[] };
}
// biome-ignore lint/suspicious/noExplicitAny: one table holds entries of different context types
type AnyToolEntry = ToolEntry<any>;

const one = (name: string, tool: ToolDefinition) => ({ names: [name], tools: [tool] });

/** Library actions that wait for one ADS request (similar, then useful): far longer than a click. */
const SLOW_VIEW_ACTIONS: ReadonlySet<string> = new Set([
  "explore_work",
  "explore_candidate",
  "retry_exploration",
]);
const EXPLORE_REPORT_MS = 120_000;
/** Reader navigation may first open a Doc, which has to load before the Reader can jump. */
const READER_REPORT_MS = 30_000;
const FILES = "files";

/** The tools a run can be given, in the order they are registered. */
export const TOOL_TABLE: readonly AnyToolEntry[] = Object.freeze([
  {
    id: PLAN_TOOL_NAME,
    names: [PLAN_TOOL_NAME],
    gate: (g) => !!g.workbench,
    requires: [],
    host: "full",
    context: (host, deps, { workbench }) => ({
      ...host,
      plans: workbench.plans,
      viewAction: (action) => deps.viewAction(action),
      taskUndo: deps.taskUndo,
      conversationId: deps.conversationId,
      taskDeleted: deps.taskDeleted,
    }),
    create: (context) => one(PLAN_TOOL_NAME, createPlanTool(context)),
  } satisfies ToolEntry<Parameters<typeof createPlanTool>[0]>,
  {
    id: WORKSPACE_TOOL_NAME,
    names: [WORKSPACE_TOOL_NAME],
    gate: (g) => !!g.workbench,
    requires: [],
    host: "admitting",
    context: (host, deps) => ({
      ...host,
      page: deps.page,
      providerStatus: deps.providerStatus,
      selectModel: deps.selectModel,
      viewAction: (action) => deps.viewAction(action),
    }),
    create: (context) => one(WORKSPACE_TOOL_NAME, createWorkspaceTool(context)),
  } satisfies ToolEntry<Parameters<typeof createWorkspaceTool>[0]>,
  {
    id: LIBRARY_TOOL_NAME,
    names: [LIBRARY_TOOL_NAME],
    gate: (g) => !!g.workbench?.library,
    requires: [PLAN_TOOL_NAME],
    host: "full",
    context: (host, deps, { workbench }) => ({
      ...host,
      library: workbench.library as NonNullable<Workbench["library"]>,
      // An explore action waits for one ADS request (similar, then useful): far longer than a click.
      viewAction: (action) =>
        deps.viewAction(
          action,
          SLOW_VIEW_ACTIONS.has(action.action) ? { reportMs: EXPLORE_REPORT_MS } : {}
        ),
      page: deps.page,
      // State sync after a delete or a candidate save, not navigation: no runId, so a later Stop does not cancel it.
      shellSync: (action) => deps.shellSync(action),
    }),
    create: (context) => one(LIBRARY_TOOL_NAME, createLibraryTool(context)),
  } satisfies ToolEntry<Parameters<typeof createLibraryTool>[0]>,
  {
    id: READER_TOOL_NAME,
    names: [READER_TOOL_NAME],
    gate: (g) => !!g.workbench?.reader,
    requires: [PLAN_TOOL_NAME],
    host: "admitting",
    context: (host, deps, { workbench }) => ({
      ...host,
      reader: workbench.reader as NonNullable<Workbench["reader"]>,
      conversationId: deps.conversationId,
      viewAction: (action) =>
        deps.viewAction(action, action.action === "navigate" ? { reportMs: READER_REPORT_MS } : {}),
      modelAcceptsImages: deps.modelAcceptsImages,
      page: deps.page,
      budget: deps.budget,
      reclaim: deps.reclaim,
      imageBytesUsed: deps.imageBytesUsed,
    }),
    create: (context) => one(READER_TOOL_NAME, createReaderTool(context)),
  } satisfies ToolEntry<Parameters<typeof createReaderTool>[0]>,
  {
    id: WRITER_TOOL_NAME,
    names: [WRITER_TOOL_NAME],
    gate: (g) => !!g.workbench?.writer,
    requires: [PLAN_TOOL_NAME],
    host: "full",
    prompt: "writer",
    context: (host, deps, { workbench }) => ({
      ...host,
      writer: workbench.writer as NonNullable<Workbench["writer"]>,
      viewAction: (action) => deps.viewAction(action),
      budget: deps.budget,
    }),
    create: (context) => one(WRITER_TOOL_NAME, createWriterTool(context)),
  } satisfies ToolEntry<Parameters<typeof createWriterTool>[0]>,
  {
    id: TEXT_TOOL_NAME,
    names: [TEXT_TOOL_NAME],
    gate: (g) => !!g.workbench?.text,
    requires: [PLAN_TOOL_NAME],
    host: "full",
    prompt: "text",
    context: (host, deps, { workbench, loader }) => ({
      ...host,
      text: workbench.text as NonNullable<Workbench["text"]>,
      instruction: (name) => loader.getInstruction(name),
      instructionNames: () => loader.instructionNames(),
      sourceCoverage: deps.sourceCoverage,
      page: deps.page,
      viewAction: (action) => deps.viewAction(action),
      budget: deps.budget,
      reclaim: deps.reclaim,
    }),
    create: (context) => one(TEXT_TOOL_NAME, createTextTool(context)),
  } satisfies ToolEntry<Parameters<typeof createTextTool>[0]>,
  {
    id: MAIL_TOOL_NAME,
    names: [MAIL_TOOL_NAME],
    // Mounted only while an account exists, decided when the run starts (never in the middle of one).
    gate: (g) => g.mailMount === "on" && !!g.workbench?.mail,
    requires: [PLAN_TOOL_NAME],
    host: "full",
    prompt: "mail",
    context: (host, deps, { workbench }) => ({
      ...host,
      mail: workbench.mail as NonNullable<Workbench["mail"]>,
      modelAcceptsImages: deps.modelAcceptsImages,
      budget: deps.budget,
      imageBytesUsed: deps.imageBytesUsed,
    }),
    create: (context) => one(MAIL_TOOL_NAME, createMailTool(context)),
  } satisfies ToolEntry<Parameters<typeof createMailTool>[0]>,
  {
    id: ARGUMENT_TOOL_NAME,
    names: [ARGUMENT_TOOL_NAME],
    gate: (g) => !!g.workbench?.argument,
    requires: [PLAN_TOOL_NAME],
    host: "full",
    prompt: "argument",
    context: (host, deps, { workbench }) => ({
      ...host,
      argument: workbench.argument as NonNullable<Workbench["argument"]>,
      viewAction: (action) => deps.viewAction(action),
      budget: deps.budget,
      // The model learns what it wrote from the tool result: the page showing that revision is an outline.
      wrote: deps.wrote,
    }),
    create: (context) => one(ARGUMENT_TOOL_NAME, createArgumentTool(context)),
  } satisfies ToolEntry<Parameters<typeof createArgumentTool>[0]>,
  {
    id: SHELF_TOOL_NAME,
    names: [SHELF_TOOL_NAME],
    gate: (g) => !!g.workbench?.shelf,
    requires: [PLAN_TOOL_NAME],
    host: "full",
    context: (host, _deps, { workbench }) => ({
      ...host,
      shelf: workbench.shelf as NonNullable<Workbench["shelf"]>,
    }),
    create: (context) => one(SHELF_TOOL_NAME, createShelfTool(context)),
  } satisfies ToolEntry<Parameters<typeof createShelfTool>[0]>,
  {
    id: FILES,
    names: FILE_TOOL_NAMES,
    gate: (g) => !!g.workbench?.fileTools,
    requires: [PLAN_TOOL_NAME, WORKSPACE_TOOL_NAME],
    host: "file",
    context: (host, deps, { workbench }) => {
      const config = workbench.fileTools as NonNullable<Workbench["fileTools"]>;
      return {
        ...host,
        cwd: config.cwd,
        permission: config.permission,
        protectedFolders: config.protectedFolders,
        ...(config.platform ? { platform: config.platform } : {}),
        // Read-only here: only a real view's click on a card sets the standing allowance (`decide`).
        allowed: deps.fileAllow,
        lifecycle: deps.fileLifecycle,
      };
    },
    // The names come from the tools built for this run (the permission as read now, and the platform), never a list.
    create: (context) => createFileTools(context),
  } satisfies ToolEntry<FileToolsContext>,
]);

/**
 * The tools a run can be given, every name any run can register (the file tools' part is the contracts' full set,
 * `powershell` included): the closed enum of `copilot.tool_called`, never one session's list.
 */
export const COPILOT_TOOL_NAMES: readonly string[] = Object.freeze([
  ...TOOL_TABLE.filter((entry) => entry.id === FILES).flatMap((entry) => entry.names),
  ...TOOL_TABLE.filter((entry) => entry.id !== FILES).flatMap((entry) => entry.names),
]);

/** The entries a run is offered, in table order: its gate holds and every entry it requires is offered. */
function selected(g: ToolGates): AnyToolEntry[] {
  const offered: AnyToolEntry[] = [];
  for (const entry of TOOL_TABLE)
    if (entry.gate(g) && entry.requires.every((id) => offered.some((o) => o.id === id)))
      offered.push(entry);
  return offered;
}

/**
 * Which paragraphs the base instruction carries. Writer, text and argument follow their capability; the Mail
 * sentences follow the run's mount decision, which is "on" only while the workbench has Mail and an account exists
 * (`mailMountState`). The session and the footprint both take theirs from here.
 */
export function promptSwitches(g: ToolGates): PromptSwitches {
  return {
    writer: !!g.workbench?.writer,
    text: !!g.workbench?.text,
    mail: g.mailMount === "on",
    argument: !!g.workbench?.argument,
  };
}

/** The shared fields a tool gets (see {@link HostShare}). */
function share(host: ToolHostContext, kind: HostShare): ToolHostContext {
  if (kind === "admitting") return { admitting: host.admitting };
  if (kind === "file")
    return {
      admitting: host.admitting,
      ...(host.track ? { track: host.track } : {}),
      ...(host.confirm ? { confirm: host.confirm } : {}),
    };
  return { ...host };
}
/** One entry's full context for this run: its share of the host context and its own dependencies. */
export function contextOf(
  entry: AnyToolEntry,
  host: ToolHostContext,
  deps: RunToolDeps,
  run: RunScope
): unknown {
  return entry.context(share(host, entry.host), deps, run);
}

/**
 * The business tools' schemas exactly as a run with these gates registers them (the file tools are measured apart,
 * {@link fileFootprintTools}); the closures are never called. A factory that throws (one that would need its
 * dependencies at creation) stops the measure there: what was built still counts, and `threw` tells the host to add
 * its generous allowance.
 */
export function footprintTools(g: ToolGates): { tools: ToolDefinition[]; threw: boolean } {
  const tools: ToolDefinition[] = [];
  try {
    for (const entry of selected(g))
      if (entry.id !== FILES) tools.push(...entry.create({} as never).tools);
  } catch {
    return { tools, threw: true };
  }
  return { tools, threw: false };
}
/** The file and command tools' schemas as an asking run is given them (the stub's closures are never called). */
export function fileFootprintTools(config: NonNullable<Workbench["fileTools"]>): ToolDefinition[] {
  return createFileTools({
    cwd: config.cwd,
    permission: () => "ask",
    protectedFolders: () => [],
    allowed: () => false,
    admitting: () => true,
    ...(config.platform ? { platform: config.platform } : {}),
  }).tools;
}

export interface RunTools {
  resourceLoader: ApplicationResourceLoader;
  /** What the session must report as its active tools (and all its tools). */
  toolNames: string[];
  session:
    | { tools: string[]; customTools: ToolDefinition[] }
    | { tools: []; customTools: []; noTools: "all" };
}
/**
 * Everything one run is given. First the entries are chosen (gates only), then the one resource loader is made with
 * the prompt switches, then each chosen entry is built in table order — so the text tool, which reads its
 * instructions from the loader, always comes after it. The file tools' closing paragraph is worked out once, when the
 * session first asks for the instruction, from the file tools this run really has.
 */
export function assembleRunTools(input: {
  gates: ToolGates;
  host: ToolHostContext;
  deps: RunToolDeps;
  loader: (
    switches: PromptSwitches,
    files: () => FilePromptContext | undefined
  ) => ApplicationResourceLoader;
  /** Whether the bundled skills folder holds any skill (read only when the paragraph is first asked for). */
  hasSkills: () => boolean;
}): RunTools {
  const { gates, host, deps } = input;
  const workbench = gates.workbench;
  const chosen = selected(gates);
  // The instruction the model gets is built from the tools this session really has (`fileTools`, built below, whose
  // list is fixed from the permission as read then): worked out once, when the session first asks for it, and kept
  // for the whole run. A setting changed later takes effect with the next run, as for the tools themselves; each call
  // still reads the setting (copilot ticket 57).
  let fileTools: { names: readonly string[] } | undefined;
  let promptFiles: { value: FilePromptContext | undefined } | undefined;
  const filePromptOf = (): FilePromptContext | undefined => {
    if (promptFiles) return promptFiles.value;
    let value: FilePromptContext | undefined;
    if (workbench?.fileTools && fileTools) {
      const permission = fileTools.names.length === 0 ? "off" : workbench.fileTools.permission();
      value = {
        permission: permission === "off" && fileTools.names.length > 0 ? "ask" : permission,
        cwd: workbench.fileTools.cwd,
        shell:
          (workbench.fileTools.platform ?? process.platform) === "win32" ? "powershell" : "bash",
        skills: fileTools.names.length > 0 && input.hasSkills(),
      };
    }
    promptFiles = { value };
    return value;
  };
  // The ONE application resource loader of this session: the base instruction and the instructions that are loaded on
  // demand come from it and nowhere else (the same object builds the session and answers `load_instruction`).
  const resourceLoader = input.loader(promptSwitches(gates), filePromptOf);
  // No workbench, no plan and workspace tools: the session is given no tools at all.
  const offered = (id: string) => chosen.some((entry) => entry.id === id);
  if (!workbench || !offered(PLAN_TOOL_NAME) || !offered(WORKSPACE_TOOL_NAME))
    return {
      resourceLoader,
      toolNames: [],
      session: { tools: [], customTools: [], noTools: "all" },
    };
  const run: RunScope = { workbench, loader: resourceLoader };
  const toolNames: string[] = [];
  const customTools: ToolDefinition[] = [];
  for (const entry of chosen) {
    const built = entry.create(contextOf(entry, host, deps, run));
    if (entry.id === FILES) fileTools = built;
    toolNames.push(...built.names);
    customTools.push(...built.tools);
  }
  return { resourceLoader, toolNames, session: { tools: toolNames, customTools } };
}
