import type { ChapterDefinition } from "../types";
import { ARGUMENT } from "./argument";
import { PLAN_CHAPTER } from "./plan";
import { PREPARE } from "./prepare";
import { TOUR } from "./tour";

/**
 * The registered chapters, in order: the chapter rail shows exactly these. Later chapters (2-8) and the finish page are
 * registered by their own tickets.
 */
export const CHAPTERS: readonly ChapterDefinition[] = [PREPARE, TOUR, ARGUMENT, PLAN_CHAPTER];

