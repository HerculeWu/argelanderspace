import type { ChapterDefinition } from "../types";
import { ARGUMENT } from "./argument";
import { FINISH } from "./finish";
import { LIBRARY } from "./library";
import { PLAN_CHAPTER } from "./plan";
import { PREPARE } from "./prepare";
import { TOUR } from "./tour";
import { WRITER } from "./writer";

/**
 * The registered chapters, in order: the chapter rail shows exactly these. The finish page stays last; chapter 8 is
 * registered by its own ticket, just before it.
 */
export const CHAPTERS: readonly ChapterDefinition[] = [PREPARE, TOUR, LIBRARY, ARGUMENT, PLAN_CHAPTER, WRITER, FINISH];
