import { type DiagnosticsExportRequest, type DiagnosticsInfo, isDiagnosticsInfo } from "@argelanderspace/contracts";
import { apiRequest } from "./request";

/**
 * Diagnostics (desktop-app ticket 14): where the log is and what a bundle would take, and the bundle itself. The bundle
 * is the answer to the page's own request and goes to the browser's save; nothing is uploaded anywhere.
 */

/** The log directory and the compile-failure logs; null when the server gave no usable answer. */
export async function fetchDiagnostics(signal?: AbortSignal): Promise<DiagnosticsInfo | null> {
  try {
    const body = await apiRequest<unknown>("/api/diagnostics", { cache: "no-store" }, { signal });
    return isDiagnosticsInfo(body) ? body : null;
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    return null;
  }
}

export interface DiagnosticsBundle {
  /** The file name the server gave (`argelanderspace-diagnostics-<date>-<time>.zip`). */
  name: string;
  blob: Blob;
}

const FILE_NAME = /filename="([A-Za-z0-9._-]+)"/;

/** Asks the server for a bundle; rejects when it gives none. */
export async function exportDiagnostics(request: DiagnosticsExportRequest): Promise<DiagnosticsBundle> {
  const response = await apiRequest<Response>(
    "/api/diagnostics/export",
    { method: "POST", json: request },
    { parse: "none" }
  );
  const name = FILE_NAME.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "argelanderspace-diagnostics.zip";
  return { name, blob: await response.blob() };
}

/** Hands a bundle to the browser's download (the browser decides, or asks, where it goes). */
export function saveBundle(bundle: DiagnosticsBundle): void {
  const url = URL.createObjectURL(bundle.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = bundle.name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
