import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createCachedTexWorkspace } from "../src/tex/cache.js";
import { runTexProcess } from "../src/tex/proc.js";

let root: string, source: string, cache: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "writer-cache-test-"));
  source = join(root, "source");
  cache = join(root, "cache");
  await fs.mkdir(join(source, "inc"), { recursive: true });
  await fs.writeFile(join(source, "main.tex"), "source");
  await fs.writeFile(join(source, "inc/old.tex"), "old");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("unchanged source keeps mtimes/intermediates; changed and removed source is synchronized", async () => {
  const first = await createCachedTexWorkspace(source, cache);
  const before = (await fs.stat(join(cache, "main.tex"))).mtimeMs;
  await fs.writeFile(join(cache, "main.aux"), "compiled facts");
  await first.cleanup();
  await createCachedTexWorkspace(source, cache);
  expect((await fs.stat(join(cache, "main.tex"))).mtimeMs).toBe(before);
  expect(await fs.readFile(join(cache, "main.aux"), "utf8")).toBe("compiled facts");
  await fs.writeFile(join(source, "main.tex"), "edited");
  await fs.rm(join(source, "inc"), { recursive: true });
  await createCachedTexWorkspace(source, cache);
  expect(await fs.readFile(join(cache, "main.tex"), "utf8")).toBe("edited");
  await expect(fs.access(join(cache, "inc/old.tex"))).rejects.toThrow();
});

test("source symlinks and overlapping caches are refused", async () => {
  await expect(createCachedTexWorkspace(source, join(source, "cache"))).rejects.toThrow("disjoint");
  await fs.symlink(join(root, "external"), join(source, "escape"));
  await expect(createCachedTexWorkspace(source, cache)).rejects.toThrow("symlink");
});

test("stale-source cleanup cannot traverse a replaced symlink parent", async () => {
  await createCachedTexWorkspace(source, cache);
  await fs.mkdir(join(root, "external"));
  await fs.writeFile(join(root, "external/old.tex"), "KEEP");
  await fs.rm(join(cache, "inc"), { recursive: true });
  await fs.symlink(join(root, "external"), join(cache, "inc"));
  await fs.rm(join(source, "inc"), { recursive: true });
  await expect(createCachedTexWorkspace(source, cache)).rejects.toThrow("symlink");
  expect(await fs.readFile(join(root, "external/old.tex"), "utf8")).toBe("KEEP");
});

test("abort cancels the detached process group without waiting for the compile timeout", async () => {
  const controller = new AbortController();
  const run = runTexProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeoutMs: 10000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const result = await run;
  expect(result.signal).toBe("SIGKILL");
  expect(result.timedOut).toBe(false);
}, 2000);
