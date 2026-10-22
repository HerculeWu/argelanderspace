import type { WriterPage } from "@argelanderspace/contracts";
import { SAMPLE_CELL_IDS, SAMPLE_CITE_KEYS, SAMPLE_LAST_CELL_ID, SAMPLE_MANUSCRIPT_ID, SAMPLE_WORK_IDS } from "../sample-ids";
import type { ChapterDefinition, GateRun, Requirement, WorkbenchSnapshot } from "../types";

type Editor = NonNullable<WriterPage["editor"]>;
type SavedCell = NonNullable<Editor["saved"]>["cells"][number];

/** The sample manuscript open and loaded in the active pane's Writer (the page context's editor, server-confirmed). */
function editorOf(s: WorkbenchSnapshot): (Editor & { saved: NonNullable<Editor["saved"]> }) | null {
  if (s.page.view !== "write") return null;
  const editor = s.page.writer?.editor;
  if (!editor || editor.manuscriptId !== SAMPLE_MANUSCRIPT_ID || editor.phase !== "ready" || !editor.saved) return null;
  return editor as Editor & { saved: NonNullable<Editor["saved"]> };
}

/** Every text field of a cell, one string (a LaTeX cell has its `source`; other types several fields). */
const textOf = (cell: SavedCell): string =>
  Object.values(cell.data as Record<string, unknown>)
    .filter((v): v is string => typeof v === "string")
    .join("\n");
const occurrences = (cells: readonly SavedCell[], needle: string): number =>
  cells.reduce((n, cell) => n + textOf(cell).split(needle).length - 1, 0);

/**
 * What the count of a "+N" gate starts from: the editor at the step's start, or — when the step started away from it
 * (its requirement not met yet) — the editor as first seen during this showing.
 */
function startOf<T>(s: WorkbenchSnapshot, run: GateRun, name: string, read: (editor: NonNullable<ReturnType<typeof editorOf>>) => T): T | undefined {
  if (!Object.getOwnPropertyDescriptor(run.memo, name)) {
    const first = editorOf(run.baseline) ?? editorOf(s);
    if (!first) return undefined;
    run.memo[name] = read(first);
  }
  return run.memo[name] as T;
}

const KROUPA = SAMPLE_CITE_KEYS.kroupa2022;
const PRESET_CELLS: ReadonlySet<string> = new Set(SAMPLE_CELL_IDS);

/** The anchors of chapter 7, constants checked by the static anchor test. */
const NAV_WRITE = { ui: "navigate-view", key: "write" } as const;
const MANUSCRIPT_ITEM = { ui: "manuscript-item", key: SAMPLE_MANUSCRIPT_ID } as const;
const MANUSCRIPT_EDITOR = { ui: "manuscript-editor", key: SAMPLE_MANUSCRIPT_ID } as const;
const MANUSCRIPT_PAPER = { ui: "manuscript-paper" } as const;
/** The add button below the last preset cell: the button carries no key, its cell block does. */
const ADD_AFTER_LAST = { ui: "add-cell-after", within: { ui: "manuscript-cell", key: SAMPLE_LAST_CELL_ID } } as const;
const ADD_CELL_MENU = { ui: "add-cell-menu" } as const;
const ADD_LATEX = { ui: "add-cell-type", key: "latex" } as const;
/**
 * The editing form's Render button: only the cell being edited has it. (A LaTeX cell is edited in a code editor, not
 * a `cell-field` text field, so the ladder has no rung for the field.)
 */
const COMMIT_CELL = { ui: "commit-cell" } as const;
const TOGGLE_REFERENCES = { ui: "toggle-writer-reference-panel" } as const;
const WRITER_REFERENCES = { ui: "writer-references" } as const;
const SEARCH_REFERENCES = { ui: "search-writer-references" } as const;
/** Kroupa 2022's insert button: inside its reference card (keyed by the Work id). */
const INSERT_KROUPA = { ui: "insert-cite-key", within: { ui: "writer-reference", key: SAMPLE_WORK_IDS.kroupa2022 } } as const;
const RENDER = { ui: "render-manuscript" } as const;
/** The rendered preview of the last preset cell (it cites Kroupa 2022 too); every rendered cell has one. */
const CELL_PREVIEW = { ui: "cell-preview", within: { ui: "manuscript-cell", key: SAMPLE_LAST_CELL_ID } } as const;
const EXPORT = { ui: "export-manuscript" } as const;

/** A render that finished, did not fail and matches the saved manuscript (the editor's preview state, L1). */
function renderCurrent(s: WorkbenchSnapshot): boolean {
  const preview = editorOf(s)?.preview;
  return Boolean(preview && preview.status === "ok" && !preview.failed && !preview.rendering);
}

/** Steps 7.2-7.6 happen in the sample manuscript's editor; "take me there" is the Writer's own registered action. */
const IN_EDITOR: Requirement = {
  test: (s) => editorOf(s) !== null,
  where: "writer",
  takeMeThere: { action: "open_manuscript", manuscriptId: SAMPLE_MANUSCRIPT_ID },
};

/** Chapter 7, "writer" (appendix A): the review manuscript of the tutorial sample. */
export const WRITER: ChapterDefinition = {
  id: "writer",
  n: 7,
  steps: [
    {
      id: "writer.open",
      kind: "do",
      anchors: [NAV_WRITE, MANUSCRIPT_ITEM, MANUSCRIPT_EDITOR],
      gate: (s) => editorOf(s) !== null,
    },
    {
      id: "writer.structure",
      kind: "look",
      anchors: [MANUSCRIPT_PAPER],
      requires: IN_EDITOR,
    },
    {
      id: "writer.add-cell",
      kind: "do",
      anchors: [ADD_AFTER_LAST, ADD_CELL_MENU, ADD_LATEX, COMMIT_CELL],
      // L1, a "+1" gate: one saved cell more than at the start, a new one with text that is no longer being edited
      // (choosing LaTeX in the menu saves an empty cell at once; Shift+Enter closes the form).
      gate: (s, run) => {
        const editor = editorOf(s);
        const before = startOf(s, run, "cellIds", (e) => e.saved.cells.map((cell) => cell.id));
        if (!editor || !before) return false;
        const cells = editor.saved.cells;
        if (cells.length < before.length + 1) return false;
        return cells.some((cell) => !before.includes(cell.id) && textOf(cell).trim() !== "" && editor.editingCellId !== cell.id);
      },
      requires: IN_EDITOR,
      preparedCopy: true,
    },
    {
      id: "writer.cite",
      kind: "do",
      anchors: [TOGGLE_REFERENCES, WRITER_REFERENCES, SEARCH_REFERENCES, INSERT_KROUPA],
      // L1 (implementation check: the page context's editor carries the saved manuscript in full, so the L2 read back
      // is not needed). A preset paragraph already cites Kroupa 2022: the key must be in a cell of the user's, or occur
      // once more than at the start.
      gate: (s, run) => {
        const editor = editorOf(s);
        const before = startOf(s, run, "citeCount", (e) => occurrences(e.saved.cells, KROUPA));
        if (!editor || before === undefined) return false;
        const cells = editor.saved.cells;
        return cells.some((cell) => !PRESET_CELLS.has(cell.id) && textOf(cell).includes(KROUPA)) || occurrences(cells, KROUPA) > before;
      },
      requires: IN_EDITOR,
    },
    {
      id: "writer.render",
      kind: "do",
      // The preview rung only once the render is current: before that, the previews of an earlier render are stale and
      // the Render button is the place to point at.
      anchors: [RENDER, { ...CELL_PREVIEW, when: renderCurrent }],
      // L1 (implementation check: the editor's page context has the preview state): a render that finished, did not
      // fail and matches the saved manuscript.
      gate: renderCurrent,
      requires: IN_EDITOR,
      needsTex: true,
    },
    {
      id: "writer.export",
      kind: "look",
      anchors: [EXPORT],
      requires: IN_EDITOR,
    },
    {
      id: "writer.agent",
      kind: "agent",
      anchors: [],
    },
  ],
};
