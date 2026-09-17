/**
 * Stage 14 — the explore state machine (`useExploreStack`) against a stubbed
 * global fetch (no network), plus fetchDiscovery's status mapping. happy-dom:
 * no layout assertions (real-browser probes cover those in Phase 6).
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryGraph } from "@argelanderspace/contracts";
import { fetchDiscovery } from "../src/api/discovery";
import { useExploreStack } from "../src/library/explore-state";
import { parseExploreHash } from "../src/lib/explore-route";

// ---------------------------------------------------------------- fixtures --

function makeGraph(seed: string): DiscoveryGraph {
  return {
    version: 1,
    provider: "ads",
    seed,
    nodes: [
      {
        bibcode: seed,
        title: `Seed ${seed}`,
        authors: ["Doe, J."],
        year: 2023,
        venue: "A&A",
        abstract: "seed abstract",
        citationCount: 10,
        doi: null,
        arxivId: null,
        roles: ["seed"],
        libraryId: null,
      },
      {
        bibcode: `R1`,
        title: "Related One",
        authors: ["Roe, K."],
        year: 2022,
        venue: "ApJ",
        abstract: null,
        citationCount: 5,
        doi: null,
        arxivId: null,
        roles: ["related"],
        relatedRank: 1,
        libraryId: null,
      },
      {
        bibcode: `U1`,
        title: "Useful One",
        authors: ["Poe, L."],
        year: 2001,
        venue: "MNRAS",
        abstract: "u",
        citationCount: 900,
        doi: null,
        arxivId: null,
        roles: ["useful"],
        usefulRank: 1,
        libraryId: null,
      },
    ],
    edges: [{ from: "R1", to: seed, kind: "citation" }],
    warnings: [],
  };
}

/** Deferred fetch for cancellation tests. */
let gate: ((r: Response) => void) | null = null;

function okJson(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

function stubNet() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/library/discovery")) {
      const bc = new URL(url, "http://test").searchParams.get("bibcode") ?? "";
      if (bc === "GATE") {
        return new Promise<Response>((resolve) => {
          gate = resolve;
        });
      }
      if (bc === "FAIL") {
        return { ok: false, status: 503, json: async () => ({ detail: "x" }) } as Response;
      }
      if (bc === "EMPTY") return okJson({ ...makeGraph(bc), nodes: [makeGraph(bc).nodes[0]], edges: [] });
      return okJson(makeGraph(bc));
    }
    if (url === "/api/library/works") {
      return okJson({ results: [{ status: "created", ref: { id: "doi:10.1/x" } }] });
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
}

// ---------------------------------------------------------------- harness ---

function Harness() {
  const ex = useExploreStack();
  return (
    <div>
      <div data-testid="active">{String(ex.active)}</div>
      <div data-testid="seed">{ex.current?.seed ?? ""}</div>
      <div data-testid="sessions">{ex.sessions.map((s) => s.seed).join(",")}</div>
      <div data-testid="index">{String(ex.index)}</div>
      <div data-testid="loading">{ex.loading?.seed ?? ""}</div>
      <div data-testid="error">{ex.error ? `${ex.error.seed}:${ex.error.status}` : ""}</div>
      <div data-testid="libid">{ex.current?.graph.nodes.find((n) => n.bibcode === "R1")?.libraryId ?? ""}</div>
      <button data-testid="goS" onClick={() => void ex.startExplore("S")} />
      <button data-testid="goT" onClick={() => void ex.startExplore("T")} />
      <button data-testid="goFail" onClick={() => void ex.startExplore("FAIL")} />
      <button data-testid="goGate" onClick={() => void ex.startExplore("GATE")} />
      <button data-testid="cancel" onClick={ex.cancelExplore} />
      <button data-testid="back" onClick={() => ex.step(-1)} />
      <button data-testid="fwd" onClick={() => ex.step(1)} />
      <button data-testid="exit" onClick={ex.exitExplore} />
      <button data-testid="hashT" onClick={() => ex.exploreFromHash("T")} />
      <button data-testid="addR1" onClick={() => void ex.addToLibrary("R1")} />
    </div>
  );
}

function txt(container: HTMLElement, id: string): string {
  return container.querySelector(`[data-testid="${id}"]`)!.textContent ?? "";
}

describe("useExploreStack", () => {
  beforeEach(() => {
    gate = null;
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("fetch", stubNet());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("a successful explore pushes the session and writes the hash (D14)", async () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-testid="goS"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("S"));
    expect(txt(container, "active")).toBe("true");
    expect(txt(container, "sessions")).toBe("S");
    expect(txt(container, "index")).toBe("0");
    expect(window.location.hash).toBe("#explore/S");
  });

  it("a failed first explore enters the error state with NO session and NO hash", async () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-testid="goFail"]')!);
    await waitFor(() => expect(txt(container, "error")).toBe("FAIL:503"));
    expect(txt(container, "active")).toBe("true"); // explore chrome shows the error
    expect(txt(container, "sessions")).toBe("");
    expect(txt(container, "index")).toBe("-1");
    expect(window.location.hash).toBe("");
  });

  it("a failed explore-from-here keeps the current session; failure is not history", async () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-testid="goS"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("S"));
    fireEvent.click(container.querySelector('[data-testid="goFail"]')!);
    await waitFor(() => expect(txt(container, "error")).toBe("FAIL:503"));
    expect(txt(container, "seed")).toBe("S"); // still the old session
    expect(txt(container, "sessions")).toBe("S");
    expect(window.location.hash).toBe("#explore/S"); // URL untouched by the failure
  });

  it("cancel aborts without error; first-explore cancel returns to the library", async () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-testid="goGate"]')!);
    await waitFor(() => expect(txt(container, "loading")).toBe("GATE"));
    fireEvent.click(container.querySelector('[data-testid="cancel"]')!);
    gate?.(okJson(makeGraph("GATE"))); // a late response must be ignored
    await waitFor(() => expect(txt(container, "loading")).toBe(""));
    await new Promise((r) => setTimeout(r, 20));
    expect(txt(container, "error")).toBe("");
    expect(txt(container, "sessions")).toBe("");
    expect(txt(container, "active")).toBe("false");
  });

  it("back/forward walks the session stack; the URL mirrors the current seed", async () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-testid="goS"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("S"));
    fireEvent.click(container.querySelector('[data-testid="goT"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("T"));
    expect(txt(container, "sessions")).toBe("S,T");
    fireEvent.click(container.querySelector('[data-testid="back"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("S"));
    expect(window.location.hash).toBe("#explore/S");
    fireEvent.click(container.querySelector('[data-testid="fwd"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("T"));
    expect(window.location.hash).toBe("#explore/T");
  });

  it("exploreFromHash restores a known session without a refetch", async () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-testid="goS"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("S"));
    fireEvent.click(container.querySelector('[data-testid="goT"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("T"));
    const fetchesBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(container.querySelector('[data-testid="back"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("S"));
    fireEvent.click(container.querySelector('[data-testid="hashT"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("T"));
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchesBefore);
  });

  it("addToLibrary patches the node libraryId in place (no re-layout, same session)", async () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-testid="goS"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("S"));
    fireEvent.click(container.querySelector('[data-testid="addR1"]')!);
    await waitFor(() => expect(txt(container, "libid")).toBe("doi:10.1/x"));
    expect(txt(container, "sessions")).toBe("S");
    expect(txt(container, "seed")).toBe("S");
    expect(window.location.hash).toBe("#explore/S");
  });

  it("exitExplore leaves the mode and clears the explore hash", async () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-testid="goS"]')!);
    await waitFor(() => expect(txt(container, "seed")).toBe("S"));
    fireEvent.click(container.querySelector('[data-testid="exit"]')!);
    expect(txt(container, "active")).toBe("false");
    expect(window.location.hash).toBe("");
    // the session survives for resume
    expect(txt(container, "sessions")).toBe("S");
  });
});

// ---------------------------------------------------------------- api ------- 

describe("fetchDiscovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps 200 → graph, HTTP errors → status, and propagates aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("bibcode=OK")) return okJson(makeGraph("OK"));
        return { ok: false, status: 429, json: async () => ({ detail: "slow" }) } as Response;
      })
    );
    const ok = await fetchDiscovery("OK");
    expect(ok).toMatchObject({ ok: true });
    const bad = await fetchDiscovery("X");
    expect(bad).toEqual({ ok: false, status: 429 });

    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      })
    );
    await expect(fetchDiscovery("OK", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

// ---------------------------------------------------------------- route -----

describe("parseExploreHash", () => {
  it("parses #explore/<encoded> and rejects everything else", () => {
    expect(parseExploreHash("#explore/2023A%26A...673A.114H")).toBe("2023A&A...673A.114H");
    expect(parseExploreHash("#explore/")).toBeNull();
    expect(parseExploreHash("#sec-2")).toBeNull();
    expect(parseExploreHash("")).toBeNull();
    expect(parseExploreHash("#explore/%E0%A4%A")).toBeNull(); // malformed percent-encoding
  });
});
