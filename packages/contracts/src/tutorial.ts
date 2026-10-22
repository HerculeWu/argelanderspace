/**
 * Tutorial progress and its endpoint (in-app-tutorial ticket 18; spec §6 and appendix B).
 *
 * `tutorial.json` in the global data directory is the person's progress through the tutorial: which tutorial project
 * it is bound to, the step shown last (`position`), and the steps done or skipped. A step not in `steps` has not been
 * done; the one in progress is `position`. Step ids are stable strings (`library.add-bibtex`), never numbers that move
 * when chapters are reordered. `appVersion` is the app's version at the write, for diagnosis only.
 *
 * - `GET /api/tutorial` → 200 {@link TutorialState}: the progress (null when there is none or the file cannot be
 *   used), the bound project's folder as it is now, and the `sample` numbers of the bundled sample and of the bound
 *   project (each from its tutorial marker).
 * - `PUT /api/tutorial` with a whole {@link TutorialProgress} → 200 {@link TutorialState} after it replaced the file;
 *   400 `{code: "unknown_version"}` for a version other than 1, 400 `{code: "invalid_request"}` for anything else that
 *   is not a progress, 413 `{code: "too_large"}` over {@link TUTORIAL_PUT_MAX_BYTES}, 500 `{code: "write_failed",
 *   detail}` when the file could not be written (the old bytes stay; `detail` is the error's code only).
 *
 * Both forms answer it, the desktop app's welcome state included. Both are `no-store` and behind the cross-origin
 * guard (the GET too: it carries a local path).
 */

import { z } from "zod";

export const TUTORIAL_PROGRESS_VERSION = 1;
/** The states a step is recorded in; a step never reached is not recorded. */
export const TUTORIAL_STEP_STATES = ["done", "skipped"] as const;
export type TutorialStepState = (typeof TUTORIAL_STEP_STATES)[number];

/** A step id is at most this long. */
export const TUTORIAL_STEP_ID_MAX_LENGTH = 128;
/** At most this many steps are recorded. */
export const TUTORIAL_STEPS_MAX = 1000;
/** A bound project's path is at most this long. */
export const TUTORIAL_PATH_MAX_LENGTH = 4096;
/** The body of `PUT /api/tutorial` is at most this many bytes. */
export const TUTORIAL_PUT_MAX_BYTES = 256 * 1024;

const StepIdSchema = z.string().min(1).max(TUTORIAL_STEP_ID_MAX_LENGTH);

export const TutorialStepRecordSchema = z
  .object({
    state: z.enum(TUTORIAL_STEP_STATES),
    at: z.iso.datetime(),
  })
  .strict();
export type TutorialStepRecord = z.infer<typeof TutorialStepRecordSchema>;

/**
 * The whole of `tutorial.json`. The bound project's path must also be absolute: checked where the file is read and
 * written (infra `tutorial-progress.ts`), which knows the platform's path rules.
 */
export const TutorialProgressSchema = z
  .object({
    version: z.literal(TUTORIAL_PROGRESS_VERSION),
    project: z
      .object({ path: z.string().min(1).max(TUTORIAL_PATH_MAX_LENGTH) })
      .strict()
      .nullable(),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    position: StepIdSchema.nullable(),
    steps: z
      .record(StepIdSchema, TutorialStepRecordSchema)
      .refine((steps) => Object.keys(steps).length <= TUTORIAL_STEPS_MAX, {
        message: `at most ${TUTORIAL_STEPS_MAX} steps`,
      }),
    appVersion: z.string().max(64),
  })
  .strict();
export type TutorialProgress = z.infer<typeof TutorialProgressSchema>;

/**
 * The bound project's folder, looked at when the answer is made: `ready` — a folder with the tutorial marker at its
 * root; `missing` — not there or not a folder; `unmarked` — a folder without a usable marker.
 */
export const TUTORIAL_PROJECT_STATES = ["ready", "missing", "unmarked"] as const;
export type TutorialProjectState = (typeof TUTORIAL_PROJECT_STATES)[number];

/** `GET /api/tutorial` (and the answer to a `PUT`). */
export interface TutorialState {
  progress: TutorialProgress | null;
  /**
   * The project the progress is bound to; null when there is no progress or it is bound to none. `display` is `path`
   * as the page shows it (the server's home directory written as `~`, as settings `ShownPath`).
   */
  project: { path: string; display: string; state: TutorialProjectState } | null;
  sample: {
    /** The `sample` number of the sample that ships with this installation; null: it has none. */
    bundled: number | null;
    /** The `sample` number of the bound project's marker; null: no project bound, or no usable marker there. */
    project: number | null;
  };
}

/** The `code` of a refused `PUT /api/tutorial`. */
export const TUTORIAL_PUT_REFUSALS = [
  "invalid_request",
  "unknown_version",
  "too_large",
  "write_failed",
] as const;
export type TutorialPutRefusal = (typeof TUTORIAL_PUT_REFUSALS)[number];

/** The tutorial marker at the root of the sample and of a tutorial project: exactly these two keys. */
export const TutorialMarkerSchema = z
  .object({
    version: z.literal(1),
    sample: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type TutorialMarker = z.infer<typeof TutorialMarkerSchema>;
