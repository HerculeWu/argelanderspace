import type { ChapterDefinition } from "../types";
import { DISCOVERY } from "./discovery";
import { PREPARE } from "./prepare";
import { READING } from "./reading";
import { TOUR } from "./tour";

/**
 * The registered chapters, in order: the chapter rail shows exactly these. Later chapters (2-8) and the finish page are
 * registered by their own tickets.
 */
export const CHAPTERS: readonly ChapterDefinition[] = [PREPARE, TOUR, READING, DISCOVERY];

