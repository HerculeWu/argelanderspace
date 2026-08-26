import { useEffect, useRef, useState } from "react";
import { useThemeName } from "../lib/theme-watch";

// Document figures are a mix of line/text plots (white paper, a few coloured
// strokes) and photographs / scientific colour maps (galaxy images, viridis
// heatmaps, sky surveys). In dark mode we want the *diagrams* to flip so they
// read as light-on-dark like the surrounding page, but we must leave photos and
// colour maps alone — inverting a colour map would misrepresent the data. So we
// classify each image once from its pixels and only invert the diagrams. The
// per-figure toggle is the escape hatch for the cases the heuristic gets wrong.

type Klass = "diagram" | "photo";

// Module-level cache keyed by src: classification is stable, and figures remount
// as they scroll in/out of the reading band, so we never re-analyse the same URL.
const classCache = new Map<string, Klass>();

/** Decide whether an image is an invert-friendly diagram or a leave-alone photo.
 *  Diagram  = lots of near-white background AND little saturated colour, or a
 *             mostly-transparent canvas (transparent-bg line art).
 *  Photo    = colourful (colour maps), or dark, or photographic — left as-is. */
function classify(img: HTMLImageElement): Klass {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return "photo";
  const S = 36; // sample grid — big enough to be representative, cheap to scan
  const cw = Math.max(1, Math.min(S, w));
  const ch = Math.max(1, Math.min(S, h));
  let data: Uint8ClampedArray;
  try {
    const cvs = document.createElement("canvas");
    cvs.width = cw;
    cvs.height = ch;
    const ctx = cvs.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "photo";
    ctx.drawImage(img, 0, 0, cw, ch);
    data = ctx.getImageData(0, 0, cw, ch).data;
  } catch {
    // Tainted canvas (cross-origin without CORS). Our images are same-origin so
    // this shouldn't happen, but if it does, don't touch the image.
    return "photo";
  }

  const totalPx = data.length / 4;
  let opaque = 0;
  let light = 0;
  let colorful = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 8) continue; // transparent → ignore for light/colour stats
    opaque++;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (lum > 0.82) light++;
    if (sat > 0.22 && lum > 0.18 && lum < 0.95) colorful++;
  }

  const transparentFrac = (totalPx - opaque) / totalPx;
  if (transparentFrac > 0.35) return "diagram"; // transparent-background line art
  if (opaque === 0) return "diagram";

  const lightFrac = light / opaque;
  const colorfulFrac = colorful / opaque;
  // The costs are asymmetric: wrongly inverting a colour map corrupts the data,
  // whereas wrongly leaving a plot just keeps a bright figure on the dark page
  // (and the toggle fixes it). So we only invert when an image is clearly a
  // light, near-monochrome diagram. These bounds clear real astronomy plots with
  // margin (measured lightFrac >= 0.76, colorfulFrac <= 0.12) while excluding
  // colour maps (which are far more saturated and/or dark-backed).
  if (lightFrac >= 0.5 && colorfulFrac <= 0.15) return "diagram";
  return "photo";
}

export function FigureImage({
  src,
  alt,
  controls = false,
}: {
  src: string;
  alt: string;
  /** Render the per-figure invert toggle (for main figures, not previews). */
  controls?: boolean;
}) {
  const theme = useThemeName();
  const dark = theme === "dark";
  const imgRef = useRef<HTMLImageElement>(null);
  const [klass, setKlass] = useState<Klass | null>(() => classCache.get(src) ?? null);
  // null = follow the heuristic; otherwise an explicit per-image override.
  const [override, setOverride] = useState<"invert" | "off" | null>(null);

  // A new src means a different figure — drop any stale override/classification.
  useEffect(() => {
    setOverride(null);
    setKlass(classCache.get(src) ?? null);
  }, [src]);

  // Classify once the bitmap is available (immediately if already cached/loaded).
  useEffect(() => {
    if (classCache.has(src)) return;
    const img = imgRef.current;
    if (!img) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const c = classify(img);
      classCache.set(src, c);
      setKlass(c);
    };
    if (img.complete && img.naturalWidth) {
      run();
    } else {
      const onLoad = () => run();
      img.addEventListener("load", onLoad, { once: true });
      return () => {
        cancelled = true;
        img.removeEventListener("load", onLoad);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [src]);

  const autoInvert = klass === "diagram";
  const inverted = dark && (override === "invert" || (override === null && autoInvert));

  const img = (
    <img
      ref={imgRef}
      src={src}
      alt={alt}
      loading="lazy"
      className={inverted ? "fig-invert" : undefined}
    />
  );

  // Previews (refcards, table images) render a bare <img> — no wrapper/toggle —
  // to avoid disturbing their existing layout selectors.
  if (!controls) return img;

  return (
    <span className="fig-img">
      {img}
      {dark && (
        <button
          type="button"
          className="fig-invert-btn"
          title={inverted ? "显示原图" : "反色以适应深色背景"}
          aria-label={inverted ? "显示原图" : "反色以适应深色背景"}
          aria-pressed={inverted}
          onClick={() => setOverride(inverted ? "off" : "invert")}
        >
          {inverted ? <SunIcon /> : <ContrastIcon />}
        </button>
      )}
    </span>
  );
}

function ContrastIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
