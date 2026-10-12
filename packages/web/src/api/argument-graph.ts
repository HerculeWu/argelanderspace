import { ARGUMENT_GRAPH_UNREADABLE_PREFIX, type ArgumentGraph, ArgumentGraphSchema } from "@argelanderspace/contracts";
import { apiRequest, HttpError } from "./request";

/**
 * What reading a Work's argument graph can end as (the read-only view, ticket 04). Every outcome is its own state:
 * an unreadable file is never an empty graph, and "no graph yet" arrives as the server's empty graph (`rev: 0`).
 */
export type ArgumentGraphLoad =
  | { kind: "ok"; graph: ArgumentGraph }
  /** The Work is not in the library (404). */
  | { kind: "not-found" }
  /** The graph file exists but cannot be read (the server's 500 with its fixed wording). */
  | { kind: "corrupt" }
  /** Anything else: no answer, another server failure, an answer that is not a graph. */
  | { kind: "error"; unreachable: boolean };

/** `GET /api/works/:workId/argument-graph`; the Work id is URL-encoded (it holds `:` and `/`). */
export async function fetchArgumentGraph(workId: string, signal?: AbortSignal): Promise<ArgumentGraphLoad> {
  try {
    const body = await apiRequest<unknown>(`/api/works/${encodeURIComponent(workId)}/argument-graph`, {}, { signal });
    const parsed = ArgumentGraphSchema.safeParse(body);
    return parsed.success ? { kind: "ok", graph: parsed.data } : { kind: "error", unreachable: false };
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") throw error;
    if (error instanceof HttpError) {
      if (error.status === 404) return { kind: "not-found" };
      const detail = (error.body as { detail?: unknown } | null)?.detail;
      if (error.status === 500 && typeof detail === "string" && detail.startsWith(ARGUMENT_GRAPH_UNREADABLE_PREFIX)) return { kind: "corrupt" };
      return { kind: "error", unreachable: error.status === 0 };
    }
    return { kind: "error", unreachable: false };
  }
}

/** What writing a Work's argument graph can end as (ticket 05). The server never overwrites on anything but `ok`. */
export type ArgumentGraphWrite =
  | { kind: "ok"; graph: ArgumentGraph }
  /** 409 `rev mismatch`: the graph moved on since it was read; `rev` is the server's current one when it said so. */
  | { kind: "conflict"; rev: number | null }
  /** 400: the server's structure check refused the graph; `detail` is its (English) reason list. */
  | { kind: "invalid"; detail: string }
  | { kind: "not-found" }
  /** The stored file is unreadable (500 with the fixed wording): nothing was written. */
  | { kind: "corrupt" }
  | { kind: "error"; unreachable: boolean };

/**
 * `PUT /api/works/:workId/argument-graph`: the whole graph, carrying the `rev` its caller read. The only way the page
 * writes (see `argument/commit.ts`, which the Copilot's tools will share).
 */
export async function putArgumentGraph(workId: string, graph: ArgumentGraph): Promise<ArgumentGraphWrite> {
  try {
    const body = await apiRequest<unknown>(`/api/works/${encodeURIComponent(workId)}/argument-graph`, { method: "PUT", json: graph });
    const parsed = ArgumentGraphSchema.safeParse(body);
    return parsed.success ? { kind: "ok", graph: parsed.data } : { kind: "error", unreachable: false };
  } catch (error) {
    if (error instanceof HttpError) {
      const detail = (error.body as { detail?: unknown; rev?: unknown } | null)?.detail;
      if (error.status === 404) return { kind: "not-found" };
      if (error.status === 409 && detail === "rev mismatch") {
        const rev = (error.body as { rev?: unknown } | null)?.rev;
        return { kind: "conflict", rev: typeof rev === "number" ? rev : null };
      }
      if (error.status === 400) return { kind: "invalid", detail: typeof detail === "string" ? detail : "" };
      if (error.status === 500 && typeof detail === "string" && detail.startsWith(ARGUMENT_GRAPH_UNREADABLE_PREFIX)) return { kind: "corrupt" };
      return { kind: "error", unreachable: error.status === 0 };
    }
    return { kind: "error", unreachable: false };
  }
}
