import { createElement, type ReactNode } from "react";
import icons from "./icons.json";

const ELEMENTS = new Set(["svg", "g", "path", "circle", "rect", "line", "polyline", "polygon"]);
const ATTRIBUTES = new Set([
  "xmlns", "viewBox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "d", "cx", "cy", "r", "x", "y", "width", "height", "x1", "x2", "y1", "y2", "points", "rx", "ry",
]);
const ATTRIBUTE_NAMES: Record<string, string> = {
  "viewBox": "viewBox", "stroke-width": "strokeWidth", "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin", "xmlns": "xmlns",
};

function validAttribute(name: string, value: string): boolean {
  if (!ATTRIBUTES.has(name)) return false;
  if (name === "xmlns") return value === "http://www.w3.org/2000/svg";
  if (name === "viewBox") return value === "0 0 24 24";
  if (name === "fill" || name === "stroke") return /^(none|currentColor|#[\da-fA-F]{3,8})$/.test(value);
  if (name === "stroke-linecap") return /^(butt|round|square)$/.test(value);
  if (name === "stroke-linejoin") return /^(arcs|bevel|miter|miter-clip|round)$/.test(value);
  if (name === "d") return /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]+$/.test(value);
  if (name === "points") return /^[0-9eE.,+\-\s]+$/.test(value);
  return /^\d+(?:\.\d+)?$/.test(value);
}

/** Parse only inert, path-based 24px icons; reject anything outside the explicit SVG subset. */
export function parseIconSvg(source: string): ReactNode | null {
  if (source.length > 4096 || /<!\s*(?:doctype|entity)/i.test(source) || /<\?xml/i.test(source)) return null;
  if (typeof DOMParser === "undefined") return null;
  let document: Document;
  try {
    document = new DOMParser().parseFromString(source, "image/svg+xml");
  } catch {
    return null;
  }
  const root = document.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg" || document.querySelector("parsererror")) return null;
  if (document.doctype) return null;

  const build = (node: Element): ReactNode | null => {
    if (node.namespaceURI !== "http://www.w3.org/2000/svg" || !ELEMENTS.has(node.localName)) return null;
    const props: Record<string, string | boolean> = {};
    for (const attribute of Array.from(node.attributes)) {
      if (!validAttribute(attribute.name, attribute.value)) return null;
      props[ATTRIBUTE_NAMES[attribute.name] ?? attribute.name] = attribute.value;
    }
    if (node.localName === "svg") {
      if (props.viewBox !== "0 0 24 24") return null;
      props.className = "ico-sm";
      props["aria-hidden"] = true;
    }
    const children: ReactNode[] = [];
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) return null;
      const converted = build(child as Element);
      if (converted === null) return null;
      children.push(converted);
    }
    return createElement(node.localName, props, ...children);
  };
  return build(root);
}

type IconEntry = string | Record<string, string>;

/** Every action is addressed by its stable data-ui; iconName selects a state variant only. */
export function getConfiguredIcon(name: string, uiId?: string): ReactNode | null {
  if (!uiId) return null;
  const entry = (icons as Record<string, IconEntry>)[uiId];
  const source = typeof entry === "string" ? entry : entry?.[name];
  return typeof source === "string" ? parseIconSvg(source) : null;
}
