/**
 * Writer cell operations on the shared business seam (copilot ticket 23): the same lock, rev check, narrow write and
 * notification the page's routes use, driven directly with a real dataDir. The tool/Pi/HTTP end-to-end is in
 * copilot-writer-cells.test.ts.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WriterManuscript, WriterNumberingResponse } from "@argelanderspace/contracts";
import { beforeEach, describe, expect, test } from "vitest";
import { AsyncLock } from "../src/lock.js";
import {
  cellOperation,
  createManuscriptOp,
  patchManuscript,
  readWriter,
  renderManuscript,
  type WriterOpDeps,
} from "../src/writer-actions.js";

const M = "m_0000000a";
let dataDir: string;
let changed: string[];
let deps: WriterOpDeps;

const file = () => join(dataDir, "manuscripts", M, "manuscript.json");
const disk = (): WriterManuscript => JSON.parse(readFileSync(file(), "utf8"));
const seed = (over: Partial<WriterManuscript> = {}) => ({
  version: 1,
  id: M,
  rev: 3,
  template: "report",
  title: "Alpha",
  authors: [{ name: "A. Author", aff: "1" }],
  affiliations: ["Somewhere"],
  userPreamble: "",
  infoValues: {},
  cells: [
    {
      id: "c_00000001",
      type: "latex",
      data: { source: "\\section{One}\nHello", x_data: "keep" },
      x_cell: "keep",
    },
    {
      id: "c_00000002",
      type: "figure",
      data: { caption: "Cap", label: "", placement: "center", width: 80, image: null },
    },
    { id: "c_00000003", type: "recipient", data: { name: "N" } },
  ],
  comments: [
    {
      id: "cm_00000001",
      cell: "c_00000001",
      who: "You",
      body: "keep me",
      created_at: "2026-10-01T00:00:00.000Z",
      x_note: 1,
    },
  ],
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  x_top: { future: true },
  ...over,
});
const put = (doc: object) => {
  mkdirSync(join(dataDir, "manuscripts", M), { recursive: true });
  writeFileSync(file(), JSON.stringify(doc, null, 2));
};
const base = { manuscriptId: M, expectedRev: 3 };

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "writer-cells-"));
  changed = [];
  deps = {
    dataDir,
    writerLock: new AsyncLock(),
    changed: (cause, id) => changed.push(`${cause}:${id}`),
    cancelCompile: async () => {},
    citeKeys: () => new Set(["smith2020", "bad key"]),
  };
  put(seed());
});

describe("insert_cell / update_cell / delete_cell / convert_cell", () => {
  test("insert: a type the template lists, at an index, with defaults and the given fields; rev bumps once, unknown keys stay", async () => {
    const before = disk();
    const out = await cellOperation(deps, {
      action: "insert_cell",
      ...base,
      cellType: "table",
      index: 1,
      fields: { csv: "a,b", caption: "T" },
    });
    expect(out).toMatchObject({ ok: true, status: "ok", rev: 4 });
    const after = disk();
    expect(after.rev).toBe(4);
    expect(after.cells.map((c) => c.type)).toEqual(["latex", "table", "figure", "recipient"]);
    const made = after.cells[1] as unknown as { id: string; data: Record<string, unknown> };
    expect(made.id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(made.data).toMatchObject({ csv: "a,b", caption: "T", placement: "center", width: 92 });
    expect(after.cells[0]).toEqual(before.cells[0]);
    expect(after.x_top).toEqual({ future: true });
    expect(after.comments).toEqual(before.comments);
    expect(changed).toEqual([`put:${M}`]);
  });

  test("insert: a type the bound template does not list, a bad index and fields of another type are invalid and write nothing", async () => {
    const bytes = readFileSync(file(), "utf8");
    // report lists latex/figure/table/code/ack/appendix, not abstract-aa
    expect(
      await cellOperation(deps, { action: "insert_cell", ...base, cellType: "abstract-aa" })
    ).toMatchObject({ ok: false, status: "invalid" });
    expect(
      await cellOperation(deps, { action: "insert_cell", ...base, cellType: "latex", index: 9 })
    ).toMatchObject({ ok: false, status: "invalid" });
    expect(
      await cellOperation(deps, {
        action: "insert_cell",
        ...base,
        cellType: "latex",
        fields: { caption: "x" },
      })
    ).toMatchObject({ ok: false, status: "invalid" });
    expect(readFileSync(file(), "utf8")).toBe(bytes);
    expect(changed).toEqual([]);
  });

  test("update: only that type's fields; the other fields, unknown keys and other cells stay; the same value is noop", async () => {
    const out = await cellOperation(deps, {
      action: "update_cell",
      ...base,
      cellId: "c_00000001",
      fields: { source: "New text" },
    });
    expect(out).toMatchObject({ ok: true, status: "ok", rev: 4 });
    const cell = disk().cells[0] as unknown as { data: Record<string, unknown>; x_cell: string };
    expect(cell.data).toEqual({ source: "New text", x_data: "keep" });
    expect(cell.x_cell).toBe("keep");
    const again = await cellOperation(deps, {
      action: "update_cell",
      ...base,
      expectedRev: 4,
      cellId: "c_00000001",
      fields: { source: "New text" },
    });
    expect(again).toMatchObject({ ok: true, status: "noop", rev: 4 });
    expect(disk().rev).toBe(4);
    // the figure's image is not a form field
    expect(
      await cellOperation(deps, {
        action: "update_cell",
        ...base,
        expectedRev: 4,
        cellId: "c_00000002",
        fields: { image: "a.png" },
      })
    ).toMatchObject({ ok: false, status: "invalid" });
    expect(
      await cellOperation(deps, {
        action: "update_cell",
        ...base,
        expectedRev: 4,
        cellId: "c_00000009",
        fields: { source: "x" },
      })
    ).toMatchObject({ ok: false, status: "not_found" });
  });

  test("delete removes the cell and leaves its comments (the page does the same)", async () => {
    const out = await cellOperation(deps, { action: "delete_cell", ...base, cellId: "c_00000001" });
    expect(out).toMatchObject({ ok: true, status: "ok" });
    const after = disk();
    expect(after.cells.map((c) => c.id)).toEqual(["c_00000002", "c_00000003"]);
    expect(after.comments).toHaveLength(1);
  });

  test("convert is lossy by design: to latex keeps the serialized source, to another type starts from defaults; an unoffered type is invalid", async () => {
    const toLatex = await cellOperation(deps, {
      action: "convert_cell",
      ...base,
      cellId: "c_00000002",
      cellType: "latex",
    });
    expect(toLatex).toMatchObject({ ok: true, status: "ok", detail: { lossy: false } });
    expect(
      String((disk().cells[1] as unknown as { data: { source: string } }).data.source)
    ).toContain("\\caption{Cap}");
    const toTable = await cellOperation(deps, {
      action: "convert_cell",
      ...base,
      expectedRev: 4,
      cellId: "c_00000001",
      cellType: "table",
    });
    expect(toTable).toMatchObject({ ok: true, status: "ok", detail: { lossy: true } });
    const t = disk().cells[0] as unknown as {
      type: string;
      data: Record<string, unknown>;
      x_cell: string;
    };
    expect(t.type).toBe("table");
    expect(t.data.csv).toBe(""); // the old source is gone, as in the page
    expect(t.x_cell).toBe("keep"); // the cell's own unknown keys stay
    expect(
      await cellOperation(deps, {
        action: "convert_cell",
        ...base,
        expectedRev: 5,
        cellId: "c_00000003",
        cellType: "abstract-aa",
      })
    ).toMatchObject({ ok: false, status: "invalid" });
  });
});

describe("rev checking (A06) and unknown keys", () => {
  test("a stale rev changes nothing; after rereading, the same edit lands on top of the user's save", async () => {
    // the user saves first (whole-document autosave semantics: rev 3 -> 4)
    const doc = disk();
    doc.rev = 4;
    doc.title = "User title";
    put(doc);
    const bytes = readFileSync(file(), "utf8");
    const stale = await cellOperation(deps, {
      action: "update_cell",
      ...base,
      cellId: "c_00000001",
      fields: { source: "Agent text" },
    });
    expect(stale).toMatchObject({ ok: false, status: "conflict", currentRev: 4 });
    expect(readFileSync(file(), "utf8")).toBe(bytes);
    const retried = await cellOperation(deps, {
      action: "update_cell",
      ...base,
      expectedRev: 4,
      cellId: "c_00000001",
      fields: { source: "Agent text" },
    });
    expect(retried).toMatchObject({ ok: true, rev: 5 });
    expect(disk().title).toBe("User title");
  });

  test("a damaged file is reported and left byte for byte", async () => {
    writeFileSync(file(), "{ not json");
    const out = await cellOperation(deps, { action: "delete_cell", ...base, cellId: "c_00000001" });
    expect(out).toMatchObject({ ok: false, status: "error" });
    expect(readFileSync(file(), "utf8")).toBe("{ not json");
  });

  test("two edits at once through the lock both land (no lost update)", async () => {
    const [a, b] = await Promise.all([
      cellOperation(deps, {
        action: "update_cell",
        ...base,
        cellId: "c_00000001",
        fields: { source: "A" },
      }),
      cellOperation(deps, {
        action: "update_cell",
        ...base,
        cellId: "c_00000001",
        fields: { source: "B" },
      }),
    ]);
    // one wins, the other is stale; never both written over each other
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(disk().rev).toBe(4);
  });
});

describe("comments and references", () => {
  test("add_comment appends a plain-text note by the page's own author name and keeps the earlier ones byte for byte", async () => {
    const before = disk();
    const out = await cellOperation(deps, {
      action: "add_comment",
      ...base,
      cellId: "c_00000002",
      body: "  Check this  ",
    });
    expect(out).toMatchObject({ ok: true, status: "ok" });
    const after = disk();
    expect(after.comments[0]).toEqual(before.comments[0]);
    expect(after.comments[1]).toMatchObject({ cell: "c_00000002", who: "You", body: "Check this" });
    expect(after.comments[1]?.id).toMatch(/^cm_[0-9a-f]{8}$/);
    expect(
      await cellOperation(deps, {
        action: "add_comment",
        ...base,
        expectedRev: 4,
        cellId: "c_000000ff",
        body: "x",
      })
    ).toMatchObject({ ok: false, status: "not_found" });
  });

  test("a cite key is inserted bare at the offset, only if the library holds it", async () => {
    const out = await cellOperation(deps, {
      action: "insert_reference",
      ...base,
      cellId: "c_00000001",
      field: "source",
      offset: 5,
      kind: "cite",
      text: "smith2020",
    });
    expect(out).toMatchObject({
      ok: true,
      status: "ok",
      detail: { inserted: "smith2020", offsetAfter: 14 },
    });
    expect((disk().cells[0] as unknown as { data: { source: string } }).data.source).toBe(
      "\\sect" + "smith2020" + "ion{One}\nHello"
    );
    const unknown = await cellOperation(deps, {
      action: "insert_reference",
      ...base,
      expectedRev: 4,
      cellId: "c_00000001",
      field: "source",
      offset: 0,
      kind: "cite",
      text: "nobody1999",
    });
    expect(unknown).toMatchObject({ ok: false, status: "invalid" });
    // a key that is in the library but cannot be written bare
    expect(
      await cellOperation(deps, {
        action: "insert_reference",
        ...base,
        expectedRev: 4,
        cellId: "c_00000001",
        field: "source",
        offset: 0,
        kind: "cite",
        text: "bad key",
      })
    ).toMatchObject({ ok: false, status: "invalid" });
    expect(
      await cellOperation(deps, {
        action: "insert_reference",
        ...base,
        expectedRev: 4,
        cellId: "c_00000001",
        field: "source",
        offset: 999,
        kind: "cite",
        text: "smith2020",
      })
    ).toMatchObject({ ok: false, status: "invalid" });
    expect(
      await cellOperation(deps, {
        action: "insert_reference",
        ...base,
        expectedRev: 4,
        cellId: "c_00000001",
        field: "caption",
        offset: 0,
        kind: "cite",
        text: "smith2020",
      })
    ).toMatchObject({ ok: false, status: "invalid" });
  });

  test("a label: an existing one bare; a target without a label is labelled first (the Crossrefs completion), caret shifted like the page", async () => {
    // the figure has no label yet: label it through the target and insert the same bare label into the latex cell
    const out = await cellOperation(deps, {
      action: "insert_reference",
      ...base,
      cellId: "c_00000001",
      field: "source",
      offset: 0,
      kind: "label",
      text: "fig:one",
      target: { cellId: "c_00000002" },
    });
    expect(out).toMatchObject({ ok: true, status: "ok", detail: { inserted: "fig:one" } });
    const after = disk();
    expect((after.cells[1] as unknown as { data: { label: string } }).data.label).toBe("fig:one");
    expect(
      (after.cells[0] as unknown as { data: { source: string } }).data.source.startsWith(
        "fig:one\\section"
      )
    ).toBe(true);
    // now it exists, so no target is needed
    const again = await cellOperation(deps, {
      action: "insert_reference",
      ...base,
      expectedRev: 4,
      cellId: "c_00000001",
      field: "source",
      offset: 0,
      kind: "label",
      text: "fig:one",
    });
    expect(again).toMatchObject({ ok: true });
    // a label nobody defines, with no target to carry it
    expect(
      await cellOperation(deps, {
        action: "insert_reference",
        ...base,
        expectedRev: 5,
        cellId: "c_00000001",
        field: "source",
        offset: 0,
        kind: "label",
        text: "fig:nope",
      })
    ).toMatchObject({ ok: false, status: "invalid" });
    // a label with TeX syntax
    expect(
      await cellOperation(deps, {
        action: "insert_reference",
        ...base,
        expectedRev: 5,
        cellId: "c_00000001",
        field: "source",
        offset: 0,
        kind: "label",
        text: "a}\\input{x",
        target: { cellId: "c_00000003" },
      })
    ).toMatchObject({ ok: false, status: "invalid" });
  });

  test("a label added to the same field before the offset moves the insertion by what it added", async () => {
    // an equation cell: its label is added right after \\begin{equation}, before the caret that sits after the equation
    const doc = disk();
    doc.cells[0] = {
      id: "c_00000001",
      type: "latex",
      data: { source: "\\begin{equation}\nx\n\\end{equation}\nSee " },
    } as never;
    put(doc);
    const source = (doc.cells[0] as unknown as { data: { source: string } }).data.source;
    const out = await cellOperation(deps, {
      action: "insert_reference",
      ...base,
      cellId: "c_00000001",
      field: "source",
      offset: source.length,
      kind: "label",
      text: "eq:x",
      target: { cellId: "c_00000001", envIndex: 0 },
    });
    expect(out).toMatchObject({ ok: true });
    const next = (disk().cells[0] as unknown as { data: { source: string } }).data.source;
    expect(next).toBe("\\begin{equation}\n  \\label{eq:x}\nx\n\\end{equation}\nSee eq:x");
  });
});

describe("spec 14.1: what reaches the TeX compiler", () => {
  test("agent text with file access, program execution or hidden control words is invalid in every field that is compiled, nothing is written", async () => {
    const bytes = readFileSync(file(), "utf8");
    const bad = "\\input{/etc/passwd}";
    const attempts = [
      cellOperation(deps, {
        action: "update_cell",
        ...base,
        cellId: "c_00000001",
        fields: { source: bad },
      }),
      cellOperation(deps, {
        action: "update_cell",
        ...base,
        cellId: "c_00000002",
        fields: { caption: bad },
      }),
      cellOperation(deps, {
        action: "insert_cell",
        ...base,
        cellType: "code",
        fields: { code: "\\end{lstlisting}\\immediate\\write18{id}" },
      }),
      cellOperation(deps, {
        action: "insert_cell",
        ...base,
        cellType: "table",
        fields: { csv: "a,\\openin5=/etc/hostname" },
      }),
      patchManuscript(deps, {
        action: "update_manuscript",
        ...base,
        userPreamble: "\\usepackage{catchfile}",
      }),
      patchManuscript(deps, {
        action: "update_manuscript",
        ...base,
        title: "T \\csname input\\endcsname",
      }),
      patchManuscript(deps, {
        action: "update_manuscript",
        ...base,
        authors: [{ name: "^^5cinput" }],
      }),
      patchManuscript(deps, { action: "update_manuscript", ...base, affiliations: [bad] }),
      createManuscriptOp(deps, { template: "report", title: bad }, { screen: true }),
    ];
    for (const out of await Promise.all(attempts))
      expect(out).toMatchObject({ ok: false, status: "invalid" });
    expect(readFileSync(file(), "utf8")).toBe(bytes);
    expect(readdirSync(join(dataDir, "manuscripts"))).toEqual([M]);
    expect(changed).toEqual([]);
  });

  test("ordinary LaTeX, math, citations and figure paths still go through", async () => {
    const ok = await cellOperation(deps, {
      action: "update_cell",
      ...base,
      cellId: "c_00000001",
      fields: {
        source:
          "\\section{Intro}\nWe measure $\\sigma_8$ \\citep{smith2020}. \\includegraphics{assets/fig.png}",
      },
    });
    expect(ok).toMatchObject({ ok: true });
  });
});

describe("read and render", () => {
  test("read returns the labels the cells define and the figure files", () => {
    const doc = disk();
    doc.cells[1] = {
      ...(doc.cells[1] as object),
      data: { caption: "c", label: "fig:a", image: null },
    } as never;
    put(doc);
    const out = readWriter(deps, M);
    expect(out.kind).toBe("manuscript");
    if (out.kind === "manuscript") {
      expect(out.labels).toEqual([{ label: "fig:a", cell: "c_00000002" }]);
      expect(out.assets).toEqual([]);
    }
  });

  test("render calls the page's compile for the saved manuscript, writes nothing to it, and reports a compile failure as a failure", async () => {
    const bytes = readFileSync(file(), "utf8");
    const response = (over: Partial<WriterNumberingResponse>): WriterNumberingResponse => ({
      status: "ok",
      facts: null,
      lastError: null,
      preview: null,
      compiling: false,
      ...over,
    });
    deps.render = async () => response({ preview: { warnings: ["w1"] } as never });
    expect(await renderManuscript(deps, M)).toMatchObject({
      ok: true,
      status: "ok",
      rev: 3,
      stale: false,
      warnings: ["w1"],
    });
    deps.render = async () =>
      response({ status: "stale", lastError: "! Undefined control sequence." });
    expect(await renderManuscript(deps, M)).toMatchObject({ ok: false, status: "error" });
    deps.render = async () => response({ status: "stale" });
    expect(await renderManuscript(deps, M)).toMatchObject({ ok: true, stale: true });
    expect(await renderManuscript(deps, "m_0000dead")).toMatchObject({
      ok: false,
      status: "not_found",
    });
    expect(readFileSync(file(), "utf8")).toBe(bytes);
    deps.render = undefined;
    expect(await renderManuscript(deps, M)).toMatchObject({ ok: false, status: "error" });
  });
});

describe("the Copilot edits and renders whether or not the machine has an OS sandbox (the sandbox is the compile's own business)", () => {
  let compiles = 0;
  beforeEach(() => {
    compiles = 0;
    deps.render = async () => {
      compiles++;
      return { items: {}, preview: null, lastError: null } as never;
    };
  });

  test("text edits work", async () => {
    expect(
      await cellOperation(deps, {
        action: "update_cell",
        ...base,
        cellId: "c_00000001",
        fields: { source: "plain text" },
      })
    ).toMatchObject({ ok: true });
    expect(
      await patchManuscript(deps, {
        action: "update_manuscript",
        ...base,
        expectedRev: 4,
        title: "A title",
      })
    ).toMatchObject({ ok: true });
    expect(
      await createManuscriptOp(deps, { template: "report", title: "New" }, { screen: true })
    ).toMatchObject({ ok: true });
  });

  test("render starts the compile (no sandbox gate)", async () => {
    expect(await renderManuscript(deps, M)).toMatchObject({ ok: true });
    expect(compiles).toBe(1);
  });
});
