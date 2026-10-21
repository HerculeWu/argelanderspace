// The stable ids of the tutorial sample (in-app-tutorial ticket 17): the objects of tutorial-sample/ at the
// repository root that the tutorial definitions point at (anchor keys, gate predicates). The sample carries no ids
// file; these constants are the single place the tutorial learns them, and tests/tutorial-sample-ids.test.ts checks
// that every one of them is really in the sample. Product ids are random, so the sample's hand-written content has
// fixed ids; regenerating the sample (packages/app/scripts/tutorial-sample.mjs) never changes them.
//
// Not here yet: the preset Copilot conversation (its id and the ids of its three user messages), the Task and the
// manuscript cell that conversation creates. They exist only once the conversation has been recorded with a real
// provider (spec section 7); until then the last cell of the manuscript is SAMPLE_CELL_IDS' last entry.

/** The five Works of the sample library (library.json ids). */
export const SAMPLE_WORK_IDS = {
  roser2019: "doi:10.1051/0004-6361/201834608",
  meingastAlves2019: "doi:10.1051/0004-6361/201834622",
  jerabkova2021: "doi:10.1051/0004-6361/202039949",
  pflammAltenburg2023: "doi:10.1051/0004-6361/202244243",
  kroupa2022: "doi:10.1093/mnras/stac2563",
} as const;

/** The one Doc of the sample: the main Doc of Jerabkova 2021. */
export const SAMPLE_DOC_ID = "arxiv-2103.12080";

/** The three preset annotations on that Doc: on the whole document, on Figure 10, on a sentence of section 3.1. */
export const SAMPLE_ANNOTATION_IDS = {
  document: "a_3c1e7a20",
  figure: "a_5f0b9d41",
  text: "a_8a62c4e3",
} as const;

/** The preset Plan and its hand-written Tasks. */
export const SAMPLE_PLAN_ID = "p_4e7a1c90";
export const SAMPLE_TASK_IDS = ["t_1b3d5f70", "t_2c4e6a81"] as const;

/** The review manuscript and its cells, in order (abstract, then two paragraphs). */
export const SAMPLE_MANUSCRIPT_ID = "m_6d2f8b14";
export const SAMPLE_CELL_IDS = ["c_0a1b2c3d", "c_1e2f3a4b", "c_2a3b4c5d"] as const;
export const SAMPLE_LAST_CELL_ID = SAMPLE_CELL_IDS[SAMPLE_CELL_IDS.length - 1];

/** Jerabkova 2021's argument graph: its End argument and the Native argument deliberately left unlinked. */
export const SAMPLE_ARGUMENT_IDS = {
  end: "ak4e7r",
  orphanNative: "an2r5m",
} as const;
