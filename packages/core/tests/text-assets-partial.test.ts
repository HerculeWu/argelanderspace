import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyWork, type LibraryPaths, LibraryStore } from "../src/library/store.js";
import { addTextAsset } from "../src/text-assets.js";
import { createTextDoc, readTextSource } from "../src/text-docs.js";

// A write that dies half way (disk full) must leave nothing on the final name: the next upload of the same bytes has to
// work, and a pre-existing file must never be touched.
const state = vi.hoisted(() => ({ failWrite: false, failLink: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (path: unknown, data: unknown, options?: unknown) => {
      if (state.failWrite && typeof path === "string" && path.includes("/assets/")) {
        actual.writeFileSync(path, (data as Buffer).subarray(0, 5), options as never);
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return actual.writeFileSync(path as never, data as never, options as never);
    },
    linkSync: (existing: never, target: never) => {
      if (state.failLink) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return actual.linkSync(existing, target);
    },
  };
});

function png(width = 4, height = 3): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    len,
    Buffer.from("IHDR"),
    ihdr,
    Buffer.alloc(4),
    Buffer.alloc(200, 9),
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
}
const dirs: string[] = [];
afterEach(() => {
  state.failWrite = false;
  state.failLink = false;
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function project() {
  const root = mkdtempSync(join(tmpdir(), "text-assets-partial-"));
  dirs.push(root);
  const paths = {
    dataDir: root,
    outputDir: join(root, "output"),
    libraryDir: join(root, "library"),
    libraryJson: join(root, "library", "library.json"),
    libraryBib: join(root, "library", "library.bib"),
    cacheDir: join(root, "library", "cache"),
    graphJson: join(root, "library", "graph.json"),
  } as LibraryPaths;
  new LibraryStore([emptyWork("work:1")]).save(paths);
  const docId = createTextDoc(paths, { operationId: "op-aaaaaaaa", workId: "work:1" }).docId;
  return { paths, docId, assets: join(paths.outputDir, docId, "assets") };
}

describe("a partial asset write leaves nothing behind (ticket 27 fix round 1, M1)", () => {
  it("ENOSPC half way: no final file, no temp file, rev unchanged; the same upload then succeeds", () => {
    const { paths, docId, assets } = project();
    const bytes = png();
    state.failWrite = true;
    expect(() =>
      addTextAsset(paths, docId, { expectedRev: 0, bytes, filename: "fig.png" })
    ).toThrow(expect.objectContaining({ code: "write_failed" }));
    expect(existsSync(assets) ? readdirSync(assets) : []).toEqual([]);
    expect(readTextSource(paths, docId).rev).toBe(0);
    state.failWrite = false;
    const retry = addTextAsset(paths, docId, { expectedRev: 0, bytes, filename: "fig.png" });
    expect(retry.kind).toBe("added");
    if (retry.kind !== "added") return;
    expect(readFileSync(join(assets, retry.asset.name))).toEqual(bytes);
    expect(readdirSync(assets)).toEqual([retry.asset.name]);
  });

  it("without hard links the write still never exposes a partial file on the final name", () => {
    const { paths, docId, assets } = project();
    const bytes = png();
    state.failLink = true;
    state.failWrite = true;
    expect(() => addTextAsset(paths, docId, { expectedRev: 0, bytes })).toThrow(
      expect.objectContaining({ code: "write_failed" })
    );
    expect(existsSync(assets) ? readdirSync(assets) : []).toEqual([]);
    state.failWrite = false;
    const ok = addTextAsset(paths, docId, { expectedRev: 0, bytes });
    expect(ok.kind).toBe("added");
    expect(readdirSync(assets)).toHaveLength(1);
  });

  it("an existing file of the target name is never deleted by a failing add", () => {
    const { paths, docId, assets } = project();
    const bytes = png();
    const first = addTextAsset(paths, docId, { expectedRev: 0, bytes });
    if (first.kind !== "added") throw new Error("not added");
    // the same name by a different registration is impossible; simulate a stray file of another image's name instead
    const other = png(9, 9);
    const sha = createHash("sha256").update(other).digest("hex");
    const stray = join(assets, `image-${sha.slice(0, 8)}.png`);
    state.failLink = true;
    writeFileSync(stray, "STRAY");
    expect(() => addTextAsset(paths, docId, { expectedRev: 1, bytes: other })).toThrow(
      expect.objectContaining({ code: "write_failed" })
    );
    expect(readFileSync(stray, "utf8")).toBe("STRAY");
    expect(readTextSource(paths, docId).rev).toBe(1);
  });
});
