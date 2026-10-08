/**
 * Showing untrusted mail HTML (Mail ticket 05; spec Q13, ADR 0008).
 *
 * Layers, each enough to stop the usual attacks by itself:
 *  1. DOMPurify (HTML profile only: no SVG/MathML) with scripts, forms, frames, objects,
 *     meta/link/base and every event handler removed;
 *  2. remote resources (img src/srcset/background, CSS url(), @import) are removed unless
 *     the user loaded remote content for this one message; `cid:` images resolve to the
 *     message's own attachments, `data:` images stay;
 *  3. links open in a new, unrelated tab (target=_blank + noopener) so the frame itself can
 *     never navigate;
 *  4. the result goes into an iframe `srcdoc` with a restrictive Content-Security-Policy and a
 *     sandbox without scripts, forms, same-origin or top navigation (see `MAIL_FRAME_SANDBOX`).
 * The sanitiser reports whether it found remote content so the UI can say so truthfully.
 */

import createDOMPurify from "dompurify";

/** Sandbox flags of the display iframe: popups only, for opening links in a separate tab. */
export const MAIL_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

export interface SanitizeOptions {
  /** The user loaded remote content for this message. */
  loadRemote: boolean;
  /** Absolute URL for a `cid:` image, or null when the message has no such attachment. */
  resolveCid: (cid: string) => string | null;
}
export interface SanitizedMail {
  /** Body markup, safe to put inside the srcdoc template. */
  html: string;
  /** The original referenced remote resources (whether or not they were kept). */
  hadRemote: boolean;
}

const FORBID_TAGS = [
  "script", "noscript", "template", "form", "input", "button", "select", "textarea", "option",
  "optgroup", "fieldset", "legend", "label", "base", "meta", "link", "iframe", "frame",
  "frameset", "object", "embed", "applet", "audio", "video", "source", "track", "picture",
  "map", "area", "dialog", "slot", "canvas", "portal", "title", "head",
];
const FORBID_ATTR = [
  "srcdoc", "formaction", "action", "method", "ping", "autofocus", "form", "id", "name",
  "contenteditable", "draggable", "accesskey", "tabindex", "is", "slot",
];

type Ctx = { loadRemote: boolean; resolveCid: (cid: string) => string | null; hadRemote: boolean };
let ctx: Ctx = { loadRemote: false, resolveCid: () => null, hadRemote: false };

const SAFE_DATA_IMAGE = /^\s*data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]*$/i;

/** Decide what an image-like URL becomes: kept as is, resolved, or dropped (null). */
function imageUrl(raw: string): string | null {
  const url = raw.trim();
  if (SAFE_DATA_IMAGE.test(url)) return url;
  if (/^cid:/i.test(url)) return ctx.resolveCid(url.slice(4).replace(/^<|>$/g, "").trim());
  if (/^(https?:)?\/\//i.test(url)) {
    // Absolute or protocol-relative web URL: remote content, loaded only on request.
    ctx.hadRemote = true;
    if (!ctx.loadRemote) return null;
    return /^https?:\/\//i.test(url) ? url : `https:${url}`;
  }
  return null; // relative paths (would hit the app origin), javascript:, file:, blob:, ...
}

function scrubCss(input: string): string {
  let css = input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\\/g, "");
  css = css.replace(/@import[^;{]*;?/gi, ""); // never loaded, so it is not "remote content" the user could allow
  css = css.replace(/(?:-moz-binding|behavior)\s*:[^;}]*/gi, "");
  css = css.replace(/expression\s*\([^)]*\)/gi, "");
  // Functions that fetch without being written url(): never allowed.
  css = css.replace(/\b(?:image-set|image|src|cross-fade|element)\s*\([^)]*\)/gi, "none");
  // Any other function carrying a web URL (e.g. what an escaped "url(" turns into): never a legitimate use.
  css = css.replace(/\b(?!url\b)[a-z0-9-]+\(\s*['"]?(?:https?:)?\/\/[^)]*\)/gi, "none");
  css = css.replace(/url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi, (_m, _q, u: string) => {
    const kept = imageUrl(u);
    return kept ? `url("${kept.replace(/["\\\n\r]/g, "")}")` : 'url("")';
  });
  return css;
}

let purify: ReturnType<typeof createDOMPurify> | null = null;
function instance() {
  if (purify) return purify;
  const p = createDOMPurify(window);
  p.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style") node.textContent = scrubCss(node.textContent ?? "");
  });
  p.addHook("uponSanitizeAttribute", (node, data) => {
    const name = data.attrName;
    const tag = node.nodeName.toLowerCase();
    if (name === "style") {
      data.attrValue = scrubCss(data.attrValue);
      return;
    }
    if (name === "srcset") {
      data.keepAttr = false; // never loaded (even on request); the plain src fallback is enough
      return;
    }
    if (name === "src" || name === "background" || name === "poster") {
      if (tag !== "img" && name === "src") {
        data.keepAttr = false;
        return;
      }
      const kept = imageUrl(data.attrValue);
      if (kept === null) {
        data.keepAttr = false;
        if (tag === "img") (node as Element).setAttribute("data-blocked", "");
      } else data.attrValue = kept;
      return;
    }
    if (name === "href") {
      if (tag !== "a" || !/^\s*(https?:|mailto:|tel:)/i.test(data.attrValue)) data.keepAttr = false;
      return;
    }
    if (name === "target" || name === "rel") data.keepAttr = false; // set by us below
  });
  p.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName.toLowerCase() === "a") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
  purify = p;
  return p;
}

export function sanitizeMailHtml(dirty: string, options: SanitizeOptions): SanitizedMail {
  ctx = { loadRemote: options.loadRemote, resolveCid: options.resolveCid, hadRemote: false };
  // Without a real DOM DOMPurify returns its input untouched: show nothing rather than raw mail HTML.
  if (!instance().isSupported) return { html: "", hadRemote: false };
  const html = instance().sanitize(dirty, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORCE_BODY: true,
    SANITIZE_DOM: true,
    SANITIZE_NAMED_PROPS: true,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  }) as string;
  return { html, hadRemote: ctx.hadRemote };
}

export function mailFrameCsp(loadRemote: boolean, origin: string): string {
  const img = ["data:", origin, ...(loadRemote ? ["https:", "http:"] : [])].join(" ");
  return `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
}

/** The complete document for the display iframe's `srcdoc`. */
export function buildMailSrcDoc(body: string, loadRemote: boolean, origin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${mailFrameCsp(loadRemote, origin)}"><style>
:root{color-scheme:light}
body{margin:0;padding:20px;background:#fff;color:#1f2328;font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
img[data-blocked]{display:inline-block;min-width:32px;min-height:20px;background:#eef1f4;outline:1px dashed #c4cbd2;outline-offset:-1px}
table{max-width:100%}
a{color:#0b5cad}
</style></head><body>${body}</body></html>`;
}
