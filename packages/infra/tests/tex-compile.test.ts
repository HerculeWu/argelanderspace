/**
 * latexmk compile-runner tests (Stage 5 MS1, `src/tex/compile.ts`).
 *
 * Real compilations are gated on latexmk + pdflatex + xelatex being on PATH
 * (HAVE_PANDOC idiom). Fixtures live in @argelanderspace/core
 * (`core/tests/fixtures/tex/`); the battery/minimal ones double as the
 * frozen-artifact sources for the core parser tests.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTexEvents } from "@argelanderspace/core";
import { describe, expect, test } from "vitest";
import {
  compileTex,
  compileTexAttempt,
  extractRelevantLogLines,
  haveLatexmk,
  haveTexEngine,
  stripTexComment,
} from "../src/tex/compile.js";

const TEX_FIXTURES = fileURLToPath(new URL("../../core/tests/fixtures/tex", import.meta.url));
const LATEX = haveLatexmk() && haveTexEngine("pdflatex") && haveTexEngine("xelatex");
if (!LATEX) console.warn("latexmk/pdflatex/xelatex not on PATH — real-compile tests skipped");

const fixture = (name: string): { srcDir: string; mainTex: string } => ({
  srcDir: join(TEX_FIXTURES, name),
  mainTex: join(TEX_FIXTURES, name, "main.tex"),
});

async function tmpOut(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tex-build-"));
}

describe("extractRelevantLogLines (pure)", () => {
  test("! lines with following context + l.<n> lines; tail fallback", () => {
    const log = [
      "noise",
      "! Undefined control sequence.",
      "l.6 \\foo",
      "more noise",
      "l.9 trailing",
    ].join("\n");
    expect(extractRelevantLogLines(log)).toEqual([
      "! Undefined control sequence.",
      "l.6 \\foo",
      "l.9 trailing",
    ]);
    const tail = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    expect(extractRelevantLogLines(tail)).toHaveLength(30);
    expect(extractRelevantLogLines(tail)[0]).toBe("line10");
  });
});

describe("stripTexComment (pure)", () => {
  test("% starts a comment; \\% is literal; \\\\ then % is a comment", () => {
    expect(stripTexComment("Hello. % \\write18{bad} in a comment")).toBe("Hello. ");
    expect(stripTexComment("% \\usepackage{minted}")).toBe("");
    expect(stripTexComment("100\\% sure % rest is comment")).toBe("100\\% sure ");
    expect(stripTexComment("newline \\\\ % comment after \\\\")).toBe("newline \\\\ ");
    expect(stripTexComment("no comment \\\\% escaped after double-backslash? no")).toBe(
      "no comment \\\\"
    );
    expect(stripTexComment("\\usepackage{minted}")).toBe("\\usepackage{minted}");
    expect(stripTexComment("trailing backslash\\")).toBe("trailing backslash\\");
  });
});

describe("compileTex: real compilations", () => {
  test.skipIf(!LATEX)(
    "battery fixture compiles (pdflatex) and collects aux/bbl/toc/fls/events, no .log",
    { timeout: 180_000 },
    async () => {
      const outDir = await tmpOut();
      const r = await compileTex({ ...fixture("battery"), outDir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.engine).toBe("pdflatex");
      expect(r.warnings).toEqual([]);
      for (const key of ["aux", "bbl", "toc", "fls", "events"] as const) {
        const p = r.artifacts[key];
        expect(p, `artifact ${key}`).toBeDefined();
        expect(p && existsSync(p)).toBe(true);
      }
      expect(r.artifacts.log).toBeUndefined();

      const { events, warnings } = parseTexEvents(readFileSync(r.artifacts.events ?? "", "utf8"));
      expect(warnings).toEqual([]);
      const math = events.filter((e) => e.type === "mathnum");
      expect(math.map((m) => (m.type === "mathnum" ? `${m.env}:${m.number}` : ""))).toEqual([
        "equation:1",
        "equation:2",
        "equation:A1",
        "align:3",
        "align:X",
        "gather:4",
        "gather:5",
        "multline:6",
        "eqnarray:7",
        "eqnarray:8",
        "equation:9", // in the \input child file (file: child.tex)
      ]);
      const childEvents = events.filter((e) => e.file === "child.tex");
      expect(childEvents.map((e) => e.type)).toEqual(["citation", "label", "mathnum"]);
      const cites = events.filter((e) => e.type === "citation");
      expect(cites.map((c) => c.id)).toEqual([
        "cite-000001",
        "cite-000002",
        "cite-000003",
        "cite-000004",
        "cite-000005",
      ]);
    }
  );

  test.skipIf(!LATEX)(
    "minimal fixture (kernel adapters, twocolumn class) compiles",
    { timeout: 180_000 },
    async () => {
      const outDir = await tmpOut();
      const r = await compileTex({ ...fixture("minimal"), outDir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.artifacts.events).toBeDefined();
      const { events } = parseTexEvents(readFileSync(r.artifacts.events ?? "", "utf8"));
      const math = events.filter((e) => e.type === "mathnum");
      expect(math.map((m) => (m.type === "mathnum" ? `${m.env}:${m.number}` : ""))).toEqual([
        "equation:1",
        "equation:2",
        "eqnarray:3",
      ]);
    }
  );

  test.skipIf(!LATEX)(
    "zero interference: instrumented vs clean compile produce identical .aux",
    { timeout: 180_000 },
    async () => {
      const instDir = await tmpOut();
      const cleanDir = await tmpOut();
      const inst = await compileTex({ ...fixture("battery"), outDir: instDir });
      const clean = await compileTexAttempt({
        ...fixture("battery"),
        outDir: cleanDir,
        instrumented: false,
        engine: "pdflatex",
      });
      expect(inst.ok).toBe(true);
      expect(clean.ok).toBe(true);
      if (!inst.ok || !clean.ok) return;
      const a = readFileSync(inst.artifacts.aux ?? "", "utf8");
      const b = readFileSync(clean.artifacts.aux ?? "", "utf8");
      expect(a).toBe(b);
    }
  );

  test.skipIf(!LATEX)(
    "engine fallback: fontspec fixture fails pdflatex, xelatex retry succeeds",
    { timeout: 180_000 },
    async () => {
      const outDir = await tmpOut();
      const r = await compileTex({ ...fixture("xonly"), outDir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.engine).toBe("xelatex");
      expect(r.warnings.some((w) => w.includes("pdflatex compile failed"))).toBe(true);
      expect(r.artifacts.events).toBeDefined();
    }
  );

  test.skipIf(!LATEX)(
    "hyperref + amsmath + \\tag regression (B1): instrumented compile succeeds, events correct",
    { timeout: 180_000 },
    async () => {
      const outDir = await tmpOut();
      const r = await compileTex({ ...fixture("hyperref"), outDir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // must NOT have silently fallen back to a clean compile
      expect(r.warnings).toEqual([]);
      expect(r.artifacts.events).toBeDefined();
      const { events, warnings } = parseTexEvents(readFileSync(r.artifacts.events ?? "", "utf8"));
      expect(warnings).toEqual([]);
      const math = events.filter((e) => e.type === "mathnum");
      expect(math.map((m) => (m.type === "mathnum" ? `${m.env}:${m.number}` : ""))).toEqual([
        "equation:1",
        "equation:B", // \tag{B}: captured exactly, counter not advanced
        "equation:2",
        "equation:3a", // subequations
        "equation:3b",
        "equation:4", // aligned-inside-equation: one event
      ]);
      expect(events.filter((e) => e.type === "citation")).toHaveLength(2);
      expect(events.filter((e) => e.type === "label")).toHaveLength(5);
      expect(events.every((e) => e.file === "main.tex")).toBe(true);
    }
  );

  test.skipIf(!LATEX)(
    "commented-out minted/\\write18 does NOT trigger unsupported-build (B2)",
    { timeout: 180_000 },
    async () => {
      const outDir = await tmpOut();
      const r = await compileTex({ ...fixture("commented-minted"), outDir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.artifacts.events).toBeDefined();
    }
  );

  test.skipIf(!LATEX)(
    "multi-line \\usepackage{% minted} is still rejected (B2)",
    { timeout: 30_000 },
    async () => {
      const r = await compileTex({ ...fixture("minted-multiline"), outDir: await tmpOut() });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe("unsupported-build");
      expect(r.message).toContain("minted");
    }
  );

  test.skipIf(!LATEX)(
    "missing .sty asset (styPath: null) degrades to a clean compile with a warning (N6)",
    { timeout: 180_000 },
    async () => {
      const outDir = await tmpOut();
      const r = await compileTex({ ...fixture("minimal"), outDir, styPath: null });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.artifacts.events).toBeUndefined();
      expect(r.warnings.some((w) => w.includes("argelander.sty is missing"))).toBe(true);
      expect(r.artifacts.aux).toBeDefined();
    }
  );

  test.skipIf(!LATEX)(
    "minted is rejected as unsupported-build before compiling",
    { timeout: 30_000 },
    async () => {
      const r = await compileTex({ ...fixture("minted"), outDir: await tmpOut() });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe("unsupported-build");
      expect(r.message).toContain("minted");
      expect(r.excerpt).toContain("minted");
    }
  );

  test.skipIf(!LATEX)(
    "missing package → compile-error with ! excerpt naming the file",
    { timeout: 180_000 },
    async () => {
      const r = await compileTex({ ...fixture("broken"), outDir: await tmpOut() });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe("compile-error");
      expect(r.message).toContain("this-package-does-not-exist-xyz.sty");
      expect(r.excerpt).toContain(
        "! LaTeX Error: File `this-package-does-not-exist-xyz.sty' not found"
      );
    }
  );

  test.skipIf(!LATEX)(
    "infinite loop → compile-timeout (SIGKILL)",
    { timeout: 60_000 },
    async () => {
      const r = await compileTex({ ...fixture("loopy"), outDir: await tmpOut(), timeoutMs: 3000 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe("compile-timeout");
      expect(r.message).toContain("3000ms");
    }
  );

  test.skipIf(!LATEX)(
    "instrumentation failure falls back to a clean compile (events absent, warning recorded)",
    { timeout: 240_000 },
    async () => {
      const badSty = join(TEX_FIXTURES, "bad-sty", "argelander.sty");
      const outDir = await tmpOut();
      const r = await compileTex({ ...fixture("battery"), outDir, styPath: badSty });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.artifacts.events).toBeUndefined();
      expect(r.warnings.some((w) => w.includes("clean compile"))).toBe(true);
      // degraded success keeps the engine .log for debugging
      expect(r.artifacts.log).toBeDefined();
      expect(existsSync(r.artifacts.log ?? "")).toBe(true);
      // the fallback still produced the engine-agnostic artifacts
      expect(r.artifacts.aux).toBeDefined();
      expect(r.artifacts.bbl).toBeDefined();
    }
  );

  test.skipIf(!LATEX)(
    "missing main file → compile-error before any engine runs",
    { timeout: 30_000 },
    async () => {
      const r = await compileTex({
        srcDir: join(TEX_FIXTURES, "minimal"),
        mainTex: join(TEX_FIXTURES, "minimal", "nope.tex"),
        outDir: await tmpOut(),
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe("compile-error");
      expect(r.message).toContain("does not exist");
    }
  );
});
