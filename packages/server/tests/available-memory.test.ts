import { describe, expect, test } from "vitest";
import {
  type AvailableMemorySources,
  createAvailableMemory,
  parseDarwinVmStat,
  parseLinuxMemAvailable,
} from "../src/available-memory.js";

const MEMINFO = [
  "MemTotal:       16314420 kB",
  "MemFree:          412180 kB",
  "MemAvailable:    9876544 kB",
  "Buffers:          123456 kB",
  "Cached:          8000000 kB",
].join("\n");

// vm_stat on an Apple silicon Mac (16 KiB pages); trimmed to the lines that matter plus their neighbours.
const VM_STAT = [
  "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
  "Pages free:                                3000.",
  "Pages active:                            200000.",
  "Pages inactive:                          150000.",
  "Pages speculative:                         2000.",
  "Pages throttled:                              0.",
  "Pages wired down:                         90000.",
  "Pages purgeable:                          40000.",
  '"Translation faults":                 123456789.',
].join("\n");

describe("parseLinuxMemAvailable", () => {
  test("reads MemAvailable in bytes", () => {
    expect(parseLinuxMemAvailable(MEMINFO)).toBe(9876544 * 1024);
  });
  test("no MemAvailable line (kernels before 3.14) or a malformed one: null", () => {
    expect(parseLinuxMemAvailable("MemTotal: 1 kB\nMemFree: 2 kB\n")).toBeNull();
    expect(parseLinuxMemAvailable("MemAvailable: lots kB\n")).toBeNull();
    expect(parseLinuxMemAvailable("MemAvailable: 12 MB\n")).toBeNull();
    expect(parseLinuxMemAvailable("")).toBeNull();
  });
});

describe("parseDarwinVmStat", () => {
  test("free + inactive + speculative pages, at the page size vm_stat names", () => {
    expect(parseDarwinVmStat(VM_STAT)).toBe((3000 + 150000 + 2000) * 16384);
  });
  test("purgeable pages are not added (they sit in the active and inactive queues already)", () => {
    const without = VM_STAT.replace(/Pages purgeable:\s+\d+\./, "Pages purgeable: 0.");
    expect(parseDarwinVmStat(without)).toBe(parseDarwinVmStat(VM_STAT));
  });
  test("4 KiB pages (Intel Macs)", () => {
    expect(parseDarwinVmStat(VM_STAT.replace("16384", "4096"))).toBe((3000 + 150000 + 2000) * 4096);
  });
  test("a missing page size or a missing counter: null (never a partial sum)", () => {
    expect(parseDarwinVmStat(VM_STAT.split("\n").slice(1).join("\n"))).toBeNull();
    expect(parseDarwinVmStat(VM_STAT.replace(/Pages inactive:.*\n/, ""))).toBeNull();
    expect(parseDarwinVmStat(VM_STAT.replace(/Pages free:.*\n/, ""))).toBeNull();
    expect(parseDarwinVmStat(VM_STAT.replace(/Pages speculative:.*\n/, ""))).toBeNull();
    expect(parseDarwinVmStat("")).toBeNull();
  });
});

function sources(over: Partial<AvailableMemorySources>): AvailableMemorySources & {
  calls: { meminfo: number; vmStat: number; freemem: number };
} {
  const calls = { meminfo: 0, vmStat: 0, freemem: 0 };
  return {
    calls,
    platform: "linux",
    now: () => 0,
    ...over,
    freemem: () => {
      calls.freemem++;
      return over.freemem ? over.freemem() : 7;
    },
    readMeminfo: async () => {
      calls.meminfo++;
      return over.readMeminfo ? over.readMeminfo() : MEMINFO;
    },
    runVmStat: async () => {
      calls.vmStat++;
      return over.runVmStat ? over.runVmStat() : VM_STAT;
    },
  };
}

describe("createAvailableMemory", () => {
  test("Linux: MemAvailable, read on every call", async () => {
    const s = sources({ platform: "linux" });
    const available = createAvailableMemory(s);
    expect(await available()).toBe(9876544 * 1024);
    expect(await available()).toBe(9876544 * 1024);
    expect(s.calls).toEqual({ meminfo: 2, vmStat: 0, freemem: 0 });
  });
  test("Linux: unreadable or unparsable /proc/meminfo falls back to os.freemem()", async () => {
    const unreadable = sources({
      platform: "linux",
      readMeminfo: () => Promise.reject(new Error("EACCES")),
    });
    expect(await createAvailableMemory(unreadable)()).toBe(7);
    const odd = sources({ platform: "linux", readMeminfo: async () => "MemFree: 1 kB\n" });
    expect(await createAvailableMemory(odd)()).toBe(7);
  });
  test("Windows (and any other platform): os.freemem(), the available physical memory", async () => {
    for (const platform of ["win32", "freebsd"] as const) {
      const s = sources({ platform });
      expect(await createAvailableMemory(s)()).toBe(7);
      expect(s.calls.meminfo + s.calls.vmStat).toBe(0);
    }
  });
  test("macOS: vm_stat's reclaimable pages, cached for a short while and shared by concurrent calls", async () => {
    let t = 0;
    const s = sources({ platform: "darwin", now: () => t });
    const available = createAvailableMemory(s);
    const expected = (3000 + 150000 + 2000) * 16384;
    expect(await Promise.all([available(), available(), available()])).toEqual([
      expected,
      expected,
      expected,
    ]);
    expect(s.calls.vmStat).toBe(1);
    t = 999;
    expect(await available()).toBe(expected);
    expect(s.calls.vmStat).toBe(1);
    t = 1000;
    expect(await available()).toBe(expected);
    expect(s.calls.vmStat).toBe(2);
  });
  test("macOS: vm_stat failing or printing something else falls back to os.freemem() (also cached)", async () => {
    let t = 0;
    const failing = sources({
      platform: "darwin",
      now: () => t,
      runVmStat: () => Promise.reject(new Error("ENOENT")),
    });
    const available = createAvailableMemory(failing);
    expect(await available()).toBe(7);
    expect(await available()).toBe(7);
    expect(failing.calls.vmStat).toBe(1);
    t = 5000;
    expect(await available()).toBe(7);
    expect(failing.calls.vmStat).toBe(2);
    const odd = sources({ platform: "darwin", runVmStat: async () => "nothing useful" });
    expect(await createAvailableMemory(odd)()).toBe(7);
  });
  test("macOS: the fallback reads os.freemem() afresh, not a cached number", async () => {
    let free = 7;
    const s = sources({
      platform: "darwin",
      freemem: () => free,
      runVmStat: () => Promise.reject(new Error("ENOENT")),
    });
    const available = createAvailableMemory(s);
    expect(await available()).toBe(7);
    free = 9;
    expect(await available()).toBe(9);
  });
});
