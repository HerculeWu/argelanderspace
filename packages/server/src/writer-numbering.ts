/** Writer compile/preview cache. The route name is retained for existing clients;
 * execution now shares latexmk -> facts + source -> IR with the reader.
 * Only derived manuscript build files are written, never ingest/library/annotations.
 */
import { createHash } from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildBib,
  buildTexDocumentMapped,
  extractManuscriptCitedKeys,
  type WriterManuscript,
  type WriterNumberingFile,
  WriterNumberingFileSchema,
  type WriterNumberingResponse,
  type WriterTemplate,
  type WsWriterChanged,
  writerDraftKey,
} from "@argelanderspace/contracts";
import {
  buildWriterPreview,
  libraryPaths,
  loadManuscript,
  loadTemplates,
  manuscriptDir,
  manuscriptJsonPath,
  templatesDir,
} from "@argelanderspace/core";
import { compileTex, TEX_WORKSPACE_LIMITS, texFigurePort } from "@argelanderspace/infra";

const COMPILE_TIMEOUT_MS = 30_000;
const DEBOUNCE_MS = 500; // follows the editor's save debounce; measured, not a latency guarantee
const PREVIEW_PROFILE = "writer-ir-v1";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const buildDir = (dataDir: string, id: string) => join(manuscriptDir(dataDir, id), "build");
const numberingPath = (dataDir: string, id: string) =>
  join(buildDir(dataDir, id), "numbering.json");

export class WriterNumberingError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "canceled"
  ) {
    super(message);
    this.name = "WriterNumberingError";
  }
}

async function readNumberingFile(dataDir: string, id: string): Promise<WriterNumberingFile | null> {
  try {
    return WriterNumberingFileSchema.parse(
      JSON.parse(await fs.readFile(numberingPath(dataDir, id), "utf8"))
    );
  } catch {
    return null;
  } // derived cache only; manuscript parsing NEVER uses this fallback
}

async function ensureBuildDir(dataDir: string, id: string): Promise<string> {
  // DELETE drains the shared flight before removing the manuscript. Also refuse
  // late writes if an external actor removed it while a compile was running.
  await fs.access(manuscriptJsonPath(dataDir, id));
  const dir = buildDir(dataDir, id);
  await fs.mkdir(dir, { recursive: true });
  if ((await fs.realpath(dir)) !== resolve(dir))
    throw new Error("Writer build directory must not be a symlink");
  return dir;
}

async function writeNumberingFile(
  dataDir: string,
  id: string,
  file: WriterNumberingFile
): Promise<void> {
  await ensureBuildDir(dataDir, id);
  const p = numberingPath(dataDir, id);
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await fs.rename(tmp, p);
}

async function persistFailure(
  dataDir: string,
  id: string,
  message: string
): Promise<WriterNumberingFile> {
  const prev = await readNumberingFile(dataDir, id);
  const file: WriterNumberingFile = {
    ...prev,
    version: 1,
    at: new Date().toISOString(),
    texHash: prev?.texHash ?? "",
    facts: prev?.facts ?? null,
    lastError: message.slice(0, 6000),
  };
  await writeNumberingFile(dataDir, id, file);
  return file;
}

interface Snapshot {
  manuscript: WriterManuscript;
  template: WriterTemplate;
  tex: string;
  cellRanges: ReturnType<typeof buildTexDocumentMapped>["cellRanges"];
  files: Map<string, Buffer>;
  inputHash: string;
  warnings: string[];
}

/** Read a complete immutable input snapshot. Hash CONTENT, not just main.tex:
 * bibliography, template dependencies and assets can change independently of rev.
 */
async function snapshot(dataDir: string, id: string): Promise<Snapshot> {
  const manuscript = loadManuscript(dataDir, id);
  if (!manuscript) throw new WriterNumberingError(`manuscript not found: ${id}`, "not-found");
  if (new Set(manuscript.cells.map((c) => c.id)).size !== manuscript.cells.length) {
    throw new Error(
      "duplicate cell ids: preview requires an unambiguous cell/source mapping; manuscript preserved"
    );
  }
  const loaded = loadTemplates(dataDir);
  const template = loaded.templates.find((t) => t.id === manuscript.template);
  if (!template) throw new Error(`template "${manuscript.template}" unavailable`);
  const { tex, cellRanges } = buildTexDocumentMapped(manuscript, template);
  const files = new Map<string, Buffer>();
  const warnings = [...loaded.warnings];
  let bytes = 0;
  const collect = async (dir: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      const rootStat = await fs.lstat(dir);
      if (rootStat.isSymbolicLink())
        throw new Error(`symlink dependency/asset directory is not supported: ${dir}`);
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const name = `${prefix}${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`symlink dependency/asset is not supported: ${name}`);
      if (entry.isDirectory()) {
        await collect(path, `${name}/`);
        continue;
      }
      if (!entry.isFile()) throw new Error(`non-regular dependency/asset: ${name}`);
      if (
        name === "main.tex" ||
        name === "references.bib" ||
        name.startsWith("__argelander") ||
        name.startsWith(".argelander")
      )
        throw new Error(`reserved Writer build input: ${name}`);
      bytes += (await fs.stat(path)).size;
      if (bytes > TEX_WORKSPACE_LIMITS.maxBytes || files.size >= TEX_WORKSPACE_LIMITS.maxFiles)
        throw new Error("Writer compile input exceeds workspace limits");
      files.set(name, await fs.readFile(path));
    }
  };
  await collect(join(manuscriptDir(dataDir, id), "assets"), "assets/");
  const deps = join(templatesDir(dataDir), `${template.id}.deps`);
  const missing: string[] = [];
  for (const dep of template.deps) {
    const stat = await fs.lstat(join(deps, dep)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) missing.push(dep);
  }
  if (missing.length)
    throw new Error(
      `template "${template.id}" is missing dependencies in ${deps}: ${missing.join(", ")}`
    );
  await collect(deps, "");
  const keys = extractManuscriptCitedKeys(manuscript, template);
  let libraryBib = "";
  if (keys.length) {
    try {
      libraryBib = await fs.readFile(libraryPaths(dataDir).libraryBib, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const bib = buildBib(keys, libraryBib);
  if (bib.missing.length) warnings.push(`bibliography keys missing: ${bib.missing.join(", ")}`);
  files.set("main.tex", Buffer.from(tex));
  if (keys.length) files.set("references.bib", Buffer.from(bib.bib));
  const digest = createHash("sha256")
    .update(PREVIEW_PROFILE)
    .update(JSON.stringify(template))
    .update(writerDraftKey(manuscript));
  for (const [name, value] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    digest.update(`${name}\0${value.length}\0`).update(value);
  return {
    manuscript,
    template,
    tex,
    cellRanges,
    files,
    warnings,
    inputHash: digest.digest("hex"),
  };
}

export async function computeWriterNumbering(
  dataDir: string,
  id: string,
  signal?: AbortSignal
): Promise<WriterNumberingFile> {
  let stage: string | undefined;
  try {
    signal?.throwIfAborted();
    const input = await snapshot(dataDir, id);
    signal?.throwIfAborted();
    // Always let latexmk inspect its recorded dependencies (including system
    // styles) on a requested refresh, then run the current fuser. Unchanged
    // files keep their mtimes, so this does not force a TeX/BibTeX rerun.
    const root = await ensureBuildDir(dataDir, id);
    stage = await fs.mkdtemp(join(os.tmpdir(), "argelander-writer-source-"));
    for (const [name, value] of input.files) {
      const path = join(stage, name);
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, value);
    }
    const mainTex = join(stage, "main.tex");
    const compiled = await compileTex({
      srcDir: stage,
      mainTex,
      outDir: join(root, "artifacts"),
      cacheDir: join(root, "latexmk"),
      renderProfile: "writer",
      timeoutMs: COMPILE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    if (!compiled.ok)
      return persistFailure(
        dataDir,
        id,
        compiled.message + (compiled.excerpt ? `\n${compiled.excerpt}` : "")
      );
    const result = await buildWriterPreview({
      srcDir: stage,
      mainTex,
      docId: id,
      origin: `writer:${id}`,
      engine: compiled.engine,
      factFiles: compiled.artifacts,
      figures: texFigurePort,
      assetsDir: join(root, "assets"),
      manuscript: input.manuscript,
      template: input.template,
      cellRanges: input.cellRanges,
    });
    result.preview.warnings.unshift(...input.warnings, ...compiled.warnings);
    if (compiled.artifacts.log) {
      const log = await fs.readFile(compiled.artifacts.log, "utf8");
      for (const line of log.split("\n")) {
        if (/undefined|multiply defined|Rerun to get/.test(line))
          result.preview.warnings.push(line.trim());
      }
    }
    const file: WriterNumberingFile = {
      version: 1,
      at: new Date().toISOString(),
      texHash: sha256(input.tex),
      inputHash: input.inputHash,
      facts: result.facts,
      preview: result.preview,
      lastError: null,
    };
    signal?.throwIfAborted();
    await writeNumberingFile(dataDir, id, file);
    return file;
  } catch (err) {
    if (signal?.aborted) throw new WriterNumberingError(`preview canceled for ${id}`, "canceled");
    if (err instanceof WriterNumberingError) throw err;
    return persistFailure(dataDir, id, err instanceof Error ? err.message : String(err));
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function getWriterNumbering(
  dataDir: string,
  id: string
): Promise<WriterNumberingResponse> {
  if (!loadManuscript(dataDir, id))
    throw new WriterNumberingError(`manuscript not found: ${id}`, "not-found");
  const file = await readNumberingFile(dataDir, id);
  const compiling = Boolean(scheduled.get(scheduleKey(dataDir, id))?.running);
  let input: Snapshot;
  try {
    input = await snapshot(dataDir, id);
  } catch (err) {
    return {
      status: "stale",
      ...(file ? { at: file.at } : {}),
      facts: file?.facts ?? null,
      preview: file?.preview ?? null,
      compiling,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
  if (!file) return { status: "never", facts: null, lastError: null, preview: null, compiling };
  return {
    status:
      file.lastError === null && file.inputHash === input.inputHash && file.preview
        ? "ok"
        : "stale",
    at: file.at,
    facts: file.facts,
    preview: file.preview ?? null,
    lastError: file.lastError,
    compiling,
  };
}

// One shared flight for ALL entry points; scoped to data root as well as id.
type BroadcastFn = (msg: WsWriterChanged) => void;
type ComputeFn = (
  dataDir: string,
  id: string,
  signal?: AbortSignal
) => Promise<WriterNumberingFile>;
interface Scheduled {
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  again: boolean;
  canceled: boolean;
  controller: AbortController;
  broadcast: BroadcastFn;
  dataDir: string;
  id: string;
}
const scheduled = new Map<string, Scheduled>();
const scheduleKey = (dataDir: string, id: string) => `${resolve(dataDir)}\0${id}`;
let computeImpl: ComputeFn = computeWriterNumbering;
export function __setNumberingComputeForTests(impl: ComputeFn): () => void {
  const prev = computeImpl;
  computeImpl = impl;
  return () => {
    computeImpl = prev;
  };
}
function entryFor(dataDir: string, id: string, broadcast: BroadcastFn): Scheduled {
  const key = scheduleKey(dataDir, id);
  let entry = scheduled.get(key);
  if (!entry) {
    entry = {
      timer: null,
      running: null,
      again: false,
      canceled: false,
      controller: new AbortController(),
      broadcast,
      dataDir,
      id,
    };
    scheduled.set(key, entry);
  }
  entry.broadcast = broadcast;
  return entry;
}
function runScheduled(entry: Scheduled): Promise<void> {
  if (entry.running) {
    entry.again = true;
    return entry.running;
  }
  // Queue the body in a microtask so running is installed BEFORE compute can
  // schedule a follow-up. Manual/manual and manual/automatic share this promise.
  entry.running = Promise.resolve()
    .then(async () => {
      do {
        entry.again = false;
        if (entry.canceled) break;
        const file = await computeImpl(entry.dataDir, entry.id, entry.controller.signal);
        // Failures also notify the UI; leaving an old green preview is misleading.
        if (!entry.canceled)
          entry.broadcast({
            type: "writer.changed",
            cause: "numbering",
            id: entry.id,
            at: file.at,
          });
      } while (entry.again && !entry.canceled);
    })
    .finally(() => {
      entry.running = null;
      const key = scheduleKey(entry.dataDir, entry.id);
      if (!entry.timer && scheduled.get(key) === entry) scheduled.delete(key);
    });
  return entry.running;
}
export function scheduleNumberingCompile(
  dataDir: string,
  id: string,
  opts: { broadcast: BroadcastFn }
): void {
  const entry = entryFor(dataDir, id, opts.broadcast);
  if (entry.running) {
    entry.again = true;
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void runScheduled(entry).catch((err) => {
      if (!(err instanceof WriterNumberingError)) console.error("[writer-preview]", err);
    });
  }, DEBOUNCE_MS);
  entry.timer.unref?.();
}
export async function runWriterNumberingNow(
  dataDir: string,
  id: string,
  opts: { broadcast: BroadcastFn }
): Promise<WriterNumberingResponse> {
  const entry = entryFor(dataDir, id, opts.broadcast);
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  await runScheduled(entry);
  return getWriterNumbering(dataDir, id);
}
/** Drain before DELETE: an in-flight compile must never resurrect a deleted dir. */
export async function cancelNumberingCompile(id: string, dataDir?: string): Promise<void> {
  const entries = [...scheduled.values()].filter(
    (e) => e.id === id && (dataDir === undefined || resolve(e.dataDir) === resolve(dataDir))
  );
  for (const entry of entries) {
    entry.canceled = true;
    entry.controller.abort();
    entry.again = false;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    await entry.running?.catch(() => {});
    scheduled.delete(scheduleKey(entry.dataDir, entry.id));
  }
}
