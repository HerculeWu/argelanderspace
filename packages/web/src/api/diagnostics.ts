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

/** The name a bundle made now gets (the server names it the same way, in UTC). */
export function suggestedBundleName(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
  const t = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `argelanderspace-diagnostics-${d}-${t}.zip`;
}

/** The part of the File System Access API the page uses (not in every browser, nor in TypeScript's DOM types). */
interface SaveFileHandle {
  readonly name: string;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
}
type ShowSaveFilePicker = (options: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<SaveFileHandle>;

/** Where a bundle goes: a file the user chose in the system's save window, or the browser's downloads. */
export type SaveTarget = { kind: "picker"; handle: SaveFileHandle } | { kind: "download" };

/**
 * Asks where to save, before the bundle is asked for: the system's save window opens only from a user's click, and that
 * permission is gone once the page has waited for the server. Call it first thing in the click handler. Resolves null
 * when the user cancelled the window; the browser's downloads when there is no such window here.
 */
export async function chooseSaveTarget(suggestedName: string, description: string): Promise<SaveTarget | null> {
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (typeof picker !== "function") return { kind: "download" };
  try {
    const handle = await picker.call(window, {
      suggestedName,
      types: [{ description, accept: { "application/zip": [".zip"] } }],
    });
    return { kind: "picker", handle };
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") return null;
    throw e;
  }
}

/** Writes a bundle where the user chose; a failed write is undone as far as the browser can. */
export async function writeBundle(handle: SaveFileHandle, bundle: DiagnosticsBundle): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(bundle.blob);
    await writable.close();
  } catch (e) {
    await writable.abort?.().catch(() => {});
    throw e;
  }
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
