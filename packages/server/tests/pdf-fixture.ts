/**
 * A synthetic PDF built in memory (no downloaded or user files): Helvetica text with a superscript, a raw RGB image,
 * a rotated and an odd-sized page, a page with NO text layer, and an optional outline. Page 0 text is
 * "PAGE 1 UNIQUE" etc.; the last-page unique marker of a long variant is "PAGE <n> UNIQUE".
 */
export function syntheticPdf({
  pageCount = 3,
  outline = false,
  deepOutline = 0,
  wideOutline = 0,
  hugePage = false,
  noTextPages = [2],
}: {
  pageCount?: number;
  outline?: boolean;
  /** An outline nested this many levels deep (one entry per level). */
  deepOutline?: number;
  /** An outline with this many top-level entries. */
  wideOutline?: number;
  hugePage?: boolean;
  noTextPages?: number[];
} = {}): Buffer {
  const objects: Buffer[] = [];
  const add = (value: string) => {
    objects.push(Buffer.from(value, "latin1"));
    return objects.length;
  };
  const stream = (body: string, dict = "") =>
    `<< /Length ${Buffer.byteLength(body, "latin1")} ${dict} >>\nstream\n${body}\nendstream`;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pixels = String.fromCharCode(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0);
  const image = add(
    stream(
      pixels,
      "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate false"
    )
  );
  const pages: number[] = [];
  const pageObjectBase = objects.length + 1;
  for (let i = 0; i < pageCount; i++) {
    const [width, height, rotation] =
      i === 0 ? [360, 480, 0] : i === 1 ? [400, 240, 90] : [280, 280, 0];
    const text = noTextPages.includes(i)
      ? ""
      : `BT /F1 20 Tf 30 ${height - 50} Td (PAGE ${i + 1} UNIQUE) Tj ET\n`;
    const formula = i === 0 ? "BT /F1 24 Tf 30 350 Td (E = mc) Tj /F1 14 Tf 7 Ts (2) Tj ET\n" : "";
    const content = add(stream(`${text}${formula}q 80 0 0 80 30 40 cm /Im1 Do Q`));
    const box = hugePage && i === 0 ? "0 0 99999 99999" : `0 0 ${width} ${height}`;
    pages.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Rotate ${rotation} /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${image} 0 R >> >> /Contents ${content} 0 R >>`
      )
    );
  }
  void pageObjectBase;
  objects[1] = Buffer.from(
    `<< /Type /Pages /Count ${pageCount} /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] >>`
  );
  if (outline) {
    // Two top-level entries, the first with one child; destinations are zero-based pages of the document.
    const root = objects.length + 1;
    const first = root + 1;
    const child = root + 2;
    const second = root + 3;
    add(`<< /Type /Outlines /First ${first} 0 R /Last ${second} 0 R /Count 3 >>`);
    add(
      `<< /Title (Chapter One) /Parent ${root} 0 R /First ${child} 0 R /Last ${child} 0 R /Next ${second} 0 R /Dest [${pages[0]} 0 R /Fit] >>`
    );
    add(`<< /Title (Section 1.1) /Parent ${first} 0 R /Dest [${pages[1]} 0 R /Fit] >>`);
    add(
      `<< /Title (Chapter Two) /Parent ${root} 0 R /Prev ${first} 0 R /Dest [${pages[pageCount - 1]} 0 R /Fit] >>`
    );
    objects[0] = Buffer.from(`<< /Type /Catalog /Pages 2 0 R /Outlines ${root} 0 R >>`);
  }
  if (deepOutline > 0 || wideOutline > 0) {
    const root = objects.length + 1;
    const count = deepOutline > 0 ? deepOutline : wideOutline;
    const first = root + 1;
    const last = root + count;
    add(
      `<< /Type /Outlines /First ${first} 0 R /Last ${deepOutline > 0 ? first : last} 0 R /Count ${count} >>`
    );
    for (let i = 0; i < count; i++) {
      const id = first + i;
      const dest = `/Dest [${pages[i % pages.length]} 0 R /Fit]`;
      if (deepOutline > 0) {
        const parent = i === 0 ? root : id - 1;
        const child = i < count - 1 ? ` /First ${id + 1} 0 R /Last ${id + 1} 0 R /Count 1` : "";
        add(`<< /Title (Level ${i + 1}) /Parent ${parent} 0 R${child} ${dest} >>`);
      } else {
        const prev = i > 0 ? ` /Prev ${id - 1} 0 R` : "";
        const next = i < count - 1 ? ` /Next ${id + 1} 0 R` : "";
        add(`<< /Title (Entry ${i + 1}) /Parent ${root} 0 R${prev}${next} ${dest} >>`);
      }
    }
    objects[0] = Buffer.from(`<< /Type /Catalog /Pages 2 0 R /Outlines ${root} 0 R >>`);
  }
  const parts = [Buffer.from("%PDF-1.7\n%synthetic\n")];
  const offsets = [0];
  let length = parts[0]?.length ?? 0;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      objects[i] as Buffer,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(part);
    length += part.length;
  }
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
        .join(
          ""
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`
    )
  );
  return Buffer.concat(parts);
}
