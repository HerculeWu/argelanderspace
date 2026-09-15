/**
 * buildWriterExport (Stage 10 M3): tex assembly + cited-only bib + referenced
 * assets, against a tmp dataDir. Covers the not-found / unknown-template
 * error kinds, the missing-library.bib warning path, and asset hygiene
 * (referenced-but-missing and suspicious names are warnings, not crashes).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildWriterExport } from "../src/writer/export.js";
import { createManuscript, saveManuscript } from "../src/writer/store.js";

const dataDir = mkdtempSync(join(tmpdir(), "writer-export-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function seedLibraryBib() {
  mkdirSync(join(dataDir, "library"), { recursive: true });
  writeFileSync(
    join(dataDir, "library", "library.bib"),
    `@article{Belokurov2006,\n  title = {The Field of Streams},\n}\n\n@article{GaiaDR3,\n  title = {Gaia DR3},\n}\n`
  );
}

function seedManuscript() {
  const m = createManuscript(dataDir, { template: "report", title: "Export Probe" });
  m.cells = [
    {
      id: "c_00000001",
      type: "latex",
      data: { source: "\\section{Intro}\n\nSee \\citep{Belokurov2006} and \\cite{ghost2026}." },
    },
    {
      id: "c_00000002",
      type: "figure",
      data: { caption: "Fig", label: "fig:f", placement: "center", width: 80, image: "fig.png" },
    },
    {
      id: "c_00000003",
      type: "figure",
      data: { caption: "Gone", label: "fig:g", placement: "center", width: 80, image: "gone.png" },
    },
  ];
  saveManuscript(dataDir, m, { bumpRev: false });
  mkdirSync(join(dataDir, "manuscripts", m.id, "assets"), { recursive: true });
  writeFileSync(join(dataDir, "manuscripts", m.id, "assets", "fig.png"), "PNG_BYTES");
  return m;
}

describe("buildWriterExport", () => {
  it("assembles tex + cited-only bib + referenced assets with warnings", () => {
    seedLibraryBib();
    const m = seedManuscript();
    const bundle = buildWriterExport(dataDir, m.id);
    expect(bundle.tex).toContain("\\section{Intro}");
    expect(bundle.tex).toContain("\\bibliography{references}");
    expect(bundle.bib).toContain("@article{Belokurov2006,");
    expect(bundle.bib).not.toContain("GaiaDR3");
    expect(bundle.bibMissing).toEqual(["ghost2026"]);
    expect(bundle.bib).toContain("% missing: ghost2026");
    expect(bundle.assets).toEqual([
      { name: "fig.png", abs: join(dataDir, "manuscripts", m.id, "assets", "fig.png") },
    ]);
    expect(bundle.warnings.some((w) => w.includes("gone.png"))).toBe(true);
  });

  it("not-found and unknown-template error kinds", () => {
    expect(() => buildWriterExport(dataDir, "m_00000000")).toThrowError(
      expect.objectContaining({ kind: "not-found" })
    );
    const m = createManuscript(dataDir, { template: "report" });
    m.template = "ghost-template";
    saveManuscript(dataDir, m, { bumpRev: false });
    expect(() => buildWriterExport(dataDir, m.id)).toThrowError(
      expect.objectContaining({ kind: "unknown-template" })
    );
  });

  it("no citations → bib null", () => {
    const m = createManuscript(dataDir, { template: "report" });
    m.cells = [{ id: "c_00000009", type: "latex", data: { source: "No cites." } }];
    saveManuscript(dataDir, m, { bumpRev: false });
    const bundle = buildWriterExport(dataDir, m.id);
    expect(bundle.bib).toBeNull();
    expect(bundle.tex).not.toContain("\\bibliography");
  });
});
