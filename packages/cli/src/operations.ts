/**
 * CLI subcommands derived from the operation catalog (ADR 0015; release-0.2 ticket 01;
 * `docs/operation-catalog.md`):
 *
 *   argelanderspace <domain> <operation-name> [--<param> <value> ...] [--json <file|->] [--data-dir <dir>]
 *
 * `<operation-name>` is the catalog name with `_` as `-`; each parameter is an option (`refId` -> `--ref-id`);
 * `--json` supplies the whole parameter object instead. The output is the operation's result as JSON on stdout, the
 * same object the Copilot tool returns. Exit codes: 0 the result is ok/noop (or a read), 1 the operation answered
 * `ok: false` or failed, 2 the parameters were not valid (nothing was run), 3 the user denied the confirmation card
 * (`status: "denied"`), 4 an operation waiting for a confirmation card was interrupted (the workbench exited or
 * stopped answering), 130 this command was interrupted (Ctrl-C) and withdrew its card. An operation with
 * `confirm: "card"` and every navigation operation (`argelanderspace open doc|work|argument-graph`, ticket 05) need
 * a running workbench: without one the command answers `workbench_required` (exit 1) and runs nothing in this process. A
 * `confirm: "conditional"` operation (replacing or clearing an argument graph that has arguments, ticket 08) runs in this
 * process when it needs no card and decides itself to answer `workbench_required` when it does. Exit codes are listed in `docs/operation-catalog.md`.
 *
 * Only the catalog's operations are registered here; the older commands (`ingest`, `library build`, `annot`, ...) are
 * not in the catalog and are not touched. A command first looks for a workbench running for the data directory and, if
 * there is one, hands the operation to it over local HTTP (server `workbench-instance.ts`, `operation-routes.ts`);
 * otherwise it runs in this process. Both give the same output and exit codes.
 */
import { readFileSync } from "node:fs";
import {
  type OperationDef,
  type OperationId,
  type OperationOption,
  operationCliGroups,
  operationCliName,
  operationJsonOnlyParams,
  operationOptions,
  operationsOfCliGroup,
} from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import {
  createLocalOperationRuntime,
  findRunningWorkbench,
  parseOperationParams,
  runCatalogOperation,
  runOnWorkbench,
} from "@argelanderspace/server";
import type { Command } from "commander";
import { fail, resolveDataDir, withDataDir } from "./common.js";

class ParamError extends Error {}

/** Exit codes beyond 0/1/2 (documented in `docs/operation-catalog.md`). */
export const EXIT_DENIED = 3;
export const EXIT_INTERRUPTED = 4;
export const EXIT_SIGINT = 130;

function optionValue(option: OperationOption, raw: string | boolean): unknown {
  if (option.kind === "boolean") return raw === true || raw === "true";
  const text = String(raw);
  if (option.nullable && text === "null") return null;
  if (option.kind === "integer" || option.kind === "number") {
    const value = Number(text);
    if (
      text.trim() === "" ||
      !Number.isFinite(value) ||
      (option.kind === "integer" && !Number.isInteger(value))
    )
      throw new ParamError(
        `${option.flag} must be ${option.kind === "integer" ? "an integer" : "a number"}`
      );
    return value;
  }
  return text;
}

function readJsonParams(source: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(source === "-" ? 0 : source, "utf8");
  } catch {
    throw new ParamError(`--json: cannot read ${source === "-" ? "standard input" : source}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ParamError("--json: not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ParamError("--json: expected a JSON object of parameters");
  return value as Record<string, unknown>;
}

function paramsFromOptions(
  options: readonly OperationOption[],
  opts: Record<string, unknown>
): Record<string, unknown> {
  const jsonSource = opts.json as string | undefined;
  const given = options.filter((option) => opts[option.param] !== undefined);
  if (jsonSource !== undefined) {
    if (given.length > 0)
      throw new ParamError(`--json cannot be combined with ${given.map((o) => o.flag).join(" ")}`);
    return readJsonParams(jsonSource);
  }
  const params: Record<string, unknown> = {};
  for (const option of given)
    params[option.param] = optionValue(option, opts[option.param] as string | boolean);
  return params;
}

function printResult(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

async function runOperationCommand(op: OperationDef, cmd: Command): Promise<void> {
  const opts = cmd.optsWithGlobals() as Record<string, unknown>;
  let params: Record<string, unknown>;
  try {
    params = paramsFromOptions(operationOptions(op), opts);
    const parsed = parseOperationParams(op, params);
    if (!parsed.ok) throw new ParamError(parsed.detail);
    params = parsed.params;
  } catch (e) {
    if (!(e instanceof ParamError)) throw e;
    printResult({ ok: false, status: "unsupported", detail: e.message });
    process.exitCode = 2;
    return;
  }
  const dataDir = resolveDataDir(opts);
  // Single writer (ADR 0015): a workbench running for this data directory takes the operation, reads included, so the
  // answer is its current state and its writes are announced to the open pages. Otherwise it runs in this process.
  let workbench: Awaited<ReturnType<typeof findRunningWorkbench>>;
  try {
    workbench = await findRunningWorkbench(dataDir);
  } catch (e) {
    fail(e);
    return;
  }
  if (workbench !== null) {
    await runViaWorkbench(workbench, op, params);
    return;
  }
  // The card is the real user's confirmation: with no workbench to show it nothing is asked and nothing runs here.
  if (op.confirm === "card") {
    printResult({
      ok: false,
      status: "workbench_required",
      detail: `${op.id} needs your confirmation on a card in the workbench, and no workbench is running for this data directory; open ArgelanderSpace on this project first. Nothing was done`,
    });
    process.exitCode = 1;
    return;
  }
  const runtime = createLocalOperationRuntime(libraryPaths(dataDir));
  let result: unknown;
  try {
    result = await runCatalogOperation(runtime, op.id as OperationId, params);
  } catch (e) {
    fail(e);
    return;
  }
  printResult(result);
  if ((result as { ok?: boolean } | null)?.ok === false) process.exitCode = 1;
}

/** The workbench's answer, in the same shape and with the same exit codes as the in-process run. */
async function runViaWorkbench(
  workbench: NonNullable<Awaited<ReturnType<typeof findRunningWorkbench>>>,
  op: OperationDef,
  params: Record<string, unknown>
): Promise<void> {
  let answer: Awaited<ReturnType<typeof runOnWorkbench>>;
  // A command that waits for a confirmation card is interrupted from the terminal: the request is aborted, which
  // withdraws the card in the workbench.
  const waits = op.confirm !== "none";
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    controller.abort();
  };
  if (waits) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  try {
    answer = await runOnWorkbench(
      workbench,
      {
        id: op.id,
        params,
        client: {
          pid: process.pid,
          commandLine: ["argelanderspace", ...process.argv.slice(2)].join(" "),
        },
      },
      waits ? controller.signal : undefined
    );
  } catch {
    if (interrupted) {
      console.error("error: interrupted; the request was withdrawn and nothing was done");
      process.exitCode = EXIT_SIGINT;
    } else if (waits) {
      console.error(
        `error: interrupted; the workbench (port ${workbench.port}) stopped answering before the request was decided. Nothing was done unless you had just approved it; read the object to check`
      );
      process.exitCode = EXIT_INTERRUPTED;
    } else {
      fail(
        new Error(
          `the workbench (port ${workbench.port}) stopped answering; the operation may or may not have run`
        )
      );
    }
    return;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const body = answer.body as { ok?: boolean; status?: string; detail?: string } | null;
  if (answer.status === 200) {
    printResult(body);
    if (body?.ok === false) process.exitCode = body.status === "denied" ? EXIT_DENIED : 1;
  } else if (answer.status === 400) {
    printResult(body);
    process.exitCode = 2;
  } else {
    fail(new Error(body?.detail ?? `the workbench refused the operation (HTTP ${answer.status})`));
  }
}

function registerOperation(group: Command, op: OperationDef): void {
  const command = withDataDir(group.command(op.cli?.name ?? operationCliName(op.name))).description(
    op.summary
  );
  for (const option of operationOptions(op)) {
    const value =
      option.kind === "boolean"
        ? ""
        : ` <${option.kind === "enum" ? option.choices?.join("|") : option.kind}>`;
    const required = option.required ? " (required)" : "";
    command.option(`${option.flag}${value}`, `parameter ${option.param}${required}`);
  }
  // Array and object parameters have no option of their own (argument operations, ticket 08): only --json carries them.
  const jsonOnly = operationJsonOnlyParams(op);
  command.option(
    "--json <file|->",
    jsonOnly.length > 0
      ? `parameters as a JSON object from a file or stdin, instead of options (the only way to give ${jsonOnly.join(", ")})`
      : "parameters as a JSON object from a file or stdin, instead of options"
  );
  command.action(async (_opts: unknown, cmd: Command) => {
    await runOperationCommand(op, cmd);
  });
}

/** What `--help` says of a group whose name is not a domain (navigation, ticket 05). */
const GROUP_DESCRIPTIONS: Record<string, string> = {
  open: "ask the running workbench to show a place in its most recently active window",
};

/**
 * Add the catalog's subcommands. A group that already exists (`library`) gains them next to its old ones. The group of an
 * entry is its `cli.group` when it has one (`open`), else its domain.
 */
export function registerOperationCommands(program: Command): void {
  for (const name of operationCliGroups()) {
    const group =
      program.commands.find((c) => c.name() === name) ??
      program.command(name).description(GROUP_DESCRIPTIONS[name] ?? `${name} operations`);
    for (const op of operationsOfCliGroup(name)) registerOperation(group, op);
  }
}
