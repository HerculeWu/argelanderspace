import { describe, expect, it } from "vitest";
import {
  buildStructureTarget,
  canonicalContainerText,
  irIndex,
  ReaderWriteOperationSchema,
  resolveTextTarget,
  type TexDocIr,
  withAssetHash,
} from "../src/index.js";

const SEGMENTS = [
  { type: "text" as const, text: "Alpha " },
  { type: "math" as const, latex: "E=mc^2" },
  { type: "text" as const, text: " beta 😀 " },
  {
    type: "cite" as const,
    refs: [{ id: "ref-1", resolved: true, short: "Bok 1934" }],
    raw: "(Bok 1934)",
  },
  { type: "text" as const, text: " omega" },
];
function ir(): TexDocIr {
  return {
    version: 1,
    docId: "d",
    sections: [
      {
        id: "sec-1",
        level: 1,
        number: "1",
        heading: "Intro",
        blocks: [
          { id: "p-1", type: "paragraph", segments: SEGMENTS },
          {
            id: "l-1",
            type: "list",
            ordered: true,
            items: [
              { segments: [{ type: "text", text: "first" }] },
              { segments: [{ type: "text", text: "second item" }] },
            ],
          },
          {
            id: "fig-1",
            type: "figure",
            number: "1",
            imgPath: "assets/a.png",
            captionSegments: [{ type: "text", text: "A figure." }],
          },
          { id: "fig-2", type: "figure" },
          { id: "eq-1", type: "equation", number: "1", latex: "a=b" },
        ],
        children: [],
      },
    ],
    refsManifest: [],
    bib: [],
    citationsByBlock: {},
    source: { type: "latex", origin: "x", main_tex: "main.tex" },
    meta: {},
  } as TexDocIr;
}
const CANON = "Alpha $E=mc^2$ beta 😀 (Bok 1934) omega";
const at = (needle: string) => CANON.indexOf(needle);
const text = (start: number, end: number, extra: object = {}) =>
  resolveTextTarget(ir(), { block: "p-1", container: { type: "content" }, start, end, ...extra });

describe("resolveTextTarget: canonical UTF-16 offsets with atomic math/cite/xref", () => {
  it("indexes the canonical text the Reader uses", () => {
    const p = irIndex(ir()).blocks.get("p-1");
    expect(canonicalContainerText(p as never, { type: "content" })).toBe(CANON);
  });

  it("takes plain text offsets as given, counting an astral character as two code units", () => {
    const start = at("beta");
    const end = at("beta") + "beta 😀".length;
    const result = text(start, end);
    expect(result).toMatchObject({ ok: true, expanded: false });
    if (result.ok) {
      expect(result.target.quote).toBe("beta 😀");
      expect(result.target.end - result.target.start).toBe(7); // the emoji is a surrogate pair
    }
  });

  it("expands an endpoint strictly inside math to the whole segment", () => {
    const m = at("$E=mc^2$");
    const result = text(m + 3, m + 5); // inside the math
    expect(result).toMatchObject({ ok: true, expanded: true });
    if (result.ok) expect(result.target).toMatchObject({ start: m, end: m + 8, quote: "$E=mc^2$" });
  });

  it("expands a range that ends inside a cite and one that starts inside it", () => {
    const c = at("(Bok 1934)");
    const endsInside = text(at("beta"), c + 4);
    if (!endsInside.ok) throw new Error("expected ok");
    expect(endsInside.target.end).toBe(c + "(Bok 1934)".length);
    const startsInside = text(c + 2, at("omega") + 2);
    if (!startsInside.ok) throw new Error("expected ok");
    expect(startsInside.target.start).toBe(c);
  });

  it("leaves a boundary exactly at an atom edge alone (no expansion)", () => {
    const m = at("$E=mc^2$");
    const result = text(m, m + 8);
    expect(result).toMatchObject({ ok: true, expanded: false });
  });

  it("refuses an empty, reversed, negative, fractional or out-of-range span", () => {
    for (const [s, e] of [
      [3, 3],
      [5, 2],
      [-1, 4],
      [1.5, 4],
      [0, CANON.length + 1],
    ] as const)
      expect(text(s, e)).toMatchObject({ ok: false, reason: "range" });
  });

  it("refuses a quote that is not what those offsets select (a miscounted or stale selection)", () => {
    expect(text(0, 5, { quote: "Alpha" })).toMatchObject({ ok: true });
    expect(text(0, 5, { quote: "Alph" })).toMatchObject({ ok: false, reason: "quote_mismatch" });
    expect(text(1, 6, { quote: "Alpha" })).toMatchObject({ ok: false, reason: "quote_mismatch" });
  });

  it("handles list items and captions, and refuses what has no text container", () => {
    const item = resolveTextTarget(ir(), {
      block: "l-1",
      container: { type: "list_item", index: 1 },
      start: 0,
      end: 6,
    });
    expect(item).toMatchObject({ ok: true, target: { quote: "second" } });
    expect(
      resolveTextTarget(ir(), {
        block: "l-1",
        container: { type: "list_item", index: 2 },
        start: 0,
        end: 1,
      })
    ).toMatchObject({ ok: false, reason: "no_container" });
    expect(
      resolveTextTarget(ir(), { block: "fig-1", container: { type: "caption" }, start: 2, end: 8 })
    ).toMatchObject({ ok: true, target: { quote: "figure" } });
    // no caption, an equation, a section and an unknown block can only be structure targets / do not exist
    for (const block of ["fig-2", "eq-1"])
      expect(
        resolveTextTarget(ir(), { block, container: { type: "caption" }, start: 0, end: 1 })
      ).toMatchObject({ ok: false, reason: "no_container" });
    for (const block of ["sec-1", "nope"])
      expect(
        resolveTextTarget(ir(), { block, container: { type: "content" }, start: 0, end: 1 })
      ).toMatchObject({ ok: false, reason: "no_block" });
    expect(
      resolveTextTarget(ir(), { block: "p-1", container: { type: "caption" }, start: 0, end: 1 })
    ).toMatchObject({ ok: false, reason: "no_container" });
  });
});

describe("structure targets", () => {
  it("are built with the full snapshot of the stored content", () => {
    const { blocks, sections } = irIndex(ir());
    expect(buildStructureTarget(sections.get("sec-1") as never)).toEqual({
      type: "structure",
      id: "sec-1",
      kind: "section",
      snapshot: { number: "1", heading: "Intro" },
    });
    expect(buildStructureTarget(blocks.get("p-1") as never).snapshot).toEqual({ text: CANON });
    expect(buildStructureTarget(blocks.get("l-1") as never).snapshot).toEqual({
      ordered: true,
      items: ["first", "second item"],
    });
    expect(buildStructureTarget(blocks.get("eq-1") as never).snapshot).toEqual({
      number: "1",
      latex: "a=b",
    });
  });

  it("take a figure's asset_hash from the admitted manifest only, and fail when it is missing", () => {
    const { blocks } = irIndex(ir());
    const target = buildStructureTarget(blocks.get("fig-1") as never);
    expect(
      withAssetHash([{ imgPath: "assets/a.png", sha256: "ab".repeat(32) }], blocks, target)
    ).toMatchObject({ snapshot: { asset_hash: "ab".repeat(32) } });
    expect(() => withAssetHash([], blocks, target)).toThrow(/digest/);
    // a figure without an image needs no hash
    const none = buildStructureTarget(blocks.get("fig-2") as never);
    expect(withAssetHash([], blocks, none)).toEqual(none);
  });
});

describe("annotation write operations", () => {
  const epoch = { docId: "d", fingerprint: "f".repeat(64), rev: 0 };
  it("name the epoch they were planned against and carry a non-empty body", () => {
    const ok = {
      action: "create_annotation",
      ...epoch,
      target: { type: "document" },
      body: "  keep my bytes  ",
    };
    expect(ReaderWriteOperationSchema.safeParse(ok).success).toBe(true);
    const { fingerprint: _f, ...noFingerprint } = ok;
    expect(ReaderWriteOperationSchema.safeParse(noFingerprint).success).toBe(false);
    const { rev: _r, ...noRev } = ok;
    expect(ReaderWriteOperationSchema.safeParse(noRev).success).toBe(false);
    expect(ReaderWriteOperationSchema.safeParse({ ...ok, body: " \n " }).success).toBe(false);
    expect(ReaderWriteOperationSchema.safeParse({ ...ok, body: "x".repeat(100_001) }).success).toBe(
      false
    );
  });

  it("have no way to set a target's kind, snapshot, author, colour or any other field", () => {
    const base = { action: "create_annotation", ...epoch, body: "b" };
    expect(
      ReaderWriteOperationSchema.safeParse({
        ...base,
        target: { type: "structure", id: "p-1", kind: "paragraph", snapshot: { text: "forged" } },
      }).success
    ).toBe(false);
    expect(
      ReaderWriteOperationSchema.safeParse({ ...base, target: { type: "document" }, color: "red" })
        .success
    ).toBe(false);
    expect(
      ReaderWriteOperationSchema.safeParse({
        action: "update_annotation",
        ...epoch,
        annotationId: "a_0000aaaa",
        expectedUpdatedAt: "2026-09-10T10:00:00.000Z",
        body: "b",
        target: { type: "document" },
      }).success
    ).toBe(false);
    expect(
      ReaderWriteOperationSchema.safeParse({
        action: "delete_annotation",
        ...epoch,
        expectedUpdatedAt: "2026-09-10T10:00:00.000Z",
        annotationId: "../x",
      }).success
    ).toBe(false);
  });
});

describe("annotation write operations: what an agent must carry", () => {
  const epoch = { docId: "d", fingerprint: "f".repeat(64), rev: 3 };
  it("update and delete name the annotation's state as last read (updated_at)", () => {
    const upd = { action: "update_annotation", ...epoch, annotationId: "a_0000aaaa", body: "b" };
    expect(ReaderWriteOperationSchema.safeParse(upd).success).toBe(false);
    expect(
      ReaderWriteOperationSchema.safeParse({ ...upd, expectedUpdatedAt: "yesterday" }).success
    ).toBe(false);
    expect(
      ReaderWriteOperationSchema.safeParse({
        ...upd,
        expectedUpdatedAt: "2026-09-10T10:00:00.000Z",
      }).success
    ).toBe(true);
    const del = { action: "delete_annotation", ...epoch, annotationId: "a_0000aaaa" };
    expect(ReaderWriteOperationSchema.safeParse(del).success).toBe(false);
    expect(
      ReaderWriteOperationSchema.safeParse({
        ...del,
        expectedUpdatedAt: "2026-09-10T10:00:00.000Z",
      }).success
    ).toBe(true);
  });

  it("a text target must carry the quote it was counted from", () => {
    const text = {
      action: "create_annotation",
      ...epoch,
      body: "b",
      target: { type: "text", block: "p-1", container: { type: "content" }, start: 0, end: 5 },
    };
    expect(ReaderWriteOperationSchema.safeParse(text).success).toBe(false);
    expect(
      ReaderWriteOperationSchema.safeParse({ ...text, target: { ...text.target, quote: "" } })
        .success
    ).toBe(false);
    expect(
      ReaderWriteOperationSchema.safeParse({ ...text, target: { ...text.target, quote: "Alpha" } })
        .success
    ).toBe(true);
  });
});
