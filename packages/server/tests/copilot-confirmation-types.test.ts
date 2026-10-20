/**
 * Compile-time checks of the confirmation shapes (architecture-deepening ticket 07): the tool's request is derived from
 * the contracts' card schema and each kind's flat identifiers, and each kind's record projection must match its arm of
 * the record schema. Every `@ts-expect-error` below is a line that must NOT compile (`tsc --noEmit` covers tests): an
 * extra field, a renamed field, a missing field or a missing action. The runtime test only keeps the file a suite.
 */
import { expect, test } from "vitest";
import type {
  ConfirmationKind,
  ConfirmationKinds,
  ConfirmationRequest,
  ExtraRecordKeys,
} from "../src/copilot-confirmations/index.js";
import { createConfirmationKinds } from "../src/copilot-confirmations/index.js";

const plan = {
  toolCallId: "call",
  action: "delete_plan",
  planId: "p_0000000a",
  label: "Alpha",
  planName: "Alpha",
  impact: { tasks: 2, openTasks: 1 },
  baseRev: 7,
  objectDigest: "plan-digest",
} as const;

// The request of a kind: the card's fields without id, runId and object, plus that kind's flat identifiers.
const requestOk: ConfirmationRequest = { ...plan };
const requestExtra: ConfirmationRequest = {
  ...plan,
  // @ts-expect-error a field the card schema does not have
  shownTo: "nobody",
};
const requestRenamed: ConfirmationRequest = {
  toolCallId: "call",
  action: "delete_plan",
  planId: "p_0000000a",
  label: "Alpha",
  // @ts-expect-error a renamed field (planName → name): an unknown field, and the card's one is missing
  name: "Alpha",
  impact: { tasks: 2, openTasks: 1 },
  baseRev: 7,
  objectDigest: "plan-digest",
};
// @ts-expect-error the flat identifier the kind makes the object from is required
const requestNoId: ConfirmationRequest = { ...plan, planId: undefined };
const requestHostOwned: ConfirmationRequest = {
  ...plan,
  // @ts-expect-error the host's id is never the tool's to give
  id: "00000000-0000-4000-8000-000000000000",
};
const requestUnknownAction: ConfirmationRequest = {
  ...plan,
  // @ts-expect-error an action no card schema has
  action: "accept_pdf_resource_warning",
};

// The record projection: exactly the fields of the record schema's arm for that action.
const base = {
  object: (entry: { docId: string }) => ({ kind: "doc" as const, id: entry.docId }),
  askedLine: () => "",
  check: () => Promise.resolve("valid" as const),
  revalidateOn: null,
  boundToNavView: false,
};
const recordOk = {
  ...base,
  action: "delete_doc",
  record: (card) => ({ action: card.action, docId: card.object.id }),
} satisfies ConfirmationKind<"delete_doc", { docId: string }>;
const okHasNoExtra: [ExtraRecordKeys<typeof recordOk>] extends [never] ? true : false = true;
const recordExtra = {
  ...base,
  action: "delete_doc",
  record: (card) => ({ action: card.action, docId: card.object.id, path: "/secret" }),
} satisfies ConfirmationKind<"delete_doc", { docId: string }>;
// @ts-expect-error a field the record schema does not have (the registry's own check, applied to this kind)
const extraIsCaught: [ExtraRecordKeys<typeof recordExtra>] extends [never] ? true : false = true;
const recordRenamed: ConfirmationKind<"delete_doc", { docId: string }> = {
  ...base,
  action: "delete_doc",
  // @ts-expect-error a renamed field (docId → doc)
  record: (card) => ({ action: card.action, doc: card.object.id }),
};
const recordWrongArm: ConfirmationKind<"delete_doc", { docId: string }> = {
  ...base,
  action: "delete_doc",
  // @ts-expect-error another action's arm (delete_plan names planId)
  record: () => ({ action: "delete_plan", planId: "p" }),
};

// Every action has a kind: leaving one out of the registry does not compile.
const { write_file: _left, ...withoutOne } = createConfirmationKinds(undefined);
// @ts-expect-error write_file is missing
const missingAction: ConfirmationKinds = withoutOne;

test("the confirmation shape checks above are compile-time (tsc --noEmit)", () => {
  void [
    requestOk,
    requestExtra,
    requestRenamed,
    requestNoId,
    requestHostOwned,
    requestUnknownAction,
    okHasNoExtra,
    extraIsCaught,
    recordRenamed,
    recordWrongArm,
    missingAction,
  ];
  expect(Object.keys(createConfirmationKinds(undefined))).toHaveLength(12);
});
