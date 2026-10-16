/**
 * How much memory the PDF headroom check (512 MiB, `PDF_MIN_IN_FLIGHT_HEADROOM_BYTES`) counts as available, per
 * platform (desktop-app ticket 30). `os.freemem()` alone is wrong on macOS: there it counts only free (and speculative)
 * pages, not the inactive ones the kernel reclaims on demand, so a Mac that has plenty to give often reports less than
 * 512 MiB and every PDF upload was refused.
 *
 *  - Linux: `MemAvailable` from /proc/meminfo (the kernel's own estimate), read on every call (a small file).
 *  - macOS: `vm_stat`'s free + inactive + speculative pages at its page size. Purgeable pages are NOT added: they sit
 *    in the active and inactive queues already, so adding them would count some pages twice. `vm_stat` is a child
 *    process, so its answer is kept for one second and concurrent calls share one run.
 *  - Windows and anything else: `os.freemem()` (on Windows the available physical memory).
 *
 * Whenever the platform's own number cannot be had (unreadable, unexpected output), `os.freemem()` is used, read
 * afresh each time. The threshold and its meaning are unchanged; only what counts as available.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { freemem } from "node:os";

/** `MemAvailable` in bytes, or null when the line is missing or not in kB. */
export function parseLinuxMemAvailable(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : null;
}

/** free + inactive + speculative pages from `vm_stat`'s output, in bytes; null when any of them or the page size is missing. */
export function parseDarwinVmStat(output: string): number | null {
  const size = /page size of (\d+) bytes/.exec(output);
  if (!size) return null;
  let pages = 0;
  for (const name of ["free", "inactive", "speculative"]) {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.\\s*$`, "m").exec(output);
    if (!m) return null;
    pages += Number(m[1]);
  }
  return pages * Number(size[1]);
}

export interface AvailableMemorySources {
  platform: NodeJS.Platform;
  freemem: () => number;
  readMeminfo: () => Promise<string>;
  runVmStat: () => Promise<string>;
  now: () => number;
}

const DARWIN_CACHE_MS = 1000;

/** The available-memory reader for one set of sources (the real ones in `availableMemory`; fakes in tests). */
export function createAvailableMemory(sources: AvailableMemorySources): () => Promise<number> {
  if (sources.platform === "linux") {
    return async () => {
      let parsed: number | null = null;
      try {
        parsed = parseLinuxMemAvailable(await sources.readMeminfo());
      } catch {
        // Unreadable: os.freemem() below.
      }
      return parsed ?? sources.freemem();
    };
  }
  if (sources.platform === "darwin") {
    // The last vm_stat answer (null: it failed) and when it was asked for; one run in flight at most.
    let cached: { at: number; value: Promise<number | null> } | null = null;
    return async () => {
      const t = sources.now();
      if (!cached || t - cached.at >= DARWIN_CACHE_MS) {
        cached = {
          at: t,
          value: sources.runVmStat().then(parseDarwinVmStat, () => null),
        };
      }
      return (await cached.value) ?? sources.freemem();
    };
  }
  return async () => sources.freemem();
}

export const availableMemory = createAvailableMemory({
  platform: process.platform,
  freemem,
  readMeminfo: () => readFile("/proc/meminfo", "utf8"),
  runVmStat: () =>
    new Promise((resolve, reject) => {
      execFile("/usr/bin/vm_stat", [], { timeout: 2000, encoding: "utf8" }, (error, stdout) =>
        error ? reject(error) : resolve(stdout)
      );
    }),
  now: () => Date.now(),
});
