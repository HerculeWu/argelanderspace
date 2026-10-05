vi.mock("../src/doc/ReaderSession", () => import("./reader-unit-session"));
import { AnnotationProvider } from "../src/annotations/AnnotationStore";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DocIr, IrBlock } from "@argelanderspace/contracts";
import { BlockView } from "../src/components/Block";
import { RefCard } from "../src/components/RefCard";
import { StoreProvider } from "../src/store";

// Ticket 27 (carry-over from 23): every Reader injection of a table body goes through safeTableHtml, so a table that a
// text source or an agent wrote cannot become live HTML in the Reader or in a right-panel card.

const HOSTILE =
  '<table onclick="x()"><tr><td onmouseover="alert(1)" rowspan="2" style="x:y">a<script>window.__pwn=1</script><svg onload="window.__pwn=2"><circle r="1"/></svg></td>' +
  '<th colspan="evil">b <a href="javascript:alert(3)">link</a> <b>bold</b> $x^2$</th></tr><tr><td><object data="data:text/html,x"></object>c</td></tr></table>';

const ir = (blocks: IrBlock[]): DocIr => ({
  docId: "t",
  sections: [{ id: "s", level: 1, blocks, children: [] }],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function expectInert(root: HTMLElement) {
  expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
  expect(root.querySelector("script,iframe,img,a,style,svg,object")).toBeNull();
  for (const el of root.querySelectorAll("*")) {
    if (el.closest(".katex")) continue; // KaTeX markup is generated from the formula text, with its own styles
    for (const attr of el.getAttributeNames())
      expect(attr.startsWith("on") || attr === "style" || attr === "href" || attr === "src").toBe(false);
  }
}

describe("Reader table HTML is sanitized", () => {
  it("the table block keeps structure, spans, text and math and drops everything active", () => {
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
    const table: IrBlock = { id: "tab-1", type: "table", tableBody: HOSTILE, footnote: "note with <b>html</b> and $y$" };
    const { container } = render(
      <StoreProvider ir={ir([table])}>
        <AnnotationProvider>
          <BlockView block={table} />
        </AnnotationProvider>
      </StoreProvider>
    );
    const scroll = container.querySelector<HTMLElement>(".tbl-scroll")!;
    expectInert(scroll);
    expect(scroll.querySelector("td")?.getAttribute("rowspan")).toBe("2");
    expect(scroll.querySelector("th")?.hasAttribute("colspan")).toBe(false); // not a number: dropped
    expect(scroll.textContent).toContain("bold");
    expect(scroll.querySelector(".katex")).not.toBeNull(); // the math survived
    // the footnote is text, never markup
    const note = container.querySelector<HTMLElement>("[data-ui=latex-block-footnote]")!;
    expect(note.querySelector("b")).toBeNull();
    expect(note.textContent).toContain("<b>html</b>");
    expect(note.querySelector(".katex")).toBeNull();
  });

  it("the right-panel card preview of a table is sanitized too", () => {
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
    const table: IrBlock = { id: "tab-1", type: "table", tableBody: HOSTILE };
    const { container } = render(
      <StoreProvider ir={ir([table])}>
        <AnnotationProvider>
          <RefCard card={{ id: "tab-1", kind: "table", block: table } as never} expanded focused={false} onToggleExpand={() => {}} />
        </AnnotationProvider>
      </StoreProvider>
    );
    const preview = container.querySelector<HTMLElement>("table")!;
    expectInert(preview);
    expect(preview.textContent).toContain("bold");
  });
});

describe("fix round 1: footnotes from segments, alt text, wide spans, literal dollars", () => {
  const stub = () => vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  const mount = (block: IrBlock) =>
    render(
      <StoreProvider ir={ir([block])}>
        <AnnotationProvider>
          <BlockView block={block} />
        </AnnotationProvider>
      </StoreProvider>
    );

  it("a footnote is rendered from its IR segments like a caption: currency stays text, one formula, no raw tokens", () => {
    stub();
    const fig: IrBlock = {
      id: "fig-1",
      type: "figure",
      imgPath: "a.png",
      footnote: "costs $5 to $9, error $x$ [cite: k]",
      footnoteSegments: [
        { type: "text", text: "costs $5 to $9, error " },
        { type: "math", latex: "x" },
        { type: "text", text: " " },
        { type: "cite", refs: [{ id: "k", resolved: false }], raw: "k" },
      ],
    };
    const { container } = mount(fig);
    const note = container.querySelector<HTMLElement>("[data-ui=latex-block-footnote]")!;
    expect(note.textContent).toContain("costs $5 to $9, error");
    expect(note.querySelectorAll(".katex")).toHaveLength(1);
  });

  it("an IR with a plain footnote string and no segments shows it as inert text (no math pairing)", () => {
    stub();
    const t: IrBlock = { id: "t", type: "table", tableBody: "<table><tr><td>a</td></tr></table>", footnote: "costs $5 to $9 <b>x</b>" };
    const { container } = mount(t);
    const note = container.querySelector<HTMLElement>("[data-ui=latex-block-footnote]")!;
    expect(note.textContent).toBe("costs $5 to $9 <b>x</b>");
    expect(note.querySelector(".katex,b")).toBeNull();
  });

  it("the figure's alt text becomes the image's accessible name, falling back to the label", () => {
    stub();
    const withAlt = mount({ id: "f", type: "figure", imgPath: "a.png", label: "Figure 1", content: "A shear profile" });
    expect(withAlt.container.querySelector("[role=img]")?.getAttribute("aria-label")).toContain("A shear profile");
    cleanup();
    const noAlt = mount({ id: "f", type: "figure", imgPath: "a.png", label: "Figure 1" });
    expect(noAlt.container.querySelector("[role=img]")?.getAttribute("aria-label")).toContain("Figure 1");
  });

  it("a validated grid renders identically: rowspan/colspan up to the table limits survive, a non-number does not", () => {
    stub();
    const body = '<table><tr><td rowspan="1999" colspan="199">a</td><td rowspan="12345">b</td></tr></table>';
    const { container } = mount({ id: "t", type: "table", tableBody: body });
    const cell = container.querySelector("td")!;
    expect(cell.getAttribute("rowspan")).toBe("1999");
    expect(cell.getAttribute("colspan")).toBe("199");
    expect(container.querySelectorAll("td")[1]?.hasAttribute("rowspan")).toBe(false);
  });

  it("literal dollars isolated in their own element never pair into a formula", () => {
    stub();
    const body = "<table><tr><td>costs <span>$</span>5 and <span>$</span>6 and $y$</td></tr></table>";
    const { container } = mount({ id: "t", type: "table", tableBody: body });
    const cell = container.querySelector("td")!;
    expect(cell.querySelectorAll(".katex")).toHaveLength(1);
    expect(cell.textContent).toContain("costs $5 and $6 and");
  });
});
