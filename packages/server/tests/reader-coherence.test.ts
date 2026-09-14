import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnnotationsFile,
  CoherentAnnotationsReadSchema,
  type Job,
  type TexDocIr,
} from "@argelanderspace/contracts";
import {
  annotationsArchiveDir,
  annotationsCurrentPath,
  libraryPaths,
  saveAnnotationsFile,
  uploadDocId,
} from "@argelanderspace/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { AsyncLock } from "../src/lock.js";
import {
  collectBroadcasts,
  KNOWN_WORK_ID,
  makeDataDir,
  stubPipelines,
  stubSources,
  UPLOAD_ZIP,
} from "./helpers.js";

let dataDir: string;
let docDir: string;
let currentPath: string;
let archiveDir: string;
let ir: TexDocIr;
let app: Hono;
let registry: DocMutationRegistry;
let messages: ReturnType<typeof collectBroadcasts>["messages"];
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const endpoint = "/api/paper/demo/annotations";
const coherent = `${endpoint}?coherent=1`;
const persist = () => fs.writeFileSync(join(docDir, "demo.json"), JSON.stringify(ir));
function section() {
  const first = ir.sections[0];
  if (!first) throw new Error("missing synthetic section");
  return first;
}
const get = (path = coherent) => app.request(path);
const put = (body: AnnotationsFile) =>
  app.request(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const archives = () =>
  fs.existsSync(archiveDir) && fs.statSync(archiveDir).isDirectory()
    ? fs.readdirSync(archiveDir).filter((n) => n.endsWith(".json"))
    : [];

beforeEach(() => {
  dataDir = fs.mkdtempSync(join(tmpdir(), "coherent-server-"));
  docDir = join(dataDir, "output", "demo");
  currentPath = annotationsCurrentPath(dataDir, "demo");
  archiveDir = annotationsArchiveDir(dataDir, "demo");
  fs.mkdirSync(join(docDir, "assets"), { recursive: true });
  fs.writeFileSync(join(docDir, "assets", "a.svg"), "asset A");
  ir = {
    version: 1,
    docId: "demo",
    sections: [
      {
        id: "s",
        level: 1,
        heading: "Heading",
        children: [],
        blocks: [
          { id: "p", type: "paragraph", segments: [{ type: "text", text: "Body" }] },
          { id: "f", type: "figure", imgPath: "a.svg" },
        ],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: "/tmp/synthetic", main_tex: "main.tex" },
    meta: { title: "A" },
  };
  persist();
  registry = new DocMutationRegistry();
  const collector = collectBroadcasts();
  messages = collector.messages;
  app = createApp({
    paths: libraryPaths(dataDir),
    statusDir: join(dataDir, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    docMutations: registry,
    broadcast: collector.broadcast,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function seed(): Promise<AnnotationsFile> {
  const response = await get();
  expect(response.status).toBe(200);
  const { file } = CoherentAnnotationsReadSchema.parse(await response.json());
  const saved: AnnotationsFile = {
    ...file,
    rev: 8,
    annotations: [
      {
        id: "a_12345678",
        target: { type: "document" },
        body: "  保留\n原文  ",
        created_at: "2026-09-10T10:00:00.000Z",
        updated_at: "2026-09-10T10:00:00.000Z",
      },
    ],
  };
  saveAnnotationsFile(dataDir, "demo", saved);
  // Unknown keys and formatting are user bytes, not Zod round-trip output.
  fs.writeFileSync(
    currentPath,
    `\n${JSON.stringify({ ...saved, future: { keep: true } }, null, 3)}\n\n`
  );
  return saved;
}

function expectNoStore(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

test("opt-in shape, legacy shape, fresh full IR despite unchanged projection, same-epoch rev reset", async () => {
  const saved = await seed();
  const legacy = await get(endpoint);
  expectNoStore(legacy, 200);
  expect(await legacy.json()).toEqual(saved);
  ir.meta.title = "B";
  ir.title = "New title";
  persist();
  const changed = CoherentAnnotationsReadSchema.parse(await (await get()).json());
  expect(changed.ir).toEqual(ir);
  expect(changed.file).toEqual(saved);
  expect(changed.assets).toEqual([{ imgPath: "a.svg", sha256: hash("asset A") }]);
  fs.unlinkSync(currentPath);
  const reset = CoherentAnnotationsReadSchema.parse(await (await get()).json());
  expect(reset.file.rev).toBe(0);
  expect(reset.file.content_fingerprint).toBe(saved.content_fingerprint);
  expect(messages).toEqual([]);
});

test("coherent mismatch archives raw bytes once, resets rev, repeated reads are idempotent", async () => {
  await seed();
  const raw = fs.readFileSync(currentPath);
  section().heading = "Replacement";
  persist();
  const responses = await Promise.all([get(), get()]);
  for (const response of responses) {
    expectNoStore(response, 200);
    const result = CoherentAnnotationsReadSchema.parse(await response.json());
    expect(result.ir).toEqual(ir);
    expect(result.file.rev).toBe(0);
    expect(result.file.annotations).toEqual([]);
  }
  expect(archives()).toHaveLength(1);
  expect(fs.readFileSync(join(archiveDir, archives()[0] as string))).toEqual(raw);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    type: "annotation.changed",
    doc_id: "demo",
    cause: "invalidate",
  });
});

test.each([
  "missing-doc",
  "corrupt-ir",
  "invalid-ir",
  "wrong-doc-id",
  "corrupt-current",
  "invalid-current",
  "missing-asset",
  "directory-asset",
  "read-asset",
  "hash",
  "archive-dir",
  "archive-write",
  "archive-rename",
  "current-write",
  "current-rename",
])("%s: GET and PUT fail without losing user bytes or broadcasting invalidate", async (failure) => {
  const saved = await seed();
  section().heading = "Replacement";
  persist();
  const asset = join(docDir, "assets", "a.svg");
  if (failure === "missing-doc") fs.unlinkSync(join(docDir, "demo.json"));
  if (failure === "corrupt-ir") fs.writeFileSync(join(docDir, "demo.json"), "{broken");
  if (failure === "invalid-ir") fs.writeFileSync(join(docDir, "demo.json"), '{"version":1}');
  if (failure === "wrong-doc-id") {
    ir.docId = "wrong";
    persist();
  }
  if (failure === "corrupt-current") fs.writeFileSync(currentPath, "{user broken");
  if (failure === "invalid-current") fs.writeFileSync(currentPath, '{"version":2,"user":"keep"}');
  if (failure === "missing-asset" || failure === "directory-asset") fs.unlinkSync(asset);
  if (failure === "directory-asset") fs.mkdirSync(asset);
  if (failure === "archive-dir") fs.writeFileSync(archiveDir, "not a directory");
  const before = fs.readFileSync(currentPath);
  if (failure === "read-asset") {
    const original = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof original>) => {
      if (String(args[0]) === asset) throw new Error("synthetic EIO");
      return original(...args);
    }) as typeof original);
  }
  if (failure === "hash")
    vi.spyOn(crypto, "createHash").mockImplementation(() => {
      throw new Error("synthetic hash failure");
    });
  if (failure === "archive-write" || failure === "current-write") {
    const original = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      const target = String(args[0]);
      if (
        failure === "archive-write"
          ? target.startsWith(archiveDir)
          : target === `${currentPath}.tmp`
      )
        throw new Error("synthetic write failure");
      return original(...args);
    });
  }
  if (failure === "archive-rename" || failure === "current-rename") {
    const original = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      const target = String(args[1]);
      if (failure === "archive-rename" ? target.startsWith(archiveDir) : target === currentPath)
        throw new Error("synthetic rename failure");
      return original(...args);
    });
  }
  syncBuiltinESMExports();
  for (const request of [() => get(), () => put(saved)]) {
    expectNoStore(await request(), failure === "missing-doc" ? 404 : 500);
    expect(fs.readFileSync(currentPath)).toEqual(before);
    expect(messages).toEqual([]);
  }
  const newCurrentFailure = failure === "current-write" || failure === "current-rename";
  expect(archives().length).toBe(newCurrentFailure ? 2 : 0);
  for (const name of archives()) expect(fs.readFileSync(join(archiveDir, name))).toEqual(before);
  if (newCurrentFailure) {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expectNoStore(await get(), 200);
    expect(archives()).toHaveLength(3);
    expect(messages).toHaveLength(1);
  }
});

test("absent imgPath is valid absence; PUT fingerprint check precedes rev", async () => {
  const saved = await seed();
  const figure = section().blocks[1];
  if (figure?.type === "figure") delete figure.imgPath;
  persist();
  const response = await put({ ...saved, rev: 999 });
  expectNoStore(response, 409);
  expect(await response.json()).toMatchObject({ detail: "document changed", file: { rev: 0 } });
  const result = CoherentAnnotationsReadSchema.parse(await (await get()).json());
  expect(result.assets).toEqual([]);
  expect(messages).toHaveLength(1);
});

test.each(["writer", "delete"])(
  "%s gate wins over partial IR, including legacy GET and PUT",
  async (kind) => {
    const saved = await seed();
    const before = fs.readFileSync(currentPath);
    if (kind === "writer") registry.pinWriter("demo");
    else expect(registry.tryBeginDelete("demo")).toBe(true);
    fs.unlinkSync(join(docDir, "demo.json"));
    for (const request of [() => get(), () => get(endpoint), () => put(saved)]) {
      const response = await request();
      expectNoStore(response, 409);
      expect(await response.json()).toEqual({ detail: "document busy" });
    }
    expect(fs.readFileSync(currentPath)).toEqual(before);
    expect(archives()).toEqual([]);
    expect(messages).toEqual([]);
    if (kind === "writer") {
      registry.unpinWriter("demo");
      persist();
      expectNoStore(await get(), 200);
    } else {
      registry.endDelete("demo");
      expectNoStore(await get(), 404);
    }
  }
);

test("refresh pins do not gate coherent content but still gate DELETE", async () => {
  registry.pinRefresh();
  expectNoStore(await get(), 200);
  expect(registry.tryBeginDelete("demo")).toBe(false);
  registry.unpinRefresh();
  expect(registry.tryBeginDelete("demo")).toBe(true);
});

test("PUT rechecks busy after JSON parsing and annotationLock queue", async () => {
  const saved = await seed();
  const original = AsyncLock.prototype.run;
  vi.spyOn(AsyncLock.prototype, "run").mockImplementation(function (this: AsyncLock, fn) {
    return original.call(this, () => {
      registry.pinWriter("demo");
      return fn();
    });
  });
  const before = fs.readFileSync(currentPath);
  expectNoStore(await put(saved), 409);
  expect(fs.readFileSync(currentPath)).toEqual(before);
  expect(messages).toEqual([]);
});

test.each(["a.svg", "assets/a.svg"])(
  "verified %s sends exactly the compared buffer after a path replacement, no ensure",
  async (path) => {
    await seed();
    const before = fs.readFileSync(currentPath);
    const original = fs.readFileSync;
    let reads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof original>) => {
      const bytes = original(...args);
      if (String(args[0]) === join(docDir, "assets", "a.svg")) {
        reads += 1;
        fs.writeFileSync(join(docDir, "assets", "a.svg"), "asset B");
      }
      return bytes;
    }) as typeof original);
    syncBuiltinESMExports();
    const response = await get(`/images/demo/${path}?sha256=${hash("asset A")}`);
    expectNoStore(response, 200);
    expect(await response.text()).toBe("asset A");
    expect(reads).toBe(1);
    const stale = await get(`/images/demo/${path}?sha256=${hash("asset A")}`);
    expectNoStore(stale, 409);
    expect(await stale.json()).toEqual({ detail: "asset changed" });
    expect(fs.readFileSync(currentPath)).toEqual(before);
    expect(archives()).toEqual([]);
    expect(messages).toEqual([]);
  }
);

test.each([
  ["a.svg?sha256=", 400],
  ["a.svg?sha256=random", 400],
  ["gone.svg", 404],
  ["assets/gone.svg", 404],
  ["assets", 500],
  ["assets/%2Ehidden.svg", 400],
  ["assets/%2e%2e%2fa.svg", 400],
  ["assets//a.svg", 400],
  ["assets/%5ca.svg", 400],
  ["assets/%00.svg", 400],
  ["%2e%2e%2foutside.svg", 400],
])("verified invalid/missing %s -> %s (no-store)", async (path, status) => {
  const query = path.includes("?") ? path : `${path}?sha256=${hash("asset A")}`;
  // 'assets' bare filename maps to assets/assets, so create a nonregular target.
  fs.mkdirSync(join(docDir, "assets", "assets"));
  expectNoStore(await get(`/images/demo/${query}`), status);
  expect(messages).toEqual([]);
  expect(fs.existsSync(currentPath)).toBe(false);
});

test("symlink escape is rejected by both routes and manifest; unverified images retain legacy behavior", async () => {
  await seed();
  const before = fs.readFileSync(currentPath);
  const outside = join(dataDir, "outside.svg");
  fs.renameSync(join(docDir, "assets", "a.svg"), outside);
  fs.symlinkSync(outside, join(docDir, "assets", "a.svg"));
  for (const path of ["a.svg", "assets/a.svg"]) {
    expectNoStore(await get(`/images/demo/${path}?sha256=${hash("asset A")}`), 400);
    const legacy = await get(`/images/demo/${path}`);
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toBe("asset A");
  }
  expectNoStore(await get(), 500);
  expect(fs.readFileSync(currentPath)).toEqual(before);
  expect(archives()).toEqual([]);
  expect(messages).toEqual([]);
});

test("verified assets honor busy, ignore conditional cache headers, and accept uppercase SHA", async () => {
  for (const path of ["a.svg", "assets/a.svg"]) {
    const url = `/images/demo/${path}?sha256=${hash("asset A").toUpperCase()}`;
    registry.pinWriter("demo");
    expectNoStore(await get(url), 409);
    registry.unpinWriter("demo");
    expect(registry.tryBeginDelete("demo")).toBe(true);
    expectNoStore(await get(url), 409);
    registry.endDelete("demo");
    const response = await app.request(url, {
      headers: { "If-None-Match": "*", "If-Modified-Since": new Date().toUTCString() },
    });
    expectNoStore(response, 200);
    expect(await response.text()).toBe("asset A");
  }
});

test.each([false, true])(
  "partial ingest across await is busy until unpin (sync=%s)",
  async (sync) => {
    const uploadData = makeDataDir();
    try {
      const docId = uploadDocId(KNOWN_WORK_ID);
      const target = join(uploadData, "output", docId);
      fs.mkdirSync(target, { recursive: true });
      const stored = { ...ir, docId, sections: [] };
      fs.writeFileSync(join(target, `${docId}.json`), JSON.stringify(stored));
      let started!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((r) => {
        started = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const pipelines = stubPipelines();
      const base = pipelines.ingestLatexZip;
      pipelines.ingestLatexZip = async (...args) => {
        fs.writeFileSync(join(target, `${docId}.json`), "{partial ingest");
        started();
        await gate;
        return base(...args);
      };
      const runner = new JobRunner({ dir: join(uploadData, "jobs") });
      const collector = collectBroadcasts();
      const uploadApp = createApp({
        paths: libraryPaths(uploadData),
        statusDir: join(uploadData, "status"),
        makeSources: () => stubSources(),
        pipelines,
        runner,
        broadcast: collector.broadcast,
      });
      const url = `/api/paper/${docId}/annotations`;
      const saved = (await (await uploadApp.request(url)).json()) as AnnotationsFile;
      saveAnnotationsFile(uploadData, docId, saved);
      const raw = fs.readFileSync(annotationsCurrentPath(uploadData, docId));
      const pending = uploadApp.request(
        `/api/library/upload?id=${encodeURIComponent(KNOWN_WORK_ID)}${sync ? "&sync=1" : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body: UPLOAD_ZIP,
        }
      );
      await entered;
      try {
        for (const method of ["GET", "PUT"]) {
          const response = await uploadApp.request(`${url}?coherent=1`, {
            method,
            ...(method === "PUT"
              ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(saved) }
              : {}),
          });
          expectNoStore(response, 409);
          expect(await response.json()).toEqual({ detail: "document busy" });
        }
        expect(fs.readFileSync(annotationsCurrentPath(uploadData, docId))).toEqual(raw);
        expect(fs.existsSync(annotationsArchiveDir(uploadData, docId))).toBe(false);
        expect(collector.messages.filter((m) => m.type === "annotation.changed")).toEqual([]);
      } finally {
        release();
      }
      const result = await pending;
      if (!sync) {
        const { job } = (await result.json()) as { job: Job };
        expect((await runner.waitFor(job.id)).status).toBe("done");
      } else expect(result.status).toBe(200);
      expectNoStore(await uploadApp.request(`${url}?coherent=1`), 200);
    } finally {
      fs.rmSync(join(uploadData, ".."), { recursive: true, force: true });
    }
  }
);

test.each(["intermediate", "document-root"])(
  "server containment rejects %s symlinks",
  async (kind) => {
    await seed();
    const before = fs.readFileSync(currentPath);
    const origin = kind === "intermediate" ? join(docDir, "assets") : docDir;
    const outside = join(dataDir, "demo-other");
    fs.renameSync(origin, outside);
    fs.symlinkSync(outside, origin);
    for (const path of ["a.svg", "assets/a.svg"]) {
      expectNoStore(await get(`/images/demo/${path}?sha256=${hash("asset A")}`), 400);
    }
    expectNoStore(await get(), 500);
    expect(fs.readFileSync(currentPath)).toEqual(before);
    expect(archives()).toEqual([]);
    expect(messages).toEqual([]);
  }
);

test.each(["read", "hash"])(
  "verified image %s failure is 500/no-store without ensure",
  async (failure) => {
    await seed();
    const before = fs.readFileSync(currentPath);
    const expected = hash("asset A");
    if (failure === "read") {
      const original = fs.readFileSync;
      vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof original>) => {
        if (String(args[0]) === join(docDir, "assets", "a.svg")) throw new Error("synthetic EIO");
        return original(...args);
      }) as typeof original);
    } else
      vi.spyOn(crypto, "createHash").mockImplementation(() => {
        throw new Error("synthetic hash failure");
      });
    syncBuiltinESMExports();
    for (const path of ["a.svg", "assets/a.svg"]) {
      expectNoStore(await get(`/images/demo/${path}?sha256=${expected}`), 500);
    }
    expect(fs.readFileSync(currentPath)).toEqual(before);
    expect(archives()).toEqual([]);
    expect(messages).toEqual([]);
  }
);

test.each(["async-failure", "sync-failure", "submit-failure", "spool-failure"])(
  "%s releases content pin without annotation side effects",
  async (failure) => {
    const uploadData = makeDataDir();
    try {
      const docId = uploadDocId(KNOWN_WORK_ID);
      const target = join(uploadData, "output", docId);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(
        join(target, `${docId}.json`),
        JSON.stringify({ ...ir, docId, sections: [] })
      );
      const pipelines = stubPipelines();
      pipelines.ingestLatexZip = async () => {
        throw new Error("synthetic ingest failure");
      };
      const runner = new JobRunner({ dir: join(uploadData, "jobs") });
      const mutations = new DocMutationRegistry();
      const collector = collectBroadcasts();
      const uploadApp = createApp({
        paths: libraryPaths(uploadData),
        statusDir: join(uploadData, "status"),
        makeSources: () => stubSources(),
        pipelines,
        runner,
        docMutations: mutations,
        broadcast: collector.broadcast,
      });
      const url = `/api/paper/${docId}/annotations?coherent=1`;
      const result = CoherentAnnotationsReadSchema.parse(
        await (await uploadApp.request(url)).json()
      );
      saveAnnotationsFile(uploadData, docId, result.file);
      const before = fs.readFileSync(annotationsCurrentPath(uploadData, docId));
      if (failure === "submit-failure")
        vi.spyOn(runner, "submit").mockImplementation(() => {
          throw new Error("synthetic submit failure");
        });
      if (failure === "spool-failure")
        fs.writeFileSync(join(uploadData, "jobs", "spool"), "not a dir");
      const response = await uploadApp.request(
        `/api/library/upload?id=${encodeURIComponent(KNOWN_WORK_ID)}${failure === "sync-failure" ? "&sync=1" : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body: UPLOAD_ZIP,
        }
      );
      expect(response.status).toBe(failure === "async-failure" ? 202 : 500);
      for (const job of runner.list()) expect((await runner.waitFor(job.id)).status).toBe("failed");
      expect(mutations.isDocumentContentBusy(docId)).toBe(false);
      expectNoStore(await uploadApp.request(url), 200);
      expect(fs.readFileSync(annotationsCurrentPath(uploadData, docId))).toEqual(before);
      expect(fs.existsSync(annotationsArchiveDir(uploadData, docId))).toBe(false);
      expect(collector.messages.filter((m) => m.type === "annotation.changed")).toEqual([]);
    } finally {
      fs.rmSync(join(uploadData, ".."), { recursive: true, force: true });
    }
  }
);
