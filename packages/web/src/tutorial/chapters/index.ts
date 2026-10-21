import type { ChapterDefinition } from "../types";
import { FINISH } from "./finish";
import { PREPARE } from "./prepare";
import { TOUR } from "./tour";
import { WRITER } from "./writer";

/**
 * The registered chapters, in order: the chapter rail shows exactly these. The finish page is always last; the other
 * chapters are registered by their own tickets.
 */
export const CHAPTERS: readonly ChapterDefinition[] = [PREPARE, TOUR, WRITER, FINISH];
