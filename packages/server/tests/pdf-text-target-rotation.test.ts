/**
 * The rectangles of a text annotation on a rotated page (copilot ticket 21). Node's PDFium reports a page's geometry as the
 * page is VIEWED; the sidecar stores visible-page fractions. The same words on pages that differ only in /Rotate must
 * therefore come out as the one unrotated rectangle turned by the page's rotation, never turned twice.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { resolvePdfTextTarget } from "../src/pdf-material.js";
import { probePdf } from "../src/pdfium-probe.js";

function pdfWithRotations(rotations: number[]): Buffer {
  const objects: string[] = [];
  const add = (value: string) => objects.push(value);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pages: number[] = [];
  for (const rotation of rotations) {
    const body = "BT /F1 20 Tf 50 180 Td (ROTATED MARK) Tj ET";
    add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    const content = objects.length;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Rotate ${rotation} /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`
    );
    pages.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Count ${rotations.length} /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] >>`;
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("the same words on pages rotated 0, 90, 180 and 270 give the unrotated rectangle turned once by the page's rotation", async () => {
  const bytes = pdfWithRotations([0, 90, 180, 270]);
  const { pages } = await probePdf(bytes);
  expect(pages.map((p) => p.rotation)).toEqual([0, 90, 180, 270]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const rect = async (pageIndex: number) => {
    const result = await resolvePdfTextTarget(
      bytes,
      sha,
      [{ pageIndex, quote: "ROTATED MARK" }],
      pages
    );
    if (!result.ok) throw new Error(result.detail);
    const fragment = result.target.fragments[0];
    expect(fragment?.page_index).toBe(pageIndex);
    expect(fragment?.rectangles).toHaveLength(1);
    return fragment?.rectangles[0] as { x: number; y: number; width: number; height: number };
  };
  const [r0, r90, r180, r270] = [await rect(0), await rect(1), await rect(2), await rect(3)];
  // the unrotated words: a wide, short box near the left of a 400x240 page
  expect(r0.width).toBeGreaterThan(r0.height);
  expect(r0.x).toBeCloseTo(50 / 400, 2);
  const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 2);
  // 90 degrees clockwise: a tall, thin box (the page is viewed 240 wide, 400 tall)
  near(r90.x, 1 - r0.y - r0.height);
  near(r90.y, r0.x);
  near(r90.width, r0.height * (240 / 240));
  expect(r90.height).toBeGreaterThan(r90.width);
  // 180 degrees
  near(r180.x, 1 - r0.x - r0.width);
  near(r180.y, 1 - r0.y - r0.height);
  near(r180.width, r0.width);
  // 270 degrees
  near(r270.x, r0.y);
  near(r270.y, 1 - r0.x - r0.width);
  expect(r270.height).toBeGreaterThan(r270.width);
  for (const r of [r0, r90, r180, r270]) {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-9);
  }
});
