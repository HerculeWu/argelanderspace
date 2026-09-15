/**
 * Writer numbering channel (Stage 10 M3, D14): compile-truth numbers for the
 * Writer's outline/crossref panels.
 *
 * A single-pass `pdflatex` run over the assembled document
 * (buildTexDocumentMapped) in an isolated workspace — instrumented with the
 * shipped argelander.sty wrapper — yields section/mathnum/label events with
 * TRUE printed numbers (verified 2026-09-15, session inbox F5: numbering is
 * single-pass truth; multi-pass only stabilizes \ref display, which the
 * writer never shows; the PDF is discarded, never served).
 *
 * Outcomes persist to `manuscripts/<id>/build/numbering.json`
 * (WriterNumberingFile): success stores facts; failure keeps the previous
 * facts and records `lastError` (the UI then shows a stale marker, never a
 * disruptive error — an edit-in-progress document routinely does not
 * compile). The file is a DERIVED cache: corrupt content degrades to the
 * "never compiled" response, it is never treated as user data.
 *
 * Template dependencies (D14): `template.deps` names files that must exist
 * in `templates/<templateId>.deps/`; they are searched via TEXINPUTS (cwd
 * first — TeX always searches the working directory, so assets/ next to
 * main.tex needs no path entry).
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  buildTexDocumentMapped,
  fuseNumberingEvents,
  type WriterManuscript,
  type WriterNumberingFacts,
  type WriterNumberingFile,
  WriterNumberingFileSchema,
  type WriterNumberingResponse,
  type WriterTemplate,
  type WsWriterChanged,
} from "@argelanderspace/contracts";
import { loadManuscript, loadTemplates, manuscriptDir, templatesDir } from "@argelanderspace/core";
import {
  createTexWorkspace,
  extractRelevantLogLines,
  prepareTexInstrumentation,
  runTexProcess,
  TEX_WRAPPER_NAME,
  type TexWorkspace,
} from "@argelanderspace/infra";

const COMPILE_TIMEOUT_MS = 30_000;
const DEBOUNCE_MS = 2_500;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function numberingPath(dataDir: string, id: string): string {
  return join(manuscriptDir(dataDir, id), "build", "numbering.json");
}

/** Read the persisted numbering file; missing/corrupt → null (derived cache). */
async function readNumberingFile(dataDir: string, id: string): Promise<WriterNumberingFile | null> {
  try {
    const raw = await fs.readFile(numberingPath(dataDir, id), "utf8");
    return WriterNumberingFileSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeNumberingFile(
  dataDir: string,
  id: string,
  file: WriterNumberingFile
): Promise<void> {
  const p = numberingPath(dataDir, id);
  await fs.mkdir(join(manuscriptDir(dataDir, id), "build"), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await fs.rename(tmp, p);
}

/** Persist a failure: keep the previous facts/hash, set a compact lastError. */
async function persistFailure(
  dataDir: string,
  id: string,
  message: string
): Promise<WriterNumberingFile> {
  const prev = await readNumberingFile(dataDir, id);
  const file: WriterNumberingFile = {
    version: 1,
    at: prev?.at ?? new Date().toISOString(),
    texHash: prev?.texHash ?? "",
    facts: prev?.facts ?? null,
    lastError: message.slice(0, 500),
  };
  await writeNumberingFile(dataDir, id, file);
  return file;
}

class WriterNumberingError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found"
  ) {
    super(message);
    this.name = "WriterNumberingError";
  }
}

function resolveTemplate(
  manuscript: { template: string },
  templates: WriterTemplate[]
): WriterTemplate | undefined {
  return templates.find((t) => t.id === manuscript.template);
}

/**
 * Compile-truth numbering for one manuscript. Always persists the outcome to
 * build/numbering.json (success facts or failure with retained prior facts).
 * Throws WriterNumberingError("not-found") for an unknown manuscript id.
 */
export async function computeWriterNumbering(
  dataDir: string,
  id: string
): Promise<WriterNumberingFile> {
  const manuscript = loadManuscript(dataDir, id);
  if (!manuscript) {
    throw new WriterNumberingError(`manuscript not found: ${id}`, "not-found");
  }
  const { templates } = loadTemplates(dataDir);
  const template = resolveTemplate(manuscript, templates);
  if (!template) {
    return persistFailure(dataDir, id, `template "${manuscript.template}" unavailable`);
  }

  // D14 dependency pre-check: declared deps must live in the template's
  // deps dir; anything missing fails fast WITHOUT attempting a compile.
  const depsDir = join(templatesDir(dataDir), `${template.id}.deps`);
  const missingDeps: string[] = [];
  for (const dep of template.deps) {
    try {
      await fs.access(join(depsDir, dep));
    } catch {
      missingDeps.push(dep);
    }
  }
  if (missingDeps.length > 0) {
    return persistFailure(
      dataDir,
      id,
      `template "${template.id}" is missing dependencies in ${depsDir}: ${missingDeps.join(", ")}`
    );
  }

  const { tex, cellRanges } = buildTexDocumentMapped(manuscript, template);
  const texHash = sha256(tex);

  let workspace: TexWorkspace | null = null;
  try {
    // Assemble an isolated source dir: main.tex + the manuscript's assets/.
    workspace = await createTexWorkspaceFromParts(manuscriptDir(dataDir, id), tex);
    const mainAbs = join(workspace.dir, "main.tex");
    await prepareTexInstrumentation(mainAbs);

    // One pass; numbering/labels are single-pass truth (F5). The events land
    // at <jobname>.argelander.jsonl; the PDF is never collected.
    const result = await runTexProcess(
      "pdflatex",
      ["-interaction=nonstopmode", "-recorder", "-jobname=main", TEX_WRAPPER_NAME],
      {
        cwd: workspace.dir,
        timeoutMs: COMPILE_TIMEOUT_MS,
        // Trailing ':' keeps the default search path after the deps dir.
        ...(template.deps.length > 0 ? { env: { TEXINPUTS: `${depsDir}:` } } : {}),
      }
    );

    const log = await fs.readFile(join(workspace.dir, "main.log"), "utf8").catch(() => "");
    const eventsText = await fs
      .readFile(join(workspace.dir, "main.argelander.jsonl"), "utf8")
      .catch(() => "");
    const failMessage = (): string => {
      const lines = extractRelevantLogLines(log || `${result.stdout}\n${result.stderr}`);
      return (
        (result.timedOut
          ? `numbering compile timed out after ${COMPILE_TIMEOUT_MS}ms`
          : `numbering compile failed (exit ${result.code ?? result.signal ?? "?"})`) +
        (lines.length > 0 ? `\n${lines.join("\n")}` : "")
      );
    };

    let facts: WriterNumberingFacts | null = null;
    if (!result.timedOut && result.code === 0 && eventsText.trim() !== "") {
      const auxText = await fs.readFile(join(workspace.dir, "main.aux"), "utf8").catch(() => "");
      facts = fuseNumberingEvents(eventsText, auxText, cellRanges);
      if (facts.sections.length === 0 && facts.equations.length === 0 && eventsText.trim() === "") {
        facts = null;
      }
    }

    if (facts === null) {
      return persistFailure(
        dataDir,
        id,
        result.code === 0 && !result.timedOut
          ? "numbering compile produced no events (instrumentation degraded)"
          : failMessage()
      );
    }
    const file: WriterNumberingFile = {
      version: 1,
      at: new Date().toISOString(),
      texHash,
      facts,
      lastError: null,
    };
    await writeNumberingFile(dataDir, id, file);
    return file;
  } finally {
    await workspace?.cleanup();
  }
}

/**
 * Isolated workspace carrying main.tex + the manuscript's assets/ tree.
 * Stage through an empty source dir (createTexWorkspace guards) and write
 * main.tex + copy assets (plain copies, no symlinks) into it.
 */
async function createTexWorkspaceFromParts(
  manuscriptDirAbs: string,
  tex: string
): Promise<TexWorkspace> {
  const staging = await fs.mkdtemp(join(os.tmpdir(), "argelander-writer-stage-"));
  try {
    const workspace = await createTexWorkspace(staging);
    await fs.writeFile(join(workspace.dir, "main.tex"), tex, "utf8");
    const assetsDir = join(manuscriptDirAbs, "assets");
    const assetsExist = await fs
      .stat(assetsDir)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (assetsExist) {
      // plain copies only (never symlinks — the workspace guard philosophy)
      const srcReal = await fs.realpath(assetsDir);
      const dstAssets = join(workspace.dir, "assets");
      await fs.mkdir(dstAssets, { recursive: true });
      for (const name of await fs.readdir(srcReal)) {
        const src = join(srcReal, name);
        const stat = await fs.lstat(src);
        if (!stat.isFile()) continue;
        await fs.copyFile(src, join(dstAssets, name));
      }
    }
    return workspace;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/**
 * Current numbering state for the GET route. Missing/corrupt file → `never`;
 * the live tex hash is recomputed (template gone → `stale` with an error).
 */
export function getWriterNumbering(dataDir: string, id: string): Promise<WriterNumberingResponse> {
  return getWriterNumberingAsync(dataDir, id);
}

/** Sync hash helper shared by getWriterNumberingAsync and the scheduler. */
function assembleCurrentHash(
  _dataDir: string,
  manuscript: WriterManuscript,
  templates: WriterTemplate[]
): { hash: string | null; template: WriterTemplate | undefined } {
  const template = resolveTemplate(manuscript, templates);
  if (!template) return { hash: null, template: undefined };
  const { tex } = buildTexDocumentMapped(manuscript, template);
  return { hash: sha256(tex), template };
}

async function getWriterNumberingAsync(
  dataDir: string,
  id: string
): Promise<WriterNumberingResponse> {
  const manuscript = loadManuscript(dataDir, id);
  if (!manuscript) {
    throw new WriterNumberingError(`manuscript not found: ${id}`, "not-found");
  }
  const { templates } = loadTemplates(dataDir);
  const { hash, template } = assembleCurrentHash(dataDir, manuscript, templates);
  const file = await readNumberingFile(dataDir, id);

  if (!template) {
    return {
      status: "stale",
      at: file?.at,
      facts: file?.facts ?? null,
      lastError: `template "${manuscript.template}" unavailable`,
    };
  }
  if (!file) return { status: "never", facts: null, lastError: null };

  const status = file.lastError === null && file.texHash === hash ? "ok" : "stale";
  return { status, at: file.at, facts: file.facts, lastError: file.lastError };
}

// ---- scheduler: per-manuscript debounce + single-flight + one follow-up --- //

type BroadcastFn = (msg: WsWriterChanged) => void;
type ComputeFn = (dataDir: string, id: string) => Promise<WriterNumberingFile>;

interface Scheduled {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** exactly one pending follow-up while a compile is in flight */
  followUp: boolean;
  broadcast: BroadcastFn;
}

const scheduled = new Map<string, Scheduled>();
/** Test seam: swap the compute implementation (default: the real compile). */
let computeImpl: ComputeFn = computeWriterNumbering;

/** TEST-ONLY: replace the compute implementation; returns a restore fn. */
export function __setNumberingComputeForTests(impl: ComputeFn): () => void {
  const prev = computeImpl;
  computeImpl = impl;
  return () => {
    computeImpl = prev;
  };
}

async function runScheduled(dataDir: string, id: string): Promise<void> {
  const entry = scheduled.get(id);
  if (!entry) return;
  if (entry.running) {
    entry.followUp = true;
    return;
  }
  entry.running = true;
  try {
    do {
      entry.followUp = false;
      const file = await computeImpl(dataDir, id);
      if (file.lastError === null && file.facts !== null) {
        entry.broadcast({ type: "writer.changed", cause: "numbering", id, at: file.at });
      }
      // failures persisted the file; no broadcast (UI stays on prior facts).
    } while (entry.followUp);
  } finally {
    entry.running = false;
    if (!entry.timer && !entry.followUp) scheduled.delete(id);
  }
}

/** Debounced auto-compile after saves (2.5 s per manuscript, single-flight). */
export function scheduleNumberingCompile(
  dataDir: string,
  id: string,
  opts: { broadcast: BroadcastFn }
): void {
  let entry = scheduled.get(id);
  if (!entry) {
    entry = { timer: null, running: false, followUp: false, broadcast: opts.broadcast };
    scheduled.set(id, entry);
  }
  entry.broadcast = opts.broadcast;
  if (entry.running) {
    // a compile is in flight: run exactly one follow-up, no debounce wait
    entry.followUp = true;
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void runScheduled(dataDir, id).catch((err) => {
      console.error(`[writer-numbering] compile for ${id} failed:`, err);
      if (!entry.running && !entry.timer) scheduled.delete(id);
    });
  }, DEBOUNCE_MS);
}

/** Manual refresh: skip the debounce, same single-flight; returns the state. */
export async function runWriterNumberingNow(
  dataDir: string,
  id: string,
  opts: { broadcast: BroadcastFn }
): Promise<WriterNumberingResponse> {
  const entry = scheduled.get(id);
  if (entry?.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry?.running) {
    // coalesce: mark a follow-up and wait for the in-flight loop to finish
    entry.followUp = true;
    while (entry.running) await new Promise((r) => setTimeout(r, 50));
  } else {
    await computeImpl(dataDir, id).then((file) => {
      if (file.lastError === null && file.facts !== null) {
        opts.broadcast({ type: "writer.changed", cause: "numbering", id, at: file.at });
      }
    });
  }
  return getWriterNumberingAsync(dataDir, id);
}

/** DELETE path: drop any pending debounce; never waits for an in-flight run. */
export function cancelNumberingCompile(id: string): void {
  const entry = scheduled.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  scheduled.delete(id);
}

export { WriterNumberingError };
