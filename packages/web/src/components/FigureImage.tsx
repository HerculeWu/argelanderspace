import { useEffect, useRef, useState } from "react";
import { useReaderSession, type AssetBinding } from "../doc/ReaderSession";
import { imageUrl } from "../api";
import { useThemeName } from "../lib/theme-watch";

// Document figures are a mix of line/text plots (white paper, a few coloured
// strokes) and photographs / scientific colour maps (galaxy images, viridis
// heatmaps, sky surveys). In dark mode we want the *diagrams* to flip so they
// read as light-on-dark like the surrounding page, but we must leave photos and
// colour maps alone — inverting a colour map would misrepresent the data. So we
// classify each image once from its pixels and only invert the diagrams. The
// per-figure toggle is the escape hatch for the cases the heuristic gets wrong.

type Klass = "diagram" | "photo";

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

export function FigureImage({ imgPath, alt, controls = false, width, height }: {
  imgPath: string; alt: string; controls?: boolean; width?: number; height?: number;
}) {
  const { controller, state } = useReaderSession();
  const sha256 = state.accepted?.assets.find((a) => a.imgPath === imgPath)?.sha256;
  const generation = state.generation;
  const ready = state.phase === "ready";
  const root = useRef<HTMLSpanElement>(null);
  const measured = useRef<{ width: number; height: number }>();
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState<{ url: string; binding: AssetBinding } | null>(null);
  const [klass, setKlass] = useState<Klass | null>(null);
  const [override, setOverride] = useState<"invert" | "off" | null>(null);
  const dark = useThemeName() === "dark";

  useEffect(() => {
    const el = root.current; if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setLoaded(null); setKlass(null); setOverride(null);
    if (!ready || !visible || !sha256) return;
    const binding: AssetBinding = { docId: controller.docId, generation, imgPath, sha256 };
    const abort = new AbortController();
    let disposed = false;
    let url: string | null = null;
    const valid = () => !disposed && controller.isCurrentAsset(binding);
    const dispose = () => {
      const rect = root.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) measured.current = { width: rect.width, height: rect.height };
      disposed = true; abort.abort();
      if (url) { URL.revokeObjectURL(url); url = null; }
    };
    const off = controller.onInvalidate(dispose);
    void (async () => {
      try {
        const r = await fetch(`${imageUrl(controller.docId, imgPath)}?sha256=${sha256}`, { cache: "no-store", signal: abort.signal });
        if (!valid()) return;
        if (r.status !== 200) {
          const body = await r.json().catch(() => null);
          if (valid()) controller.reportAssetFailure(binding, r.status === 409 && body?.detail === "asset changed" ? "changed" : r.status === 409 && body?.detail === "document busy" ? "busy" : "error");
          return;
        }
        const bytes = await r.arrayBuffer();
        if (!valid()) return;
        if (crypto.subtle) {
          const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
          if (!valid()) return;
          if (hash !== sha256) { controller.reportAssetFailure(binding, "changed"); return; }
        }
        url = URL.createObjectURL(new Blob([bytes], { type: r.headers.get("Content-Type") ?? "application/octet-stream" }));
        if (valid()) setLoaded({ url, binding }); else { URL.revokeObjectURL(url); url = null; }
      } catch {
        if (valid()) controller.reportAssetFailure(binding, "error");
      }
    })();
    return () => { off(); dispose(); };
  }, [controller, ready, generation, imgPath, sha256, visible]);

  // Render gate, not effect cleanup: a stale blob never survives a syncing render.
  const current = ready && loaded && loaded.binding.generation === generation &&
    loaded.binding.imgPath === imgPath && loaded.binding.sha256 === sha256 && controller.isCurrentAsset(loaded.binding) ? loaded : null;
  const inverted = dark && (override === "invert" || (override === null && klass === "diagram"));
  const boxWidth = width ?? measured.current?.width;
  const boxHeight = height ?? measured.current?.height;
  return <span ref={root} className="fig-img verified-figure" style={{ maxWidth: "100%" }}>
    {current ? <img src={current.url} alt={alt} width={width} height={height}
      className={inverted ? "fig-invert" : undefined}
      onLoad={(e) => {
        if (!controller.isCurrentAsset(current.binding)) return;
        setKlass(classify(e.currentTarget));
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) measured.current = { width: rect.width, height: rect.height };
      }}
      onError={() => controller.reportAssetFailure(current.binding, "error")} /> :
      <span className="figure-placeholder" role="img" aria-label={`${alt} · 图片暂不可用`}
        style={{ width: boxWidth ?? "100%", aspectRatio: boxWidth && boxHeight ? `${boxWidth} / ${boxHeight}` : undefined, minHeight: boxHeight ? undefined : 120 }}>
        {ready ? "图片待加载" : "图片暂不可用"}
      </span>}
    {controls && dark && current && <button type="button" className="fig-invert-btn"
      title={inverted ? "显示原图" : "反色以适应深色背景"}
      aria-label={inverted ? "显示原图" : "反色以适应深色背景"} aria-pressed={inverted}
      onClick={() => setOverride(inverted ? "off" : "invert")}>
      {inverted ? <SunIcon /> : <ContrastIcon />}
    </button>}
  </span>;
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
