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
};

let store: ReturnType<typeof useStore>;
function Capture() {
  store = useStore();
  return null;
}

function renderSegments(segments: IrSegment[]) {
  return render(
    <StoreProvider ir={ir}>
      <Capture />
      <Segments segments={segments} />
    </StoreProvider>
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

  it("falls back to per-ref short labels, '; '-joined for groups", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "ref-2", resolved: true, short: "Doe 2020" },
        ],
      },
    ]);
    expect(container.querySelector(".cite-chip")!.textContent).toBe("Bok 1934; Doe 2020");
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

  it("any unresolved ref in a group greys the whole chip", () => {
    const { container } = renderSegments([
      {
        type: "cite",
        refs: [
          { id: "ref-1", resolved: true, short: "Bok 1934" },
          { id: "?", resolved: false },
        ],
      },
    ]);
    expect(container.querySelector(".cite-chip")!.className).toContain("chip-unresolved");
  });

  it("clicking focuses the first ref id", () => {
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
    fireEvent.click(container.querySelector(".cite-chip")!);
    expect(spy).toHaveBeenCalledWith("ref-1");
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
