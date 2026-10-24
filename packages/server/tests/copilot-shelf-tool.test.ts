/**
 * The Copilot `shelf` tool (shelf ticket 07) on its own seam, against scripted Shelf ports: what it sends after the
 * user's click and how it reads the answers. The end-to-end paths are copilot-shelf.test.ts; this file covers the
 * moments a real server cannot be made to hit on cue (a change between the click and the write).
 */
import type { ShelfListRow } from "@argelanderspace/contracts";
import { expect, test, vi } from "vitest";
import { createShelfTool, type ShelfOpDeps, shelfDeleteDigest } from "../src/copilot-shelf-tool.js";
import type { ConfirmationOutcome } from "../src/copilot-tool-kit.js";

const ENTRY = "0123456789abcdef0123456789abcdef";
const WORK = "doi:10.1234/shelf-a";
const okRow: ShelfListRow = {
  status: "ok",
  entryId: ENTRY,
  rev: 2,
  bytes: 10,
  addedAt: "2026-10-23T00:00:00.000Z",
  source: { project: "/p", workId: WORK },
  identity: { doi: "10.1234/shelf-a", arxiv: null, openalex: null },
  title: "A",
  authors: [],
  year: null,
  docs: [{ docId: "paper-a", kind: "latex", bytes: 10, annotations: 1 }],
  annotations: 1,
  argumentGraph: false,
  argumentCount: null,
  note: false,
};
const preview = {
  impact: null,
  carried: {
    docs: [{ docId: "paper-a", kind: "latex", annotations: 1 }],
    argumentGraph: false,
    note: false,
  },
  notCarried: [],
  wouldArchive: [],
};

function tool(shelf: Partial<ShelfOpDeps>, onAsk: () => void = () => {}) {
  const deps: ShelfOpDeps = {
    writer: {
      add: vi.fn(),
      preview: vi.fn(async () => ({ status: 200 as const, body: preview })),
      remove: vi.fn(),
    },
    take: { take: vi.fn(), preview: vi.fn() } as never,
    list: vi.fn(async () => [okRow]),
    work: () => ({ id: WORK, title: "A", docIds: ["paper-a"] }),
    ...shelf,
  };
  const confirm = {
    request: vi.fn(async (): Promise<ConfirmationOutcome> => {
      onAsk();
      return { outcome: "approved" };
    }),
  };
  const made = createShelfTool({ admitting: () => true, confirm, shelf: deps });
  const run = async (params: Record<string, unknown>) => {
    const out = await (
      made as unknown as {
        execute(id: string, p: unknown): Promise<{ content: { text: string }[] }>;
      }
    ).execute("call_1", params);
    return JSON.parse(out.content[0]?.text ?? "{}");
  };
  return { deps, confirm, run };
}

test("delete: an entry that could not be looked at when checked after the click is a system error, never a change, and nothing is deleted", async () => {
  let rows: ShelfListRow[] = [okRow];
  const { deps, run } = tool({ list: vi.fn(async () => rows) }, () => {
    rows = [{ status: "unreadable", entryId: ENTRY, rev: 2, bytes: 0, code: "EACCES" }];
  });
  const result = await run({ action: "delete", entryId: ENTRY, rev: 2 });
  expect(result).toMatchObject({ ok: false, status: "error" });
  expect(result.detail).toContain("EACCES");
  expect(result.detail).toContain("not a change");
  expect(deps.writer.remove).not.toHaveBeenCalled();
});

test("add: the write is bound to the preview the card showed (an in-process expectation), and one that no longer holds is expired with nothing written", async () => {
  const add = vi.fn(async () => ({
    status: 409 as const,
    body: {
      code: "carried_changed",
      detail: "what would go in is not what was confirmed; nothing was written to the Shelf",
      archived: [],
    },
  }));
  const { run } = tool({
    writer: {
      add,
      preview: vi.fn(async () => ({ status: 200 as const, body: preview })),
      remove: vi.fn(),
    },
  });
  const result = await run({
    action: "add",
    workId: WORK,
    annotations: { "paper-a": ["a_00000001"] },
  });
  expect(add).toHaveBeenCalledTimes(1);
  expect(add.mock.calls[0]).toEqual([
    {
      workId: WORK,
      docs: [{ docId: "paper-a", annotationIds: ["a_00000001"] }],
      argumentGraph: false,
      note: false,
    },
    { expect: preview },
  ]);
  expect(result).toMatchObject({ ok: false, status: "expired", code: "carried_changed" });
  expect(result.detail).toContain("nothing was written to the Shelf");
});

test("add: a confirmation refused by the server keeps the server's own detail (and its archive report)", async () => {
  const detail =
    "the Shelf changed since the replacement was confirmed; nothing was written Before it stopped, the annotations access path archived …";
  const add = vi.fn(async () => ({
    status: 409 as const,
    body: { code: "confirmation_changed", detail, archived: [{ docId: "paper-a", count: 2 }] },
  }));
  const { run } = tool({
    writer: {
      add,
      preview: vi.fn(async () => ({ status: 200 as const, body: preview })),
      remove: vi.fn(),
    },
  });
  const result = await run({ action: "add", workId: WORK });
  expect(result).toMatchObject({ status: "expired", archived: [{ docId: "paper-a", count: 2 }] });
  expect(result.detail).toContain(detail);
});

test('a delete card is not bound to the argument count: a graph read failing at the click is not "the entry changed"', () => {
  const counted = { ...okRow, argumentCount: 3 } as ShelfListRow;
  const unknown = { ...okRow, argumentCount: null } as ShelfListRow;
  expect(shelfDeleteDigest(unknown)).toBe(shelfDeleteDigest(counted));
  // what the card does show still binds it
  expect(shelfDeleteDigest({ ...okRow, rev: okRow.rev + 1 } as ShelfListRow)).not.toBe(
    shelfDeleteDigest(okRow)
  );
});
