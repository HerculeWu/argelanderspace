/**
 * The Copilot's argument-graph tool (argument graph ticket 09, ADR 0005): the operations the model may ask for, the
 * view actions the browser performs, and the table that ties every write the argument graph page offers to the tool
 * operation that does the same. The pure edits are `argument-edit.ts`'s (the page calls the same functions); this file
 * is only the shape of a request.
 *
 * Reading is bounded, and measured with the one ruler the host's window uses: UTF-8 bytes of the result as the history
 * holds it (the result text JSON-escaped once more, `historyCost`), never UTF-16 characters. One `read` result is never
 * larger than {@link argumentReadLimit} bytes (a ceiling that shrinks with the room the model's window has left), and
 * when the room cannot hold even the smallest part the result is an honest `rejected` gap saying so, never a result the
 * host would have to withdraw. The arguments, the edges and the audit lists share the ceiling and each comes in parts,
 * saying what is delivered (`batch`, `edgesBatch`) and what is cut (`batch.clipped`, `audit.capped`). One protocol for
 * every form: `offset` / `edgeOffset` index the list being read (all arguments, or the `ids` named, in the order given;
 * the edges of the graph, or the edges touching the named arguments), and a continuing call passes BOTH (a list that is
 * already complete is passed its total and returns nothing); `ids` fetches particular arguments (what a partial page
 * context leaves out); an argument too big for one result comes alone with its long texts cut, and `field` (with one
 * id and `offset` as a character offset) reads the rest of a cut text. Writes carry the `expectedRev` of the model's
 * latest read.
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

/** The most bytes (as the history counts them) of argument JSON one `read` call returns (a larger graph comes in parts). */
export const ARGUMENT_READ_MAX_BYTES = 60_000;
/** The most edges one `read` call returns. */
export const ARGUMENT_READ_MAX_EDGES = 800;
/** The longest `read` result (history bytes, whole payload) when the window has room to spare. */
export const ARGUMENT_READ_MAX_TOTAL = 70_000;
/** The shortest soft ceiling of a `read` result (history bytes); the room itself can still be smaller (then a gap). */
export const ARGUMENT_READ_MIN_TOTAL = 8_000;
/**
 * The soft ceiling on one `read` result, in the bytes the history holds it in (UTF-8, JSON-escaped): half the room the
 * model's window has left, between {@link ARGUMENT_READ_MIN_TOTAL} and {@link ARGUMENT_READ_MAX_TOTAL}. No room given:
 * the maximum. The host also never lets a result exceed the room itself (less the record that travels with it).
 */
export function argumentReadLimit(room?: number): number {
  const half = room === undefined ? Number.POSITIVE_INFINITY : Math.floor(Math.max(0, room) / 2);
  return Math.max(ARGUMENT_READ_MIN_TOTAL, Math.min(ARGUMENT_READ_MAX_TOTAL, half));
}
/**
 * What `field` may name: a text field of an argument, or `sources.N` (the N-th source, zero-based; `sources.N.text` is
 * the same, the spelling the page's `reduction.truncated` uses).
 */
export const ARGUMENT_READ_FIELD =
  /^(claim|grounds|warrant|backing|qualifier|rebuttal|sources\.\d{1,2}(\.text)?)$/;
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
  field: z.string().regex(ARGUMENT_READ_FIELD).optional(),
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
