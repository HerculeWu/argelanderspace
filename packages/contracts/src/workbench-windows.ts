/**
 * The workbench's windows and the navigation frames (release-0.2 ticket 05; `docs/operation-catalog.md`
 * "Navigation"). A window is one page (a browser tab, or the desktop app's webview) with one `/ws` socket. Each window
 * names itself with an id it makes at load and tells the server when it is the one the user is looking at, so a CLI
 * "open somewhere" can go to the most recently active one. The server sends the page a `workbench.navigate` frame; the
 * page does what the user's own click would do and answers with `window.navigated`, saying what it really showed.
 *
 * Window ids and navigation ids are not secrets and carry no user data: the frames travel on the page's own socket,
 * which already passes the origin guard.
 */
import { z } from "zod";
import { ArgumentOpenGraphSchema } from "./argument-copilot.js";
import { LibraryOpenWorkSchema, WorkspaceOpenDocParamsSchema } from "./navigation-catalog.js";

const WindowId = z.string().min(1).max(64);
const NavigationId = z.string().min(1).max(64);

/** Page -> server. The user gave this window their attention: it gained focus, became visible, or just connected visible. */
export const WsWindowActiveSchema = z
  .object({ type: z.literal("window.active"), windowId: WindowId })
  .strict();
/** Page -> server. The window is no longer visible (minimised, another tab in front). */
export const WsWindowHiddenSchema = z
  .object({ type: z.literal("window.hidden"), windowId: WindowId })
  .strict();
/**
 * Page -> server. What the page really showed for a `workbench.navigate` frame. `detail` is the page's own reason when
 * `ok` is false: `not_found` (no such Doc or Work), `anchor_not_found` (the Doc opened but has no such anchor),
 * `leave_blocked` (unsaved work was kept open), `unavailable`, `disabled`.
 */
export const WsWindowNavigatedSchema = z
  .object({
    type: z.literal("window.navigated"),
    windowId: WindowId,
    navId: NavigationId,
    ok: z.boolean(),
    detail: z.string().max(60).optional(),
  })
  .strict();
export const WindowClientMessageSchema = z.discriminatedUnion("type", [
  WsWindowActiveSchema,
  WsWindowHiddenSchema,
  WsWindowNavigatedSchema,
]);
export type WindowClientMessage = z.infer<typeof WindowClientMessageSchema>;

/** The place to open: a cataloged navigation operation and its parameters (the catalog entry's, without `action`). */
export const NavigationTargetSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("workspace.open_doc"),
      params: WorkspaceOpenDocParamsSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("library.open_work"),
      params: LibraryOpenWorkSchema.omit({ action: true }),
    })
    .strict(),
  z
    .object({
      op: z.literal("argument.open"),
      params: ArgumentOpenGraphSchema.omit({ action: true }),
    })
    .strict(),
]);
export type NavigationTarget = z.infer<typeof NavigationTargetSchema>;

/** Server -> exactly one window. */
export const WsWorkbenchNavigateSchema = z
  .object({
    type: z.literal("workbench.navigate"),
    windowId: WindowId,
    navId: NavigationId,
    target: NavigationTargetSchema,
  })
  .strict();
export type WsWorkbenchNavigate = z.infer<typeof WsWorkbenchNavigateSchema>;
