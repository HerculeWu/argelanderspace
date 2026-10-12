/**
 * The Copilot's argument-graph tool (argument graph ticket 09, ADR 0005): the operations the model may ask for, the
 * view actions the browser performs, and the table that ties every write the argument graph page offers to the tool
 * operation that does the same. The pure edits are `argument-edit.ts`'s (the page calls the same functions); this file
 * is only the shape of a request.
 *
 * Reading is bounded: {@link ARGUMENT_READ_MAX_CHARS} characters of arguments and {@link ARGUMENT_READ_MAX_EDGES} edges
 * per call, `offset` / `edgeOffset` to continue, `ids` to fetch particular arguments whole (what a partial page context
 * leaves out). Writes carry the `expectedRev` of the model's latest read.
 */
import { z } from "zod";
import {
  ARGUMENT_GRAPH_LIMITS,
  ArgumentEdgeRoleSchema,
  ArgumentKindSchema,
} from "./argument-graph.js";

const L = ARGUMENT_GRAPH_LIMITS;
const WorkId = z.string().min(1).max(500);
const ArgumentId = z.string().min(1).max(L.idChars);
const Rev = z.number().int().nonnegative();

/** The most characters of argument JSON one `read` call returns (a larger graph comes in parts). */
export const ARGUMENT_READ_MAX_CHARS = 60_000;
/** The most edges one `read` call returns. */
export const ARGUMENT_READ_MAX_EDGES = 800;
/** The most arguments one `read` call may name by id. */
export const ARGUMENT_READ_MAX_IDS = 50;

export const ARGUMENT_TOOL_READ_ACTIONS = ["read", "guide"] as const;
export const ARGUMENT_TOOL_WRITE_ACTIONS = [
  "create",
  "update",
  "delete",
  "undo_delete",
  "add_edge",
  "remove_edge",
  "replace",
  "clear",
] as const;
export const ARGUMENT_TOOL_VIEW_ACTIONS = ["open", "select", "exit"] as const;
export const ARGUMENT_TOOL_ACTIONS = [
  ...ARGUMENT_TOOL_READ_ACTIONS,
  ...ARGUMENT_TOOL_WRITE_ACTIONS,
  ...ARGUMENT_TOOL_VIEW_ACTIONS,
] as const;
export type ArgumentToolAction = (typeof ARGUMENT_TOOL_ACTIONS)[number];

/**
 * Every write the argument graph page offers (ticket 05) and the tool operation that does the same through the same pure
 * edit and the same write path. A page write without an entry here, or an entry whose operation does not exist, fails a
 * test.
 */
export const ARGUMENT_PAGE_WRITE_TOOL = {
  "new argument": "create",
  "save argument form": "update",
  delete: "delete",
  "undo delete": "undo_delete",
  "connect (drag or picker)": "add_edge",
  "remove relation": "remove_edge",
  "clear graph": "clear",
} as const;

/**
 * The fields of an argument a request may set. Only types are checked here: lengths, blank titles and malformed sources
 * are the graph schema's to refuse (the pure edits check every result against it), so they come back as the same
 * readable issues the page shows, not as a malformed request.
 */
const ArgumentFields = {
  title: z.string(),
  claim: z.string(),
  grounds: z.string(),
  warrant: z.string(),
  backing: z.string(),
  qualifier: z.string(),
  rebuttal: z.string(),
  warrant_implicit: z.boolean(),
  kind: ArgumentKindSchema,
  sources: z.array(z.unknown()),
};
/** A new argument: only the short title is required. */
export const ArgumentToolDraftSchema = z
  .strictObject({ ...ArgumentFields })
  .partial()
  .required({ title: true });
/** Some fields of an existing argument; the others stay as they are. */
export const ArgumentToolPatchSchema = z.strictObject({ ...ArgumentFields }).partial();
/**
 * The whole body of a replacement: the same shape `argument put` takes, without the bookkeeping keys. The entries are
 * checked by the graph's own schema afterwards, so a blank title or a dangling edge is reported as the same readable
 * issue every write gets, not as a malformed request.
 */
export const ArgumentToolGraphBodySchema = z.strictObject({
  arguments: z.array(z.unknown()).max(L.arguments),
  edges: z.array(z.unknown()).max(L.edges),
});

const Write = { workId: WorkId, expectedRev: Rev };
export const ArgumentToolReadSchema = z.strictObject({
  action: z.literal("read"),
  workId: WorkId,
  offset: z.number().int().nonnegative().optional(),
  edgeOffset: z.number().int().nonnegative().optional(),
  ids: z.array(ArgumentId).min(1).max(ARGUMENT_READ_MAX_IDS).optional(),
});
export const ArgumentToolWriteSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    ...Write,
    argument: ArgumentToolDraftSchema,
    id: ArgumentId.optional(),
  }),
  z.strictObject({
    action: z.literal("update"),
    ...Write,
    id: ArgumentId,
    patch: ArgumentToolPatchSchema,
  }),
  z.strictObject({ action: z.literal("delete"), ...Write, id: ArgumentId }),
  z.strictObject({ action: z.literal("undo_delete"), ...Write, id: ArgumentId }),
  z.strictObject({
    action: z.literal("add_edge"),
    ...Write,
    from: ArgumentId,
    to: ArgumentId,
    role: ArgumentEdgeRoleSchema,
  }),
  z.strictObject({
    action: z.literal("remove_edge"),
    ...Write,
    from: ArgumentId,
    to: ArgumentId,
    role: ArgumentEdgeRoleSchema,
  }),
  z.strictObject({ action: z.literal("replace"), ...Write, graph: ArgumentToolGraphBodySchema }),
  z.strictObject({ action: z.literal("clear"), ...Write }),
]);
export type ArgumentToolWrite = z.infer<typeof ArgumentToolWriteSchema>;
export type ArgumentToolRead = z.infer<typeof ArgumentToolReadSchema>;

/** What the browser does for the model (ADR 0005: opening, selecting and leaving the view are visible navigation). */
export const ArgumentViewActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("open_argument_graph"), workId: WorkId }),
  z.strictObject({
    action: z.literal("select_argument"),
    workId: WorkId,
    argumentId: ArgumentId.nullable(),
  }),
  z.strictObject({ action: z.literal("exit_argument_graph") }),
]);
export type ArgumentViewAction = z.infer<typeof ArgumentViewActionSchema>;

/** The counts a replacement card shows. */
export const ArgumentGraphSizeSchema = z.strictObject({
  arguments: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
});
export type ArgumentGraphSize = z.infer<typeof ArgumentGraphSizeSchema>;

export const ARGUMENT_VIEW_ACTIONS = [
  "open_argument_graph",
  "select_argument",
  "exit_argument_graph",
] as const;
export function isArgumentViewAction(action: { action: string }): action is ArgumentViewAction {
  return (ARGUMENT_VIEW_ACTIONS as readonly string[]).includes(action.action);
}
