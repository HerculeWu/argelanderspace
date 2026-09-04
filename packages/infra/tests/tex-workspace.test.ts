/**
 * Isolated-workspace tests (Stage 5 MS1, `src/tex/workspace.ts`): pure fs,
 * no TeX toolchain needed.
 */

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createTexWorkspace,
  guardTexWorkspaceSize,
  TexWorkspaceError,
} from "../src/tex/workspace.js";

async function tmpSrc(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tex-ws-src-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

describe("createTexWorkspace", () => {
  test("copies the full tree (incl. subdirs) and cleans up", async () => {
    const src = await tmpSrc({ "main.tex": "\\relax", "sub/chap.tex": "x", "fig/f.bin": "y" });
    const ws = await createTexWorkspace(src);
    expect(existsSync(join(ws.dir, "main.tex"))).toBe(true);
    expect(existsSync(join(ws.dir, "sub/chap.tex"))).toBe(true);
    expect(existsSync(join(ws.dir, "fig/f.bin"))).toBe(true);
    expect(ws.dir).not.toBe(src);
    await ws.cleanup();
    expect(existsSync(ws.dir)).toBe(false);
    await rm(src, { recursive: true, force: true });
  });

  test("symlinks are refused (unsafe-source)", async () => {
    const src = await tmpSrc({ "main.tex": "\\relax" });
    symlinkSync(join(src, "main.tex"), join(src, "linked.tex"));
    await expect(createTexWorkspace(src)).rejects.toMatchObject({
      name: "TexWorkspaceError",
      kind: "unsafe-source",
    });
    await rm(src, { recursive: true, force: true });
  });

  test("file-count guard trips while copying", async () => {
    const src = await tmpSrc({ "a.tex": "1", "b.tex": "2" });
    await expect(createTexWorkspace(src, { maxFiles: 1, maxBytes: 1 << 30 })).rejects.toMatchObject(
      { name: "TexWorkspaceError", kind: "resource-limit" }
    );
    await rm(src, { recursive: true, force: true });
  });

  test("byte guard trips while copying", async () => {
    const src = await tmpSrc({ "big.bin": "x".repeat(1024) });
    await expect(createTexWorkspace(src, { maxFiles: 100, maxBytes: 10 })).rejects.toMatchObject({
      name: "TexWorkspaceError",
      kind: "resource-limit",
    });
    await rm(src, { recursive: true, force: true });
  });

  test("TexWorkspaceError is an Error subclass", () => {
    expect(new TexWorkspaceError("unsafe-source", "m")).toBeInstanceOf(Error);
  });
});

describe("guardTexWorkspaceSize", () => {
  test("passes under the default limits; trips with a tight limit", async () => {
    const src = await tmpSrc({ "main.tex": "\\relax" });
    const ws = await createTexWorkspace(src);
    await expect(guardTexWorkspaceSize(ws.dir)).resolves.toBeUndefined();
    await expect(
      guardTexWorkspaceSize(ws.dir, { maxFiles: 0, maxBytes: 1 << 30 })
    ).rejects.toMatchObject({ kind: "resource-limit" });
    await ws.cleanup();
    await rm(src, { recursive: true, force: true });
  });
});
