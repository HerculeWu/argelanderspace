// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const commandPath = fileURLToPath(new URL("../scripts/svg-import.ts", import.meta.url));
const temps: string[] = [];
const stroke = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M5 12H19" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "svg-import-test-"));
  temps.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(source, name), content);
  const confirmation = join(root, "confirmation.json");
  writeFileSync(confirmation, JSON.stringify({ pack: "dazzle-line-icons", evidence: "user-confirmed", files: Object.fromEntries(Object.entries(files).filter(([name]) => name.endsWith(".svg") && !name.startsWith("._")).map(([name, content]) => [name, hash(content)])) }));
  return { root, source, confirmation };
}
function run(...args: string[]) {
  const result = spawnSync(process.execPath, [commandPath, ...args], { encoding: "utf8", timeout: 20000 });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, report: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

it("defaults to a read-only audit with confirmed pack membership and ignores AppleDouble files", () => {
  const f = fixture({ "arrow.svg": stroke, "._arrow.svg": "metadata" });
  const result = run("--source", f.source, "--confirmation", f.confirmation);
  expect(result.status, result.stderr).toBe(0);
  expect(result.report.operation).toBe("audit");
  expect(result.report.counts).toMatchObject({ total: 1, stroke: 1, eligible: 1, ignoredMetadata: 1 });
  expect(result.report.files[0]).toMatchObject({ file: "arrow.svg", originalHash: hash(stroke), attributionReady: true });
  expect(readFileSync(join(f.source, "arrow.svg"), "utf8")).toBe(stroke);
  expect(readdirSync(f.root).sort()).toEqual(["confirmation.json", "source"]);
  expect(result.stdout).not.toContain(f.root);
});

it("audits a mixed pack before conversion and normalizes safe copies without changing geometry or fill-only artwork", () => {
  const downloaded = '<?xml version="1.0" encoding="utf-8" standalone="yes"?><!-- harmless download: <script>& is inert here -->\n' + stroke.replace('<svg ', '<svg width="800px" height="800px" ');
  const fill = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" d="M1 1L5 1L5 5Z"/></svg>';
  const f = fixture({
    "arrow.svg": downloaded, "fill.svg": fill, "._arrow.svg": "metadata",
    "event.svg": stroke.replace('d="', 'onload="alert(1)" d="'),
    "style.svg": stroke.replace('d="', 'style="stroke:red" d="'),
    "entity.svg": '<!DOCTYPE svg [<!ENTITY x "M2 2">]>' + stroke,
    "href.svg": stroke.replace('d="', 'href="https://bad.test/x" d="'),
    "script.svg": stroke.replace('</svg>', '<script>alert(1)</script></svg>'),
    "unsupported.svg": stroke.replace('<path ', '<text '),
    "frame.svg": stroke.replace('0 0 24 24', '0 0 32 32'),
    "malformed.svg": '<svg><path',
    "oversize.svg": stroke.replace('M5 12H19', 'M1 1' + 'L2 2'.repeat(1100)),
  });
  const destination = join(f.root, "normalized");
  const result = run("normalize", "--source", f.source, "--confirmation", f.confirmation, "--destination", destination);
  expect(result.status, result.stderr).toBe(0);
  expect(result.report.counts).toMatchObject({ total: 11, stroke: 7, fillOnly: 1, unsafe: 5, unsupported: 1, coordinateFrame: 1, malformed: 1, oversize: 1, eligible: 2 });
  expect(readdirSync(destination).sort()).toEqual(["arrow.svg", "fill.svg", "report.json"]);
  const normalized = readFileSync(join(destination, "arrow.svg"), "utf8");
  expect(normalized).toContain('viewBox="0 0 24 24"');
  expect(normalized).toContain('d="M5 12H19"');
  expect(normalized).toContain('stroke="currentColor"');
  expect(normalized).not.toContain('stroke-width');
  expect(normalized).not.toContain('800');
  const normalizedFill = readFileSync(join(destination, "fill.svg"), "utf8");
  expect(normalizedFill).toContain('fill="currentColor"');
  expect(normalizedFill).not.toContain('stroke=');
  expect(result.report.files.find((file: { file: string }) => file.file === "arrow.svg")).toMatchObject({ originalHash: hash(downloaded), normalizedHash: hash(normalized), modifications: expect.arrayContaining(["removed XML declaration", "removed comments", "removed root download dimensions", "monochrome paint to currentColor", "removed explicit stroke widths (preset-owned)"]) });
  expect(readFileSync(join(f.source, "arrow.svg"), "utf8")).toBe(downloaded);
  expect(readFileSync(join(f.source, "fill.svg"), "utf8")).toBe(fill);
});

it("promotes explicit data-ui variants with traceable provenance and one set-level notice while preserving unrelated resources", () => {
  const f = fixture({ "arrow.svg": stroke, "unsafe.svg": stroke.replace('d="', 'onload="alert(1)" d="') });
  const destination = join(f.root, "published");
  mkdirSync(destination);
  writeFileSync(join(destination, "icons.json"), JSON.stringify({ untouched: stroke, "navigate-view": { library: stroke } }));
  writeFileSync(join(destination, "THIRD_PARTY_LICENSES.md"), "# Third-party notices\n\nExisting MIT notice must remain.\n");
  const selection = join(f.root, "selection.json");
  writeFileSync(selection, JSON.stringify([{ file: "arrow.svg", uiId: "close-pane" }, { file: "arrow.svg", uiId: "navigate-view", variant: "doc" }]));
  const result = run("promote", "--source", f.source, "--confirmation", f.confirmation, "--destination", destination, "--selection", selection);
  expect(result.status, result.stderr).toBe(0);
  expect(result.report.publication).toMatchObject({ selectedCount: 2, artifacts: ["icons.json", "icons.provenance.json", "THIRD_PARTY_LICENSES.md"] });
  const icons = JSON.parse(readFileSync(join(destination, "icons.json"), "utf8"));
  expect(icons.untouched).toBe(stroke);
  expect(icons["navigate-view"].library).toBe(stroke);
  expect(icons["close-pane"]).toBe(icons["navigate-view"].doc);
  const provenance = JSON.parse(readFileSync(join(destination, "icons.provenance.json"), "utf8"));
  expect(provenance.icons["close-pane"]).toMatchObject({ file: "arrow.svg", originalHash: hash(stroke), normalizedHash: hash(icons["close-pane"]), set: "dazzle-line-icons", modifications: expect.arrayContaining(["monochrome paint to currentColor", "removed explicit stroke widths (preset-owned)"]) });
  expect(provenance.icons["navigate-view"].doc.file).toBe("arrow.svg");
  expect(provenance.sets["dazzle-line-icons"]).toMatchObject({ author: "Dazzle UI", evidence: "user-confirmed", notice: "THIRD_PARTY_LICENSES.md" });
  const notice = readFileSync(join(destination, "THIRD_PARTY_LICENSES.md"), "utf8");
  expect(notice).toContain("Existing MIT notice must remain.");
  expect(notice).toContain("Dazzle UI");
  expect(notice).toContain("https://www.svgrepo.com/collection/dazzle-line-icons");
  expect(notice).toContain("https://www.svgrepo.com/page/licensing/");
  expect(notice).toContain("version unspecified");
  expect(notice).toContain("arrow.svg");
  expect(notice).toContain("monochrome paint to currentColor");
  expect(notice).toContain("geometry unchanged");
  expect(notice).not.toContain("4.0");
  expect(notice).not.toContain("unsafe.svg");
  expect(result.stdout).not.toContain(f.root);
});

it("fails a whole selection without publishing partial catalog, provenance or notice, then repeats a successful publication byte-for-byte", () => {
  const f = fixture({ "arrow.svg": stroke, "bad.svg": stroke.replace('d="', 'style="fill:red" d="') });
  const destination = join(f.root, "published");
  mkdirSync(destination);
  writeFileSync(join(destination, "icons.json"), JSON.stringify({ untouched: stroke }));
  writeFileSync(join(destination, "icons.provenance.json"), '{"version":1,"sets":{},"icons":{}}\n');
  writeFileSync(join(destination, "THIRD_PARTY_LICENSES.md"), "Existing notice\n");
  const snapshot = () => Object.fromEntries(readdirSync(destination).map(name => [name, readFileSync(join(destination, name), "utf8")]));
  const before = snapshot();
  const selection = join(f.root, "selection.json");
  const args = ["promote", "--source", f.source, "--confirmation", f.confirmation, "--destination", destination, "--selection", selection];
  writeFileSync(selection, JSON.stringify([{ file: "arrow.svg", uiId: "close-pane" }, { file: "bad.svg", uiId: "delete-item" }]));
  expect(run(...args).status).toBe(1);
  expect(snapshot()).toEqual(before);
  expect(readdirSync(f.root).some(name => name.includes("svg-import"))).toBe(false);
  writeFileSync(selection, JSON.stringify([{ file: "arrow.svg", uiId: "close-pane" }]));
  expect(run(...args).status).toBe(0);
  const after = snapshot();
  expect(run(...args).status).toBe(0);
  expect(snapshot()).toEqual(after);
  // The old confirmation cannot grant permission to a changed or future input.
  writeFileSync(join(f.source, "arrow.svg"), stroke.replace("M5 12H19", "M2 2H20"));
  expect(run(...args).status).toBe(1);
  expect(snapshot()).toEqual(after);
  writeFileSync(join(f.source, "future.svg"), stroke);
  writeFileSync(selection, JSON.stringify([{ file: "future.svg", uiId: "new-action" }]));
  expect(run(...args).status).toBe(1);
  expect(snapshot()).toEqual(after);
});

it("refuses destinations that alias the source and preserves every source byte on refusal", () => {
  const f = fixture({ "arrow.svg": stroke });
  const alias = join(f.root, "alias");
  symlinkSync(f.source, alias, "dir");
  for (const destination of [f.source, f.root, alias, join(alias, "nested-output")]) {
    const result = run("normalize", "--source", f.source, "--destination", destination);
    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(join(f.source, "arrow.svg"), "utf8")).toBe(stroke);
  }
  expect(readdirSync(f.source)).toEqual(["arrow.svg"]);
});

it("rejects output symlinks and malformed mapping/notice metadata before touching published artifacts", () => {
  const f = fixture({ "arrow.svg": stroke });
  const destination = join(f.root, "published");
  mkdirSync(destination);
  writeFileSync(join(destination, "icons.json"), JSON.stringify({ untouched: stroke }));
  const outside = join(f.root, "outside-notice.md");
  writeFileSync(outside, "Keep this external file unchanged\n");
  symlinkSync(outside, join(destination, "THIRD_PARTY_LICENSES.md"));
  const selection = join(f.root, "selection.json");
  writeFileSync(selection, JSON.stringify([{ file: "arrow.svg", uiId: "close-pane" }]));
  const args = ["promote", "--source", f.source, "--confirmation", f.confirmation, "--destination", destination, "--selection", selection];
  expect(run(...args).status).toBe(1);
  expect(readFileSync(outside, "utf8")).toBe("Keep this external file unchanged\n");
  expect(readdirSync(destination).sort()).toEqual(["THIRD_PARTY_LICENSES.md", "icons.json"]);
  rmSync(join(destination, "THIRD_PARTY_LICENSES.md"));
  writeFileSync(join(destination, "THIRD_PARTY_LICENSES.md"), "<!-- svg-import:dazzle-line-icons:begin -->\nBroken notice\n");
  expect(run(...args).status).toBe(1);
  expect(readFileSync(join(destination, "icons.json"), "utf8")).toBe(JSON.stringify({ untouched: stroke }));
  for (const mapping of [[], [{ file: "../outside.svg", uiId: "close-pane" }], [{ file: "arrow.svg", uiId: "close-pane" }, { file: "arrow.svg", uiId: "close-pane" }]]) {
    writeFileSync(selection, JSON.stringify(mapping));
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(f.root);
  }
});

it("does not grant unknown inputs attribution and rejects over-limit, unsupported or missing-namespace selections", () => {
  const f = fixture({
    "arrow.svg": stroke,
    "oversize.svg": stroke.replace("M5 12H19", "M1 1" + "L2 2".repeat(1100)),
    "transform.svg": stroke.replace('<path ', '<path transform="translate(1 1)" '),
    "namespace.svg": stroke.replace('xmlns="http://www.w3.org/2000/svg" ', ''),
  });
  const audit = run("--source", f.source);
  expect(audit.status).toBe(0);
  expect(audit.report.counts.attributionMissing).toBe(4);
  expect(audit.report.counts.eligible).toBe(0);
  expect(audit.report.attribution.evidence).toBe("not-provided");
  const destination = join(f.root, "published");
  const selection = join(f.root, "selection.json");
  for (const file of ["oversize.svg", "transform.svg", "namespace.svg"]) {
    writeFileSync(selection, JSON.stringify([{ file, uiId: "close-pane" }]));
    expect(run("promote", "--source", f.source, "--confirmation", f.confirmation, "--destination", destination, "--selection", selection).status).toBe(1);
    expect(readdirSync(f.root)).not.toContain("published");
  }
});

it("does not repair malformed XML comments or turn a zero-width stroke into visible artwork", () => {
  const f = fixture({
    "comment.svg": '<!-- invalid -- comment -->' + stroke,
    "zero-width.svg": stroke.replace('stroke-width="2"', 'stroke-width="0"'),
  });
  const result = run("--source", f.source, "--confirmation", f.confirmation);
  expect(result.status).toBe(0);
  expect(result.report.counts).toMatchObject({ malformed: 1, unsupported: 1, eligible: 0 });
});

it.skipIf(process.getuid?.() === 0)("leaves an existing publication unchanged when the filesystem refuses staging", () => {
  const f = fixture({ "arrow.svg": stroke });
  const destination = join(f.root, "published");
  mkdirSync(destination);
  const catalog = JSON.stringify({ untouched: stroke });
  writeFileSync(join(destination, "icons.json"), catalog);
  writeFileSync(join(destination, "THIRD_PARTY_LICENSES.md"), "Existing notice\n");
  const selection = join(f.root, "selection.json");
  writeFileSync(selection, JSON.stringify([{ file: "arrow.svg", uiId: "close-pane" }]));
  chmodSync(f.root, 0o500);
  try {
    const result = run("promote", "--source", f.source, "--confirmation", f.confirmation, "--destination", destination, "--selection", selection);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("filesystem error: EACCES");
    expect(result.stderr).not.toContain(f.root);
    expect(readFileSync(join(destination, "icons.json"), "utf8")).toBe(catalog);
    expect(readFileSync(join(destination, "THIRD_PARTY_LICENSES.md"), "utf8")).toBe("Existing notice\n");
    expect(readdirSync(destination).sort()).toEqual(["THIRD_PARTY_LICENSES.md", "icons.json"]);
  } finally { chmodSync(f.root, 0o700); }
});

it("refuses inconsistent existing provenance without rewriting the publication", () => {
  const f = fixture({ "arrow.svg": stroke });
  const destination = join(f.root, "published");
  mkdirSync(destination);
  const catalog = JSON.stringify({ untouched: stroke });
  writeFileSync(join(destination, "icons.json"), catalog);
  const provenance = JSON.stringify({ version: 1, sets: { "dazzle-line-icons": {} }, icons: { untouched: { set: "dazzle-line-icons", file: "arrow.svg", originalHash: hash(stroke), normalizedHash: "0".repeat(64), modifications: ["monochrome paint to currentColor"] } } });
  writeFileSync(join(destination, "icons.provenance.json"), provenance);
  const selection = join(f.root, "selection.json");
  writeFileSync(selection, JSON.stringify([{ file: "arrow.svg", uiId: "close-pane" }]));
  const result = run("promote", "--source", f.source, "--confirmation", f.confirmation, "--destination", destination, "--selection", selection);
  expect(result.status).toBe(1);
  expect(readFileSync(join(destination, "icons.json"), "utf8")).toBe(catalog);
  expect(readFileSync(join(destination, "icons.provenance.json"), "utf8")).toBe(provenance);
  expect(readdirSync(destination).sort()).toEqual(["icons.json", "icons.provenance.json"]);
});

it("rejects comment syntax inside XML attributes instead of repairing it into publishable geometry", () => {
  const malformed = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M1 1<!-- harmless -->L2 2" stroke="#000"/></svg>';
  const malformedTag = stroke.replace("<path ", "<path <!-- harmless --> ");
  const f = fixture({ "bad.svg": malformed, "bad-tag.svg": malformedTag });
  const audit = run("--source", f.source, "--confirmation", f.confirmation);
  expect(audit.status).toBe(0);
  expect(audit.report.counts).toMatchObject({ malformed: 2, eligible: 0 });
  expect(audit.report.files.every((file: { status: string }) => file.status === "malformed")).toBe(true);
  const selection = join(f.root, "selection.json");
  writeFileSync(selection, JSON.stringify([{ file: "bad.svg", uiId: "close-pane" }]));
  expect(run("promote", "--source", f.source, "--confirmation", f.confirmation, "--selection", selection, "--destination", join(f.root, "published")).status).toBe(1);
  expect(readdirSync(f.root)).not.toContain("published");
  expect(readFileSync(join(f.source, "bad.svg"), "utf8")).toBe(malformed);
});

it("hashes original file bytes even when the SVG is malformed non-UTF8 input", () => {
  const f = fixture({ "broken.svg": "replaced below" });
  writeFileSync(join(f.source, "broken.svg"), Buffer.from([255]));
  const result = run("--source", f.source);
  expect(result.status).toBe(0);
  expect(result.report.files[0]).toMatchObject({ status: "malformed", originalHash: "a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89" });
  expect(readFileSync(join(f.source, "broken.svg"))).toEqual(Buffer.from([255]));
});
