/**
 * The confirmation kinds (copilot ticket 35) on their own seam: each kind's `check` answers valid, changed or an error
 * from a fake workbench, and the background trigger and bound-view rule of each kind are what the host had before.
 * The card and the durable record are assembled once from the contracts' card schema and each kind's `object` and
 * `record` (architecture-deepening ticket 07): `confirmationCard` and `confirmationRecord` are what the host calls, and
 * their output is pinned to a golden captured from the code before that ticket (records byte for byte).
 * The business reads the checks call are replaced here; the host-level paths are covered by the copilot-* host tests.
 */
import { readFileSync } from "node:fs";
import {
  CopilotConfirmationSchema,
  type OperationConfirmation,
  OperationConfirmationSchema,
} from "@argelanderspace/contracts";
import { beforeEach, expect, test, vi } from "vitest";
import type { Workbench } from "../src/copilot.js";
import {
  type ConfirmationAction,
  type ConfirmationKind,
  type ConfirmationKinds,
  type ConfirmationRequest,
  confirmationCard,
  confirmationRecord,
  createConfirmationKinds,
} from "../src/copilot-confirmations/index.js";

const reads = vi.hoisted(() => ({
  describeDeleteTarget: vi.fn(),
  describeManuscriptDelete: vi.fn(),
  prepareArxivRefresh: vi.fn(),
  draftUnchanged: vi.fn(),
  describeArgumentTarget: vi.fn(),
  shelfAddDigest: vi.fn(),
  shelfDeleteDigest: vi.fn(),
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

vi.mock("../src/copilot-shelf-tool.js", async (original) => ({
  ...(await original<object>()),
  shelfAddDigest: reads.shelfAddDigest,
  shelfDeleteDigest: reads.shelfDeleteDigest,
}));

const sha = (c: string) => c.repeat(64);
const ENTRY = "0123456789abcdef0123456789abcdef";
const SHELF_ADD_DIGEST = "add-digest";
const SHELF_DELETE_DIGEST = "delete-digest";
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
  run_command: {
    toolCallId: "call",
    action: "run_command",
    shell: "bash",
    command: "ls -la",
    cwd: "~/project",
    baseRev: 0,
  },
  edit_file: {
    toolCallId: "call",
    action: "edit_file",
    path: "notes/a.md",
    resolved: "~/project/notes/a.md",
    cwd: "~/project",
    change: { edits: 1, added: 1, removed: 1 },
    baseRev: 0,
  },
  write_file: {
    toolCallId: "call",
    action: "write_file",
    path: "notes/b.md",
    resolved: "~/project/notes/b.md",
    cwd: "~/project",
    change: { bytes: 3, lines: 1, overwrite: false },
    baseRev: 0,
  },
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
  shelf_add: {
    toolCallId: "call",
    action: "shelf_add",
    workId: "doi:10.1/x",
    label: "A paper",
    request: {
      workId: "doi:10.1/x",
      docs: [{ docId: "d_1", annotationIds: ["a1"] }],
      argumentGraph: false,
      note: false,
    },
    carried: {
      docs: [{ docId: "d_1", kind: "latex", annotations: 1 }],
      argumentGraph: false,
      note: false,
    },
    notCarried: [],
    wouldArchive: [],
    impact: null,
    baseRev: 0,
    objectDigest: SHELF_ADD_DIGEST,
  },
  shelf_take: {
    toolCallId: "call",
    action: "shelf_take",
    entryId: ENTRY,
    label: "A paper",
    request: { rev: 2, argumentGraph: true, note: true },
    plan: {
      work: { id: "doi:10.1/x", title: "A paper", created: true, citeKey: "doe2021", filled: [] },
      mainDoc: { before: null, after: "d_1", changed: true },
      docs: {
        taken: [{ docId: "d_1", kind: "latex", annotations: 1, stamped: false }],
        skipped: [],
      },
      argumentGraph: "not_carried",
      note: "not_carried",
    },
    planDigest: sha("c"),
    baseRev: 2,
    objectDigest: sha("c"),
  },
  shelf_delete: {
    toolCallId: "call",
    action: "shelf_delete",
    entryId: ENTRY,
    label: "A paper",
    status: "ok",
    entry: {
      entryId: ENTRY,
      rev: 2,
      title: "A paper",
      addedAt: "2026-10-23T00:00:00.000Z",
      sourceProject: "/projects/a",
      docs: [{ docId: "d_1", kind: "latex", bytes: 10 }],
      annotations: 1,
      argumentGraph: false,
      note: false,
    },
    baseRev: 2,
    objectDigest: SHELF_DELETE_DIGEST,
  },
};

let describe_: ReturnType<typeof vi.fn>;
let describeSource: ReturnType<typeof vi.fn>;
let probeReplacement: ReturnType<typeof vi.fn>;
let addPreview: ReturnType<typeof vi.fn>;
let takePreview: ReturnType<typeof vi.fn>;
let shelfList: ReturnType<typeof vi.fn>;
let kinds: ConfirmationKinds;
const workbench = () =>
  ({
    plans: { statusDir: "/status" },
    writer: {},
    library: { deletion: { describe: describe_ }, acquisition: { describeSource } },
    text: { probeReplacement },
    mail: {},
    argument: {},
    shelf: {
      writer: { preview: addPreview },
      take: { preview: takePreview },
      list: shelfList,
    },
  }) as unknown as Workbench;
const kindOf = (action: ConfirmationAction) => kinds[action] as ConfirmationKind;
/** The card the host shows for one request (the host's own assembly). */
const cardOf = <A extends ConfirmationAction>(action: A, id = "c1") =>
  confirmationCard(kindOf(action), id, "r1", requests[action]);
const checkOf = <A extends ConfirmationAction>(action: A) =>
  kindOf(action).check(cardOf(action) as never);

beforeEach(() => {
  for (const read of Object.values(reads)) read.mockReset();
  describe_ = vi.fn();
  describeSource = vi.fn();
  probeReplacement = vi.fn();
  addPreview = vi.fn();
  takePreview = vi.fn();
  shelfList = vi.fn();
  kinds = createConfirmationKinds(workbench());
});

test("shelf_add: previews the card's own request again; valid on the same preview, changed on a refusal or another preview, an error on a server failure", async () => {
  const body = { impact: null, carried: requests.shelf_add.carried, notCarried: [] };
  addPreview.mockResolvedValue({ status: 200, body });
  reads.shelfAddDigest.mockReturnValue(SHELF_ADD_DIGEST);
  expect(await checkOf("shelf_add")).toBe("valid");
  // the request previewed is the one on the card, never another
  expect(addPreview).toHaveBeenCalledWith(requests.shelf_add.request);
  expect(reads.shelfAddDigest).toHaveBeenCalledWith(requests.shelf_add.request, body);
  reads.shelfAddDigest.mockReturnValue("an annotation was deleted meanwhile");
  expect(await checkOf("shelf_add")).toBe("changed");
  for (const status of [404, 409, 400])
    addPreview.mockResolvedValueOnce({ status, body: { code: "x", detail: "refused" } });
  for (let i = 0; i < 3; i++) expect(await checkOf("shelf_add")).toBe("changed");
  addPreview.mockResolvedValue({
    status: 500,
    body: { code: "item_unreadable", detail: "doc d_1 unreadable" },
  });
  expect(await checkOf("shelf_add")).toEqual({ error: "doc d_1 unreadable" });
  addPreview.mockRejectedValue(new Error("EIO"));
  expect(await checkOf("shelf_add")).toEqual({ error: "EIO" });
});

test("shelf_take: previews the card's own request again; valid on the same plan digest, changed otherwise, an error on a server failure", async () => {
  takePreview.mockResolvedValue({ ok: true, preview: { plan: {}, planDigest: sha("c") } });
  expect(await checkOf("shelf_take")).toBe("valid");
  expect(takePreview).toHaveBeenCalledWith(ENTRY, requests.shelf_take.request);
  takePreview.mockResolvedValue({ ok: true, preview: { plan: {}, planDigest: sha("d") } });
  expect(await checkOf("shelf_take")).toBe("changed");
  takePreview.mockResolvedValue({
    ok: false,
    status: 409,
    body: { code: "changed", detail: "replaced" },
  });
  expect(await checkOf("shelf_take")).toBe("changed");
  takePreview.mockResolvedValue({
    ok: false,
    status: 404,
    body: { code: "not_found", detail: "gone" },
  });
  expect(await checkOf("shelf_take")).toBe("changed");
  takePreview.mockResolvedValue({
    ok: false,
    status: 500,
    body: { code: "shelf_unreadable", detail: "the Shelf could not be read" },
  });
  expect(await checkOf("shelf_take")).toEqual({ error: "the Shelf could not be read" });
});

test("shelf_delete: valid while the entry is listed at the rev and with the row shown, changed otherwise, an error when the Shelf cannot be read", async () => {
  const row = { status: "ok", entryId: ENTRY, rev: 2 };
  shelfList.mockResolvedValue([row]);
  reads.shelfDeleteDigest.mockReturnValue(SHELF_DELETE_DIGEST);
  expect(await checkOf("shelf_delete")).toBe("valid");
  expect(reads.shelfDeleteDigest).toHaveBeenCalledWith(row);
  shelfList.mockResolvedValue([{ ...row, rev: 3 }]);
  expect(await checkOf("shelf_delete")).toBe("changed");
  shelfList.mockResolvedValue([]);
  expect(await checkOf("shelf_delete")).toBe("changed");
  shelfList.mockResolvedValue([row]);
  reads.shelfDeleteDigest.mockReturnValue("another row");
  expect(await checkOf("shelf_delete")).toBe("changed");
  shelfList.mockRejectedValue(new Error("EACCES"));
  expect(await checkOf("shelf_delete")).toEqual({ error: "EACCES" });
  // the entry could not be looked at (a system error kept it from being read): not a change (票 07 B2)
  shelfList.mockResolvedValue([
    { status: "unreadable", entryId: ENTRY, rev: 2, bytes: 0, code: "EACCES" },
  ]);
  expect(await checkOf("shelf_delete")).toEqual({
    error: "the Shelf entry could not be looked at (EACCES)",
  });
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
    "shelf_add",
    "shelf_take",
    "shelf_delete",
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
    shelf_add: [null, false],
    shelf_take: [null, false],
    shelf_delete: [null, false],
    run_command: [null, false],
    edit_file: [null, false],
    write_file: [null, false],
  });
  for (const [action, kind] of Object.entries(kinds)) expect(kind.action).toBe(action);
});

test("records and resume lines keep their fields and wording", () => {
  const card = cardOf("delete_mail");
  expect(card.object).toEqual({ kind: "mail_message", id: "acc:INBOX:7", accountId: "acc" });
  expect(confirmationRecord(kindOf("delete_mail"), card, "resolved", "approved")).toMatchObject({
    action: "delete_mail",
    accountId: "acc",
    folder: "INBOX",
    uid: 7,
  });
  expect(confirmationRecord(kindOf("move_mail"), cardOf("move_mail"), "requested")).toMatchObject({
    action: "move_mail",
    accountId: "acc",
    folder: "INBOX",
    uid: 7,
  });
  const refresh = cardOf("refresh_arxiv_source");
  expect(
    confirmationRecord(kindOf("refresh_arxiv_source"), refresh, "resolved", "declined")
  ).toMatchObject({ action: "refresh_arxiv_source", workId: "w_1", docId: "d_1" });
  const replaced = cardOf("replace_argument_graph");
  expect(replaced.object).toEqual({ kind: "work", id: "doi:10.1/x", workId: "doi:10.1/x" });
  for (const record of [
    confirmationRecord(kindOf("replace_argument_graph"), replaced, "requested"),
    confirmationRecord(kindOf("replace_argument_graph"), replaced, "resolved", "expired"),
  ])
    expect(record).toMatchObject({ action: "replace_argument_graph", workId: "doi:10.1/x" });
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

test("file and command cards: nothing on disk to recheck, the record keeps no command and no path, and the allowance class is per kind", async () => {
  const run = cardOf("run_command");
  expect(run).toMatchObject({
    action: "run_command",
    object: { kind: "command", id: "call" },
    shell: "bash",
    command: "ls -la",
    cwd: "~/project",
  });
  const own = (record: OperationConfirmation) => {
    const { version, phase, confirmationId, runId, toolCallId, baseRev, outcome, ...rest } =
      record as OperationConfirmation & { outcome?: string };
    void [version, phase, confirmationId, runId, toolCallId, baseRev, outcome];
    return rest;
  };
  expect(own(confirmationRecord(kindOf("run_command"), run, "requested"))).toEqual({
    action: "run_command",
  });
  expect(own(confirmationRecord(kindOf("run_command"), run, "resolved", "approved"))).toEqual({
    action: "run_command",
  });
  const edit = cardOf("edit_file", "c2");
  expect(own(confirmationRecord(kindOf("edit_file"), edit, "requested"))).toEqual({
    action: "edit_file",
  });
  const resolvedEdit = JSON.stringify(
    confirmationRecord(kindOf("edit_file"), edit, "resolved", "declined")
  );
  expect(resolvedEdit).not.toContain("notes");
  expect(JSON.stringify(confirmationRecord(kindOf("run_command"), run, "requested"))).not.toContain(
    "ls -la"
  );
  expect(await kinds.run_command.check(run as never)).toBe("valid");
  expect(await kinds.write_file.check(cardOf("write_file", "c3") as never)).toBe("valid");
  expect(kinds.run_command.remembers).toBe("command");
  expect(kinds.edit_file.remembers).toBe("write");
  expect(kinds.write_file.remembers).toBe("write");
  expect(kinds.delete_plan.remembers).toBeUndefined();
});

// ---- the shared assembly against the golden of the code before ticket 07 ----------------------------------------- //

type Golden = {
  confirmationId: string;
  runId: string;
  requests: Record<ConfirmationAction, ConfirmationRequest>;
  cards: Record<ConfirmationAction, Record<string, unknown>>;
  records: Record<
    ConfirmationAction,
    { requested: string; approved: string; declined: string; expired: string }
  >;
};
const golden: Golden = JSON.parse(
  readFileSync(new URL("./fixtures/confirmation-golden.json", import.meta.url), "utf8")
);
const schemaKeys = (action: string) => {
  const schema = CopilotConfirmationSchema.options.find(
    (card) => card.shape.action.value === action
  );
  return Object.keys(schema?.shape ?? {}).sort();
};

test("every card is the golden card by value, with exactly the keys of its card schema", () => {
  expect(Object.keys(golden.requests).sort()).toEqual(Object.keys(kinds).sort());
  for (const [action, request] of Object.entries(golden.requests) as [
    ConfirmationAction,
    ConfirmationRequest,
  ][]) {
    const card = confirmationCard(kindOf(action), golden.confirmationId, golden.runId, request);
    expect(card, action).toEqual(golden.cards[action]);
    expect(Object.keys(card).sort(), action).toEqual(schemaKeys(action));
  }
  // the object, value for value: the mail message's compound id and the tool call as a file or command id
  expect(golden.cards.delete_mail.object).toEqual({
    kind: "mail_message",
    id: "acc:INBOX:7",
    accountId: "acc",
  });
  expect(golden.cards.move_mail.object).toMatchObject({ id: "acc:INBOX:7" });
  expect(golden.cards.run_command.object).toEqual({ kind: "command", id: "call_cmd" });
  expect(golden.cards.edit_file.object).toEqual({ kind: "file", id: "call_edit" });
  expect(golden.cards.write_file.object).toEqual({ kind: "file", id: "call_write" });
});

test("every requested and resolved record is byte for byte the golden record and parses as the record schema", () => {
  for (const [action, request] of Object.entries(golden.requests) as [
    ConfirmationAction,
    ConfirmationRequest,
  ][]) {
    const kind = kindOf(action);
    const card = confirmationCard(kind, golden.confirmationId, golden.runId, request);
    const want = golden.records[action];
    expect(JSON.stringify(confirmationRecord(kind, card, "requested")), action).toBe(
      want.requested
    );
    for (const outcome of ["approved", "declined", "expired"] as const)
      expect(JSON.stringify(confirmationRecord(kind, card, "resolved", outcome)), action).toBe(
        want[outcome]
      );
    for (const line of Object.values(want)) {
      const parsed = OperationConfirmationSchema.safeParse(JSON.parse(line));
      expect(parsed.success, action).toBe(true);
    }
  }
});

test("records already on disk read back to the same resume lines (the golden corpus, one pair per action)", () => {
  const lines = Object.fromEntries(
    (Object.keys(golden.records) as ConfirmationAction[]).map((action) => {
      const record = JSON.parse(golden.records[action].requested) as OperationConfirmation;
      const resolved = JSON.parse(golden.records[action].declined) as OperationConfirmation;
      // the line is told from the record alone: the requested and the resolved record say the same
      expect(kindOf(action).askedLine(resolved as never)).toBe(
        kindOf(action).askedLine(record as never)
      );
      return [action, kindOf(action).askedLine(record as never)];
    })
  );
  expect(lines).toEqual({
    send_mail: "send_mail acc <m@x>",
    delete_mail: "delete_mail acc INBOX uid 7",
    move_mail: "move_mail acc INBOX uid 7",
    replace_text_reading: "replace_text_reading t_doc",
    delete_plan: "delete_plan p_0000000a",
    refresh_arxiv_source: "refresh_arxiv_source w_1 d_1",
    delete_doc: "delete_doc d_1",
    replace_argument_graph: "replace_argument_graph doi:10.1/x",
    run_command: "run_command",
    edit_file: "edit_file",
    write_file: "write_file",
    delete_manuscript: "delete_manuscript m_1",
    shelf_add: "shelf_add doi:10.1/x",
    shelf_take: "shelf_take 0123456789abcdef0123456789abcdef",
    shelf_delete: "shelf_delete 0123456789abcdef0123456789abcdef",
  });
});

test("a key the request carries beyond its card schema never reaches the card", () => {
  const card = confirmationCard(kindOf("delete_doc"), golden.confirmationId, golden.runId, {
    ...requests.delete_doc,
    secret: "not for the page",
  } as ConfirmationRequest);
  expect(card).not.toHaveProperty("secret");
  // the flat identifier is the object's, not a card field
  expect(card).not.toHaveProperty("docId");
  expect(card.object).toEqual({ kind: "doc", id: "d_1" });
});
