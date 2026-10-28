/**
 * The navigation operations of the catalog (release-0.2 ticket 05): ask the running workbench to show a Doc (at an
 * anchor), a Work or a Work's argument graph in its most recently active window (`workbench-windows.ts`). Nothing is
 * written, and nothing is opened that does not exist: a Work the Library does not have is answered `not_found` here,
 * and a Doc or anchor the page cannot find is answered `not_found` from the page's own report.
 */
import type { NavigationResult, NavigationTarget } from "@argelanderspace/contracts";
import { readLibrary } from "./library-actions.js";
import type { OperationCall, OperationRuntime } from "./operation-catalog.js";
import type { NavigationOutcome } from "./workbench-windows.js";

const NOTHING = "nothing was opened";

export const NAVIGATION_WORKBENCH_REQUIRED =
  "this opens a place in the workbench, and no workbench is running for this data directory; open ArgelanderSpace on this project first (the command never starts it). Nothing was opened";

const subject = (target: NavigationTarget): string =>
  target.op === "workspace.open_doc"
    ? `Doc ${target.params.docId}`
    : target.op === "library.open_work"
      ? `Work ${target.params.refId}`
      : `Work ${target.params.workId}`;

function describe(target: NavigationTarget, outcome: NavigationOutcome): NavigationResult {
  const what = subject(target);
  switch (outcome.kind) {
    case "shown":
      return { ok: true, status: "ok" };
    case "no_window":
      return {
        ok: false,
        status: "no_window",
        detail: `the workbench is running but no window is open on it; open ArgelanderSpace in a browser or the desktop app, then try again. ${NOTHING}`,
      };
    case "refused":
      if (outcome.detail === "not_found")
        return { ok: false, status: "not_found", detail: `no such ${what}; ${NOTHING}` };
      if (outcome.detail === "anchor_not_found")
        return {
          ok: false,
          status: "not_found",
          detail: `${what} is open, but it has no such anchor; the Doc is shown without a position`,
        };
      if (outcome.detail === "leave_blocked")
        return {
          ok: false,
          status: "not_displayed",
          detail: `the window has unsaved work open and kept it; save or discard it there first. ${NOTHING}`,
        };
      return {
        ok: false,
        status: "not_displayed",
        detail: `the window could not show ${what} right now (${outcome.detail}); ${NOTHING}`,
      };
    case "timeout":
      return {
        ok: false,
        status: "not_displayed",
        detail: `the window did not confirm in time, so ${what} may or may not be shown`,
      };
    case "closed":
      return {
        ok: false,
        status: "not_displayed",
        detail: `the window closed before it answered, so ${what} may not be shown`,
      };
    case "aborted":
      return { ok: false, status: "not_displayed", detail: "the request was abandoned" };
  }
}

export async function runNavigationOperation(
  runtime: OperationRuntime,
  target: NavigationTarget,
  call: OperationCall
): Promise<NavigationResult> {
  if (!runtime.navigate)
    return { ok: false, status: "workbench_required", detail: NAVIGATION_WORKBENCH_REQUIRED };
  // A Work the Library does not have is not opened (the Library page and the graph view would show an empty page).
  if (target.op !== "workspace.open_doc") {
    const refId = target.op === "library.open_work" ? target.params.refId : target.params.workId;
    const read = await readLibrary(runtime.library, { action: "read", refId });
    if (!read.ok)
      return { ok: false, status: "not_found", detail: `no such ${subject(target)}; ${NOTHING}` };
  }
  return describe(target, await runtime.navigate.navigate(target, { signal: call.signal }));
}
