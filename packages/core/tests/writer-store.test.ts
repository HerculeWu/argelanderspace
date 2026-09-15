/**
 * The Writer store (Stage 10 M2a): manuscript create/load/save round-trips
 * (atomic tmp+rename, pretty 2-space, rev bump + updated_at refresh),
 * looseObject unknown-key preservation (agent-authored keys must survive),
 * corrupt-file hard errors (never a silent reset), listManuscripts skipping a
 * bad dir with a warning, physical delete, the templates merger (user file
 * overrides a same-id built-in; bad files warned + skipped), and asset
 * write/read sanitization. Hermetic: throwaway tmp data dirs.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_WRITER_TEMPLATES, type WriterManuscript } from "@argelanderspace/contracts";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createManuscript,
  deleteManuscript,
  listManuscripts,
  loadManuscript,
  loadTemplates,
  manuscriptDir,
  manuscriptJsonPath,
  manuscriptsDir,
  newManuscriptId,
  readManuscriptAsset,
  saveManuscript,
  templatesDir,
  writeManuscriptAsset,
} from "../src/writer/store.js";

let dataDir: string;

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), "aspace-writer-store-")), "data");
});

describe("paths / ids", () => {
  test("path helpers follow the <dataDir>/manuscripts/m_<id>/ layout", () => {
    expect(manuscriptsDir(dataDir)).toBe(join(dataDir, "manuscripts"));
    expect(templatesDir(dataDir)).toBe(join(dataDir, "templates"));
    expect(manuscriptDir(dataDir, "m_0123abcd")).toBe(join(dataDir, "manuscripts", "m_0123abcd"));
    expect(manuscriptJsonPath(dataDir, "m_0123abcd")).toBe(
      join(dataDir, "manuscripts", "m_0123abcd", "manuscript.json")
    );
  });

  test("newManuscriptId is m_ + 8 lowercase hex", () => {
    expect(newManuscriptId()).toMatch(/^m_[0-9a-f]{8}$/);
    expect(newManuscriptId()).not.toBe(newManuscriptId());
  });
});

describe("create / load / save", () => {
  test("createManuscript persists schema defaults at rev 0", () => {
    const doc = createManuscript(dataDir, { template: "aa", title: "  Halo paper  " });
    expect(doc.id).toMatch(/^m_[0-9a-f]{8}$/);
    expect(doc.rev).toBe(0);
    expect(doc.title).toBe("Halo paper");
    expect(doc.cells).toEqual([]);
    expect(doc.comments).toEqual([]);
    // round-trips through load
    expect(loadManuscript(dataDir, doc.id)).toEqual(doc);
    // and the on-disk form is pretty-printed
    expect(readFileSync(manuscriptJsonPath(dataDir, doc.id), "utf8")).toContain("\n  ");
  });

  test("empty title falls back to 'Untitled manuscript'", () => {
    expect(createManuscript(dataDir, { template: "report" }).title).toBe("Untitled manuscript");
  });

  test("loadManuscript: missing → null; corrupt JSON → throws (never resets)", () => {
    expect(loadManuscript(dataDir, "m_00000000")).toBeNull();
    const doc = createManuscript(dataDir, { template: "aa" });
    writeFileSync(manuscriptJsonPath(dataDir, doc.id), "{ not json");
    expect(() => loadManuscript(dataDir, doc.id)).toThrow(/not valid JSON/);
    // and the corrupt bytes are still there
    expect(readFileSync(manuscriptJsonPath(dataDir, doc.id), "utf8")).toBe("{ not json");
  });

  test("schema-invalid manuscript.json → throws", () => {
    const doc = createManuscript(dataDir, { template: "aa" });
    writeFileSync(manuscriptJsonPath(dataDir, doc.id), JSON.stringify({ ...doc, version: 2 }));
    expect(() => loadManuscript(dataDir, doc.id)).toThrow(/schema validation/);
  });

  test("saveManuscript(bumpRev) bumps rev and refreshes updated_at", () => {
    const doc = createManuscript(dataDir, { template: "aa" });
    const stored = saveManuscript(dataDir, { ...doc, title: "Renamed" }, { bumpRev: true });
    expect(stored.rev).toBe(1);
    expect(stored.title).toBe("Renamed");
    expect(Date.parse(stored.updated_at)).toBeGreaterThanOrEqual(Date.parse(doc.updated_at));
    expect(loadManuscript(dataDir, doc.id)).toEqual(stored);
  });

  test("agent-written unknown keys survive a load/save round-trip (looseObject)", () => {
    const doc = createManuscript(dataDir, { template: "aa" });
    // hand-write a manuscript carrying agent keys at several levels
    const withExtras = {
      ...doc,
      agentMeta: { stage: "draft", todo: ["intro"] },
      cells: [
        {
          id: "c_00000001",
          type: "latex",
          data: { source: "\\section{X}", reviewNote: "check stats" },
        },
      ],
    };
    writeFileSync(manuscriptJsonPath(dataDir, doc.id), JSON.stringify(withExtras, null, 2));
    const loaded = loadManuscript(dataDir, doc.id) as WriterManuscript & {
      agentMeta: { stage: string };
    };
    expect(loaded.agentMeta.stage).toBe("draft");
    const saved = saveManuscript(dataDir, loaded, { bumpRev: true }) as WriterManuscript & {
      agentMeta: { stage: string };
      cells: { data: Record<string, unknown> }[];
    };
    expect(saved.agentMeta.stage).toBe("draft");
    expect(saved.cells[0]?.data.reviewNote).toBe("check stats");
    // …and they are still on disk after the write
    const raw = JSON.parse(readFileSync(manuscriptJsonPath(dataDir, doc.id), "utf8"));
    expect(raw.agentMeta).toEqual({ stage: "draft", todo: ["intro"] });
  });

  test("saveManuscript refuses to write an invalid document", () => {
    const doc = createManuscript(dataDir, { template: "aa" });
    expect(() => saveManuscript(dataDir, { ...doc, id: "bogus" } as WriterManuscript)).toThrow(
      /refusing to write/
    );
  });
});

describe("listManuscripts", () => {
  test("empty root → empty list; entries sorted by updated_at desc", () => {
    expect(listManuscripts(dataDir)).toEqual({ manuscripts: [], warnings: [] });
    const a = createManuscript(dataDir, { template: "aa", title: "Old" });
    // hand-age a's file so the desc sort is deterministic (bumpRev refreshes
    // updated_at to the same millisecond otherwise)
    saveManuscript(dataDir, { ...a, updated_at: "2026-09-01T00:00:00.000Z" });
    const b = createManuscript(dataDir, { template: "report", title: "New" });
    saveManuscript(dataDir, { ...b }, { bumpRev: true });
    const { manuscripts, warnings } = listManuscripts(dataDir);
    expect(warnings).toEqual([]);
    expect(manuscripts.map((m) => m.title)).toEqual(["New", "Old"]);
    expect(manuscripts[0]).toMatchObject({ id: b.id, template: "report", rev: 1 });
  });

  test("a corrupt manuscript dir is skipped with a warning, not an error", () => {
    const good = createManuscript(dataDir, { template: "aa", title: "Good" });
    mkdirSync(join(manuscriptsDir(dataDir), "m_deadbeef"), { recursive: true });
    writeFileSync(join(manuscriptsDir(dataDir), "m_deadbeef", "manuscript.json"), "{ nope");
    mkdirSync(join(manuscriptsDir(dataDir), "m_deadbee0"), { recursive: true }); // no json
    mkdirSync(join(manuscriptsDir(dataDir), "not-a-manuscript"), { recursive: true }); // ignored
    const { manuscripts, warnings } = listManuscripts(dataDir);
    expect(manuscripts.map((m) => m.id)).toEqual([good.id]);
    expect(warnings.some((w) => w.startsWith("m_deadbeef"))).toBe(true);
    expect(warnings.some((w) => w.startsWith("m_deadbee0"))).toBe(true);
  });
});

describe("deleteManuscript", () => {
  test("removes the whole tree (manuscript.json + assets); missing → false", () => {
    const doc = createManuscript(dataDir, { template: "aa" });
    writeManuscriptAsset(dataDir, doc.id, "fig.png", new Uint8Array([1, 2, 3]));
    expect(deleteManuscript(dataDir, doc.id)).toBe(true);
    expect(existsSync(manuscriptDir(dataDir, doc.id))).toBe(false);
    expect(deleteManuscript(dataDir, doc.id)).toBe(false);
  });
});

describe("loadTemplates", () => {
  test("built-ins only when no user dir exists; sorted by label", () => {
    const { templates, warnings } = loadTemplates(dataDir);
    expect(warnings).toEqual([]);
    expect(templates.map((t) => t.id)).toContain("aa");
    expect(templates).toHaveLength(BUILTIN_WRITER_TEMPLATES.length);
    const labels = templates.map((t) => t.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  test("a user file overrides the same-id built-in and adds new templates", () => {
    const dir = templatesDir(dataDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "aa.json"),
      JSON.stringify({
        id: "aa",
        version: 1,
        label: "A&A custom",
        chip: "custom",
        preamble: "\\documentclass{aa}",
        types: ["latex"],
        frontMatter: "\\title{ {{title}} }",
      })
    );
    writeFileSync(
      join(dir, "mnras.json"),
      JSON.stringify({
        id: "mnras",
        version: 1,
        label: "MNRAS",
        preamble: "\\documentclass{mnras}",
        types: ["latex", "figure"],
      })
    );
    const { templates, warnings } = loadTemplates(dataDir);
    expect(warnings).toEqual([]);
    expect(templates.find((t) => t.id === "aa")?.label).toBe("A&A custom");
    expect(templates.find((t) => t.id === "mnras")?.label).toBe("MNRAS");
  });

  test("corrupt / schema-invalid / id-mismatched files are warned + skipped", () => {
    const dir = templatesDir(dataDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "badschema.json"), JSON.stringify({ id: "badschema", version: 2 }));
    writeFileSync(
      join(dir, "mismatch.json"),
      JSON.stringify({ id: "other", version: 1, label: "X", types: ["latex"] })
    );
    const { templates, warnings } = loadTemplates(dataDir);
    expect(warnings).toHaveLength(3);
    expect(templates).toHaveLength(BUILTIN_WRITER_TEMPLATES.length); // built-ins intact
  });
});

describe("assets", () => {
  test("write/read round-trip; assets/ created on demand", () => {
    const doc = createManuscript(dataDir, { template: "aa" });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const name = writeManuscriptAsset(dataDir, doc.id, "curve.png", bytes);
    expect(name).toBe("curve.png");
    expect(readManuscriptAsset(dataDir, doc.id, "curve.png")).toEqual(Buffer.from(bytes));
    expect(readManuscriptAsset(dataDir, doc.id, "missing.png")).toBeNull();
  });

  test("a name collision appends -1, -2 (never overwrites)", () => {
    const doc = createManuscript(dataDir, { template: "aa" });
    expect(writeManuscriptAsset(dataDir, doc.id, "fig.png", new Uint8Array([1]))).toBe("fig.png");
    expect(writeManuscriptAsset(dataDir, doc.id, "fig.png", new Uint8Array([2]))).toBe("fig-1.png");
    expect(writeManuscriptAsset(dataDir, doc.id, "fig.png", new Uint8Array([3]))).toBe("fig-2.png");
    expect(readManuscriptAsset(dataDir, doc.id, "fig.png")).toEqual(Buffer.from([1]));
  });

  test("traversal and hidden names are rejected on write and read", () => {
    const doc = createManuscript(dataDir, { template: "aa" });
    for (const bad of ["../evil.png", "a/b.png", "..\\evil.png", ".hidden.png", ""]) {
      expect(() => writeManuscriptAsset(dataDir, doc.id, bad, new Uint8Array([1]))).toThrow(
        /bad asset filename/
      );
      expect(() => readManuscriptAsset(dataDir, doc.id, bad)).toThrow(/bad asset filename/);
    }
  });

  test("extensions outside the allowlist are rejected (case-insensitive allow)", () => {
    const doc = createManuscript(dataDir, { template: "aa" });
    expect(() => writeManuscriptAsset(dataDir, doc.id, "x.txt", new Uint8Array([1]))).toThrow(
      /unsupported asset extension/
    );
    expect(() => writeManuscriptAsset(dataDir, doc.id, "noext", new Uint8Array([1]))).toThrow(
      /unsupported asset extension/
    );
    expect(writeManuscriptAsset(dataDir, doc.id, "Upper.PNG", new Uint8Array([1]))).toBe(
      "Upper.PNG"
    );
  });
});
