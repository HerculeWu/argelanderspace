import { type EnvironmentReport, isEnvironmentReport } from "@argelanderspace/contracts";
import { apiRequest } from "./request";

/**
 * The environment check (desktop-app ticket 13): each call checks again on the server. An answer without the shape the
 * page relies on counts as no answer (null).
 */
export async function fetchEnvironment(signal?: AbortSignal): Promise<EnvironmentReport | null> {
  try {
    const body = await apiRequest<unknown>("/api/environment", { cache: "no-store" }, { signal });
    return isEnvironmentReport(body) ? body : null;
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    return null;
  }
}
