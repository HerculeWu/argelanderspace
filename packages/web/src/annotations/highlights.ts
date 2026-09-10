// Painting layer for text annotations (Stage 8 MS4): the CSS Custom Highlight
// API paints the annotation ranges WITHOUT touching the body DOM (no nested
// spans — arbitrary overlap with math/cite/xref atom DOM is the whole point).
//
// Overlap deepening: the HighlightRegistry maps ONE name to ONE Highlight, so
// each annotation gets its own generated name (`annhl-<instance>-<annId>`) and
// its own Highlight object; overlapping registered highlights paint as
// independent layers and the semi-transparent base color visually deepens at
// intersections. The active annotation (popover open / list click) is pulled
// out under a separate name with a stronger color and higher paint priority.
// All `::highlight(...)` rules live in a managed <style> element the painter
// regenerates per paint (colors reference the root-level theme vars, which
// ::highlight inherits from the root element).
//
// Feature-detected: without `CSS.highlights` (older browsers, happy-dom) the
// painter reports `supported: false` and everything no-ops — the annotation
// list / popover / gutter markers all keep working unpainted.

/** The registry surface the painter needs (structural — tests inject fakes). */
export interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

export interface HighlightDeps {
  registry: HighlightRegistryLike;
  /** Constructs a Highlight from ranges (the live `Highlight` class in real
   *  browsers; tests inject a recording fake). */
  makeHighlight: (ranges: Range[]) => { priority: number };
}

export interface PaintEntry {
  /** Annotation id (used in the generated highlight name). */
  id: string;
  range: Range;
  active: boolean;
}

export interface HighlightPainter {
  readonly supported: boolean;
  /** Rebuild all highlights from scratch (fingerprint guarantee: stored
   *  offsets are authoritative — callers pass resolved ranges, never
   *  quote-re-searched ones). */
  paint: (entries: PaintEntry[]) => void;
  /** Remove all owned highlights + the managed style element. */
  dispose: () => void;
}

const BASE_NAME = "annhl";
const ACTIVE_NAME = "annhl-active";
const BASE_BG = "color-mix(in oklch, var(--accent) 26%, transparent)";
const ACTIVE_BG = "color-mix(in oklch, var(--accent) 52%, transparent)";

/** Detect the real CSS Custom Highlight API from the window's globals. */
export function detectHighlightDeps(): HighlightDeps | null {
  try {
    if (
      typeof CSS !== "undefined" &&
      "highlights" in CSS &&
      CSS.highlights &&
      typeof Highlight !== "undefined"
    ) {
      return {
        registry: CSS.highlights as unknown as HighlightRegistryLike,
        makeHighlight: (ranges) => new Highlight(...ranges),
      };
    }
  } catch {
    // fall through to unsupported
  }
  return null;
}

export function createHighlightPainter(
  doc: Document,
  instanceKey: string,
  deps: HighlightDeps | null = detectHighlightDeps()
): HighlightPainter {
  if (deps === null) {
    return { supported: false, paint: () => {}, dispose: () => {} };
  }
  const styleEl = doc.createElement("style");
  styleEl.setAttribute("data-ann-highlights", instanceKey);
  doc.head.appendChild(styleEl);
  const owned = new Set<string>();
  let disposed = false;

  return {
    supported: true,
    paint(entries) {
      if (disposed) return;
      for (const name of owned) deps.registry.delete(name);
      owned.clear();
      const rules: string[] = [];
      for (const e of entries) {
        const name = e.active
          ? `${ACTIVE_NAME}-${instanceKey}`
          : `${BASE_NAME}-${instanceKey}-${e.id}`;
        const hl = deps.makeHighlight([e.range]);
        // the active highlight paints last (on top of the stacked base layers)
        hl.priority = e.active ? 1 : 0;
        deps.registry.set(name, hl);
        owned.add(name);
        rules.push(
          `::highlight(${name}) { background-color: ${e.active ? ACTIVE_BG : BASE_BG}; }`
        );
      }
      styleEl.textContent = rules.join("\n");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const name of owned) deps.registry.delete(name);
      owned.clear();
      styleEl.remove();
    },
  };
}
