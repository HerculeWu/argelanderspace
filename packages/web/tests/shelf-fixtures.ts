/** Shared stand-ins for the Shelf tests (shelf ticket 05): a routed fetch stub and synthetic Shelf rows. */
import type { ShelfListRow, ShelfReplaceImpact } from "@argelanderspace/contracts";
import { vi } from "vitest";

export type Route = (url: string, init: RequestInit | undefined) => Response | undefined | Promise<Response | undefined>;

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Replace fetch with the routes (first answer wins); anything unrouted is a 404. Returns the mock to read calls. */
export function stubFetch(...routes: Route[]) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const route of routes) {
      const answer = await route(url, init);
      if (answer) return answer;
    }
    return json({ detail: "not found" }, 404);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The JSON bodies sent to `url` (exact path, query included) with `method`. */
export function bodiesOf(mock: ReturnType<typeof stubFetch>, url: string, method = "POST"): unknown[] {
  return mock.mock.calls
    .filter(([input, init]) => String(input) === url && (init?.method ?? "GET") === method)
    .map(([, init]) => JSON.parse(String(init?.body ?? "null")));
}

/** The element for `selector`; throws while it is not there (for `waitFor`). */
export function must(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`not found: ${selector}`);
  return el;
}

export const ENTRY_A = "a".repeat(32);
export const ENTRY_B = "b".repeat(32);
export const ENTRY_C = "c".repeat(32);
export const ENTRY_D = "d".repeat(32);

export const OK_ROW: ShelfListRow = {
  status: "ok",
  entryId: ENTRY_A,
  rev: 2,
  bytes: 5 * 1024 * 1024,
  addedAt: "2026-10-02T09:40:00.000Z",
  source: { project: "/home/u/research/wd-cooling", workId: "doi:10.1/gaia" },
  identity: { doi: "10.1/gaia", arxiv: "1804.09378", openalex: null },
  title: "Gaia Data Release 2. Observational HRD",
  authors: ["Gaia Collaboration", "Babusiaux, C."],
  year: 2018,
  docs: [
    { docId: "arxiv-1804.09378", kind: "latex", bytes: 4 * 1024 * 1024, annotations: 2 },
    { docId: "pdf-0f3b7d21", kind: "pdf", bytes: 1024 * 1024, annotations: 1 },
  ],
  annotations: 3,
  argumentGraph: true,
  note: true,
};

export const OTHER_ROW: ShelfListRow = {
  ...(OK_ROW as Extract<ShelfListRow, { status: "ok" }>),
  entryId: ENTRY_B,
  rev: 1,
  identity: { doi: null, arxiv: "1906.03924", openalex: null },
  title: "A 5D view of the alpha Per, Pleiades, and Praesepe clusters",
  authors: ["Lodieu, N."],
  year: 2019,
  docs: [{ docId: "pdf-a90b33e4", kind: "pdf", bytes: 2048, annotations: null }],
  annotations: 0,
  argumentGraph: false,
  note: false,
};

export const INCOMPATIBLE_ROW: ShelfListRow = { status: "incompatible", entryId: ENTRY_C, rev: 1, bytes: 6 * 1024 * 1024, format: 3, title: "The Pleiades distance", needsUpdate: true };
export const UNREADABLE_ROW: ShelfListRow = { status: "unreadable", entryId: ENTRY_D, rev: 1, bytes: 0, code: "EACCES" };

export const IMPACT: ShelfReplaceImpact = {
  entries: [
    {
      entryId: ENTRY_A,
      rev: 2,
      title: "Extended stellar systems",
      addedAt: "2026-09-30T16:12:00.000Z",
      sourceProject: "/home/u/research/hyades-tails",
      docs: [{ docId: "arxiv-1901.06387", kind: "latex", bytes: 4096 }],
      annotations: 2,
      argumentGraph: false,
      note: true,
    },
  ],
};
