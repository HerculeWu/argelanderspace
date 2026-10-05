import { describe, expect, it } from "vitest";
import { PageContextSchema } from "../src/copilot.js";
import { copilotContextObjects } from "../src/reader-ops.js";
import { ManuscriptSchema, type WriterManuscript } from "../src/writer.js";
import {
  diffManuscriptDraft,
  observationWriterPage,
  rebaseManuscriptDraft,
  summarizeWriterPage,
  WriterDeleteOperationSchema,
  type WriterPage,
  WriterViewActionSchema,
  WriterWriteOperationSchema,
  writerKey,
} from "../src/writer-ops.js";

const manuscript = (extra: Record<string, unknown> = {}): WriterManuscript =>
  ManuscriptSchema.parse({
    version: 1,
    id: "m_0123abcd",
    rev: 3,
    template: "report",
    title: "Base title",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    cells: [
      { id: "c_00000001", type: "latex", data: { source: "one" } },
      { id: "c_00000002", type: "latex", data: { source: "two", extraKey: "kept" } },
    ],
    comments: [],
    futureKey: { a: 1 },
    ...extra,
  });

const withCells = (m: WriterManuscript, cells: unknown[]): WriterManuscript =>
  ({ ...m, cells }) as WriterManuscript;

describe("diffManuscriptDraft", () => {
  it("is null when the content is the same, even if rev or updated_at differ", () => {
    const base = manuscript();
    expect(
      diffManuscriptDraft(base, { ...base, rev: 9, updated_at: "2027-01-01T00:00:00.000Z" })
    ).toBeNull();
  });

  it("names only what differs: fields (unknown keys too), changed/new/removed cells and comments", () => {
    const base = manuscript();
    const local = withCells({ ...base, title: "Typed", futureKey: { a: 2 } } as WriterManuscript, [
      { id: "c_00000001", type: "latex", data: { source: "one edited" } },
      { id: "c_00000003", type: "latex", data: { source: "new" } },
    ]);
    local.comments = [
      {
        id: "cm_00000001",
        cell: "c_00000001",
        who: "You",
        body: "n",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    const draft = diffManuscriptDraft(base, ManuscriptSchema.parse(local));
    expect(draft?.fields).toEqual({ title: "Typed", futureKey: { a: 2 } });
    expect(draft?.cells.changed.map((c) => c.id)).toEqual(["c_00000001", "c_00000003"]);
    expect(draft?.cells.removed).toEqual(["c_00000002"]);
    expect(draft?.cells.order).toEqual(["c_00000001", "c_00000003"]);
    expect(draft?.comments.added.map((c) => c.id)).toEqual(["cm_00000001"]);
  });
});

describe("rebaseManuscriptDraft keeps the user's unsaved edits over a newer save", () => {
  it("keeps the typed cell and takes the agent's change to a cell the user did not touch", () => {
    const base = manuscript();
    const local = ManuscriptSchema.parse(
      withCells(base, [
        { id: "c_00000001", type: "latex", data: { source: "user typed" } },
        base.cells[1],
      ])
    );
    const current = ManuscriptSchema.parse({
      ...withCells(base, [
        base.cells[0],
        { id: "c_00000002", type: "latex", data: { source: "agent edit", extraKey: "kept" } },
      ]),
      rev: 4,
      title: "Agent title",
    });
    const { merged, contested } = rebaseManuscriptDraft(base, local, current);
    expect(merged.rev).toBe(4);
    expect(merged.title).toBe("Agent title");
    expect((merged.cells[0] as { data: { source: string } }).data.source).toBe("user typed");
    expect((merged.cells[1] as { data: { source: string } }).data.source).toBe("agent edit");
    expect(contested).toEqual([]);
  });

  it("on the same field the user's typing wins and the clash is named", () => {
    const base = manuscript();
    const local = ManuscriptSchema.parse({ ...base, title: "User title" });
    const current = ManuscriptSchema.parse({ ...base, rev: 4, title: "Agent title" });
    const { merged, contested } = rebaseManuscriptDraft(base, local, current);
    expect(merged.title).toBe("User title");
    expect(contested).toEqual(["title"]);
  });

  it("keeps unknown keys the newer save added and puts a new cell behind its neighbour", () => {
    const base = manuscript();
    const local = ManuscriptSchema.parse(
      withCells(base, [
        base.cells[0],
        { id: "c_00000009", type: "latex", data: { source: "mine" } },
        base.cells[1],
      ])
    );
    const current = ManuscriptSchema.parse({ ...base, rev: 4, agentKey: "x" });
    const { merged } = rebaseManuscriptDraft(base, local, current);
    expect(merged.agentKey).toBe("x");
    expect(merged.futureKey).toEqual({ a: 1 });
    expect(merged.cells.map((c) => c.id)).toEqual(["c_00000001", "c_00000009", "c_00000002"]);
  });

  it("a cell the user deleted stays deleted; a user comment is added once", () => {
    const base = manuscript();
    const comment = {
      id: "cm_00000001",
      cell: "c_00000001",
      who: "You",
      body: "n",
      created_at: "2026-01-02T00:00:00.000Z",
    };
    const local = ManuscriptSchema.parse({
      ...withCells(base, [base.cells[0]]),
      comments: [comment],
    });
    const current = ManuscriptSchema.parse({ ...base, rev: 4, comments: [comment] });
    const { merged } = rebaseManuscriptDraft(base, local, current);
    expect(merged.cells.map((c) => c.id)).toEqual(["c_00000001"]);
    expect(merged.comments.map((c) => c.id)).toEqual(["cm_00000001"]);
  });
});

describe("rebase granularity and accuracy (fix round 1)", () => {
  const cell = (id: string, source: string) => ({ id, type: "latex", data: { source } });
  it("B1: a cell the other side deleted but the user edited is kept and reported, not silently resurrected", () => {
    const base = manuscript();
    const local = ManuscriptSchema.parse(
      withCells(base, [{ ...cell("c_00000001", "user edit of one") }, base.cells[1]])
    );
    const current = ManuscriptSchema.parse({ ...withCells(base, [base.cells[1]]), rev: 4 });
    const { merged, contested } = rebaseManuscriptDraft(base, local, current);
    expect(merged.cells.map((c) => c.id)).toEqual(["c_00000001", "c_00000002"]);
    expect(contested).toEqual(["cell c_00000001"]);
  });
  it("B1 symmetric: a cell the user deleted but the other side edited is deleted and reported", () => {
    const base = manuscript();
    const local = ManuscriptSchema.parse(withCells(base, [base.cells[1]]));
    const current = ManuscriptSchema.parse({
      ...withCells(base, [cell("c_00000001", "agent edit"), base.cells[1]]),
      rev: 4,
    });
    const { merged, contested } = rebaseManuscriptDraft(base, local, current);
    expect(merged.cells.map((c) => c.id)).toEqual(["c_00000002"]);
    expect(contested).toEqual(["cell c_00000001"]);
  });
  it("F1: infoValues merge per key; only the same key changed on both sides is contested", () => {
    const base = ManuscriptSchema.parse({ ...manuscript(), infoValues: { a: "a0", b: "b0" } });
    const local = ManuscriptSchema.parse({ ...base, infoValues: { a: "user a", b: "b0" } });
    const current = ManuscriptSchema.parse({
      ...base,
      rev: 4,
      infoValues: { a: "a0", b: "agent b" },
    });
    const disjoint = rebaseManuscriptDraft(base, local, current);
    expect(disjoint.merged.infoValues).toEqual({ a: "user a", b: "agent b" });
    expect(disjoint.contested).toEqual([]);
    const clash = rebaseManuscriptDraft(base, local, {
      ...current,
      infoValues: { a: "agent a", b: "b0" },
    });
    expect(clash.merged.infoValues).toEqual({ a: "user a", b: "b0" });
    expect(clash.contested).toEqual(["infoValues.a"]);
  });
  it("F1: authors merge per element when the lists line up", () => {
    const base = ManuscriptSchema.parse({
      ...manuscript(),
      authors: [
        { name: "A", aff: "1" },
        { name: "B", aff: "1" },
      ],
    });
    const local = ManuscriptSchema.parse({
      ...base,
      authors: [
        { name: "A user", aff: "1" },
        { name: "B", aff: "1" },
      ],
    });
    const current = ManuscriptSchema.parse({
      ...base,
      rev: 4,
      authors: [
        { name: "A", aff: "1" },
        { name: "B agent", aff: "1" },
      ],
    });
    const { merged, contested } = rebaseManuscriptDraft(base, local, current);
    expect(merged.authors.map((a) => a.name)).toEqual(["A user", "B agent"]);
    expect(contested).toEqual([]);
  });
});

describe("agent author patches", () => {
  it("allow only name, aff and email", () => {
    const op = { action: "update_manuscript", manuscriptId: "m_0123abcd", expectedRev: 1 };
    expect(
      WriterWriteOperationSchema.safeParse({ ...op, authors: [{ name: "N", x: 1 }] }).success
    ).toBe(false);
    expect(
      WriterWriteOperationSchema.safeParse({ ...op, authors: [{ name: "N", aff: "1" }] }).success
    ).toBe(true);
  });
});

const editorPage = (over: Partial<NonNullable<WriterPage["editor"]>> = {}): WriterPage => ({
  mode: "editor",
  list: null,
  editor: {
    manuscriptId: "m_0123abcd",
    phase: "ready",
    saved: manuscript(),
    saveState: "saved",
    draft: null,
    template: { id: "report", label: "Report", found: true, types: ["latex"] },
    unsupportedCellIds: [],
    activeCellId: null,
    editingCellId: null,
    caret: null,
    modal: null,
    preview: { status: "never", failed: false, warnings: 0, rendering: false },
    ...over,
  },
});

const context = (writer: WriterPage | null, status: "complete" | "unavailable" | "error") => ({
  version: 1 as const,
  viewId: "7d444840-9dc0-41b0-8b39-8c0d0d6b4a60",
  revision: 1,
  paneId: 1,
  view: "write",
  otherPanes: [],
  status,
  plan: null,
  writer,
});

describe("Writer page context", () => {
  it("is complete only with a loaded list or a loaded manuscript", () => {
    expect(PageContextSchema.safeParse(context(editorPage(), "complete")).success).toBe(true);
    expect(
      PageContextSchema.safeParse(
        context(editorPage({ phase: "loading", saved: null }), "complete")
      ).success
    ).toBe(false);
    expect(
      PageContextSchema.safeParse(
        context(editorPage({ phase: "loading", saved: null }), "unavailable")
      ).success
    ).toBe(true);
    expect(PageContextSchema.safeParse(context(null, "complete")).success).toBe(false);
    const list: WriterPage = {
      mode: "list",
      list: { phase: "ready", manuscripts: [], templates: [] },
      editor: null,
    };
    expect(PageContextSchema.safeParse(context(list, "complete")).success).toBe(true);
  });

  it("names the open manuscript and its revision as the one object, and marks a draft", () => {
    const draft = diffManuscriptDraft(
      manuscript(),
      ManuscriptSchema.parse({ ...manuscript(), title: "Typed" })
    );
    const page = editorPage({ draft });
    expect(copilotContextObjects({ writer: page })).toEqual([{ id: "m_0123abcd", rev: 3 }]);
    expect(summarizeWriterPage(page)).toMatchObject({
      manuscriptId: "m_0123abcd",
      cells: 2,
      draft: true,
      rev: 3,
    });
  });

  it("an observation leaves a held manuscript out but keeps the draft", () => {
    const draft = diffManuscriptDraft(
      manuscript(),
      ManuscriptSchema.parse({ ...manuscript(), title: "Typed" })
    );
    const page = { writer: editorPage({ draft }) };
    const held = observationWriterPage(page, new Set([writerKey("m_0123abcd", 3)]));
    expect(held.writer?.editor?.saved).toBeNull();
    expect(held.writer?.editor?.savedOmitted?.note).toContain("in the task's context");
    expect(held.writer?.editor?.draft?.fields).toEqual({ title: "Typed" });
    const unheld = observationWriterPage(page, new Set());
    expect(unheld.writer?.editor?.savedOmitted?.note).toContain("not in the task's context");
  });
});

describe("Writer operations", () => {
  it("an update names its manuscript, rev and at least one field; no cell or unknown field", () => {
    const ok = {
      action: "update_manuscript",
      manuscriptId: "m_0123abcd",
      expectedRev: 3,
      title: "T",
    };
    expect(WriterWriteOperationSchema.safeParse(ok).success).toBe(true);
    expect(WriterWriteOperationSchema.safeParse({ ...ok, title: undefined }).success).toBe(false);
    expect(WriterWriteOperationSchema.safeParse({ ...ok, expectedRev: undefined }).success).toBe(
      false
    );
    expect(WriterWriteOperationSchema.safeParse({ ...ok, cells: [] }).success).toBe(false);
    expect(WriterWriteOperationSchema.safeParse({ ...ok, manuscriptId: "../x" }).success).toBe(
      false
    );
  });

  it("delete is not a write operation and view actions carry no data", () => {
    expect(
      WriterWriteOperationSchema.safeParse({
        action: "delete_manuscript",
        manuscriptId: "m_0123abcd",
        expectedRev: 1,
      }).success
    ).toBe(false);
    expect(
      WriterDeleteOperationSchema.safeParse({
        action: "delete_manuscript",
        manuscriptId: "m_0123abcd",
        expectedRev: 1,
      }).success
    ).toBe(true);
    expect(
      WriterViewActionSchema.safeParse({ action: "open_manuscript", manuscriptId: "m_0123abcd" })
        .success
    ).toBe(true);
    expect(WriterViewActionSchema.safeParse({ action: "close_manuscript", x: 1 }).success).toBe(
      false
    );
  });
});
