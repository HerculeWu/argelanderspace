// Child process for the cross-process tests of the Shelf store: one put, its outcome printed as one JSON line.
//   new <shelfDir> <n>              add a new entry for DOI 10.1/race
//   replace <shelfDir> <id> <rev>   replace that entry at that rev
//   stall <shelfDir> <marker>       add a new entry, but at the first file write create <marker> and then block this
//                                   process's event loop for 6 s (lock stale threshold 2 s), as a busy process would
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { register } from "node:module";

register("../mail/ts-resolve-hook.mjs", import.meta.url);
const { createShelfStore } = await import("../../src/shelf/store.ts");
const [mode, dir, a, b] = process.argv.slice(2);
// Big enough that two writes overlap in time if the lock did not keep them apart.
const pdf = Buffer.alloc(4 * 1024 * 1024, 7);
const input = {
  bibliography: { title: "Race", authors: ["A"], year: 2020, doi: "10.1/race" },
  source: { project: "/projects/p", workId: "doi:10.1/race" },
  docs: [
    {
      docId: "pdf-race",
      kind: "pdf",
      files: [
        { path: "pdf-race.json", bytes: Buffer.from(JSON.stringify({ worker: process.pid })) },
        { path: "original.pdf", bytes: pdf },
      ],
      annotations: null,
    },
  ],
  argumentGraph: null,
  note: `written by ${process.pid}`,
};
let stalled = false;
const store =
  mode === "stall"
    ? createShelfStore({
        dir,
        lockStaleMs: 2000,
        io: {
          async writeFile(path, bytes) {
            if (!stalled) {
              stalled = true;
              writeFileSync(a, "holding");
              const until = Date.now() + 6000;
              while (Date.now() < until) {
                /* a blocked event loop: the lock is not refreshed */
              }
            }
            await writeFile(path, bytes, { flag: "wx" });
          },
        },
      })
    : createShelfStore({ dir });
try {
  const r =
    mode === "replace"
      ? await store.put(input, { mode: "replace", targets: [{ entryId: a, rev: Number(b) }] })
      : await store.put(input, { mode: "new" });
  console.log(JSON.stringify(r.ok ? { ok: true, rev: r.entry.rev, entryId: r.entry.entryId } : r));
} catch (e) {
  console.log(JSON.stringify({ error: String(e) }));
}
