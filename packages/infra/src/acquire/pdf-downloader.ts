/**
 * `acquire/fetch_pdf.py::_download_pdf` — the {@link PdfDownloader} port impl.
 * Browser User-Agent, redirects followed, `%PDF` magic (or a pdf
 * content-type) verified, atomic `.part` → rename write.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PdfDownloader } from "@argelanderspace/core";
import { type FetchImpl, HttpError } from "../lib/http.js";

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Raised when the URL did not return a PDF (Python `ValueError`). */
export class NotAPdfError extends Error {
  constructor(url: string, contentType: string) {
    super(`${url} did not return a PDF (content-type '${contentType}')`);
    this.name = "NotAPdfError";
  }
}

export class FetchPdfDownloader implements PdfDownloader {
  private readonly timeout: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: { timeout?: number; fetchImpl?: FetchImpl } = {}) {
    this.timeout = opts.timeout ?? 60;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async download(url: string, destPath: string): Promise<void> {
    mkdirSync(dirname(destPath), { recursive: true });
    const res = await this.fetchImpl(url, {
      headers: { "User-Agent": BROWSER_UA },
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeout * 1000),
    });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      throw new HttpError(res.status, url, snippet);
    }
    const contentType = res.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    const hasMagic =
      bytes.length >= 4 &&
      bytes[0] === 0x25 && // %
      bytes[1] === 0x50 && // P
      bytes[2] === 0x44 && // D
      bytes[3] === 0x46; // F
    if (!hasMagic && !contentType.toLowerCase().includes("pdf")) {
      throw new NotAPdfError(url, contentType);
    }
    const tmp = `${destPath}.part`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, destPath);
  }
}
