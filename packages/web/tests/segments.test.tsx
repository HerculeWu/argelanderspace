vi.mock("../src/doc/ReaderSession", () => import("./reader-unit-session"));
import { AnnotationProvider } from "../src/annotations/AnnotationStore";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { DocIr, IrBlock, IrSegment } from "@argelanderspace/contracts";
import { Segments, xrefTargetIds } from "../src/lib/segments";
import { StoreProvider, useStore } from "../src/store";

// Minimal IR: one section + one figure so resolved xref chips have a target in
// the store's blockById (and fig-99 deliberately does not).
const ir: DocIr = {
  docId: "t",
  title: "Test doc",
  sections: [
    {
      id: "sec-1",
      level: 1,
      heading: "Intro",
      blocks: [{ id: "fig-1", type: "figure", number: "2" }],
      children: [],
    },
  ],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
  references: [
    { id: "ref-1", raw: "Bok, V. 1934, ApJ, 100, 1" },
    { id: "ref-2", raw: "Doe, J. 2020, MNRAS, 200, 2" },
  ],
};

let store: ReturnType<typeof useStore>;
function Capture() {
  store = useStore();
  return null;
}

function renderSegments(segments: IrSegment[]) {
  return render(
    <StoreProvider ir={ir}><AnnotationProvider>
      <Capture />
      <Segments segments={segments} />
    </AnnotationProvider></StoreProvider>
  );
}

afterEach(() => cleanup());

describe("Segments: text & math", () => {
  it("renders text segments verbatim", () => {
    const { container } = renderSegments([{ type: "text", text: "plain text" }]);
    expect(container.textContent).toBe("plain text");
  });

  it("renders math segments through KaTeX, keeping the surrounding text", () => {
    const { container } = renderSegments([
      { type: "text", text: "a " },
      { type: "math", latex: "x^2" },
      { type: "text", text: " b" },
    ]);
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.textContent).toMatch(/^a .* b$/);
  });
});

describe("Segments: cite chips", () => {
  it("greys only the unresolved chip when a split group has a raw", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        raw: "(Bok 1934; ?)",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "?", resolved: false },
        ],
      },
    ]);
    const chips = [...container.querySelectorAll(".cite-chip")];
    expect(chips).toHaveLength(2);
    expect(chips[0]!.className).not.toContain("chip-unresolved");
    expect(chips[1]!.className).toContain("chip-unresolved");
    expect(chips[1]!.textContent).toBe("?");
  });

  it("legacy fallback keeps group gating: any unresolved greys the whole chip", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        raw: "Bok 1934, ?",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "?", resolved: false },
        ],
      },
    ]);
    const chips = container.querySelectorAll(".cite-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.className).toContain("chip-unresolved");
    const spy = vi.spyOn(store, "focusReference");
    fireEvent.click(chips[0]!);
    expect(spy).not.toHaveBeenCalled();
  });

  it("per-ref chips respond to Enter and Space", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        raw: "(Bok 1934; Doe 2020)",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "ref-2", resolved: true, short: "Doe 2020" },
        ],
      },
    ]);
    const spy = vi.spyOn(store, "focusReference");
    const chips = container.querySelectorAll(".cite-chip");
    fireEvent.keyDown(chips[1]!, { key: "Enter" });
    expect(spy).toHaveBeenCalledWith("ref-2");
    fireEvent.keyDown(chips[0]!, { key: " " });
    expect(spy).toHaveBeenCalledWith("ref-1");
  });

  it("keeps prefix/suffix notes inside the wrapper as chip text, printed form intact", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        raw: "(see Bok 1934; Doe 2020, §3)",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "ref-2", resolved: true, short: "Doe 2020" },
        ],
      },
    ]);
    const chips = [...container.querySelectorAll(".cite-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["see Bok 1934", "Doe 2020, §3"]);
    expect(container.textContent).toBe("(see Bok 1934; Doe 2020, §3)");
  });

  it("splits square-bracket raws", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        raw: "[A 2001; B 2002]",
        refs: [
          { id: "ref-1", resolved: true, short: "A 2001" },
          { id: "ref-2", resolved: true, short: "B 2002" },
        ],
      },
    ]);
    const chips = [...container.querySelectorAll(".cite-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["A 2001", "B 2002"]);
    expect(container.textContent).toBe("[A 2001; B 2002]");
  });

  it("prefers the paired occurrence raw text as label", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        raw: "(Bok, 1934)",
        refs: [{ id: "ref-1", resolved: true, short: "Bok 1934" }],
      },
    ]);
    const chip = container.querySelector(".cite-chip")!;
    expect(chip.textContent).toBe("(Bok, 1934)");
    expect(chip.className).not.toContain("chip-unresolved");
  });

  it("splits a multi-ref raw into per-ref chips, keeping the printed form", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        raw: "(Bok 1934; Doe 2020)",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "ref-2", resolved: true, short: "Doe 2020" },
        ],
      },
    ]);
    const chips = [...container.querySelectorAll(".cite-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["Bok 1934", "Doe 2020"]);
    expect(container.textContent).toBe("(Bok 1934; Doe 2020)");
  });

  it("splits author-in-text raws (no wrapper) too", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        raw: "Bok (1934); Doe (2020)",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "ref-2", resolved: true, short: "Doe 2020" },
        ],
      },
    ]);
    const chips = [...container.querySelectorAll(".cite-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["Bok (1934)", "Doe (2020)"]);
    expect(container.textContent).toBe("Bok (1934); Doe (2020)");
  });

  it("a long multi-cite run renders one chip per ref (lines wrap between chips)", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        raw: "(A 2001; B 2002; C 2003; D 2004; E 2005; F 2006)",
        refs: [
          { id: "ref-1", resolved: true, short: "A 2001" },
          { id: "ref-2", resolved: true, short: "B 2002" },
          { id: "ref-3", resolved: true, short: "C 2003" },
          { id: "ref-4", resolved: true, short: "D 2004" },
          { id: "ref-5", resolved: true, short: "E 2005" },
          { id: "ref-6", resolved: true, short: "F 2006" },
        ],
      },
    ]);
    expect(container.querySelectorAll(".cite-chip")).toHaveLength(6);
    expect(container.textContent).toBe("(A 2001; B 2002; C 2003; D 2004; E 2005; F 2006)");
  });

  it("falls back to per-ref short labels when a group has no raw", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "ref-2", resolved: true, short: "Doe 2020" },
        ],
      },
    ]);
    const chips = [...container.querySelectorAll(".cite-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["Bok 1934", "Doe 2020"]);
    expect(container.textContent).toBe("Bok 1934; Doe 2020");
  });

  it("keeps one chip when the raw won't split into the ref count", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        raw: "Bok 1934, Doe 2020",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "ref-2", resolved: true, short: "Doe 2020" },
        ],
      },
    ]);
    const chips = container.querySelectorAll(".cite-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toBe("Bok 1934, Doe 2020");
    const spy = vi.spyOn(store, "focusReference");
    fireEvent.click(chips[0]!);
    expect(spy).toHaveBeenCalledWith("ref-1");
  });

  it("uses the id for unresolved refs and greys the chip", () => {
    const { container } = renderSegments([
      { type: "cite", refs: [{ id: "ref-9", resolved: false }] },
    ]);
    const chip = container.querySelector(".cite-chip")!;
    expect(chip.textContent).toBe("ref-9");
    expect(chip.className).toContain("chip-unresolved");
    expect(chip.getAttribute("role")).toBeNull();
  });

  it("unresolved refs grey only their own chip in a group", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "?", resolved: false },
        ],
      },
    ]);
    const chips = [...container.querySelectorAll(".cite-chip")];
    expect(chips).toHaveLength(2);
    expect(chips[0]!.className).not.toContain("chip-unresolved");
    expect(chips[1]!.className).toContain("chip-unresolved");
    expect(chips[1]!.getAttribute("role")).toBeNull();
  });

  it("each chip in a group focuses its own ref", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "ref-2", resolved: true, short: "Doe 2020" },
        ],
      },
    ]);
    const spy = vi.spyOn(store, "focusReference");
    const chips = container.querySelectorAll(".cite-chip");
    fireEvent.click(chips[1]!);
    expect(spy).toHaveBeenCalledWith("ref-2");
    fireEvent.click(chips[0]!);
    expect(spy).toHaveBeenCalledWith("ref-1");
  });

  it("per-ref tooltips show that ref's raw from the bibliography", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        raw: "(Bok 1934; Doe 2020)",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "ref-2", resolved: true, short: "Doe 2020" },
        ],
      },
    ]);
    const chips = container.querySelectorAll(".cite-chip");
    expect(chips[0]!.getAttribute("title")).toBe("Bok, V. 1934, ApJ, 100, 1");
    expect(chips[1]!.getAttribute("title")).toBe("Doe, J. 2020, MNRAS, 200, 2");
  });
});

describe("Segments: xref chips", () => {
  it("prettifies resolved targets via the KIND_LABEL table", () => {
    const { container } = renderSegments([
      { type: "xref", target: { id: "fig-1", resolved: true, targetType: "figure", number: "2" } },
    ]);
    const chip = container.querySelector(".xref-chip")!;
    expect(chip.textContent).toBe("Fig. 2");
    expect(chip.className).not.toContain("chip-unresolved");
  });

  it("prefers the paired occurrence raw text", () => {
    const { container } = renderSegments([
      {
        type: "xref",
        raw: "Figure 2",
        target: { id: "fig-1", resolved: true, targetType: "figure", number: "2" },
      },
    ]);
    expect(container.querySelector(".xref-chip")!.textContent).toBe("Figure 2");
  });

  it("clicking a resolved chip jumps to the target", () => {
    const { container } = renderSegments([
      { type: "xref", target: { id: "fig-1", resolved: true, targetType: "figure", number: "2" } },
    ]);
    const spy = vi.spyOn(store, "jumpTo");
    fireEvent.click(container.querySelector(".xref-chip")!);
    expect(spy).toHaveBeenCalledWith("fig-1");
  });

  it("section targets resolve too (sections are registered as jump targets)", () => {
    const { container } = renderSegments([
      {
        type: "xref",
        target: { id: "sec-1", resolved: true, targetType: "section", number: "1" },
      },
    ]);
    const chip = container.querySelector(".xref-chip")!;
    expect(chip.textContent).toBe("Sec. 1");
    const spy = vi.spyOn(store, "jumpTo");
    fireEvent.click(chip);
    expect(spy).toHaveBeenCalledWith("sec-1");
  });

  it("unresolved targets are grey and not clickable", () => {
    const { container } = renderSegments([
      { type: "xref", target: { id: "fig-9", resolved: false } },
    ]);
    const chip = container.querySelector(".xref-chip")!;
    expect(chip.className).toContain("chip-unresolved");
    expect(chip.getAttribute("title")).toBe("target not found");
    const spy = vi.spyOn(store, "jumpTo");
    fireEvent.click(chip);
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolved ids missing from blockById stay grey", () => {
    const { container } = renderSegments([
      { type: "xref", target: { id: "fig-99", resolved: true, targetType: "figure" } },
    ]);
    expect(container.querySelector(".xref-chip")!.className).toContain("chip-unresolved");
  });
});

describe("xrefTargetIds", () => {
  it("collects resolved targets from body, items and captions, deduped in order", () => {
    const para: IrBlock = {
      id: "p-1",
      type: "paragraph",
      segments: [
        { type: "text", text: "see " },
        { type: "xref", target: { id: "fig-1", resolved: true } },
        { type: "xref", target: { id: "fig-1", resolved: true } },
        { type: "xref", target: { id: "fig-x", resolved: false } },
      ],
    };
    expect(xrefTargetIds(para)).toEqual(["fig-1"]);
    const fig: IrBlock = {
      id: "fig-2",
      type: "figure",
      captionSegments: [{ type: "xref", target: { id: "sec-1", resolved: true } }],
    };
    expect(xrefTargetIds(fig)).toEqual(["sec-1"]);
    const list: IrBlock = {
      id: "l-1",
      type: "list",
      ordered: false,
      items: [
        { segments: [{ type: "xref", target: { id: "fig-1", resolved: true } }] },
        { segments: [{ type: "xref", target: { id: "tab-1", resolved: true } }] },
      ],
    };
    expect(xrefTargetIds(list)).toEqual(["fig-1", "tab-1"]);
  });
});
