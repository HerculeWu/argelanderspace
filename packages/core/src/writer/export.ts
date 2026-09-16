/**
 * Writer export bundle assembly (Stage 10 M3, plan §5): the pieces of the
 * downloadable zip — a single `manuscript.tex`, a cited-only verbatim
 * `references.bib`, and the figure assets referenced by figure cells.
 * IO lives here (core store + library paths); the zip container itself is
 * `infra/src/lib/zip.ts`; the route is `GET /api/writer/manuscripts/:id/export`.
 * Synchronous, like the core plans/writer stores.
 */

import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  buildBib,
  buildTexDocument,
  extractManuscriptCitedKeys,
  type WriterManuscript,
  type WriterTemplate,
} from "@argelanderspace/contracts";
import { libraryPaths } from "../library/store.js";
import { loadManuscript, loadTemplates, manuscriptDir, templatesDir } from "./store.js";

export interface WriterExportBundle {
  /** Manuscript title (download filename). */
  title: string;
  /** Contents of `manuscript.tex`. */
  tex: string;
  /** Contents of `references.bib`; null when nothing is cited. */
  bib: string | null;
  /** Cited keys not present in `library.bib` (surfaced as warnings). */
  bibMissing: string[];
  /** Figure assets to ship (name inside `assets/`, absolute source path). */
  assets: { name: string; abs: string }[];
  /** Template dependencies shipped verbatim at the zip root (Stage 12): the
   *  user installed them under templates/<id>.deps/ — the zip must be
   *  self-contained for a local latexmk run. */
  deps: { name: string; abs: string }[];
  /** Non-fatal issues worth surfacing to the user. */
  warnings: string[];
}

/** Manuscript id is unknown (→ 404) or its template is gone (→ 400-ish). */
export class WriterExportError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "unknown-template"
  ) {
    super(message);
    this.name = "WriterExportError";
  }
}

/** Assets referenced by figure cells that exist under the manuscript's assets/. */
function collectReferencedAssets(
  dataDir: string,
  manuscript: WriterManuscript,
  warnings: string[]
): WriterExportBundle["assets"] {
  const dir = join(manuscriptDir(dataDir, manuscript.id), "assets");
  const names = new Set<string>();
  for (const cell of manuscript.cells) {
    if (cell.type !== "figure") continue;
    const image = (cell.data as Record<string, unknown>).image;
    if (typeof image === "string" && image) names.add(image);
  }
  const out: WriterExportBundle["assets"] = [];
  for (const name of names) {
    // the store write path already sanitizes names; re-check before reading
    if (name !== name.split("/").pop() || name.includes("..") || name.includes("\\")) {
      warnings.push(`skipped suspicious asset name: ${name}`);
      continue;
    }
    const abs = join(dir, name);
    try {
      if (lstatSync(abs).isFile()) out.push({ name, abs });
      else warnings.push(`figure asset referenced but missing on disk: ${name}`);
    } catch {
      warnings.push(`figure asset referenced but missing on disk: ${name}`);
    }
  }
  return out;
}

/**
 * Assemble the export bundle. Throws WriterExportError("not-found") for an
 * unknown manuscript id and ("unknown-template") when its bound template is
 * no longer loadable.
 */
export function buildWriterExport(dataDir: string, id: string): WriterExportBundle {
  const manuscript = loadManuscript(dataDir, id);
  if (!manuscript) throw new WriterExportError(`manuscript not found: ${id}`, "not-found");
  const { templates, warnings } = loadTemplates(dataDir);
  const template: WriterTemplate | undefined = templates.find((t) => t.id === manuscript.template);
  if (!template) {
    throw new WriterExportError(
      `template "${manuscript.template}" is not available for manuscript ${id}`,
      "unknown-template"
    );
  }

  const tex = buildTexDocument(manuscript, template);
  const keys = extractManuscriptCitedKeys(manuscript, template);
  let bib: string | null = null;
  let bibMissing: string[] = [];
  if (keys.length > 0) {
    let bibText = "";
    try {
      bibText = readFileSync(libraryPaths(dataDir).libraryBib, "utf8");
    } catch {
      /* missing library.bib handled below */
    }
    if (bibText === "")
      warnings.push("library.bib is missing or empty; all citations are unresolved");
    const built = buildBib(keys, bibText);
    bib = built.bib;
    bibMissing = built.missing;
  }

  const deps: { name: string; abs: string }[] = [];
  for (const dep of template.deps) {
    // deps are plain file names; refuse traversal and symlinks (same rule as
    // the compile input assembly in server/writer-numbering)
    if (dep !== basename(dep)) {
      warnings.push(`template dependency is not a plain file name, skipped: ${dep}`);
      continue;
    }
    const path = join(templatesDir(dataDir), `${template.id}.deps`, dep);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        warnings.push(`template dependency is a symlink, skipped: ${dep}`);
        continue;
      }
      if (!st.isFile()) {
        warnings.push(`template dependency is not a regular file: ${dep}`);
        continue;
      }
      deps.push({ name: dep, abs: path });
    } catch {
      warnings.push(`template dependency missing: ${path}`);
    }
  }
  const assets = collectReferencedAssets(dataDir, manuscript, warnings);
  return { title: manuscript.title, tex, bib, bibMissing, assets, deps, warnings };
}
