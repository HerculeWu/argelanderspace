/**
 * Navigation entries of the operation catalog (release-0.2 ticket 05, ADR 0015): "ask the workbench to open somewhere".
 * Only opening is cataloged (a Doc, optionally at an anchor; a Work; a Work's argument graph); switching panels,
 * paging and zooming stay interface actions of the Copilot. The workbench shows the place in its most recently active
 * window (`workbench-windows.ts`), so the operations exist only for a running workbench: the CLI refuses without one
 * and never starts it.
 *
 * Copilot correspondence: `workspace.open_doc` and `argument.open` are the Copilot's existing actions of the same names (the
 * `workspace` tool's `open_doc` view action; the `argument` tool's `open`, which asks the browser for `open_argument_graph`;
 * the parameter schemas are the ones in `workspace-ops.ts` / `argument-copilot.ts`; `anchor` is the one CLI-only addition). `library.open_work` is the CLI's way to what the Copilot does with the Library
 * tool's `select_work` interface action, which stays out of the catalog.
 *
 * CLI names are the `cli` override, `argelanderspace open doc|work|argument-graph`, instead of the derived
 * `workspace open-doc` and so on: three navigation verbs from three Copilot tools read better as one group.
 */
import { z } from "zod";
import { ArgumentOpenGraphSchema } from "./argument-copilot.js";
import { defineOperation } from "./operation-def.js";
import { WorkspaceOpenDocSchema } from "./workspace-ops.js";

/** Show a Work (a Library entry) selected in the Library page, switching a pane to the Library if none shows it. */
export const LibraryOpenWorkSchema = z
  .object({ action: z.literal("open_work"), refId: z.string().min(1).max(500) })
  .strict();

/** What every navigation operation answers: shown, or the reason it was not (and then nothing was opened). */
export const NavigationResultSchema = z.union([
  z
    .object({ ok: z.literal(true), status: z.literal("ok"), detail: z.string().optional() })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      status: z.enum([
        "not_found",
        "not_displayed",
        "no_window",
        "workbench_required",
        "unsupported",
        "error",
      ]),
      detail: z.string(),
    })
    .strict(),
]);
export type NavigationResult = z.infer<typeof NavigationResultSchema>;

/** The parameters of `workspace.open_doc`: the Copilot action's `docId` and the CLI-only `anchor`. */
export const WorkspaceOpenDocParamsSchema = WorkspaceOpenDocSchema.omit({ action: true }).extend({
  anchor: z.string().min(1).max(500).optional(),
});

export const WORKSPACE_OPEN_DOC_OPERATION = defineOperation({
  domain: "workspace",
  name: "open_doc",
  summary:
    "Show a Doc in the running workbench's most recently active window; --anchor scrolls to a section, float, reference or ann-<annotation id>.",
  effect: "read",
  confirm: "none",
  navigates: true,
  cli: { group: "open", name: "doc" },
  params: WorkspaceOpenDocParamsSchema,
  result: NavigationResultSchema,
});

export const LIBRARY_OPEN_WORK_OPERATION = defineOperation({
  domain: "library",
  name: "open_work",
  summary:
    "Show a Work selected in the Library page of the running workbench's most recently active window.",
  effect: "read",
  confirm: "none",
  navigates: true,
  cli: { group: "open", name: "work" },
  params: LibraryOpenWorkSchema.omit({ action: true }),
  result: NavigationResultSchema,
});

export const ARGUMENT_OPEN_OPERATION = defineOperation({
  domain: "argument",
  name: "open",
  summary: "Show a Work's argument graph in the running workbench's most recently active window.",
  effect: "read",
  confirm: "none",
  navigates: true,
  cli: { group: "open", name: "argument-graph" },
  params: ArgumentOpenGraphSchema.omit({ action: true }),
  result: NavigationResultSchema,
});
