/**
 * Recursive field-by-field JSON diff reporter shared by the golden gates
 * (`golden-latex.test.ts`, `golden-pdf.test.ts`). Reports human-readable paths
 * where the emitted document and the frozen Python golden diverge, in order.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: Json): v is { [k: string]: Json } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Collect human-readable paths where `got` and `want` diverge (in-order). */
export function diffJson(got: Json, want: Json, path = "$", out: string[] = []): string[] {
  if (isObj(got) && isObj(want)) {
    for (const k of Object.keys(want)) {
      const w = want[k] as Json;
      if (!(k in got)) {
        out.push(`${path}.${k} — missing in emitted (golden: ${preview(w)})`);
      } else {
        diffJson(got[k] as Json, w, `${path}.${k}`, out);
      }
    }
    for (const k of Object.keys(got)) {
      if (!(k in want)) {
        out.push(`${path}.${k} — extra in emitted (${preview(got[k] as Json)})`);
      }
    }
    return out;
  }
  if (Array.isArray(got) && Array.isArray(want)) {
    if (got.length !== want.length) {
      out.push(`${path} — array length ${got.length} != golden ${want.length}`);
    }
    for (let i = 0; i < Math.min(got.length, want.length); i++) {
      diffJson(got[i] as Json, want[i] as Json, `${path}[${i}]`, out);
    }
    return out;
  }
  if (got !== want) {
    out.push(`${path} — ${preview(got)} != golden ${preview(want)}`);
  }
  return out;
}

function preview(v: Json): string {
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}
