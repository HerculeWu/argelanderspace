import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PdfActionType, PdfAnnotationSubtype, PdfZoomMode, type PdfBookmarkObject, type PdfDestinationObject, type PdfLinkAnnoObject, type PdfLinkTarget } from "@embedpdf/models";
import { PdfLinkHitLayer } from "../src/doc/PdfLinkHitLayer";
import { dispatchPdfLinkTarget, flattenPdfBookmarks, isPdfLinkTargetAllowed, safePdfExternalUrl } from "../src/doc/pdf-navigation";

afterEach(cleanup);

const pageDestination = (pageIndex: number): PdfDestinationObject => ({ pageIndex, zoom: { mode: PdfZoomMode.Unknown }, view: [] });
const destination = (pageIndex: number): PdfLinkTarget => ({ type: "destination", destination: pageDestination(pageIndex) });
const action = (type: PdfActionType, value: Record<string, unknown> = {}): PdfLinkTarget => ({ type: "action", action: { type, ...value } } as PdfLinkTarget);
const actionGoto = (pageIndex: number): PdfLinkTarget => action(PdfActionType.Goto, { destination: pageDestination(pageIndex) });
const link = (id: string, target: PdfLinkTarget, rect = { origin: { x: 20, y: 30 }, size: { width: 80, height: 40 } }, pageIndex = 0): PdfLinkAnnoObject => ({
  id,
  type: PdfAnnotationSubtype.LINK,
  pageIndex,
  rect,
  target,
});

describe("PDF link action security", () => {
  test("allows in-range same-document destinations, Goto actions, and safe absolute HTTP(S) URIs", () => {
    expect(isPdfLinkTargetAllowed(destination(0), 3)).toBe(true);
    expect(isPdfLinkTargetAllowed(actionGoto(2), 3)).toBe(true);
    expect(isPdfLinkTargetAllowed(action(PdfActionType.URI, { uri: "https://example.org/paper" }), 3)).toBe(true);
    expect(safePdfExternalUrl("https://example.org/paper")).toBe("https://example.org/paper");
  });

  test.each([
    ["out-of-range destination", destination(3)],
    ["negative destination", destination(-1)],
    ["fractional destination", destination(1.5)],
    ["out-of-range Goto", actionGoto(3)],
    ["remote Goto", action(PdfActionType.RemoteGoto, { destination: pageDestination(0) })],
    ["launch action", action(PdfActionType.LaunchAppOrOpenFile, { path: "/tmp/untrusted" })],
    ["unsupported action", action(PdfActionType.Unsupported)],
    ["JavaScript URI", action(PdfActionType.URI, { uri: "javascript:alert(1)" })],
    ["file URI", action(PdfActionType.URI, { uri: "file:///etc/passwd" })],
    ["data URI", action(PdfActionType.URI, { uri: "data:text/html,bad" })],
    ["credentialed URI", action(PdfActionType.URI, { uri: "https://user:pass@example.org/" })],
    ["malformed destination", { type: "destination", destination: { pageIndex: "0", zoom: { mode: PdfZoomMode.Unknown }, view: [] } } as unknown as PdfLinkTarget],
    ["malformed zoom", { type: "destination", destination: { pageIndex: 0, zoom: { mode: 999 }, view: [] } } as unknown as PdfLinkTarget],
    ["malformed view", { type: "destination", destination: { pageIndex: 0, zoom: { mode: PdfZoomMode.Unknown }, view: [Number.NaN] } } as unknown as PdfLinkTarget],
    ["nonpositive page count", destination(0), 0],
  ])("rejects %s", (_label, target, pageCount = 3) => {
    expect(isPdfLinkTargetAllowed(target, pageCount)).toBe(false);
  });

  test("flattens unsafe native bookmarks as disabled and retains only admissible targets", () => {
    const tree: PdfBookmarkObject[] = [
      { title: "Page destination", target: destination(0) },
      { title: "Same-document action", target: actionGoto(2) },
      { title: "Safe external URI", target: action(PdfActionType.URI, { uri: "https://example.org/" }) },
      { title: "Unsafe external URI", target: action(PdfActionType.URI, { uri: "javascript:alert(1)" }) },
      { title: "Remote document", target: action(PdfActionType.RemoteGoto, { destination: pageDestination(0) }) },
      { title: "Launch file", target: action(PdfActionType.LaunchAppOrOpenFile, { path: "/tmp/untrusted" }) },
      { title: "Unsupported", target: action(PdfActionType.Unsupported) },
      { title: "Bad page", target: destination(3) },
      { title: "Bad destination", target: { type: "destination", destination: { pageIndex: Number.NaN } } as unknown as PdfLinkTarget },
    ];
    const result = flattenPdfBookmarks(tree, 3);
    expect(result.entries.map((entry) => [entry.title, entry.disabled])).toEqual([
      ["Page destination", false],
      ["Same-document action", false],
      ["Safe external URI", false],
      ["Unsafe external URI", true],
      ["Remote document", true],
      ["Launch file", true],
      ["Unsupported", true],
      ["Bad page", true],
      ["Bad destination", true],
    ]);
    expect(result.targets.size).toBe(3);
    expect(result.targets.has("pdf-outline-3")).toBe(false);
  });

  test("native hit layer renders and activates only allowed link targets", () => {
    const onNavigate = vi.fn();
    const { container } = render(<PdfLinkHitLayer
      pageIndex={0}
      pageCount={3}
      geometry={{ size: { width: 200, height: 300 }, rotation: 0 }}
      links={[
        link("same-doc", destination(0)),
        link("goto", actionGoto(2)),
        link("remote", action(PdfActionType.RemoteGoto, { destination: pageDestination(1) })),
        link("unsafe-uri", action(PdfActionType.URI, { uri: "javascript:alert(1)" })),
        link("launch", action(PdfActionType.LaunchAppOrOpenFile, { path: "/tmp/untrusted" })),
        link("out-of-range", destination(3)),
        link("malformed-destination", { type: "destination", destination: { pageIndex: "0" } } as unknown as PdfLinkTarget),
        link("negative-rect", destination(0), { origin: { x: -1, y: 30 }, size: { width: 20, height: 10 } }),
        link("negative-area", destination(0), { origin: { x: 40, y: 30 }, size: { width: -20, height: 10 } }),
        link("nonfinite-rect", destination(0), { origin: { x: Number.NaN, y: 30 }, size: { width: 20, height: 10 } }),
        link("adjacent-page-rect", destination(0), { origin: { x: 199, y: 30 }, size: { width: 2, height: 10 } }),
        link("rounded-edge", destination(0), { origin: { x: 199.9999, y: 30 }, size: { width: 0.0002, height: 10 } }),
      ]}
      onNavigate={onNavigate}
    />);
    const buttons = container.querySelectorAll<HTMLButtonElement>("button[data-pdf-native-link]");
    expect([...buttons].map((button) => button.dataset.pdfNativeLink)).toEqual(["same-doc", "goto", "rounded-edge"]);
    expect(buttons[2]?.style.left).toBe(`${(199.9999 / 200) * 100}%`);
    expect(Number(buttons[2]?.style.width.replace("%", ""))).toBeCloseTo(0.00005, 10);
    fireEvent.click(buttons[1]!);
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith(actionGoto(2));
  });

  test("rotated SDK page hit geometry stays in pre-rotation page coordinates for the Rotate parent", () => {
    const { container } = render(<PdfLinkHitLayer
      pageIndex={2}
      pageCount={3}
      geometry={{ size: { width: 393, height: 557 }, rotation: 3 }}
      links={[link("rotated-valid", destination(2), { origin: { x: 32, y: 141 }, size: { width: 16, height: 224 } }, 2)]}
      onNavigate={vi.fn()}
    />);
    const button = container.querySelector<HTMLButtonElement>('[data-pdf-native-link="rotated-valid"]');
    expect(button).not.toBeNull();
    expect(button?.style.left).toBe(`${(32 / 393) * 100}%`);
    expect(button?.style.top).toBe(`${(141 / 557) * 100}%`);
    expect(button?.style.width).toBe(`${(16 / 393) * 100}%`);
    expect(button?.style.height).toBe(`${(224 / 557) * 100}%`);
  });

  test("final navigation boundary never invokes SDK for unsafe targets and forwards valid Goto", () => {
    const sdkNavigate = vi.fn();
    const openExternal = vi.fn();
    const rejectedTargets = [
      action(PdfActionType.RemoteGoto, { destination: pageDestination(0) }),
      action(PdfActionType.LaunchAppOrOpenFile, { path: "/tmp/untrusted" }),
      action(PdfActionType.Unsupported),
      action(PdfActionType.URI, { uri: "file:///etc/passwd" }),
      destination(3),
      { type: "destination", destination: { pageIndex: "0" } } as unknown as PdfLinkTarget,
    ];
    const goto = actionGoto(1);
    for (const rejected of rejectedTargets) expect(dispatchPdfLinkTarget(rejected, 3, sdkNavigate, openExternal)).toBe(false);
    expect(sdkNavigate).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(dispatchPdfLinkTarget(goto, 3, sdkNavigate, openExternal)).toBe(true);
    expect(sdkNavigate).toHaveBeenCalledExactlyOnceWith(goto);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
