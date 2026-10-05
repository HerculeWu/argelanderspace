import { PdfActionType, PdfZoomMode, type PdfBookmarkObject, type PdfDestinationObject, type PdfLinkTarget } from "@embedpdf/models";
import type { OutlineEntry } from "../components/TocPanel";

export function safePdfExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidPdfDestination(value: unknown, pageCount: number): value is PdfDestinationObject {
  if (!Number.isInteger(pageCount) || pageCount < 1 || !isRecord(value)) return false;
  if (!Number.isInteger(value.pageIndex) || (value.pageIndex as number) < 0 || (value.pageIndex as number) >= pageCount) return false;
  if (!Array.isArray(value.view) || !Array.from(value.view).every((item) => typeof item === "number" && Number.isFinite(item))) return false;
  if (!isRecord(value.zoom)) return false;
  switch (value.zoom.mode) {
    case PdfZoomMode.Unknown:
    case PdfZoomMode.FitPage:
    case PdfZoomMode.FitHorizontal:
    case PdfZoomMode.FitVertical:
    case PdfZoomMode.FitRectangle:
    case PdfZoomMode.FitBoundingBox:
    case PdfZoomMode.FitBoundingBoxHorizontal:
    case PdfZoomMode.FitBoundingBoxVertical:
      return true;
    case PdfZoomMode.XYZ: {
      const params = value.zoom.params;
      return isRecord(params) && [params.x, params.y, params.zoom].every((item) => typeof item === "number" && Number.isFinite(item));
    }
    default:
      return false;
  }
}

/** Only in-document destinations and credential-free HTTP(S) URI actions are navigable. */
export function isPdfLinkTargetAllowed(target: unknown, pageCount: number): target is PdfLinkTarget {
  if (!isRecord(target)) return false;
  if (target.type === "destination") return isValidPdfDestination(target.destination, pageCount);
  if (target.type !== "action" || !isRecord(target.action)) return false;
  if (target.action.type === PdfActionType.Goto) return isValidPdfDestination(target.action.destination, pageCount);
  return target.action.type === PdfActionType.URI && typeof target.action.uri === "string" && safePdfExternalUrl(target.action.uri) !== null;
}

/** Final fail-closed dispatcher immediately before any SDK or browser navigation call. */
export function dispatchPdfLinkTarget(
  target: unknown,
  pageCount: number,
  navigateInternal: (target: PdfLinkTarget) => void,
  openExternal: (url: string) => void
): boolean {
  if (!isPdfLinkTargetAllowed(target, pageCount)) return false;
  if (target.type === "action" && target.action.type === PdfActionType.URI) {
    const url = safePdfExternalUrl(target.action.uri);
    if (!url) return false;
    openExternal(url);
    return true;
  }
  navigateInternal(target);
  return true;
}

export function flattenPdfBookmarks(bookmarks: PdfBookmarkObject[], pageCount: number): { entries: OutlineEntry[]; targets: Map<string, PdfLinkTarget> } {
  const entries: OutlineEntry[] = [];
  const targets = new Map<string, PdfLinkTarget>();
  // Ids are the depth-first position (`pdf-outline-<n>`): short and bounded whatever the nesting; the service numbers its
  // outline the same way, so a tool and the panel name one entry alike.
  let position = 0;
  const walk = (nodes: PdfBookmarkObject[], depth: number) => {
    nodes.forEach((bookmark) => {
      const id = `pdf-outline-${position++}`;
      const target = bookmark.target;
      const allowed = isPdfLinkTargetAllowed(target, pageCount);
      entries.push({ id, title: bookmark.title, level: Math.min(6, depth), disabled: !allowed });
      if (allowed) targets.set(id, target);
      if (bookmark.children?.length) walk(bookmark.children, depth + 1);
    });
  };
  walk(bookmarks, 1);
  return { entries, targets };
}

/** The zero-based page an allowed in-document target goes to; null for an external link or anything else. */
export function pdfTargetPageIndex(target: unknown): number | null {
  if (!isRecord(target)) return null;
  const destination = target.type === "destination" ? target.destination : isRecord(target.action) && target.action.type === PdfActionType.Goto ? target.action.destination : null;
  return isRecord(destination) && Number.isInteger(destination.pageIndex) ? (destination.pageIndex as number) : null;
}
