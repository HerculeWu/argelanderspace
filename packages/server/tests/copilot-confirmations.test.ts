/**
 * The confirmation kinds (copilot ticket 35) on their own seam: each kind's `check` answers valid, changed or an error
 * from a fake workbench, and the background trigger and bound-view rule of each kind are what the host had before.
 * The business reads the checks call are replaced here; the host-level paths are covered by the copilot-* host tests.
 */
import { beforeEach, expect, test, vi } from "vitest";
import type { Workbench } from "../src/copilot.js";
import {
  type ConfirmationAction,
  type ConfirmationKinds,
  createConfirmationKinds,
} from "../src/copilot-confirmations/index.js";
import type { ConfirmationRequest } from "../src/copilot-tool-kit.js";

const reads = vi.hoisted(() => ({
  describeDeleteTarget: vi.fn(),
  describeManuscriptDelete: vi.fn(),
  prepareArxivRefresh: vi.fn(),
  draftUnchanged: vi.fn(),
  describeArgumentTarget: vi.fn(),
}));
vi.mock("../src/plans-actions.js", async (original) => ({
  ...(await original<object>()),
  describeDeleteTarget: reads.describeDeleteTarget,
}));
vi.mock("../src/writer-actions.js", async (original) => ({
  ...(await original<object>()),
  describeManuscriptDelete: reads.describeManuscriptDelete,
}));
vi.mock("../src/library-actions.js", async (original) => ({
  ...(await original<object>()),
  prepareArxivRefresh: reads.prepareArxivRefresh,
}));
vi.mock("../src/copilot-argument-tool.js", async (original) => ({
  ...(await original<object>()),
  describeArgumentTarget: reads.describeArgumentTarget,
}));
vi.mock("../src/mail-copilot.js", async (original) => ({
  ...(await original<object>()),
  draftUnchanged: reads.draftUnchanged,
}));

const sha = (c: string) => c.repeat(64);
const account = { id: "acc", address: "me@example.org", displayName: "Me" };
const message = {
  folder: "INBOX",
  uid: 7,
  uidValidity: 1,
  from: null,
  subject: "Hello",
  date: null,
};
const textImpact = {
  docId: "t_doc",
  sourceRev: 2,
  publishedSourceRev: 1,
  annotations: 3,
  annotationsRev: 4,
  oldFingerprint: sha("a"),
  newFingerprint: sha("b"),
};
const requests: { [A in ConfirmationAction]: Extract<ConfirmationRequest, { action: A }> } = {
  send_mail: {
    toolCallId: "call",
    action: "send_mail",
    accountId: "acc",
    messageId: "<m@x>",
    account,
    kind: "new",
    to: [{ name: "", address: "you@example.org" }],
    cc: [],
    bcc: [],
    subject: "Hi",
    text: "Body",
    attachments: [],
    inReplyTo: null,
    baseRev: 0,
    objectDigest: "draft-digest",
  },
  delete_mail: {
    toolCallId: "call",
    action: "delete_mail",
    accountId: "acc",
    account,
    message,
    permanent: false,
    baseRev: 1,
    objectDigest: "msg-digest",
  },
  move_mail: {
    toolCallId: "call",
    action: "move_mail",
    accountId: "acc",
    account,
    message,
    destination: "Archive",
    baseRev: 1,
    objectDigest: "msg-digest",
  },
  replace_text_reading: {
    toolCallId: "call",
    action: "replace_text_reading",
    docId: "t_doc",
    label: "Notes",
    impact: textImpact,
    baseRev: 4,
    objectDigest: "text-digest",
  },
  delete_plan: {
    toolCallId: "call",
    action: "delete_plan",
    planId: "p_0000000a",
    label: "Alpha",
    planName: "Alpha",
    impact: { tasks: 2, openTasks: 1 },
    baseRev: 7,
    objectDigest: "plan-digest",
  },
  delete_manuscript: {
    toolCallId: "call",
    action: "delete_manuscript",
    manuscriptId: "m_1",
    label: "Paper",
    impact: { cells: 3, comments: 0, assets: 1 },
    baseRev: 5,
    objectDigest: "ms-digest",
  },
  delete_doc: {
    toolCallId: "call",
    action: "delete_doc",
    docId: "d_1",
    format: "latex",
    works: [{ id: "w_1", title: "Work", main: true, remaining: 0 }],
    impact: { annotations: "known", count: 2 },
    baseRev: 3,
    objectDigest: "doc-digest",
  },
  replace_argument_graph: {
    toolCallId: "call",
    action: "replace_argument_graph",
    workId: "doi:10.1/x",
    label: "A paper",
    mode: "replace",
    current: { arguments: 4, edges: 3 },
    next: { arguments: 6, edges: 7 },
    baseRev: 5,
    objectDigest: "graph-digest",
  },
  refresh_arxiv_source: {
    toolCallId: "call",
    action: "refresh_arxiv_source",
    workId: "w_1",
    docId: "d_1",
    label: "Work",
    impact: { annotations: "known", count: 2 },
    baseRev: 3,
    objectDigest: "refresh-digest",
  },
};

let describe_: ReturnType<typeof vi.fn>;
let describeSource: ReturnType<typeof vi.fn>;
let probeReplacement: ReturnType<typeof vi.fn>;
let kinds: ConfirmationKinds;
const workbench = () =>
  ({
    plans: { statusDir: "/status" },
    writer: {},
    library: { deletion: { describe: describe_ }, acquisition: { describeSource } },
    text: { probeReplacement },
    mail: {},
    argument: {},
  }) as unknown as Workbench;
const checkOf = <A extends ConfirmationAction>(action: A) =>
  (kinds[action] as ConfirmationKinds[ConfirmationAction]).check(
    // biome-ignore lint/suspicious/noExplicitAny: one card per kind, built by the kind itself
    (kinds[action].card as any)("c1", "r1", requests[action])
  );

beforeEach(() => {
  for (const read of Object.values(reads)) read.mockReset();
  describe_ = vi.fn();
  describeSource = vi.fn();
  probeReplacement = vi.fn();
  kinds = createConfirmationKinds(workbench());
});

test("delete_plan: valid when rev and content digest match, changed otherwise, an error when the plans cannot be read", async () => {
  reads.describeDeleteTarget.mockReturnValue({ rev: 7, objectDigest: "plan-digest" });
  expect(await checkOf("delete_plan")).toBe("valid");
  expect(reads.describeDeleteTarget).toHaveBeenCalledWith("/status", {
    action: "delete_plan",
    planId: "p_0000000a",
  });
  reads.describeDeleteTarget.mockReturnValue({ rev: 7, objectDigest: "edited by hand" });
  expect(await checkOf("delete_plan")).toBe("changed");
  reads.describeDeleteTarget.mockReturnValue({ rev: 8, objectDigest: "plan-digest" });
  expect(await checkOf("delete_plan")).toBe("changed");
  reads.describeDeleteTarget.mockReturnValue(null);
  expect(await checkOf("delete_plan")).toBe("changed");
  reads.describeDeleteTarget.mockImplementation(() => {
    throw new Error("plans.json: Unexpected token");
  });
  expect(await checkOf("delete_plan")).toEqual({ error: "plans.json: Unexpected token" });
});

test("replace_argument_graph: valid on the same rev and stored content, changed otherwise, an error when the graph cannot be read", async () => {
  reads.describeArgumentTarget.mockReturnValue({ rev: 5, objectDigest: "graph-digest" });
  expect(await checkOf("replace_argument_graph")).toBe("valid");
  expect(reads.describeArgumentTarget).toHaveBeenCalledWith({}, "doi:10.1/x");
  // a hand edit that leaves the rev alone also ends the card
  reads.describeArgumentTarget.mockReturnValue({ rev: 5, objectDigest: "edited by hand" });
  expect(await checkOf("replace_argument_graph")).toBe("changed");
  reads.describeArgumentTarget.mockReturnValue({ rev: 6, objectDigest: "graph-digest" });
  expect(await checkOf("replace_argument_graph")).toBe("changed");
  // the Work left the library
  reads.describeArgumentTarget.mockReturnValue(null);
  expect(await checkOf("replace_argument_graph")).toBe("changed");
  reads.describeArgumentTarget.mockImplementation(() => {
    throw new Error("the argument graph file could not be read");
  });
  expect(await checkOf("replace_argument_graph")).toEqual({
    error: "the argument graph file could not be read",
  });
});

test("delete_manuscript: valid on the same rev and bytes, changed otherwise, an error when reading throws", async () => {
  reads.describeManuscriptDelete.mockReturnValue({ rev: 5, digest: "ms-digest" });
  expect(await checkOf("delete_manuscript")).toBe("valid");
  reads.describeManuscriptDelete.mockReturnValue({ rev: 6, digest: "ms-digest" });
  expect(await checkOf("delete_manuscript")).toBe("changed");
  reads.describeManuscriptDelete.mockReturnValue({ rev: 5, digest: "new figure" });
  expect(await checkOf("delete_manuscript")).toBe("changed");
  reads.describeManuscriptDelete.mockReturnValue(null);
  expect(await checkOf("delete_manuscript")).toBe("changed");
  // `{ error }`: the manuscript file exists but cannot be read or parsed (a missing one is null): a system error.
  reads.describeManuscriptDelete.mockReturnValue({
    error: "writer store: m.json is not valid JSON",
  });
  expect(await checkOf("delete_manuscript")).toEqual({
    error: "writer store: m.json is not valid JSON",
  });
  reads.describeManuscriptDelete.mockImplementation(() => {
    throw new Error("EACCES: assets");
  });
  expect(await checkOf("delete_manuscript")).toEqual({ error: "EACCES: assets" });
});

test("delete_doc: valid while the description is ready with the same digest and rev, changed otherwise, an error when it throws", async () => {
  describe_.mockResolvedValue({ kind: "ready", digest: "doc-digest", rev: 3 });
  expect(await checkOf("delete_doc")).toBe("valid");
  expect(describe_).toHaveBeenCalledWith("d_1");
  describe_.mockResolvedValue({ kind: "ready", digest: "doc-digest", rev: 4 });
  expect(await checkOf("delete_doc")).toBe("changed");
  for (const kind of ["not_found", "bad_id", "busy", "orphan"]) {
    describe_.mockResolvedValue({ kind });
    expect(await checkOf("delete_doc")).toBe("changed");
  }
  // The library holding the Doc could not be read: a system error.
  describe_.mockResolvedValue({ kind: "error", detail: "the library could not be read" });
  expect(await checkOf("delete_doc")).toEqual({ error: "the library could not be read" });
  describe_.mockRejectedValue(new Error("annotations unreadable"));
  expect(await checkOf("delete_doc")).toEqual({ error: "annotations unreadable" });
});

test("refresh_arxiv_source: valid while the Work refreshes the same Doc with the same risk, changed otherwise, an error when a read throws", async () => {
  describeSource.mockReturnValue({ kind: "refresh", docId: "d_1" });
  reads.prepareArxivRefresh.mockResolvedValue({ ok: true, digest: "refresh-digest", rev: 3 });
  expect(await checkOf("refresh_arxiv_source")).toBe("valid");
  expect(describeSource).toHaveBeenCalledWith("w_1");
  reads.prepareArxivRefresh.mockResolvedValue({ ok: true, digest: "refresh-digest", rev: 4 });
  expect(await checkOf("refresh_arxiv_source")).toBe("changed");
  describeSource.mockReturnValue({ kind: "refresh", docId: "d_2" });
  expect(await checkOf("refresh_arxiv_source")).toBe("changed");
  describeSource.mockReturnValue({ kind: "new" });
  expect(await checkOf("refresh_arxiv_source")).toBe("changed");
  describeSource.mockReturnValue({ kind: "refresh", docId: "d_1" });
  // The Doc is gone, or a task is writing or deleting it: not refreshable as shown, a change (never a read failure).
  reads.prepareArxivRefresh.mockResolvedValue({
    ok: false,
    status: "rejected",
    detail: "the document to refresh no longer exists; read the work again",
  });
  expect(await checkOf("refresh_arxiv_source")).toBe("changed");
  reads.prepareArxivRefresh.mockResolvedValue({
    ok: false,
    status: "rejected",
    detail: "the document is busy (a task is writing or deleting it)",
  });
  expect(await checkOf("refresh_arxiv_source")).toBe("changed");
  describeSource.mockReturnValue({ kind: "refresh", docId: "d_1" });
  reads.prepareArxivRefresh.mockRejectedValue(new Error("risk unreadable"));
  expect(await checkOf("refresh_arxiv_source")).toEqual({ error: "risk unreadable" });
  describeSource.mockImplementation(() => {
    throw new Error("library unreadable");
  });
  expect(await checkOf("refresh_arxiv_source")).toEqual({ error: "library unreadable" });
});

test("replace_text_reading: valid on the same impact, changed when a bound value differs, an error on a probe system error", async () => {
  probeReplacement.mockResolvedValue({ kind: "impact", impact: textImpact });
  expect(await checkOf("replace_text_reading")).toBe("valid");
  expect(probeReplacement).toHaveBeenCalledWith("t_doc", 2);
  probeReplacement.mockResolvedValue({ kind: "impact", impact: { ...textImpact, annotations: 4 } });
  expect(await checkOf("replace_text_reading")).toBe("changed");
  probeReplacement.mockResolvedValue({ kind: "impact", impact: null });
  expect(await checkOf("replace_text_reading")).toBe("changed");
  probeReplacement.mockResolvedValue({ kind: "changed" });
  expect(await checkOf("replace_text_reading")).toBe("changed");
  probeReplacement.mockResolvedValue({
    kind: "error",
    code: "annotations_unreadable",
    detail: "bad json",
  });
  expect(await checkOf("replace_text_reading")).toEqual({
    error: "annotations_unreadable: bad json",
  });
});

test("send_mail: valid on the same draft, changed when it changed, is gone or frozen, an error when the server cannot be asked", async () => {
  reads.draftUnchanged.mockResolvedValue("same");
  expect(await checkOf("send_mail")).toBe("valid");
  expect(reads.draftUnchanged).toHaveBeenCalledWith({}, "acc", "<m@x>", "draft-digest");
  reads.draftUnchanged.mockResolvedValue("changed");
  expect(await checkOf("send_mail")).toBe("changed");
  reads.draftUnchanged.mockResolvedValue({ status: "not_found", code: "draft_missing" });
  expect(await checkOf("send_mail")).toBe("changed");
  reads.draftUnchanged.mockResolvedValue({ status: "conflict", code: "frozen" });
  expect(await checkOf("send_mail")).toBe("changed");
  reads.draftUnchanged.mockResolvedValue({ status: "error", code: "imap_unreachable" });
  expect(await checkOf("send_mail")).toEqual({ error: "imap_unreachable" });
});

test("delete_mail and move_mail are always valid at the click: the server refuses a changed message by uid and uidValidity", async () => {
  expect(await checkOf("delete_mail")).toBe("valid");
  expect(await checkOf("move_mail")).toBe("valid");
  expect(reads.draftUnchanged).not.toHaveBeenCalled();
});

test("without a workbench seam every check says changed, as the host did", async () => {
  kinds = createConfirmationKinds(undefined);
  for (const action of [
    "delete_plan",
    "delete_manuscript",
    "delete_doc",
    "refresh_arxiv_source",
    "replace_argument_graph",
    "replace_text_reading",
    "send_mail",
  ] as const)
    expect(await checkOf(action)).toBe("changed");
});

test("background trigger and bound-view rule per kind are what the host had", () => {
  const table = Object.fromEntries(
    Object.values(kinds).map((kind) => [kind.action, [kind.revalidateOn, kind.boundToNavView]])
  );
  expect(table).toEqual({
    delete_plan: ["plans", false],
    delete_manuscript: ["writer", true],
    delete_doc: ["doc", true],
    refresh_arxiv_source: ["doc", false],
    replace_argument_graph: ["argument", false],
    replace_text_reading: ["doc", false],
    send_mail: [null, false],
    delete_mail: [null, false],
    move_mail: [null, false],
  });
  for (const [action, kind] of Object.entries(kinds)) expect(kind.action).toBe(action);
});

test("records and resume lines keep their fields and wording", () => {
  const card = kinds.delete_mail.card("c1", "r1", requests.delete_mail);
  expect(card.object).toEqual({ kind: "mail_message", id: "acc:INBOX:7", accountId: "acc" });
  expect(kinds.delete_mail.resolvedFields(card)).toEqual({
    action: "delete_mail",
    accountId: "acc",
    folder: "INBOX",
    uid: 7,
  });
  expect(kinds.move_mail.requestedFields(requests.move_mail)).toEqual({
    action: "move_mail",
    accountId: "acc",
    folder: "INBOX",
    uid: 7,
  });
  const refresh = kinds.refresh_arxiv_source.card("c1", "r1", requests.refresh_arxiv_source);
  expect(kinds.refresh_arxiv_source.resolvedFields(refresh)).toEqual({
    action: "refresh_arxiv_source",
    workId: "w_1",
    docId: "d_1",
  });
  const replaced = kinds.replace_argument_graph.card("c1", "r1", requests.replace_argument_graph);
  expect(replaced.object).toEqual({ kind: "work", id: "doi:10.1/x", workId: "doi:10.1/x" });
  expect(kinds.replace_argument_graph.requestedFields(requests.replace_argument_graph)).toEqual({
    action: "replace_argument_graph",
    workId: "doi:10.1/x",
  });
  expect(kinds.replace_argument_graph.resolvedFields(replaced)).toEqual({
    action: "replace_argument_graph",
    workId: "doi:10.1/x",
  });
  const base = {
    version: 1,
    phase: "requested",
    confirmationId: "c",
    runId: "r",
    toolCallId: "t",
    baseRev: 0,
  } as const;
  expect(
    kinds.move_mail.askedLine({
      ...base,
      action: "move_mail",
      accountId: "acc",
      folder: "INBOX",
      uid: 7,
    })
  ).toBe("move_mail acc INBOX uid 7");
  expect(
    kinds.refresh_arxiv_source.askedLine({
      ...base,
      action: "refresh_arxiv_source",
      workId: "w",
      docId: "d",
    })
  ).toBe("refresh_arxiv_source w d");
  expect(
    kinds.send_mail.askedLine({ ...base, action: "send_mail", accountId: "acc", messageId: "<m>" })
  ).toBe("send_mail acc <m>");
  expect(
    kinds.replace_argument_graph.askedLine({
      ...base,
      action: "replace_argument_graph",
      workId: "w",
    })
  ).toBe("replace_argument_graph w");
});
