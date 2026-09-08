/**
 * Golden regression for the Stage 5 tex pipeline (roadmap Q10):
 * `tests/golden/tex/arxiv-<id>.{json,md}` were frozen from a real compile
 * (`ingestTex` + dvisvgm figures). This suite re-runs the COMPILER-FREE
 * half (`fuseTexDoc` over the frozen build artifacts in `build-<id>/` with
 * a naming-faithful figure-port stub) and requires byte-identical IR JSON
 * and regenerated markdown — a deterministic re-run diff.
 *
 * Spot checks of print-faithful numbering live in the per-paper assertions
 * below (they encode the human review of the freeze).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrBlock, IrSegment } from "@argelanderspace/contracts";
import type { TexFigurePort } from "@argelanderspace/core";
import { fuseTexDoc, renderIrMarkdown, texFigureOutName } from "@argelanderspace/core";
import { describe, expect, test } from "vitest";
import { diffJson, type Json } from "./helpers/diff-json.js";

// packages/core/tests/ → repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GOLDEN_DIR = join(REPO_ROOT, "tests", "golden", "tex");
const FIXTURES = fileURLToPath(new URL("fixtures/latex", import.meta.url));

const PAPERS = [
  { id: "2501.17225", main: "Arxiv.tex", publisher: "aanda" },
  { id: "2012.05220", main: "gedr3_distances.tex", publisher: undefined },
] as const;

/**
 * Naming-faithful figure stub: computes exactly the name the real
 * `materializeTexFigure` produced at freeze time, without dvisvgm.
 */
const stubFigures: TexFigurePort = {
  materialize: (req) => {
    const ext = req.src.toLowerCase().split(".").pop() ?? "";
    const suffix = ext === "pdf" || ext === "eps" ? ".svg" : `.${ext}`;
    return Promise.resolve({ ok: true, file: texFigureOutName(req.srcDir, req.src, suffix) });
  },
};

async function rerun(id: string, main: string, publisher?: string) {
  const srcDir = join(FIXTURES, id);
  const build = join(GOLDEN_DIR, `build-${id}`);
  const mainBase = main.replace(/\.tex$/i, "");
  return fuseTexDoc({
    srcDir,
    mainTex: join(srcDir, main),
    docId: `arxiv-${id}`,
    origin: `https://arxiv.org/e-print/${id}`,
    arxivId: id,
    ...(publisher !== undefined ? { publisher } : {}),
    engine: "pdflatex",
    factFiles: {
      aux: join(build, `${mainBase}.aux`),
      bbl: join(build, `${mainBase}.bbl`),
      toc: join(build, `${mainBase}.toc`),
      fls: join(build, `${mainBase}.fls`),
      events: join(build, `${mainBase}.argelander.jsonl`),
    },
    figures: stubFigures,
    assetsDir: join(GOLDEN_DIR, `assets-${id}`),
  });
}

describe("golden-tex: deterministic re-run over frozen artifacts", () => {
  for (const p of PAPERS) {
    test(`arxiv-${p.id}: IR + markdown byte-identical`, { timeout: 120_000 }, async () => {
      const { ir } = await rerun(p.id, p.main, p.publisher);
      const golden = JSON.parse(
        readFileSync(join(GOLDEN_DIR, `arxiv-${p.id}.json`), "utf8")
      ) as Json;
      const diffs = diffJson(JSON.parse(JSON.stringify(ir)) as Json, golden);
      const report = diffs.slice(0, 20).join("\n");
      expect(diffs.length, `${diffs.length} field diffs (first 20):\n${report}`).toBe(0);

      const md = renderIrMarkdown(ir);
      const goldenMd = readFileSync(join(GOLDEN_DIR, `arxiv-${p.id}.md`), "utf8");
      expect(md).toBe(goldenMd);
    });
  }
});

describe("golden-tex: print-faithfulness spot checks (human-reviewed at freeze)", () => {
  test("arxiv-2501.17225 (A&A): sections, appendix tables, 12 equations, 76 refs", async () => {
    const { ir } = await rerun("2501.17225", "Arxiv.tex", "aanda");
    const top = ir.sections.map((s) => [s.number ?? "", s.heading ?? ""]);
    expect(top).toEqual([
      ["", "Abstract"],
      ["1", "Introduction"],
      ["2", "Data"],
      ["3", "Methods"],
      ["4", "Results"],
      ["5", "Discussion"],
      ["6", "Conclusions"],
      ["", "Data availability"],
      ["A", "Supplementary query and tables"],
    ]);
    const eqs: string[] = [];
    const tabs: string[] = [];
    const figs: string[] = [];
    const walk = (secs: typeof ir.sections): void => {
      for (const s of secs) {
        for (const b of s.blocks) {
          if (b.type === "equation" && b.number !== undefined) eqs.push(b.number);
          if (b.type === "table" && b.number !== undefined) tabs.push(b.number);
          if (b.type === "figure" && b.number !== undefined) figs.push(b.number);
        }
        walk(s.children);
      }
    };
    walk(ir.sections);
    expect(eqs).toEqual([...Array(12)].map((_, i) => String(i + 1)));
    expect(tabs).toEqual(["A.1", "A.2", "A.3", "A.4"]); // appendix tables; main-body ones are commented out
    expect(figs).toHaveLength(25);
    expect(figs[0]).toBe("1");
    expect(ir.references).toHaveLength(76);
    expect(ir.title).toBe("Tidal tails of nearby open clusters — I. Mapping with Gaia DR3");
  }, 120_000);

  test("arxiv-2012.05220 (AASTeX62): subsubsection print numbers, appendix letters", async () => {
    const { ir } = await rerun("2012.05220", "gedr3_distances.tex");
    const byHeading = new Map<string, string | undefined>();
    const walk = (secs: typeof ir.sections): void => {
      for (const s of secs) {
        if (s.heading !== undefined) byHeading.set(s.heading, s.number);
        walk(s.children);
      }
    };
    walk(ir.sections);
    expect(byHeading.get("Markov Chain Monte Carlo")).toBe("2.6.1");
    expect(byHeading.get("Quantitative analysis")).toBe("3.2.2");
    expect(byHeading.get("Distance distributions and uncertainties")).toBe("4.1.1");
    expect(byHeading.get("Galactic spatial distribution")).toBe("4.2.3");
    expect(byHeading.get("Thoughts on a better distance prior")).toBe("A");
    expect(byHeading.get("The limit of poor parallaxes")).toBe("B");
    expect(ir.references).toHaveLength(37);
    expect(ir.meta.authors).toEqual([
      "C.A.L. Bailer-Jones",
      "J. Rybizki",
      "M. Fouesneau",
      "M. Demleitner",
      "R. Andrae",
    ]);
  }, 120_000);

  test("arxiv-2501.17225: tables carry captions + non-empty bodies; zero comment-env code blocks", async () => {
    const { ir } = await rerun("2501.17225", "Arxiv.tex", "aanda");
    const tables: Extract<IrBlock, { type: "table" }>[] = [];
    const walk = (secs: typeof ir.sections): void => {
      for (const s of secs) {
        for (const b of s.blocks) {
          if (b.type === "table") tables.push(b);
          // B3: author-deleted comment-env content must not surface as code
          expect(b.type).not.toBe("code");
        }
        walk(s.children);
      }
    };
    walk(ir.sections);
    expect(tables).toHaveLength(4);
    for (const t of tables) {
      expect(t.tableBody, `${t.id} tableBody`).toMatch(/^<table>[\s\S]*<\/table>$/);
      expect(t.tableBody, `${t.id} rows`).toContain("<tr>");
      expect(t.captionSegments?.length ?? 0, `${t.id} caption`).toBeGreaterThan(0);
    }
    const firstCaption = (tables[0]?.captionSegments ?? [])
      .map((s: IrSegment) => (s.type === "text" ? s.text : s.type === "math" ? `$${s.latex}$` : ""))
      .join("");
    expect(firstCaption).toContain("Pole and origin"); // old-golden caption restored (B1)
  }, 120_000);

  test("arxiv-2012.05220: center-wrapped tabular bodies non-empty + parseable shape", async () => {
    const { ir } = await rerun("2012.05220", "gedr3_distances.tex");
    const tables: Extract<IrBlock, { type: "table" }>[] = [];
    const codes: Extract<IrBlock, { type: "code" }>[] = [];
    const walk = (secs: typeof ir.sections): void => {
      for (const s of secs) {
        for (const b of s.blocks) {
          if (b.type === "table") tables.push(b);
          if (b.type === "code") codes.push(b);
        }
        walk(s.children);
      }
    };
    walk(ir.sections);
    expect(tables).toHaveLength(2);
    // exactly one code block: the ADQL query (verbatim inside \small{…}),
    // matching the old golden's inventory; comment-env content stays out
    expect(codes).toHaveLength(1);
    expect(codes[0]?.body).toContain("SELECT");
    expect(codes[0]?.body).toContain("source_id");
    for (const t of tables) {
      // the shape web's tableparse.ts consumes: <table><tr><td|th>…
      expect(t.tableBody, `${t.id} tableBody`).toMatch(/^<table>[\s\S]*<\/table>$/);
      expect(t.tableBody, `${t.id} has cells`).toMatch(/<t[dh][^>]*>\S/);
      expect(t.captionSegments?.length ?? 0, `${t.id} caption`).toBeGreaterThan(0);
    }
  }, 120_000);
});
