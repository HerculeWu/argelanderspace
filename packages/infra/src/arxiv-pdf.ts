import { PDF_MAX_BYTES } from "@argelanderspace/contracts";
import type { FetchImpl } from "./lib/http.js";

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v\d+)?$/i;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

function arxivBaseId(value: string): string | null {
  let id = value;
  if (/\.pdf$/i.test(id)) id = id.slice(0, -4);
  id = id.replace(/v\d+$/i, "");
  if (!ARXIV_ID.test(id) || /v\d+$/i.test(id) || id.includes("..")) return null;
  return id.toLowerCase();
}

function assertArxivPdfUrl(url: URL, expectedBaseId: string): void {
  let pathId: string;
  try {
    pathId = decodeURIComponent(url.pathname.slice("/pdf/".length));
  } catch {
    throw new Error("arXiv PDF URL has invalid escaping");
  }
  const actualBaseId = arxivBaseId(pathId);
  const queryIsSafe = [...url.searchParams].every(
    ([key, value]) => key === "download" && (value === "1" || value === "true")
  );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "arxiv.org" ||
    url.username !== "" ||
    url.password !== "" ||
    !url.pathname.startsWith("/pdf/") ||
    actualBaseId !== expectedBaseId ||
    !queryIsSafe
  ) {
    throw new Error("arXiv PDF URL does not identify the requested paper");
  }
}

/** Download the current arXiv PDF bytes without claiming an official submission version. */
export async function fetchArxivPdf(
  arxivId: string,
  options: { fetchImpl?: FetchImpl; timeoutMs?: number } = {}
): Promise<Buffer> {
  const id = arxivId.trim();
  const expectedBaseId = arxivBaseId(id);
  if (!ARXIV_ID.test(id) || id.includes("..") || expectedBaseId === null)
    throw new Error("invalid arXiv ID");
  let url = new URL(`https://arxiv.org/pdf/${id}`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    assertArxivPdfUrl(url, expectedBaseId);
    response = await fetchImpl(url.href, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "application/pdf",
        "User-Agent": "bibgraph/0.1 (https://arxiv.org; mailto:wuwenjiegogo@gmail.com)",
      },
      signal,
    });
    if (response.url) assertArxivPdfUrl(new URL(response.url), expectedBaseId);
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("arXiv PDF redirect has no target");
    if (redirects === MAX_REDIRECTS) throw new Error("too many arXiv PDF redirects");
    const nextUrl = new URL(location, url);
    // Validate paper identity and origin before issuing any request to the target.
    assertArxivPdfUrl(nextUrl, expectedBaseId);
    await response.body?.cancel();
    url = nextUrl;
    response = undefined;
  }
  if (!response) throw new Error("arXiv PDF response is unavailable");
  if (!response.ok) throw new Error(`arXiv PDF request failed (HTTP ${response.status})`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/pdf") throw new Error("arXiv did not return a PDF document");
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > PDF_MAX_BYTES)
    throw new Error(`PDF exceeds the ${PDF_MAX_BYTES} byte limit`);
  if (!response.body) throw new Error("arXiv PDF response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > PDF_MAX_BYTES) {
        await reader.cancel();
        throw new Error(`PDF exceeds the ${PDF_MAX_BYTES} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new Error("arXiv returned an empty PDF");
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    length
  );
}
