import { fetchAnnotations } from "../../api/annotations";
import { onAnnotationChanged } from "../../api/ws";
import { SAMPLE_ANNOTATION_IDS, SAMPLE_DOC_ID, SAMPLE_WORK_IDS } from "../sample-ids";
import type { ChapterDefinition, L2Source, Requirement, WorkbenchSnapshot } from "../types";

/** The anchors of chapter 3, constants checked by the static anchor test. */
const JERABKOVA_ROW = { ui: "work-item", key: SAMPLE_WORK_IDS.jerabkova2021 } as const;
/** The open button of Jerabkova's own detail (another Work's detail has the same button). */
const OPEN_MAIN_DOC = { ui: "open-main-doc-or-acquisition", within: { ui: "work-detail", key: SAMPLE_WORK_IDS.jerabkova2021 } } as const;
const JERABKOVA_READER = { ui: "latex-reader", key: SAMPLE_DOC_ID } as const;
const READER_TOOLBAR = { ui: "latex-toolbar" } as const;
const TOGGLE_OUTLINE = { ui: "toggle-latex-outline" } as const;
/**
 * The open outline panel. Not the outline list itself (`latex-outline`): that list is as tall as the whole table of
 * contents and scrolls inside the panel, so more than half of it is always cut off and the card would only offer to
 * scroll to it. While the panel is folded the rung does not apply (its toggle is the rung below).
 */
const OUTLINE_PANEL = { ui: "latex-outline-panel", when: (s: WorkbenchSnapshot) => s.page.reader?.panels.outlineCollapsed === false } as const;
const TOGGLE_RIGHT_PANEL = { ui: "toggle-latex-right-panel" } as const;
const SHOW_ANNOTATIONS = { ui: "show-annotations" } as const;
const ANNOTATIONS_LIST = { ui: "latex-annotations-list" } as const;
/** The preset annotation on a sentence of section 3.1: clicking it jumps into the text and opens its popover. */
const PRESET_TEXT_ANNOTATION = { ui: "latex-annotation", key: SAMPLE_ANNOTATION_IDS.text } as const;
const ANNOTATION_POPOVER = { ui: "latex-annotation-popover" } as const;
const SELECTION_TOOLS = { ui: "latex-selection-tools" } as const;
const ANNOTATE_SELECTION = { ui: "annotate-selected-text" } as const;
const ANNOTATION_EDITOR = { ui: "latex-annotation-editor" } as const;
const SWITCH_DOC = { ui: "switch-doc" } as const;

/** The active pane's reader shows Jerabkova's main Doc. */
const readingJerabkova = (s: WorkbenchSnapshot) => s.page.view === "doc" && s.page.reader?.docId === SAMPLE_DOC_ID;

/**
 * The section under the reading line of Jerabkova's reader (null: before the first section); undefined while it is not
 * shown or has not measured its visible blocks yet (right after opening it reports no section before the first
 * measurement: that change is the reader settling, not a jump).
 */
function sectionOf(s: WorkbenchSnapshot): string | null | undefined {
  if (!readingJerabkova(s)) return undefined;
  const position = s.page.reader?.position;
  return position && position.visibleBlockIds.length > 0 ? position.activeSectionId : undefined;
}

/** Steps 3.2-3.7 happen in Jerabkova's reader; the registered `open_doc` action takes the user there. */
const IN_READER: Requirement = {
  test: readingJerabkova,
  where: "reader",
  whereValues: { work: "Jerabkova 2021" },
  takeMeThere: { action: "open_doc", docId: SAMPLE_DOC_ID },
};

export interface AnnotationCountDeps {
  /** The existing `annotation.changed` subscription (`api/ws.ts`), called with the Doc id of each event. */
  onChanged: (cb: (docId: string) => void) => () => void;
  /** The existing annotation list GET (`api/annotations.ts`). */
  fetch: typeof fetchAnnotations;
}

/**
 * Step 3.5's L2 source: an `annotation.changed` event of Jerabkova's Doc triggers a read of its annotation list through
 * the existing GET; the value is the number of annotations. A failed read gives no value (the gate keeps waiting).
 */
export function annotationCountSource(deps: AnnotationCountDeps = { onChanged: onAnnotationChanged, fetch: fetchAnnotations }): L2Source<number> {
  return {
    id: "annotations",
    subscribe: (changed) =>
      deps.onChanged((docId) => {
        if (docId === SAMPLE_DOC_ID) changed();
      }),
    read: async () => {
      const result = await deps.fetch(SAMPLE_DOC_ID);
      if (!result.ok) throw new Error(`annotations unreadable (${result.status})`);
      return result.file.annotations.length;
    },
  };
}

const ANNOTATIONS = annotationCountSource();
const countOf = (s: WorkbenchSnapshot): number | undefined => {
  const value = s.data[ANNOTATIONS.id];
  return typeof value === "number" ? value : undefined;
};

/** Chapter 3, "reading" (appendix A): Jerabkova 2021's reader, its outline and annotations. */
export const READING: ChapterDefinition = {
  id: "reading",
  n: 3,
  steps: [
    {
      id: "reading.open",
      kind: "do",
      anchors: [JERABKOVA_ROW, OPEN_MAIN_DOC, JERABKOVA_READER],
      gate: readingJerabkova,
    },
    {
      id: "reading.outline",
      kind: "do",
      anchors: [READER_TOOLBAR, TOGGLE_OUTLINE, OUTLINE_PANEL],
      // A process gate (spec section 5): the reading section differs from the one first seen in Jerabkova's reader during
      // this showing — the baseline at the step's start, or, when the step started elsewhere, the section the reader
      // first reports once it is open (opening the reader is not a jump).
      gate: (s, run) => {
        if (!("from" in run.memo)) {
          const start = sectionOf(run.baseline);
          if (start !== undefined) run.memo.from = start;
        }
        const now = sectionOf(s);
        if (now === undefined) return false;
        if (!("from" in run.memo)) {
          run.memo.from = now;
          return false;
        }
        return now !== run.memo.from;
      },
      requires: IN_READER,
    },
    {
      id: "reading.annotations",
      kind: "look",
      anchors: [TOGGLE_RIGHT_PANEL, SHOW_ANNOTATIONS, ANNOTATIONS_LIST],
      requires: IN_READER,
    },
    {
      id: "reading.open-annotation",
      kind: "do",
      // The panel toggle and the annotations tab first: the list is only drawn while the panel is open on that tab.
      anchors: [TOGGLE_RIGHT_PANEL, SHOW_ANNOTATIONS, PRESET_TEXT_ANNOTATION, ANNOTATION_POPOVER],
      gate: (s) => readingJerabkova(s) && Boolean(s.page.reader?.openAnnotationId),
      requires: IN_READER,
    },
    {
      id: "reading.annotate",
      kind: "do",
      anchors: [JERABKOVA_READER, SELECTION_TOOLS, ANNOTATE_SELECTION, ANNOTATION_EDITOR],
      sources: [ANNOTATIONS],
      gate: (s, run) => {
        const base = countOf(run.baseline);
        const now = countOf(s);
        return base !== undefined && now !== undefined && now >= base + 1;
      },
      requires: IN_READER,
      preparedCopy: true,
    },
    {
      id: "reading.manage",
      kind: "look",
      anchors: [ANNOTATIONS_LIST],
      requires: IN_READER,
    },
    {
      id: "reading.switch-doc",
      kind: "look",
      // The switcher is only drawn when the Work has several Docs (the sample's Jerabkova has one): the toolbar it sits in
      // is the rung below.
      anchors: [READER_TOOLBAR, SWITCH_DOC],
      requires: IN_READER,
    },
    {
      id: "reading.agent",
      kind: "agent",
      anchors: [],
    },
  ],
};
