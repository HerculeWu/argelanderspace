vi.mock("../src/doc/ReaderSession", () => import("./reader-unit-session"));
import { AnnotationProvider } from "../src/annotations/AnnotationStore";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  return render(
    <StoreProvider ir={ir}><AnnotationProvider>
      <BlockView block={block} />
    </AnnotationProvider></StoreProvider>
  );
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("figure blocks: intrinsic dims reserve the image box (jump accuracy)", () => {
  it("sets width/height attrs from imgWidth/imgHeight", () => {
    const { container } = renderFigure({
      id: "fig-1",
      type: "figure",
      imgPath: "figures__a__pdf.svg",
      imgWidth: 936,
      imgHeight: 1296,
    });
    const placeholder = container.querySelector<HTMLElement>(".figure-placeholder")!;
    expect(placeholder.style.width).toBe("936px");
    expect(placeholder.style.aspectRatio).toBe("936 / 1296");
    expect(container.querySelector("img")).toBeNull();
  });

  it("omits the attrs when the IR carries no dims (pre-migration docs)", () => {
    const { container } = renderFigure({
      id: "fig-1",
      type: "figure",
      imgPath: "figures__a__pdf.svg",
    });
    const placeholder = container.querySelector<HTMLElement>(".figure-placeholder")!;
    expect(placeholder.style.width).toBe("100%");
    expect(placeholder.style.minHeight).toBe("120px");
  });
});
