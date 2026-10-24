// The stable ids of the tutorial sample (in-app-tutorial ticket 17): the objects of tutorial-sample/ at the
// repository root that the tutorial definitions point at (anchor keys, gate predicates). The sample carries no ids
// file; these constants are the single place the tutorial learns them, and tests/tutorial-sample-ids.test.ts checks
// that every one of them is really in the sample. Product ids are random, so the sample's hand-written content has
// fixed ids; regenerating the sample (packages/app/scripts/tutorial-sample.mjs) never changes them.
//
// The preset Copilot conversation was recorded once with a real provider (spec section 7) and is frozen; its Task and
// manuscript cell carry the ids the product gave them then, and count as preset content like the hand-written ones.

/** The five Works of the sample library (library.json ids). */
export const SAMPLE_WORK_IDS = {
  roser2019: "doi:10.1051/0004-6361/201834608",
  meingastAlves2019: "doi:10.1051/0004-6361/201834622",
  jerabkova2021: "doi:10.1051/0004-6361/202039949",
  pflammAltenburg2023: "doi:10.1051/0004-6361/202244243",
  kroupa2022: "doi:10.1093/mnras/stac2563",
} as const;

/** Jerabkova 2021's arXiv id (library.json `arxiv_id`): the identity of the Shelf entry chapter 2 adds. */
export const SAMPLE_JERABKOVA_ARXIV = "2103.12080";

/** The one Doc of the sample: the main Doc of Jerabkova 2021. */
export const SAMPLE_DOC_ID = "arxiv-2103.12080";

/** The three preset annotations on that Doc: on the whole document, on Figure 10, on a sentence of section 3.1. */
export const SAMPLE_ANNOTATION_IDS = {
  document: "a_3c1e7a20",
  figure: "a_5f0b9d41",
  text: "a_8a62c4e3",
} as const;

/** The block the preset text annotation sits in (its `target.block`): the reader's gutter of that block carries its count. */
export const SAMPLE_TEXT_ANNOTATION_BLOCK = "p-51";

/** The Task the preset Copilot conversation added to the Plan (its second question). */
export const SAMPLE_COPILOT_TASK_ID = "t_9bca269c";
/** The paragraph the preset Copilot conversation inserted into the manuscript (its third question). */
export const SAMPLE_COPILOT_CELL_ID = "c_1b25d01a";

/** The preset Plan and its Tasks, in order: two hand-written, then the one the Copilot conversation added. */
export const SAMPLE_PLAN_ID = "p_4e7a1c90";
export const SAMPLE_TASK_IDS = ["t_1b3d5f70", "t_2c4e6a81", SAMPLE_COPILOT_TASK_ID] as const;

/**
 * The review manuscript and its cells, in order: the abstract, the first hand-written paragraph, the paragraph the
 * Copilot conversation inserted, and the second hand-written paragraph (still the last cell).
 */
export const SAMPLE_MANUSCRIPT_ID = "m_6d2f8b14";
export const SAMPLE_CELL_IDS = ["c_0a1b2c3d", "c_1e2f3a4b", SAMPLE_COPILOT_CELL_ID, "c_2a3b4c5d"] as const;
export const SAMPLE_LAST_CELL_ID = SAMPLE_CELL_IDS[SAMPLE_CELL_IDS.length - 1];

/**
 * The preset Copilot conversation (copilot/conversations/<id>.json) and its three user messages in order: the
 * question asked in Jerabkova's reader (it carries that page's context), the Plan request, the manuscript request.
 * `operationReplies` are the two assistant messages (Pi session entry ids, the panel's message keys) whose tool calls
 * are the conversation's operation cards: the Plan task after the second question, the cell after the third.
 */
export const SAMPLE_CONVERSATION = {
  id: "85b4af77-56d0-4684-8a1c-b8926dec17d0",
  questions: [
    "60494134-ac63-4f1b-b847-4a60047a8d42",
    "d81e0685-3fc5-4ebf-9d33-1316e1a69691",
    "bf6e6695-9981-414d-9d17-7236849f58d5",
  ],
  operationReplies: ["e391048f", "43bb4cbc"],
} as const;

/** Jerabkova 2021's argument graph: its End argument and the Native argument deliberately left unlinked. */
export const SAMPLE_ARGUMENT_IDS = {
  end: "ak4e7r",
  orphanNative: "an2r5m",
} as const;

/** Cite keys of the sample library (library.json `cite_key`, the bibcode): the one chapter 7 inserts into the manuscript. */
export const SAMPLE_CITE_KEYS = {
  kroupa2022: "2022MNRAS.517.3613K",
} as const;

/** The bibcode of Röser 2019 (library.json), the seed of chapter 4's exploration. */
export const SAMPLE_SEED_BIBCODE = "2019A&A...621L...2R";
