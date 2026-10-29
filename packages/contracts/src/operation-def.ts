/**
 * The shape of one entry of the operation catalog (ADR 0015, release-0.2 ticket 01) and the rules that derive the
 * Copilot tool call and the CLI subcommand from it. Entries live in `<domain>-catalog.ts`; `operation-catalog.ts`
 * lists them. Docs: `docs/operation-catalog.md` (the derivation rules are the authority there).
 *
 * Why metadata over the existing `*-ops.ts` schemas rather than a second registry that restates them: the zod
 * schemas of the Copilot actions are already the one definition of an action's parameters (and carry the comment
 * saying which page control it mirrors), so an entry only points at them and adds what they lack (domain, the
 * operation's own summary, effect, confirmation, navigation, result shape). A separate registry would be a second
 * place to keep parameters in step.
 */
import { z } from "zod";

/** `read`: leaves the Project as it was. `write`: changes Project data (ADR 0015's single-writer rule applies). */
export type OperationEffect = "read" | "write";
/**
 * `none`: runs at once. `card`: waits for the real user's confirmation card (Copilot) / the workbench (CLI), and with
 * no workbench the CLI refuses it without running anything. `conditional`: only some calls need the card (for example
 * `library.attach_arxiv` when it would replace an existing Doc's text, release-0.2 ticket 06, or `argument.replace` /
 * `clear` on a graph that has arguments, ticket 08); the handler decides, runs the calls that need none in either
 * place, and answers `workbench_required` itself for a call that needs a card where there is no workbench to show it.
 */
export type OperationConfirm = "none" | "card" | "conditional";

export interface OperationDef<
  Domain extends string = string,
  Name extends string = string,
  Params extends z.ZodObject = z.ZodObject,
  Result extends z.ZodType = z.ZodType,
> {
  /** The tool section and the CLI group: `library` is both the Copilot tool name and `argelanderspace library`. */
  readonly domain: Domain;
  /** The Copilot action name, snake_case; the CLI subcommand is {@link operationCliName} of it. */
  readonly name: Name;
  /** `<domain>.<name>`. */
  readonly id: `${Domain}.${Name}`;
  /** One sentence, the CLI `--help` line. */
  readonly summary: string;
  readonly effect: OperationEffect;
  readonly confirm: OperationConfirm;
  /** True only for "ask the workbench to open somewhere" (ticket 05); it needs a running workbench. */
  readonly navigates: boolean;
  /**
   * Overrides the derived CLI placement `<domain> <name>` (navigation entries, ticket 05: `open doc` for
   * `workspace.open_doc`). The Copilot side is unaffected. Absent for every other operation.
   */
  readonly cli?: { readonly group: string; readonly name: string };
  /**
   * The parameters WITHOUT the `action` discriminator, strict. Built from the `*-ops.ts` action schema with
   * `.omit({ action: true })`; an action schema that is refined (cannot be omitted) gets an explicit params schema.
   */
  readonly params: Params;
  /**
   * What the operation answers: the JSON the Copilot tool returns as its result and the CLI prints on stdout.
   * Failures that are part of the answer (`{ ok: false, status, detail }`) belong to it.
   */
  readonly result: Result;
}

export function defineOperation<
  const Domain extends string,
  const Name extends string,
  Params extends z.ZodObject,
  Result extends z.ZodType,
>(
  def: Omit<OperationDef<Domain, Name, Params, Result>, "id">
): OperationDef<Domain, Name, Params, Result> {
  return { ...def, id: `${def.domain}.${def.name}` };
}

/** `set_main_doc` -> `set-main-doc`. */
export function operationCliName(name: string): string {
  return name.replaceAll("_", "-");
}

/** `refId` -> `--ref-id`. */
export function operationOptionFlag(param: string): string {
  return `--${param.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** The input a Copilot tool call carries: the parameters plus the `action` name. */
export type OperationCallParse =
  | { match: false }
  | {
      match: true;
      op: OperationDef;
      success: true;
      params: Record<string, unknown>;
    }
  | {
      match: true;
      op: OperationDef;
      success: false;
      issues: { path: string; message: string }[];
    };

/** Parse a Copilot call `{ action, ...params }` against the catalog entries of `domain`. */
export function parseOperationCall(
  catalog: readonly OperationDef[],
  domain: string,
  raw: Record<string, unknown>
): OperationCallParse {
  const { action, ...rest } = raw;
  const op = catalog.find((entry) => entry.domain === domain && entry.name === action);
  if (!op) return { match: false };
  const parsed = op.params.safeParse(rest);
  if (parsed.success) return { match: true, op, success: true, params: parsed.data };
  return {
    match: true,
    op,
    success: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

/** One CLI option derived from a parameter. */
export interface OperationOption {
  /** The parameter name (camelCase). */
  readonly param: string;
  /** `--ref-id`. */
  readonly flag: string;
  /** `boolean`: a bare flag. `string` / `integer` / `number` / `enum`: takes a value. */
  readonly kind: "boolean" | "string" | "integer" | "number" | "enum";
  readonly required: boolean;
  /** The parameter may be `null`: the value `null` on the command line means JSON null. */
  readonly nullable: boolean;
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

interface JsonSchemaNode {
  type?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchemaNode[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

/** The flat form of a parameter, or null when it has none (an array, an object, a union of several shapes). */
function flatOption(
  param: string,
  node: JsonSchemaNode,
  requiredNames: ReadonlySet<string>
): OperationOption | null {
  let nullable = false;
  let inner = node;
  if (node.anyOf) {
    const live = node.anyOf.filter((branch) => branch.type !== "null");
    nullable = live.length !== node.anyOf.length;
    if (live.length !== 1) return null;
    inner = live[0] as JsonSchemaNode;
  }
  const kind = inner.enum
    ? "enum"
    : inner.type === "boolean"
      ? "boolean"
      : inner.type === "integer"
        ? "integer"
        : inner.type === "number"
          ? "number"
          : inner.type === "string"
            ? "string"
            : null;
  if (kind === null) return null;
  return {
    param,
    flag: operationOptionFlag(param),
    kind,
    required: requiredNames.has(param),
    nullable,
    ...(inner.enum ? { choices: inner.enum } : {}),
    ...(inner.minimum !== undefined ? { min: inner.minimum } : {}),
    ...(inner.maximum !== undefined ? { max: inner.maximum } : {}),
  };
}

function parameterNodes(op: OperationDef): {
  entries: [string, JsonSchemaNode][];
  required: Set<string>;
} {
  const schema = z.toJSONSchema(op.params, { io: "input" }) as JsonSchemaNode;
  return {
    entries: Object.entries(schema.properties ?? {}),
    required: new Set(schema.required ?? []),
  };
}

/**
 * The options of an operation, in the order its parameters are declared. Only flat parameters are mapped; an array or
 * object parameter (the argument operations' `argument`, `patch`, `graph`, `ids`) has no option and is given with
 * `--json` ({@link operationJsonOnlyParams}).
 */
export function operationOptions(op: OperationDef): OperationOption[] {
  const { entries, required } = parameterNodes(op);
  return entries.flatMap(([param, node]) => {
    const option = flatOption(param, node, required);
    return option ? [option] : [];
  });
}

/** The parameters with no flat CLI option: only `--json` can carry them. */
export function operationJsonOnlyParams(op: OperationDef): string[] {
  const { entries, required } = parameterNodes(op);
  return entries
    .filter(([param, node]) => flatOption(param, node, required) === null)
    .map(([param]) => param);
}
