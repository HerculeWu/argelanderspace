import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DocIr, IrFigureBlock } from "@argelanderspace/contracts";
import { BlockView } from "../src/components/Block";
import { StoreProvider } from "../src/store";

const ir: DocIr = {
  docId: "t",
  title: "Test doc",
  sections: [],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
};

function renderFigure(block: IrFigureBlock) {
  return render(
    <StoreProvider ir={ir}>
      <BlockView block={block} />
    </StoreProvider>
  );
}

afterEach(() => cleanup());

describe("figure blocks: intrinsic dims reserve the image box (jump accuracy)", () => {
  it("sets width/height attrs from imgWidth/imgHeight", () => {
    const { container } = renderFigure({
      id: "fig-1",
      type: "figure",
      imgPath: "figures__a__pdf.svg",
      imgWidth: 936,
      imgHeight: 1296,
    });
    const img = container.querySelector("img")!;
    expect(img.getAttribute("width")).toBe("936");
    expect(img.getAttribute("height")).toBe("1296");
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("omits the attrs when the IR carries no dims (pre-migration docs)", () => {
    const { container } = renderFigure({
      id: "fig-1",
      type: "figure",
      imgPath: "figures__a__pdf.svg",
    });
    const img = container.querySelector("img")!;
    expect(img.getAttribute("width")).toBeNull();
    expect(img.getAttribute("height")).toBeNull();
  });
});
