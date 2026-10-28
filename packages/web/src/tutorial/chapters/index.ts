import type { ChapterDefinition } from "../types";
import { ARGUMENT } from "./argument";
import { COPILOT_CHAPTER } from "./copilot";
import { DISCOVERY } from "./discovery";
import { FINISH } from "./finish";
import { INTAKE } from "./intake";
import { LIBRARY } from "./library";
import { PLAN_CHAPTER } from "./plan";
import { PREPARE } from "./prepare";
import { READING } from "./reading";
import { TOUR } from "./tour";
import { WRITER } from "./writer";

/**
 * The registered chapters, in order: the chapter rail shows exactly these. The finish page stays last.
 */
export const CHAPTERS: readonly ChapterDefinition[] = [
  PREPARE,
  TOUR,
  LIBRARY,
  READING,
  DISCOVERY,
  ARGUMENT,
  PLAN_CHAPTER,
  WRITER,
  COPILOT_CHAPTER,
  INTAKE,
  FINISH,
];
