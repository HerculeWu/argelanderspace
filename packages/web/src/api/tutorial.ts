import { type TutorialProgress, TutorialProgressSchema, type TutorialState } from "@argelanderspace/contracts";
import { apiRequest } from "./request";

/**
 * Tutorial progress (in-app-tutorial ticket 18): `GET /api/tutorial` and `PUT /api/tutorial`, the whole file each
 * time. A GET without the shape the page relies on counts as no answer (null).
 */
export async function fetchTutorial(signal?: AbortSignal): Promise<TutorialState | null> {
  try {
    const body = await apiRequest<unknown>("/api/tutorial", { cache: "no-store" }, { signal });
    return isTutorialState(body) ? body : null;
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    return null;
  }
}

/** Replace the whole progress file; rejects (HttpError) when the server did not write it. */
export async function putTutorial(progress: TutorialProgress): Promise<TutorialState> {
  return apiRequest<TutorialState>("/api/tutorial", { method: "PUT", json: progress, cache: "no-store" });
}

function isTutorialState(v: unknown): v is TutorialState {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<TutorialState>;
  if (s.progress !== null && !TutorialProgressSchema.safeParse(s.progress).success) return false;
  if (s.project !== null && (typeof s.project !== "object" || typeof s.project?.path !== "string")) return false;
  return typeof s.sample === "object" && s.sample !== null;
}
