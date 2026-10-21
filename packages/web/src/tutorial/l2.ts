import type { L2Source } from "./types";

/**
 * Watch a step's L2 sources while it is shown (spec section 5): subscribe to each source's existing `/ws` event, read
 * once at the start, then read again after each event. Reads of one source never overlap: events that arrive while a
 * read is on its way are collapsed into one more read after it. Never polls. The returned function unsubscribes,
 * aborts the reads on their way and drops their answers.
 */
export function watchSources(sources: readonly L2Source[], onData: (id: string, value: unknown) => void): () => void {
  const controller = new AbortController();
  let stopped = false;
  const offs = sources.map((source) => {
    let reading = false;
    let again = false;
    const read = (): void => {
      if (stopped) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      again = false;
      source
        .read(controller.signal)
        .then(
          (value) => {
            if (!stopped) onData(source.id, value);
          },
          () => undefined,
        )
        .finally(() => {
          reading = false;
          if (again && !stopped) read();
        });
    };
    const off = source.subscribe(read);
    read();
    return off;
  });
  return () => {
    stopped = true;
    controller.abort();
    for (const off of offs) off();
  };
}
