/**
 * PdfDownloader (acquire/fetch_pdf.py::_download_pdf) — %PDF magic /
 * content-type verification, atomic write, offline via stub fetch.
 */

import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FetchPdfDownloader, NotAPdfError } from "../src/acquire/pdf-downloader.js";
import { bytesResponse, stubFetch } from "./helpers.js";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "m2-pdf-"));
}

describe("FetchPdfDownloader (acquire PdfDownloader port)", () => {
  test("downloads a PDF: magic passes, atomic .part → rename", async () => {
    const { fetchImpl, calls } = stubFetch((c) => {
      expect(c.headers["User-Agent"]).toContain("Mozilla/5.0");
      return bytesResponse(PDF_BYTES, { contentType: "application/pdf" });
    });
    const dest = join(tmp(), "doc", "paper.pdf"); // parent dir does not exist yet
    await new FetchPdfDownloader({ fetchImpl }).download("https://arxiv.org/pdf/1610.08981", dest);
    expect(calls.length).toBe(1);
    expect(new Uint8Array(readFileSync(dest))).toEqual(PDF_BYTES);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  test("an HTML error page raises NotAPdfError (Python ValueError)", async () => {
    const { fetchImpl } = stubFetch(() =>
      bytesResponse(new TextEncoder().encode("<html>blocked</html>"), { contentType: "text/html" })
    );
    const d = new FetchPdfDownloader({ fetchImpl });
    await expect(
      d.download("https://publisher.example/blocked", join(tmp(), "x.pdf"))
    ).rejects.toThrow(NotAPdfError);
  });

  test("missing magic but a pdf content-type still passes (Python OR-branch)", async () => {
    const { fetchImpl } = stubFetch(() =>
      bytesResponse(new Uint8Array([1, 2, 3]), { contentType: "application/pdf" })
    );
    const dest = join(tmp(), "x.pdf");
    await new FetchPdfDownloader({ fetchImpl }).download("https://x.example/y", dest);
    expect(statSync(dest).size).toBe(3);
  });

  test("HTTP error raises", async () => {
    const { fetchImpl } = stubFetch(() => bytesResponse(new Uint8Array(), { status: 404 }));
    await expect(
      new FetchPdfDownloader({ fetchImpl }).download("https://x.example/404", join(tmp(), "x.pdf"))
    ).rejects.toThrow("HTTP 404");
  });
});
