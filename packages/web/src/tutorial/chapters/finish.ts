import type { ChapterDefinition } from "../types";

/** The finish page's chapter id and its one step (the rail draws it as a flag row; the layer shows the finish card). */
export const FINISH_CHAPTER_ID = "finish";
export const FINISH_STEP_ID = "finish.page";

/**
 * The finish page (appendix A, spec addendum 5): registered after the last chapter, reached by finishing it or from
 * the chapter rail. No anchor (docked at the bottom right), no gate, no requirement; its copy is
 * `tutorial.steps.finish.page.*`.
 */
export const FINISH: ChapterDefinition = {
  id: FINISH_CHAPTER_ID,
  n: 10,
  steps: [{ id: FINISH_STEP_ID, kind: "look", anchors: [] }],
};
