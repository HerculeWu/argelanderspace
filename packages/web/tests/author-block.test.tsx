vi.mock("../src/doc/ReaderSession", () => import("./reader-unit-session"));
import { AnnotationProvider } from "../src/annotations/AnnotationStore";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { TexDocIr } from "@argelanderspace/contracts";
import { AuthorBlock } from "../src/components/AuthorBlock";
import { StoreProvider } from "../src/store";

const baseIr: TexDocIr = {
  version: 1,
  docId: "t",
  title: "Test doc",
  sections: [],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
  source: { type: "latex", origin: "t", main_tex: "main.tex" },
  meta: {},
};

function renderBlock(meta: TexDocIr["meta"]) {
  const ir: TexDocIr = { ...baseIr, meta };
  return render(
    <StoreProvider ir={ir}><AnnotationProvider>
      <AuthorBlock />
    </AnnotationProvider></StoreProvider>
  );
}

afterEach(() => cleanup());

const META = {
  authorDetails: [
    { name: "Dhanraj Risbud", affiliations: [1] },
    { name: "Vikrant V. Jadhav", affiliations: [2], email: "vjadhav@uni-bonn.de" },
    { name: "Pavel Kroupa", affiliations: [2, 3] },
  ],
  affiliations: ["Uni Bonn", "HISKP Bonn", "Charles University"],
  email: "s14drisb@uni-bonn.de",
};

describe("AuthorBlock", () => {
  it("renders nothing without authorDetails", () => {
    const { container } = renderBlock({});
    expect(container.querySelector(".author-block")).toBeNull();
  });

  it("collapses to the first author + count by default", () => {
    const { container } = renderBlock(META);
    const toggle = container.querySelector(".author-toggle")!;
    expect(toggle.textContent).toContain("Dhanraj Risbud et al. (3 authors)");
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe(toggle.getAttribute("aria-label"));
    expect(toggle.hasAttribute("title")).toBe(false);
    expect(toggle.getAttribute("data-ui")).toBe("toggle-authors");
    expect(container.querySelector(".author-full")).toBeNull();
  });

  it("expands to the full list with superscripts, emails and affiliations", () => {
    const { container } = renderBlock(META);
    fireEvent.click(container.querySelector(".author-toggle")!);
    const names = [...container.querySelectorAll(".author-name")].map((n) => n.textContent);
    expect(names).toEqual(["Dhanraj Risbud", "Vikrant V. Jadhav", "Pavel Kroupa"]);
    const sups = [...container.querySelectorAll(".author-sup")].map((n) => n.textContent);
    expect(sups).toEqual(["1", "2", "2,3"]);
    expect(container.querySelector(".author-email")!.textContent).toContain(
      "vjadhav@uni-bonn.de"
    );
    const affs = [...container.querySelectorAll(".affil-list li")].map((n) => n.textContent);
    expect(affs).toEqual(["Uni Bonn", "HISKP Bonn", "Charles University"]);
    expect(container.querySelector(".author-doc-email")!.textContent).toContain(
      "s14drisb@uni-bonn.de"
    );
    // collapses back
    fireEvent.click(container.querySelector(".author-toggle")!);
    expect(container.querySelector(".author-full")).toBeNull();
  });

  it("a single author shows just the name", () => {
    const { container } = renderBlock({ authorDetails: [{ name: "Solo A." }] });
    const toggle = container.querySelector(".author-toggle")!;
    expect(toggle.textContent).toContain("Solo A.");
    expect(toggle.textContent).not.toContain("et al.");
  });

  it("omits the affiliation list when there are no affiliations", () => {
    const { container } = renderBlock({
      authorDetails: [{ name: "Solo A." }, { name: "Duo B." }],
    });
    fireEvent.click(container.querySelector(".author-toggle")!);
    expect(container.querySelector(".affil-list")).toBeNull();
    expect(container.querySelectorAll(".author-name")).toHaveLength(2);
  });
});
