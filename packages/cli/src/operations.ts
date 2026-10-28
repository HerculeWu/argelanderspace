/**
 * CLI subcommands derived from the operation catalog (ADR 0015; release-0.2 ticket 01;
 * `docs/operation-catalog.md`):
 *
 *   argelanderspace <domain> <operation-name> [--<param> <value> ...] [--json <file|->] [--data-dir <dir>]
 *
 * `<operation-name>` is the catalog name with `_` as `-`; each parameter is an option (`refId` -> `--ref-id`);
 * `--json` supplies the whole parameter object instead. The output is the operation's result as JSON on stdout, the
 * same object the Copilot tool returns. Exit codes: 0 the result is ok/noop (or a read), 1 the operation answered
 * `ok: false` or failed, 2 the parameters were not valid (nothing was run).
 *
 * Only the catalog's operations are registered here; the older commands (`ingest`, `library build`, `annot`, ...) are
 * not in the catalog and are not touched. This ticket runs in the CLI's own process; routing to a running workbench
 * is ticket 02.
 */
import { readFileSync } from "node:fs";
import {
  type OperationDef,
  type OperationId,
  type OperationOption,
  operationCliName,
  operationDomains,
  operationOptions,
  operationsOfDomain,
} from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import { createLocalOperationRuntime, runCatalogOperation } from "@argelanderspace/server";
import type { Command } from "commander";
import { fail, resolveDataDir, withDataDir } from "./common.js";

class ParamError extends Error {}

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
    const parsed = op.params.safeParse(params);
    if (!parsed.success)
      throw new ParamError(
        parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "(parameters)"}: ${issue.message}`)
          .join("; ")
      );
    params = parsed.data as Record<string, unknown>;
  } catch (e) {
    if (!(e instanceof ParamError)) throw e;
    printResult({ ok: false, status: "unsupported", detail: e.message });
    process.exitCode = 2;
    return;
  }
  const runtime = createLocalOperationRuntime(libraryPaths(resolveDataDir(opts)));
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

function registerOperation(group: Command, op: OperationDef): void {
  const command = withDataDir(group.command(operationCliName(op.name))).description(op.summary);
  for (const option of operationOptions(op)) {
    const value =
      option.kind === "boolean"
        ? ""
        : ` <${option.kind === "enum" ? option.choices?.join("|") : option.kind}>`;
    const required = option.required ? " (required)" : "";
    command.option(`${option.flag}${value}`, `parameter ${option.param}${required}`);
  }
  command.option(
    "--json <file|->",
    "parameters as a JSON object from a file or stdin, instead of options"
  );
  command.action(async (_opts: unknown, cmd: Command) => {
    await runOperationCommand(op, cmd);
  });
}

/** Add the catalog's subcommands. A domain whose group already exists (`library`) gains them next to its old ones. */
export function registerOperationCommands(program: Command): void {
  for (const domain of operationDomains()) {
    const group =
      program.commands.find((c) => c.name() === domain) ??
      program.command(domain).description(`${domain} operations`);
    for (const op of operationsOfDomain(domain)) registerOperation(group, op);
  }
}
