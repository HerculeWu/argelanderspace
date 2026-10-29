/**
 * The confirmation-card flow every card-asking catalog operation shares (release-0.2 tickets 04, 06, 08): put the card
 * in the workbench's external-requests queue, wait for the real user, and turn anything but an approval into the
 * operation's refusal. An operation that needs a card calls {@link askCard}, does its own re-check once approved, and
 * reports the result with `asked.settle` (see `docs/operation-catalog.md`, "给后续确认卡操作").
 */
import type { ExternalAsk, ExternalCardFields } from "./external-requests.js";
import type { OperationCall, OperationRuntime } from "./operation-catalog.js";

export type CardRefusal = {
  ok: false;
  status: "rejected" | "interrupted" | "denied";
  detail: string;
};

/**
 * Ask the user. `nothing` completes "nothing was …" in every refusal ("deleted", "written", "changed and no job was
 * started"). The caller must have checked `runtime.confirm` (its `workbench_required` answer is its own).
 */
export async function askCard(
  runtime: OperationRuntime,
  card: ExternalCardFields,
  call: OperationCall,
  nothing: string
): Promise<{ approved: true; asked: ExternalAsk } | { approved: false; refusal: CardRefusal }> {
  const waiting = runtime.confirm?.ask({ card, client: call.client, signal: call.signal }) ?? null;
  if (waiting === null)
    return {
      approved: false,
      refusal: {
        ok: false,
        status: "rejected",
        detail: `too many requests are already waiting for the user's confirmation; nothing was ${nothing}`,
      },
    };
  const asked = await waiting;
  if (asked.answer === "withdrawn")
    return {
      approved: false,
      refusal: {
        ok: false,
        status: "interrupted",
        detail: `the request was withdrawn before it was decided; nothing was ${nothing}`,
      },
    };
  if (asked.answer === "denied")
    return {
      approved: false,
      refusal: {
        ok: false,
        status: "denied",
        detail: `the user denied the request; nothing was ${nothing}`,
      },
    };
  return { approved: true, asked };
}
