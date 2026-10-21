import type { TutorialProgress } from "@argelanderspace/contracts";

/**
 * Writes the progress (spec section 6): once per position change and once per step done or skipped, never debounced;
 * writes go one after another in the order they were asked for. A failed write does not stop the tutorial, is not
 * retried, and is reported once (`onFirstFailure`) for the life of the writer.
 */
export function createProgressWriter(put: (progress: TutorialProgress) => Promise<unknown>, onFirstFailure: () => void) {
  let chain: Promise<void> = Promise.resolve();
  let reported = false;
  return {
    save(progress: TutorialProgress): Promise<void> {
      chain = chain.then(() =>
        put(progress).then(
          () => undefined,
          () => {
            if (!reported) {
              reported = true;
              onFirstFailure();
            }
          },
        ),
      );
      return chain;
    },
  };
}

/** Two absolute folder paths name the same folder (a trailing separator aside). */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);
  return norm(a) === norm(b);
}
