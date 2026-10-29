/**
 * Argument-domain entries of the operation catalog (release-0.2 ticket 08): the business operations of the argument
 * graph (论证图) that the Copilot `argument` tool and the page share: the read, the edits of one argument or one edge,
 * and the whole-graph replace and clear. Their parameters are the action schemas of `argument-copilot.ts`.
 *
 * Not here: the interface actions `select` and `exit` (they only change what one browser tab shows) and `guide` (the
 * Copilot's own method text, which speaks of the Copilot's reader tool; external agents get their method from the
 * skills). Opening a graph is `argument.open` of the navigation catalog (`argelanderspace open argument-graph`).
 *
 * The frozen CLI commands `argument get` and `argument put` (docs/contracts.md "CLI 论证图命令冻结契约") are older
 * than the catalog and are not catalog entries; they share the `argument` group with these, whose names do not collide
 * with them.
 */
import { z } from "zod";
import {
  ArgumentToolAddEdgeSchema,
  ArgumentToolClearSchema,
  ArgumentToolCreateSchema,
  ArgumentToolDeleteSchema,
  ArgumentToolReadSchema,
  ArgumentToolRemoveEdgeSchema,
  ArgumentToolReplaceSchema,
  ArgumentToolUndoDeleteSchema,
  ArgumentToolUpdateSchema,
} from "./argument-copilot.js";
import { defineOperation } from "./operation-def.js";

const Count = z.number().int().nonnegative();

/**
 * Why an argument operation did not do what was asked; every one is an answer, not an exception. `conflict` carries the
 * stored graph's `currentRev` and a `latest` page to rebase on; `declined` is the Copilot conversation's card refused,
 * `denied` the workbench card refused for an external agent (the CLI exits 3); `workbench_required` is the answer of a
 * replace or clear that needs a card when no workbench runs; `expired` the graph changed after the card was shown;
 * `interrupted` the asker left while the card waited.
 */
export const ArgumentFailureResultSchema = z
  .object({
    ok: z.literal(false),
    status: z.enum([
      "not_found",
      "rejected",
      "invalid",
      "conflict",
      "expired",
      "unsupported",
      "error",
      "unknown",
      "declined",
      "denied",
      "workbench_required",
      "interrupted",
    ]),
    detail: z.string(),
    currentRev: Count.optional(),
    issues: z.array(z.unknown()).optional(),
    latest: z.unknown().optional(),
    latestOmitted: z.string().optional(),
    gap: z.object({ bytes: Count }).passthrough().optional(),
  })
  .passthrough();

/** A read: the graph (in parts) or one text of one argument; `rev` is what every write must name. */
export const ArgumentReadResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      status: z.literal("ok"),
      rev: Count,
      work: z.object({ id: z.string(), title: z.string() }).passthrough(),
      note: z.string(),
    })
    .passthrough(),
  ArgumentFailureResultSchema,
]);

/** An edit that was written: the new `rev` and the counts (`create` adds `id`, `delete` adds `removed`). */
export const ArgumentWriteResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      status: z.enum(["ok", "noop"]),
      rev: Count,
      counts: z.object({ arguments: Count, edges: Count }).strict(),
      id: z.string().optional(),
      removed: z.object({ id: z.string(), title: z.string(), edges: Count }).strict().optional(),
      note: z.string().optional(),
      detail: z.string().optional(),
    })
    .strict(),
  ArgumentFailureResultSchema,
]);

export const ARGUMENT_READ_OPERATION = defineOperation({
  domain: "argument",
  name: "read",
  summary:
    "Read a work's argument graph: rev, counts, audit, arguments and edges (big graphs come in parts; follow the note). --ids (with --json) reads particular arguments; one id with --field and --offset reads the rest of a cut text.",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: ArgumentToolReadSchema.omit({ action: true }),
  result: ArgumentReadResultSchema,
});

export const ARGUMENT_CREATE_OPERATION = defineOperation({
  domain: "argument",
  name: "create",
  summary:
    "Add an argument ({argument: {title, claim, ...}} with --json); --expected-rev is the rev you read. Prints the new rev and id.",
  effect: "write",
  confirm: "none",
  navigates: false,
  params: ArgumentToolCreateSchema.omit({ action: true }),
  result: ArgumentWriteResultSchema,
});

export const ARGUMENT_UPDATE_OPERATION = defineOperation({
  domain: "argument",
  name: "update",
  summary:
    "Change some fields of an argument ({id, patch: {...}} with --json); the other fields stay. --expected-rev is the rev you read.",
  effect: "write",
  confirm: "none",
  navigates: false,
  params: ArgumentToolUpdateSchema.omit({ action: true }),
  result: ArgumentWriteResultSchema,
});

export const ARGUMENT_DELETE_OPERATION = defineOperation({
  domain: "argument",
  name: "delete",
  summary:
    "Delete an argument (--id) with the edges that touch it; --expected-rev is the rev you read. undo-delete puts it back while the graph is unchanged.",
  effect: "write",
  confirm: "none",
  navigates: false,
  params: ArgumentToolDeleteSchema.omit({ action: true }),
  result: ArgumentWriteResultSchema,
});

export const ARGUMENT_UNDO_DELETE_OPERATION = defineOperation({
  domain: "argument",
  name: "undo_delete",
  summary:
    "Put back an argument deleted since the workbench started (--id) with its edges; --expected-rev is the rev the delete returned. Only works while that workbench runs and the graph is unchanged.",
  effect: "write",
  confirm: "none",
  navigates: false,
  params: ArgumentToolUndoDeleteSchema.omit({ action: true }),
  result: ArgumentWriteResultSchema,
});

export const ARGUMENT_ADD_EDGE_OPERATION = defineOperation({
  domain: "argument",
  name: "add_edge",
  summary:
    "Make the Claim of --from play --role (grounds|warrant|backing|rebuttal) in --to; --expected-rev is the rev you read.",
  effect: "write",
  confirm: "none",
  navigates: false,
  params: ArgumentToolAddEdgeSchema.omit({ action: true }),
  result: ArgumentWriteResultSchema,
});

export const ARGUMENT_REMOVE_EDGE_OPERATION = defineOperation({
  domain: "argument",
  name: "remove_edge",
  summary:
    "Remove the edge --from --to --role (grounds|warrant|backing|rebuttal); --expected-rev is the rev you read.",
  effect: "write",
  confirm: "none",
  navigates: false,
  params: ArgumentToolRemoveEdgeSchema.omit({ action: true }),
  result: ArgumentWriteResultSchema,
});

/**
 * `conditional`: a graph without arguments is replaced at once; one that has arguments only after the user's card in
 * the running workbench (the Copilot's `replace_argument_graph` card), so with no workbench running the answer is
 * `workbench_required` and nothing is written.
 */
export const ARGUMENT_REPLACE_OPERATION = defineOperation({
  domain: "argument",
  name: "replace",
  summary:
    "Replace the whole graph ({workId, expectedRev, graph: {arguments, edges}} with --json). A graph that has arguments is replaced only after the user confirms on a card in the running workbench.",
  effect: "write",
  confirm: "conditional",
  navigates: false,
  params: ArgumentToolReplaceSchema.omit({ action: true }),
  result: ArgumentWriteResultSchema,
});

export const ARGUMENT_CLEAR_OPERATION = defineOperation({
  domain: "argument",
  name: "clear",
  summary:
    "Delete every argument and edge of the graph. A graph that has arguments is cleared only after the user confirms on a card in the running workbench.",
  effect: "write",
  confirm: "conditional",
  navigates: false,
  params: ArgumentToolClearSchema.omit({ action: true }),
  result: ArgumentWriteResultSchema,
});
