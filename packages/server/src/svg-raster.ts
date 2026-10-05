/**
 * Rendering one SVG figure to a bounded PNG for the model (copilot ticket 30, user decision 2026-10-05).
 *
 * The step is on demand, visible (an operation row) and for the model only: nothing is stored or changed, and the SVG
 * file is read through the same hash-checked asset read the Reader's images use. An SVG is untrusted input, so it is
 * checked BEFORE any renderer sees it and refused whole (never "cleaned") when it could do more than draw:
 * scripts, event attributes, `foreignObject`, a DOCTYPE/ENTITY, `@import`, and any reference that is not a fragment of
 * the same file (`#id`) or an inline raster image (`data:image/png|jpeg|webp;base64`): so nothing inside the file can
 * make the renderer read another file or reach a network. The renderer (resvg) executes no script by construction;
 * the checks keep external references out of its input as well. The output size is bounded by the caller's long edge
 * (never the SVG's own width/height or viewBox), a source over 2 MiB, more than 20000 elements or an extreme aspect
 * ratio is refused, and the PNG then obeys the byte/window rules every image given to the model obeys.
 *
 * The renderer is `@resvg/resvg-js` (MPL-2.0, native, no JavaScript engine), loaded on first use. It is an optional
 * runtime component: a build without it answers `unavailable` (honest, recoverable) instead of failing.
 */

export const SVG_MAX_BYTES = 2 * 1024 * 1024;
export const SVG_MAX_ELEMENTS = 20_000;
export const SVG_MAX_ASPECT = 100;
/** The hard ceiling on a drawn picture's longer edge, checked BEFORE the engine allocates anything. */
export const SVG_MAX_LONG_EDGE = 4096;

export type SvgSafety = { ok: true } | { ok: false; reason: string };

/** Refuses an SVG that is not purely a drawing. The reason names the first offence (never the file's content). */
export function checkSvg(svg: string): SvgSafety {
  if (!/<svg[\s>]/i.test(svg)) return { ok: false, reason: "it is not an SVG document" };
  const banned: [RegExp, string][] = [
    [/<!doctype/i, "a DOCTYPE"],
    [/<!entity/i, "an ENTITY declaration"],
    [/<\?xml-stylesheet/i, "an xml-stylesheet"],
    [/<\s*script/i, "a script element"],
    [/<\s*foreignobject/i, "a foreignObject element"],
    [/<\s*(iframe|embed|object|link|audio|video|handler)[\s>/]/i, "an embedded-content element"],
    [/[\s"'/]on[a-z]+\s*=/i, "an event-handler attribute"],
    [/javascript\s*:/i, "a javascript: reference"],
    [/@import/i, "a CSS @import"],
    [/@font-face/i, "a CSS @font-face"],
    // a CSS escape could spell url( or a property name past the checks below
    [/\\/, "a backslash (a CSS escape)"],
  ];
  for (const [pattern, what] of banned)
    if (pattern.test(svg)) return { ok: false, reason: `it contains ${what}` };
  // Every occurrence of `href` and of `url(` is judged on its own, wherever it stands (attribute, text, comment,
  // another value): a scan that consumed a quoted value could be made to step over the real reference after it.
  // An occurrence is allowed only as a quoted `#fragment` or an inline raster picture; anything else is refused.
  // An inline raster picture given as an href value is set aside first: its base64 may spell `href` by chance, and
  // what it covers is base64 text between one pair of quotes, so no markup can hide in it.
  const scan = svg.replace(
    /(href\s*=\s*)(["'])data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]*\2/gi,
    "$1$2#inline$2"
  );
  for (const at of scan.matchAll(/href/gi)) {
    const rest = scan.slice(at.index + 4);
    const quoted = /^\s*=\s*("([^"]*)"|'([^']*)')/.exec(rest);
    const value = quoted ? (quoted[2] ?? quoted[3] ?? "").trim() : undefined;
    if (value !== undefined && /^#[^#\s]*$/.test(value)) continue;
    return {
      ok: false,
      reason: "it references something outside the file (an href that is not a #fragment)",
    };
  }
  for (const at of scan.matchAll(/url\s*\(/gi)) {
    const target = /^\s*(["']?)\s*([^)"'\s]*)\s*\1\s*\)/.exec(scan.slice(at.index + at[0].length));
    if (target && /^#[^#]*$/.test(target[2] ?? "")) continue;
    return {
      ok: false,
      reason: "it references something outside the file (a url() that is not a #fragment)",
    };
  }
  const elements = (svg.match(/<[A-Za-z]/g) ?? []).length;
  if (elements > SVG_MAX_ELEMENTS)
    return { ok: false, reason: `it has more than ${SVG_MAX_ELEMENTS} elements` };
  return { ok: true };
}

/** What a rasterizer must do; the real one is resvg, tests may pass another. */
export interface SvgEngine {
  /** The SVG's own size (never rendered at it). Throws for a document the engine cannot read. */
  measure(svg: string): { width: number; height: number };
  /** One render whose LONGER edge is `longEdge` pixels. */
  render(
    svg: string,
    fit: { mode: "width" | "height"; value: number }
  ): { png: Buffer; width: number; height: number };
}

type ResvgModule = {
  Resvg: new (
    svg: string,
    options?: Record<string, unknown>
  ) => {
    width: number;
    height: number;
    render(): { width: number; height: number; asPng(): Buffer };
  };
};

let cached: Promise<SvgEngine | null> | undefined;
/** The resvg engine, or null when the component is not installed in this build. */
export function loadResvgEngine(): Promise<SvgEngine | null> {
  cached ??= (async () => {
    try {
      // a variable specifier: the component is optional and must not be bundled or resolved at build time
      const name = "@resvg/resvg-js";
      const mod = (await import(name)) as ResvgModule & { default?: ResvgModule };
      const Resvg = mod.Resvg ?? mod.default?.Resvg;
      if (!Resvg) return null;
      const options = (fit?: object) => ({
        ...(fit ? { fitTo: fit } : {}),
        // no resource directory: the renderer is given no place to read another file from
        font: { loadSystemFonts: true },
        logLevel: "off",
      });
      return {
        measure: (svg) => {
          const r = new Resvg(svg, options());
          return { width: r.width, height: r.height };
        },
        render: (svg, fit) => {
          const out = new Resvg(svg, options(fit)).render();
          return { png: out.asPng(), width: out.width, height: out.height };
        },
      } satisfies SvgEngine;
    } catch {
      return null;
    }
  })();
  return cached;
}

export type SvgRendered =
  | {
      kind: "ok";
      png: Buffer;
      width: number;
      height: number;
      sourceWidth: number;
      sourceHeight: number;
    }
  | { kind: "not_svg" }
  | { kind: "too_large" }
  | { kind: "unsafe"; reason: string }
  | { kind: "invalid"; detail: string }
  | { kind: "unavailable" };

/** Checks and renders one SVG file's bytes at a long edge of `longEdge` pixels. Nothing is written anywhere. */
export async function renderSvgFigure(
  bytes: Buffer,
  longEdge: number,
  engine?: SvgEngine | null
): Promise<SvgRendered> {
  if (bytes.length > SVG_MAX_BYTES) return { kind: "too_large" };
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  if (!/<svg[\s>]/i.test(text)) return { kind: "not_svg" };
  const safe = checkSvg(text);
  if (!safe.ok) return { kind: "unsafe", reason: safe.reason };
  const use = engine === undefined ? await loadResvgEngine() : engine;
  if (!use) return { kind: "unavailable" };
  try {
    const own = use.measure(text);
    const { width, height } = own;
    if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0))
      return { kind: "invalid", detail: "the SVG has no usable size" };
    if (Math.max(width, height) / Math.min(width, height) > SVG_MAX_ASPECT)
      return { kind: "invalid", detail: "the SVG's proportions are too extreme to draw" };
    const fit = { mode: width >= height ? "width" : "height", value: longEdge } as const;
    // checked before drawing: a renderer asked for a huge picture allocates it before anything could refuse it
    if (!(Number.isInteger(fit.value) && fit.value > 0 && fit.value <= SVG_MAX_LONG_EDGE))
      return {
        kind: "invalid",
        detail: "the picture asked for is larger than any picture given to the model",
      };
    const out = use.render(text, fit);
    // the bound is the caller's: whatever the file says, the picture is at most longEdge on its longer side
    if (Math.max(out.width, out.height) > longEdge + 1)
      return { kind: "invalid", detail: "the rendered picture is larger than asked for" };
    return { kind: "ok", ...out, sourceWidth: width, sourceHeight: height };
  } catch {
    return { kind: "invalid", detail: "the SVG could not be drawn" };
  }
}
