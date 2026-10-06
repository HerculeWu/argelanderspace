/**
 * The PDF Reader's side panels fold on their own like the LaTeX Reader's (same threshold MIN_READING_COLUMN, same
 * manual-override semantics): left first, then both; a manual choice wins until the width class changes.
 */
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_READING_COLUMN, autoFold, useAutoFoldedPanels } from "../src/doc/auto-fold";
import { pdfPanelSizes } from "../src/doc/PdfReader";

describe("autoFold for the PDF Reader", () => {
  it("at 1024 with Copilot open (pane 612) both panels fold; at 1440 with it open (pane ~996) the outline folds", () => {
    expect(autoFold(612, pdfPanelSizes(1024))).toEqual({ left: true, right: true });
    expect(autoFold(996, pdfPanelSizes(1440))).toEqual({ left: true, right: false });
    expect(autoFold(1100, pdfPanelSizes(1440))).toEqual({ left: false, right: false });
    expect(autoFold(962, pdfPanelSizes(1024))).toEqual({ left: false, right: false });
    expect(autoFold(300, pdfPanelSizes(1024))).toEqual({ left: true, right: true });
    expect(autoFold(760, pdfPanelSizes(1024))).toEqual({ left: true, right: false });
    expect(autoFold(null, pdfPanelSizes(1024))).toEqual({ left: false, right: false });
  });
  it("uses the LaTeX Reader's threshold", () => {
    const sizes = pdfPanelSizes(1024);
    expect(autoFold(sizes.left + sizes.right + MIN_READING_COLUMN, sizes)).toEqual({ left: false, right: false });
    expect(autoFold(sizes.left + sizes.right + MIN_READING_COLUMN - 1, sizes)).toEqual({ left: true, right: false });
  });
  it("the panel widths follow the stylesheet's clamp()s", () => {
    expect(pdfPanelSizes(1024)).toEqual({ left: 194.56, right: 235.52, rail: 36 });
    expect(pdfPanelSizes(2000)).toEqual({ left: 260, right: 320, rail: 36 });
    expect(pdfPanelSizes(400)).toEqual({ left: 180, right: 200, rail: 36 });
  });
});

let width = 612;
const observers = new Set<() => void>();
class RO {
  constructor(private cb: () => void) {}
  observe() { observers.add(this.cb); }
  unobserve() {}
  disconnect() { observers.delete(this.cb); }
}
const real = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this.getAttribute("data-probe") ? ({ width, height: 400, top: 0, left: 0, right: width, bottom: 400, x: 0, y: 0, toJSON() {} } as DOMRect) : real.call(this);
  };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Element.prototype.getBoundingClientRect = real; });
const resize = (next: number) => act(() => { width = next; for (const cb of [...observers]) cb(); });

let api: ReturnType<typeof useAutoFoldedPanels>;
function Probe({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  api = useAutoFoldedPanels(ref, pdfPanelSizes(1024), enabled);
  return <div ref={ref} data-probe="1" />;
}

describe("the hook", () => {
  it("folds by width, a manual choice wins until the width class changes, then the automatic choice returns", () => {
    width = 612;
    render(<Probe />);
    expect([api.collapsedLeft, api.collapsedRight]).toEqual([true, true]);
    act(() => api.setCollapsedLeft(false));
    expect([api.collapsedLeft, api.collapsedRight]).toEqual([false, true]);
    resize(620);
    expect([api.collapsedLeft, api.collapsedRight]).toEqual([false, true]);
    resize(1400);
    expect([api.collapsedLeft, api.collapsedRight]).toEqual([false, false]);
    resize(300);
    expect([api.collapsedLeft, api.collapsedRight]).toEqual([true, true]);
    act(() => api.setCollapsedRight((previous) => !previous));
    expect([api.collapsedLeft, api.collapsedRight]).toEqual([true, false]);
  });
  it("unfolding the second panel when the page column would fall under its minimum folds the first (both orders)", () => {
    width = 612;
    render(<Probe />);
    act(() => api.setCollapsedLeft(false));
    act(() => api.setCollapsedRight(false));
    expect([api.collapsedLeft, api.collapsedRight]).toEqual([true, false]);
    act(() => api.setCollapsedLeft(false));
    expect([api.collapsedLeft, api.collapsedRight]).toEqual([false, true]);
  });
  it("leaves both open when the pane has room for both", () => {
    width = 1200;
    render(<Probe />);
    act(() => api.setCollapsedLeft(true));
    act(() => api.setCollapsedLeft(false));
    expect([api.collapsedLeft, api.collapsedRight]).toEqual([false, false]);
  });
  it("measures nothing until it is enabled (the PDF layout exists only once the document has loaded)", () => {
    width = 612;
    const { rerender } = render(<Probe enabled={false} />);
    expect([api.collapsedLeft, api.collapsedRight]).toEqual([false, false]);
    rerender(<Probe enabled />);
    expect([api.collapsedLeft, api.collapsedRight]).toEqual([true, true]);
  });
});
