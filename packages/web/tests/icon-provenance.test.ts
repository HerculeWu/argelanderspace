// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// The shipped catalog, its provenance and the root notice must agree; a resource
// without a record is allowed only as a frozen pre-provenance glyph (DESIGN.md).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const icons = JSON.parse(read("../src/ui/icons.json")) as Record<string, string | Record<string, string>>;
const provenance = JSON.parse(read("../src/ui/icons.provenance.json"));
const legacy = JSON.parse(read("./fixtures/legacy-icons.json")).resources as Record<string, string>;
const notice = read("../../../THIRD_PARTY_LICENSES.md");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Record_ = { set: string; file: string; normalizedHash: string };
const resources = Object.entries(icons).flatMap(([uiId, value]) =>
  typeof value === "string" ? [{ label: uiId, svg: value, record: provenance.icons[uiId]?.set ? provenance.icons[uiId] as Record_ : undefined }]
    : Object.entries(value).map(([variant, svg]) => ({ label: `${uiId}/${variant}`, svg, record: provenance.icons[uiId]?.set ? undefined : provenance.icons[uiId]?.[variant] as Record_ | undefined })));
const records = Object.entries(provenance.icons as Record<string, Record_ | Record<string, Record_>>).flatMap(([uiId, value]) =>
  "set" in value ? [{ label: uiId, record: value as Record_ }] : Object.entries(value).map(([variant, record]) => ({ label: `${uiId}/${variant}`, record })));

it("records every provenance-covered resource by the hash of its exact catalog bytes", () => {
  const catalog = new Map(resources.map(item => [item.label, item.svg]));
  const mismatched = records.filter(({ label, record }) => catalog.get(label) === undefined || hash(catalog.get(label) as string) !== record.normalizedHash);
  expect(mismatched.map(item => item.label)).toEqual([]);
  expect(new Set(records.map(item => item.record.set))).toEqual(new Set(["dazzle-line-icons", "lucide"]));
  for (const set of ["dazzle-line-icons", "lucide"]) expect(provenance.sets[set]).toMatchObject({ notice: "THIRD_PARTY_LICENSES.md" });
});

it("allows a resource without provenance only as an unchanged frozen pre-provenance glyph", () => {
  const unrecorded = resources.filter(item => !item.record);
  expect(Object.fromEntries(unrecorded.map(item => [item.label, hash(item.svg)]))).toEqual(legacy);
});

it("lists every adopted Dazzle mapping and asset in the root notice", () => {
  const dazzle = records.filter(item => item.record.set === "dazzle-line-icons");
  const line = (prefix: string) => notice.split("\n").find(text => text.startsWith(prefix))?.slice(prefix.length).replace(/\.$/, "");
  expect(line("Mappings: ")?.split(", ")).toEqual(dazzle.map(item => item.label).sort((a, b) => a.localeCompare(b)));
  expect(line("Adopted assets: ")?.split(", ")).toEqual([...new Set(dazzle.map(item => JSON.stringify(item.record.file)))].sort());
  expect(notice).toContain("## Lucide icons — Lucide contributors");
});
