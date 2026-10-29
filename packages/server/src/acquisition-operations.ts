/**
 * The acquisition-side catalog operations of the Library domain (release-0.2 ticket 06): `acquire_arxiv_pdf`,
 * `attach_arxiv` and `attach_local_pdf` run the business code of the Copilot `library` tool (`library-actions.ts`),
 * for the CLI and over the workbench's operation route.
 *
 * `attach_arxiv` is the one that can need a person: refreshing an existing arXiv LaTeX Doc replaces its text and may
 * discard annotations, so the call that would do that waits for a card, exactly as the Files tab's acquisition dialog
 * and the Copilot tool do. The calls that only add a Doc (a docless Work, or a PDF-only Work) run without one. The card
 * is the Copilot card of the same action (`refresh_arxiv_source`), put in the workbench's external requests queue
 * (the Copilot tool keeps its own card in its conversation). The wording of every refusal is `prepareArxivRefresh`'s,
 * defined once with the Copilot path.
 */
import { type AcquireContext, applyAttachArxiv, prepareArxivRefresh } from "./library-actions.js";
import type { OperationCall, OperationRuntime } from "./operation-catalog.js";

/** How the acquisition operations wait for their job, and when they stop being admitted. */
export function acquireContext(runtime: OperationRuntime, call: OperationCall): AcquireContext {
  const signal = call.signal ?? runtime.signal;
  return {
    admitting: () => signal?.aborted !== true,
    ...(runtime.jobWaitMs !== undefined ? { waitMs: runtime.jobWaitMs } : {}),
  };
}

const NO_WORKBENCH =
  "refreshing the arXiv source replaces the text of an existing Doc and may discard its annotations, so it needs your confirmation on a card in the workbench, and no workbench is running for this data directory; open ArgelanderSpace on this project first. Nothing was changed and no job was started";

/** The CLI's `library attach-arxiv`. */
export async function runAttachArxivOperation(
  runtime: OperationRuntime,
  params: { refId: string },
  call: OperationCall
): Promise<unknown> {
  const { refId } = params;
  const port = runtime.library.acquisition;
  const context = acquireContext(runtime, call);
  if (!port) return applyAttachArxiv(runtime.library, refId, context);
  const plan = port.describeSource(refId);
  // Not a replacement (a new Doc, or a refusal such as no_arxiv): no card, the shared submit answers.
  if (plan.kind !== "refresh") return applyAttachArxiv(runtime.library, refId, context);
  if (!runtime.confirm) return { ok: false, status: "workbench_required", detail: NO_WORKBENCH };
  const nothing = "changed and no job was started";
  const prepared = await prepareArxivRefresh(runtime.library, refId, plan, {});
  if (!prepared.ok) return prepared;
  const waiting = runtime.confirm.ask({
    card: {
      action: "refresh_arxiv_source",
      object: { kind: "doc", id: prepared.docId, workId: refId },
      label: prepared.title,
      impact: prepared.impact,
      baseRev: prepared.rev,
      objectDigest: prepared.digest,
    },
    client: call.client,
    signal: call.signal,
  });
  if (waiting === null)
    return {
      ok: false,
      status: "rejected",
      detail: `too many requests are already waiting for the user's confirmation; nothing was ${nothing}`,
    };
  const asked = await waiting;
  if (asked.answer === "withdrawn")
    return {
      ok: false,
      status: "interrupted",
      detail: `the request was withdrawn before it was decided; nothing was ${nothing}`,
    };
  if (asked.answer === "denied")
    return {
      ok: false,
      status: "denied",
      detail: `the user denied the request; nothing was ${nothing}`,
    };
  // Approved: the click is the commit. The decision call is told as soon as the job exists (the job can take minutes);
  // this command's own answer is the job's end.
  let settled = false;
  const settle = (result: unknown): void => {
    if (settled) return;
    settled = true;
    asked.settle(result);
  };
  let result: unknown;
  try {
    // The same check the click made, now that the job is about to be submitted.
    const again = port.describeSource(refId);
    const recheck =
      again.kind === "refresh"
        ? await prepareArxivRefresh(runtime.library, refId, again, {})
        : null;
    if (!recheck?.ok || recheck.digest !== prepared.digest) {
      result = {
        ok: false,
        status: "expired",
        detail:
          "the library or the document's annotations changed after the user confirmed; nothing was changed. Read again and ask only if it is still wanted",
      };
      settle(result);
      return result;
    }
    result = await applyAttachArxiv(runtime.library, refId, {
      ...context,
      onSubmitted: (jobId) =>
        settle({
          ok: true,
          status: "submitted",
          jobId,
          detail: "the job was submitted; its outcome goes to the command line",
        }),
    });
  } catch (e) {
    settle({ ok: false, status: "error", detail: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  settle(result);
  return result;
}
