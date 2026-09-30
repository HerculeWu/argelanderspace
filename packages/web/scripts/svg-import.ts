import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Window } from "happy-dom";
import { MAX_ICON_SVG_LENGTH, parseIconSvg } from "../src/ui/icon-svg.ts";

// Only this developer process installs a DOM; application parsing stays unchanged.
const window = new Window({ settings: {
  enableJavaScriptEvaluation: false, disableJavaScriptFileLoading: true,
  disableCSSFileLoading: true, enableImageFileLoading: false,
  navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true },
} });
Object.assign(globalThis, { DOMParser: window.DOMParser, Node: window.Node });
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const attribution = {
  author: "Dazzle UI", family: "Dazzle Line Icons",
  source: "https://www.svgrepo.com/collection/dazzle-line-icons",
  license: "CC Attribution License (CC BY; version unspecified)",
  licenseReference: "https://www.svgrepo.com/page/licensing/", evidence: "user-confirmed",
};
type Confirmation = { pack: string; evidence: string; files: Record<string, string> };
const safeFile = (file: string) => !!file && !file.includes("\\") && !file.startsWith("/") && file.split("/").every(part => !!part && part !== "." && part !== "..") && file.endsWith(".svg");
function realDirectoryTree(directory: string) {
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error("destination must be a real directory");
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) realDirectoryTree(join(directory, entry.name));
    else if (!entry.isFile()) throw new Error("destination contains a symlink or unsupported filesystem entry");
  }
}
type FileResult = {
  file: string; originalHash: string; normalizedHash?: string; attributionReady: boolean;
  kind?: "stroke" | "fill-only"; status: string; reason?: string; eligible: boolean;
  modifications: string[];
};
function inside(path: string, directory: string) {
  const rel = relative(directory, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(canonical(dirname(path)), basename(path));
}

// Happy DOM intentionally repairs malformed XML. Check only XML well-formedness here;
// SVG elements, attributes, paints and geometry remain the runtime parser's authority.
function wellFormed(source: string) {
  const stack: string[] = [];
  let roots = 0;
  let consumed = 0;
  for (const match of source.matchAll(/<!--[\s\S]*?-->|<[^>]*>/g)) {
    if (source.slice(consumed, match.index).trim()) return false;
    consumed = (match.index ?? 0) + match[0].length;
    if (match[0].startsWith("<!--")) {
      const body = match[0].slice(4, -3);
      if (body.includes("--") || body.endsWith("-")) return false;
      continue;
    }
    const tag = /^<(\/?)([A-Za-z][\w:-]*)([\s\S]*?)(\/?)>$/.exec(match[0]);
    if (!tag) return false;
    const [, close, name, attributes, selfClose] = tag;
    if (close) {
      if (attributes.trim() || selfClose || stack.pop() !== name) return false;
    } else {
      let rest = attributes;
      const names = new Set<string>();
      while (rest.trim()) {
        const attribute = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*("[^"<>]*"|'[^'<>]*')/.exec(rest);
        if (!attribute || names.has(attribute[1])) return false;
        names.add(attribute[1]);
        rest = rest.slice(attribute[0].length);
      }
      if (!stack.length) roots++;
      if (!selfClose) stack.push(name);
    }
  }
  return consumed > 0 && !source.slice(consumed).trim() && stack.length === 0 && roots === 1;
}
function normalize(original: string): { status: string; reason?: string; kind?: "stroke" | "fill-only"; svg?: string; modifications: string[] } {
  const modifications: string[] = [];
  let kind: "stroke" | "fill-only" | undefined;
  const reject = (status: string, reason: string) => ({ status, reason, kind, modifications });
  let source = original.trim();
  if (/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/.test(source)) {
    source = source.replace(/^<\?xml[\s\S]*?\?>/, "");
    modifications.push("removed XML declaration");
  }
  const activeInput = source.replace(/<!--[\s\S]*?-->/g, "");
  if (/<!\s*(?:doctype|entity)/i.test(activeInput) || /&/.test(activeInput)) return reject("unsafe", "DTD/entities are forbidden");
  if (/<\s*(?:script|foreignObject|style)\b/i.test(activeInput)) return reject("unsafe", "executable content is forbidden");
  // Validate before removing comments: comment-looking text inside an attribute
  // is malformed XML, not an inert node that may be erased to repair geometry.
  if (!wellFormed(source)) return reject("malformed", "malformed XML");
  if (/<!--[\s\S]*?-->/.test(source)) {
    if ([...source.matchAll(/<!--([\s\S]*?)-->/g)].some(comment => comment[1].includes("--") || comment[1].endsWith("-"))) return reject("malformed", "malformed XML comment");
    source = source.replace(/<!--[\s\S]*?-->/g, "");
    modifications.push("removed comments");
  }
  // Only well-formed inert nodes were removed; active content was rejected above.
  const doc = new window.DOMParser().parseFromString(source, "image/svg+xml");
  const root = doc.documentElement;
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  kind = elements.some(element => element.hasAttribute("stroke") && element.getAttribute("stroke") !== "none") ? "stroke" : "fill-only";
  if (elements.some(e => /^(script|foreignObject|style)$/i.test(e.localName) || Array.from(e.attributes).some(a => /^on/i.test(a.name) || /^(style|.*href)$/i.test(a.name) || /url\s*\(/i.test(a.value ?? "")))) return reject("unsafe", "active, styled or referenced content is forbidden");
  if (root.getAttribute("viewBox") !== "0 0 24 24") return reject("coordinate-frame", "requires viewBox 0 0 24 24");
  for (const name of ["width", "height"]) {
    const value = root.getAttribute(name);
    if (value !== null && !/^\d+(?:\.\d+)?(?:px)?$/.test(value)) return reject("unsupported", "unsupported download dimensions");
  }
  if (root.hasAttribute("width") || root.hasAttribute("height")) {
    root.removeAttribute("width"); root.removeAttribute("height");
    modifications.push("removed root download dimensions");
  }
  const paints = new Set<string>();
  let hasStroke = false;
  let changedPaint = false;
  let removedWidths = false;
  for (const element of elements) {
    for (const name of ["stroke", "fill"]) {
      const paint = element.getAttribute(name);
      if (!paint || paint === "none") continue;
      if (name === "stroke") hasStroke = true;
      if (paint !== "currentColor") {
        if (!/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(paint)) return reject("unsupported", "only opaque monochrome paint is normalizable");
        paints.add(paint.length === 4 ? paint.slice(1).split("").map(c => c + c).join("").toLowerCase() : paint.slice(1).toLowerCase());
        element.setAttribute(name, "currentColor");
        changedPaint = true;
      }
    }
    const width = element.getAttribute("stroke-width");
    if (width !== null) {
      if (!/^\d+(?:\.\d+)?$/.test(width) || Number(width) <= 0) return reject("unsupported", "unsupported or zero stroke width");
      element.removeAttribute("stroke-width"); removedWidths = true;
    }
  }
  if (paints.size > 1) return reject("unsupported", "multiple paint colors require explicit visual review");
  if (changedPaint) modifications.push("monochrome paint to currentColor");
  // SVG's default fill is black; make that default theme-aware without creating a stroke.
  if (!root.hasAttribute("fill")) { root.setAttribute("fill", "currentColor"); modifications.push("default fill to currentColor"); }
  if (removedWidths) modifications.push("removed explicit stroke widths (preset-owned)");
  if (hasStroke) {
    for (const name of ["stroke-linecap", "stroke-linejoin"]) {
      // Do not silently replace a deliberately non-round choice.
      if (elements.some(e => e.hasAttribute(name) && e.getAttribute(name) !== "round")) return reject("unsupported", "non-round stroke caps/joins require explicit visual review");
      if (!root.hasAttribute(name)) { root.setAttribute(name, "round"); modifications.push(`root ${name} round`); }
    }
  }
  const svg = root.outerHTML;
  if (svg.length > MAX_ICON_SVG_LENGTH) return { ...reject("oversize", `normalized SVG exceeds runtime ${MAX_ICON_SVG_LENGTH}-character limit`), kind };
  if (parseIconSvg(svg) === null) return reject("unsupported", "rejected by restricted runtime SVG parser");
  return { status: "safe", kind, svg, modifications };
}
type Selection = { file: string; uiId: string; variant?: string };
type Adopted = { set: string; file: string; originalHash: string; normalizedHash: string; modifications: string[] };
type Provenance = { version: number; sets: Record<string, unknown>; icons: Record<string, Adopted | Record<string, Adopted>> };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function readJson(path: string, fallback: unknown): unknown { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback; }
function validateProvenance(provenance: Provenance, icons: Record<string, string | Record<string, string>>) {
  for (const [uiId, entry] of Object.entries(provenance.icons)) {
    if (!isRecord(entry)) throw new Error("invalid provenance entry");
    const records = "set" in entry ? [[undefined, entry]] as const : Object.entries(entry);
    for (const [variant, record] of records) {
      if (!isRecord(record) || typeof record.set !== "string" || !isRecord(provenance.sets[record.set]) || typeof record.file !== "string" || !safeFile(record.file) || typeof record.originalHash !== "string" || !/^[a-f0-9]{64}$/.test(record.originalHash) || typeof record.normalizedHash !== "string" || !/^[a-f0-9]{64}$/.test(record.normalizedHash) || !Array.isArray(record.modifications) || record.modifications.some(value => typeof value !== "string")) throw new Error("invalid provenance record");
      const resource = variant === undefined ? icons[uiId] : isRecord(icons[uiId]) ? icons[uiId][variant] : undefined;
      if (typeof resource !== "string" || sha256(resource) !== record.normalizedHash) throw new Error("catalog/provenance hash mismatch");
    }
  }
}
function makeNotice(previous: string, provenance: Provenance) {
  const begin = "<!-- svg-import:dazzle-line-icons:begin -->";
  const end = "<!-- svg-import:dazzle-line-icons:end -->";
  const adopted = Object.entries(provenance.icons).flatMap(([uiId, value]) => "set" in value ? [{ uiId, record: value as Adopted }] : Object.entries(value).map(([variant, record]) => ({ uiId: `${uiId}/${variant}`, record })));
  const relevant = adopted.filter(item => item.record.set === "dazzle-line-icons").sort((a, b) => a.uiId.localeCompare(b.uiId));
  const assets = [...new Set(relevant.map(item => item.record.file))].sort();
  const modifications = [...new Set(relevant.flatMap(item => item.record.modifications))].sort();
  const block = `${begin}\n## Dazzle Line Icons — Dazzle UI\n\nAuthor: ${attribution.author}. Source: ${attribution.source}\n\nLicense: ${attribution.license}. License reference: ${attribution.licenseReference}\nPermission evidence: user-confirmed for the hash-bound source pack; not independently verified by this tool. No author endorsement is implied.\n\nAdopted assets: ${assets.map(asset => JSON.stringify(asset)).join(", ")}.\nMappings: ${relevant.map(item => item.uiId).join(", ")}.\nModifications: ${modifications.join("; ")}; geometry unchanged; 24×24 viewBox preserved.\nFull hashes and per-action modifications: icons.provenance.json.\n${end}`;
  const start = previous.indexOf(begin); const stop = previous.indexOf(end);
  if ((start < 0) !== (stop < 0) || (start >= 0 && stop < start) || (start >= 0 && (previous.indexOf(begin, start + 1) >= 0 || previous.indexOf(end, stop + 1) >= 0))) throw new Error("invalid existing notice markers");
  return start >= 0 ? previous.slice(0, start) + block + previous.slice(stop + end.length) : previous + (previous.endsWith("\n") ? "\n" : "\n\n") + block + "\n";
}
// Publish a complete resource directory, never three independently visible file writes.
// On a caught rename failure restore the old directory. A crash leaves the named
// backup intact; refuse the next run rather than silently discarding recovery data.
function publish(destination: string, preserve: boolean, write: (stage: string) => void) {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const backup = join(parent, `.${basename(destination)}.svg-import-backup`);
  if (existsSync(backup)) throw new Error("publication backup exists; explicit recovery is required");
  if (existsSync(destination) && (!lstatSync(destination).isDirectory() || lstatSync(destination).isSymbolicLink())) throw new Error("destination must be a real directory");
  const stage = mkdtempSync(join(parent, `.${basename(destination)}.svg-import-stage-`));
  let moved = false;
  try {
    if (preserve && existsSync(destination)) { realDirectoryTree(destination); cpSync(destination, stage, { recursive: true }); }
    write(stage);
    if (existsSync(destination)) { renameSync(destination, backup); moved = true; }
    try { renameSync(stage, destination); }
    catch (error) {
      if (moved) { renameSync(backup, destination); moved = false; }
      throw error;
    }
    if (moved) rmSync(backup, { recursive: true });
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
function main(args: string[]) {
  const operation = args[0] && !args[0].startsWith("--") ? args.shift() : "audit";
  if (!["audit", "normalize", "promote"].includes(operation ?? "")) throw new Error("unsupported operation");
  const options: Record<string, string> = {};
  while (args.length) {
    const key = args.shift(); const value = args.shift();
    if (!key || !["--source", "--confirmation", "--destination", "--selection"].includes(key) || !value || value.startsWith("--") || options[key]) throw new Error("invalid command arguments");
    options[key] = value;
  }
  if (!options["--source"]) throw new Error("--source is required");
  const source = realpathSync(resolve(options["--source"]));
  const requestedDestination = options["--destination"] ? resolve(options["--destination"]) : undefined;
  if (operation !== "audit" && requestedDestination && existsSync(requestedDestination)) realDirectoryTree(requestedDestination);
  const destination = requestedDestination ? canonical(requestedDestination) : undefined;
  if (operation !== "audit" && !destination) throw new Error("--destination is required for mutation");
  if (operation === "promote" && !options["--selection"]) throw new Error("--selection is required for promote");
  if (destination && operation !== "audit" && (inside(source, destination) || inside(destination, source))) throw new Error("destination must be separate from source (including symlink aliases)");
  let confirmation: Confirmation | undefined;
  if (options["--confirmation"]) {
    confirmation = JSON.parse(readFileSync(options["--confirmation"], "utf8"));
    if (confirmation?.pack !== "dazzle-line-icons" || confirmation.evidence !== "user-confirmed" || !isRecord(confirmation.files) || Object.entries(confirmation.files).some(([file, hash]) => !safeFile(file) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new Error("invalid confirmed-pack record");
  }
  const files: FileResult[] = [];
  const copies = new Map<string, string>();
  let ignoredMetadata = 0;
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.name.startsWith("._")) { ignoredMetadata++; continue; }
      if (destination && inside(path, destination)) continue;
      if (entry.isDirectory()) { scan(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".svg")) continue;
      const file = relative(source, path).split(sep).join("/");
      const bytes = readFileSync(path);
      const originalHash = sha256(bytes);
      const attributionReady = confirmation?.files[file] === originalHash;
      let original: string | undefined;
      try { original = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {}
      const result = original === undefined ? { status: "malformed", reason: "SVG must be UTF-8", modifications: [], svg: undefined } : normalize(original);
      const { svg, ...details } = result;
      files.push({ file, originalHash, attributionReady, eligible: result.status === "safe" && attributionReady, ...details, ...(svg ? { normalizedHash: sha256(svg) } : {}) });
      if (svg) copies.set(file, svg);
    }
  };
  scan(source);
  const count = (status: string) => files.filter(f => f.status === status).length;
  const report = { operation, attribution: { ...attribution, evidence: confirmation ? "user-confirmed" : "not-provided" }, counts: {
    total: files.length, stroke: files.filter(f => f.kind === "stroke").length,
    fillOnly: files.filter(f => f.kind === "fill-only").length,
    unsafe: count("unsafe"), unsupported: count("unsupported"), malformed: count("malformed"),
    coordinateFrame: count("coordinate-frame"), oversize: count("oversize"),
    eligible: files.filter(f => f.eligible).length, attributionMissing: files.filter(f => !f.attributionReady).length, ignoredMetadata,
  }, files };
  if (operation === "normalize" && destination) {
    publish(destination, false, stage => {
      for (const [file, svg] of copies) { const path = join(stage, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, svg); }
      writeFileSync(join(stage, "report.json"), json(report));
    });
  }
  if (operation === "promote" && destination) {
    const selected = JSON.parse(readFileSync(options["--selection"], "utf8"));
    if (!Array.isArray(selected) || selected.length === 0) throw new Error("selection must be a non-empty array");
    if (existsSync(destination)) realDirectoryTree(destination);
    const icons = readJson(join(destination, "icons.json"), {}) as Record<string, string | Record<string, string>>;
    const provenance = readJson(join(destination, "icons.provenance.json"), { version: 1, sets: {}, icons: {} }) as Provenance;
    if (provenance.version !== 1 || !isRecord(provenance.sets) || !isRecord(provenance.icons)) throw new Error("invalid provenance document");
    if (!isRecord(icons) || Object.values(icons).some(entry => typeof entry !== "string" && (!isRecord(entry) || Object.values(entry).some(value => typeof value !== "string")))) throw new Error("invalid icon catalog");
    const seen = new Set<string>();
    for (const selection of selected) {
      if (!isRecord(selection) || typeof selection.file !== "string" || !safeFile(selection.file) || typeof selection.uiId !== "string" || !/^[a-z][a-z0-9-]+$/.test(selection.uiId) || (selection.variant !== undefined && (typeof selection.variant !== "string" || !/^[a-z][a-z0-9-]*$/.test(selection.variant)))) throw new Error("invalid selection mapping");
      const { file, uiId, variant } = selection as Selection;
      const key = `${uiId}/${variant ?? ""}`;
      if (seen.has(key) || [...seen].some(other => other.startsWith(`${uiId}/`) && (!variant || other === `${uiId}/`))) throw new Error("duplicate or conflicting selection mapping");
      seen.add(key);
      const result = files.find(f => f.file === file);
      if (!result?.eligible) throw new Error(`selected resource is ineligible: ${JSON.stringify(file)}`);
      const svg = copies.get(file);
      if (!svg || parseIconSvg(svg) === null) throw new Error("selected resource failed runtime parser");
      const record: Adopted = { set: "dazzle-line-icons", file, originalHash: result.originalHash, normalizedHash: sha256(svg), modifications: result.modifications };
      if (variant) {
        if (typeof icons[uiId] === "string") throw new Error("variant selection would replace an existing single-icon entry");
        icons[uiId] = { ...icons[uiId], [variant]: svg };
        const previous = provenance.icons[uiId];
        if (previous && "set" in previous) throw new Error("variant selection conflicts with existing provenance");
        provenance.icons[uiId] = { ...previous, [variant]: record };
      } else {
        if (isRecord(icons[uiId])) throw new Error("single-icon selection would replace existing variants");
        icons[uiId] = svg; provenance.icons[uiId] = record;
      }
    }
    provenance.sets["dazzle-line-icons"] = { ...attribution, notice: "THIRD_PARTY_LICENSES.md" };
    validateProvenance(provenance, icons);
    const noticePath = join(destination, "THIRD_PARTY_LICENSES.md");
    const previousNotice = existsSync(noticePath) ? readFileSync(noticePath, "utf8") : "# Third-party licenses\n";
    const notice = makeNotice(previousNotice, provenance);
    publish(destination, true, stage => {
      writeFileSync(join(stage, "icons.json"), json(icons));
      writeFileSync(join(stage, "icons.provenance.json"), json(provenance));
      writeFileSync(join(stage, "THIRD_PARTY_LICENSES.md"), notice);
    });
    return { ...report, publication: { selectedCount: selected.length, mappings: selected, artifacts: ["icons.json", "icons.provenance.json", "THIRD_PARTY_LICENSES.md"] } };
  }
  return report;
}
try {
  console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
} catch (error) {
  // Filesystem errors contain local absolute paths; only expose their stable code.
  const message = error instanceof Error && "code" in error ? `filesystem error: ${String(error.code)}` : error instanceof Error && !(error instanceof SyntaxError) ? error.message : "invalid JSON input";
  console.error(`svg-import: ${message}`);
  process.exitCode = 1;
}
