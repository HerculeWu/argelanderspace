/**
 * Caching HTML fetcher (ingest_html/fetch.py) + arXiv e-print fetcher and
 * source acquisition (ingest_latex/fetch.py) — all offline: stub fetch for
 * the network, fixture tarballs for the unpacker.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { docIdFromUrl, Fetcher, looksLikeDoi, normalizeSource } from "../src/html/fetcher.js";
import {
  ArxivFetcher,
  acquireSource,
  arxivId,
  docIdFor,
  extractArxivSource,
  findMainTex,
  looksLikeArxiv,
} from "../src/latex/arxiv-source.js";
import { bytesResponse, stubFetch, textResponse } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "m2-fetch-"));
}

const UA = "test-agent/1.0";

// --------------------------------------------------------------------------- //
// URL / id helpers
// --------------------------------------------------------------------------- //

describe("source normalization helpers", () => {
  test("looksLikeDoi / normalizeSource", () => {
    expect(looksLikeDoi("10.1051/0004-6361/202038192")).toBe(true);
    expect(looksLikeDoi(" 10.3847/1538-4365/ae4fbb ")).toBe(true);
    expect(looksLikeDoi("https://www.aanda.org/x")).toBe(false);
    expect(normalizeSource("10.1051/0004-6361/202038192")).toBe(
      "https://doi.org/10.1051/0004-6361/202038192"
    );
    expect(normalizeSource("https://doi.org/10.1086/161130")).toBe(
      "https://doi.org/10.1086/161130"
    );
    expect(
      normalizeSource("www.aanda.org/articles/aa/abs/2020/08/aa38192-20/aa38192-20.html")
    ).toBe("https://www.aanda.org/articles/aa/abs/2020/08/aa38192-20/aa38192-20.html");
    expect(normalizeSource("http://x.example/a")).toBe("http://x.example/a");
  });

  test("docIdFromUrl (A&A shape, generic stems, host fallback)", () => {
    expect(
      docIdFromUrl("https://www.aanda.org/articles/aa/full_html/2020/08/aa39341-20/aa39341-20.html")
    ).toBe("aa39341-20");
    expect(docIdFromUrl("https://example.com/journal/vol12/index.html")).toBe("vol12");
    expect(docIdFromUrl("https://example.com/journal/vol12/fulltext")).toBe("vol12");
    expect(docIdFromUrl("https://example.com/")).toBe("example-com");
    expect(docIdFromUrl("https://example.com/a b/c!.html")).toBe("c");
  });

  test("arxivId / looksLikeArxiv / docIdFor", () => {
    expect(arxivId("1610.08981")).toBe("1610.08981");
    expect(arxivId("arXiv:1610.08981v2")).toBe("1610.08981v2");
    expect(arxivId("astro-ph/9707253")).toBe("astro-ph/9707253");
    expect(arxivId("https://arxiv.org/abs/1610.08981")).toBe("1610.08981");
    expect(arxivId("https://arxiv.org/pdf/1610.08981v3")).toBe("1610.08981v3");
    expect(arxivId("https://arxiv.org/pdf/1610.08981.pdf")).toBe("1610.08981");
    expect(arxivId("not an id")).toBeNull();
    expect(looksLikeArxiv("arXiv:1610.08981v2")).toBe(true);
    expect(looksLikeArxiv("10.1086/161130")).toBe(false);
    expect(docIdFor("1610.08981", null)).toBe("arxiv-1610.08981");
    expect(docIdFor("astro-ph/9707253", null)).toBe("arxiv-astro-ph-9707253");
    expect(docIdFor(null, join(FIXTURES, "eprint-sample.tar.gz"))).toBe("latex-eprint-sample.tar");
  });
});

// --------------------------------------------------------------------------- //
// HTML Fetcher
// --------------------------------------------------------------------------- //

describe("Fetcher (ingest_html/fetch.py)", () => {
  test("get() caches by sha1(url)[:16] and serves the second call offline", async () => {
    const url = "https://www.aanda.org/articles/aa/full_html/2020/08/aa39341-20/aa39341-20.html";
    const finalUrl =
      "https://www.aanda.org/articles/aa/full_html/2020/08/aa39341-20/aa39341-20.html";
    const { fetchImpl, calls } = stubFetch(() =>
      textResponse("<html><body><p>Full text</p></body></html>", { url: finalUrl })
    );
    const cacheDir = tmp();
    const f = new Fetcher(cacheDir, { userAgent: UA, delay: 0, fetchImpl });
    const first = await f.get(url);
    expect(first.finalUrl).toBe(finalUrl);
    expect(first.text).toContain("Full text");
    const digest = createHash("sha1").update(url, "utf-8").digest("hex").slice(0, 16);
    expect(readFileSync(join(cacheDir, `${digest}.url`), "utf-8")).toBe(finalUrl);
    expect(statSync(join(cacheDir, `${digest}.html`)).size).toBeGreaterThan(0);
    const second = await f.get(url);
    expect(second.text).toBe(first.text);
    expect(calls.length).toBe(1);
  });

  test("getSoup() parses with cheerio", async () => {
    const { fetchImpl } = stubFetch(() =>
      textResponse("<html><body><p class='a'>one</p><p>two</p></body></html>")
    );
    const f = new Fetcher(tmp(), { userAgent: UA, delay: 0, fetchImpl });
    const { soup } = await f.getSoup("https://example.com/page");
    expect(soup("p").length).toBe(2);
    expect(soup("p.a").text()).toBe("one");
  });

  test("download() streams to disk, short-read triggers a retry, .part is atomic", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    let n = 0;
    const { fetchImpl, calls } = stubFetch(() => {
      n += 1;
      // first attempt lies about content-length (short read), second is honest
      return n === 1
        ? bytesResponse(payload.subarray(0, 3), { contentLength: 5 })
        : bytesResponse(payload, { contentLength: 5 });
    });
    const dir = tmp();
    const dest = join(dir, "assets", "fig1.jpg");
    const f = new Fetcher(tmp(), { userAgent: UA, delay: 0, fetchImpl });
    expect(await f.download("https://example.com/fig1.jpg", dest)).toBe(true);
    expect(calls.length).toBe(2);
    expect(new Uint8Array(readFileSync(dest))).toEqual(payload);
    expect(existsSync(`${dest}.part`)).toBe(false);
    // second download is a cache hit — no network
    expect(await f.download("https://example.com/fig1.jpg", dest)).toBe(true);
    expect(calls.length).toBe(2);
  });

  test("download() returns false after the retries are exhausted", async () => {
    const { fetchImpl } = stubFetch(() =>
      bytesResponse(new Uint8Array([1]), { contentLength: 99 })
    );
    const f = new Fetcher(tmp(), { userAgent: UA, delay: 0, fetchImpl });
    expect(await f.download("https://example.com/bad.bin", join(tmp(), "bad.bin"), 2)).toBe(false);
  });

  test("HTTP error on get() raises (raise_for_status)", async () => {
    const { fetchImpl } = stubFetch(() => textResponse("denied", { status: 403 }));
    const f = new Fetcher(tmp(), { userAgent: UA, delay: 0, fetchImpl });
    await expect(f.get("https://example.com/x")).rejects.toThrow("HTTP 403");
  });
});

// --------------------------------------------------------------------------- //
// arXiv e-print fetch + unpack
// --------------------------------------------------------------------------- //

describe("ArxivFetcher + extractArxivSource (ingest_latex/fetch.py)", () => {
  test("downloadEprint caches as <sanitized-id>.tar.gz and reuses it", async () => {
    const tar = new Uint8Array(readFileSync(join(FIXTURES, "eprint-sample.tar.gz")));
    const { fetchImpl, calls } = stubFetch((c) => {
      expect(c.url).toBe("https://arxiv.org/e-print/astro-ph/9707253");
      return bytesResponse(tar);
    });
    const cacheDir = tmp();
    const f = new ArxivFetcher(cacheDir, { userAgent: UA, delay: 0, fetchImpl });
    const dest = await f.downloadEprint("astro-ph/9707253");
    expect(dest).toBe(join(cacheDir, "astro-ph-9707253.tar.gz"));
    expect(statSync(dest).size).toBe(tar.length);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(await f.downloadEprint("astro-ph/9707253")).toBe(dest);
    expect(calls.length).toBe(1);
  });

  test("empty e-print response raises", async () => {
    const { fetchImpl } = stubFetch(() => bytesResponse(new Uint8Array()));
    const f = new ArxivFetcher(tmp(), { userAgent: UA, delay: 0, fetchImpl });
    await expect(f.downloadEprint("1610.08981")).rejects.toThrow("empty e-print response");
  });

  test("extractArxivSource unpacks a tarball; findMainTex picks the driver", () => {
    const dest = join(tmp(), "src");
    extractArxivSource(join(FIXTURES, "eprint-sample.tar.gz"), dest);
    expect(existsSync(join(dest, "main.tex"))).toBe(true);
    expect(existsSync(join(dest, "sec", "body.tex"))).toBe(true);
    // authors.tex matches _NOT_MAIN (-200) and has no \begin{document}
    expect(findMainTex(dest)).toBe(join(dest, "main.tex"));
  });

  test("single gzipped .tex materializes as main.tex", () => {
    const dest = join(tmp(), "src");
    extractArxivSource(join(FIXTURES, "eprint-single.tar.gz"), dest);
    expect(readFileSync(join(dest, "main.tex"), "utf-8")).toContain("\\documentclass{article}");
  });

  test("path-traversal and symlink members are refused (data filter)", () => {
    expect(() =>
      extractArxivSource(join(FIXTURES, "eprint-evil.tar.gz"), join(tmp(), "s"))
    ).toThrow(/outside the destination|unsafe/);
    expect(() =>
      extractArxivSource(join(FIXTURES, "eprint-symlink.tar.gz"), join(tmp(), "s"))
    ).toThrow(/unsafe/);
  });

  test("garbage input is 'neither a tar nor a readable gzip stream'", () => {
    const junk = join(tmp(), "junk.tar.gz");
    writeFileSync(junk, "this is not an archive at all, just plain text bytes.");
    expect(() => extractArxivSource(junk, join(tmp(), "s"))).toThrow(
      /neither a tar nor a readable gzip/
    );
  });

  test("acquireSource end-to-end: arXiv id → cached tarball → unpacked tree", async () => {
    const tar = new Uint8Array(readFileSync(join(FIXTURES, "eprint-sample.tar.gz")));
    const { fetchImpl, calls } = stubFetch(() => bytesResponse(tar));
    const workRoot = tmp();
    const fetcher = new ArxivFetcher(join(tmp(), ".latexcache"), {
      userAgent: UA,
      delay: 0,
      fetchImpl,
    });
    const src = await acquireSource("arXiv:1610.08981v2", workRoot, { fetcher });
    expect(src.docId).toBe("arxiv-1610.08981v2");
    expect(src.arxivId).toBe("1610.08981v2");
    expect(src.origin).toBe("https://arxiv.org/e-print/1610.08981v2");
    expect(src.mainTex).toBe(join(workRoot, "arxiv-1610.08981v2", "src", "main.tex"));
    expect(existsSync(src.mainTex)).toBe(true);
    // idempotent: second acquire reuses cache + extracted tree
    const again = await acquireSource("1610.08981v2", workRoot, { fetcher });
    expect(again.docId).toBe(src.docId);
    expect(calls.length).toBe(1);
  });

  test("acquireSource: local directory / .tex / tarball", async () => {
    const root = tmp();
    const dir = join(root, "paper dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "driver.tex"),
      "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n"
    );
    const { fetchImpl } = stubFetch(() => {
      throw new Error("no network for local sources");
    });
    const fetcher = new ArxivFetcher(join(root, ".latexcache"), {
      userAgent: UA,
      delay: 0,
      fetchImpl,
    });

    const fromDir = await acquireSource(dir, root, { fetcher });
    expect(fromDir.docId).toBe("latex-paper-dir");
    expect(fromDir.mainTex).toBe(join(dir, "driver.tex"));

    const fromTex = await acquireSource(join(dir, "driver.tex"), root, { fetcher });
    expect(fromTex.docId).toBe("latex-driver");
    expect(fromTex.srcDir).toBe(dir);

    const fromTar = await acquireSource(join(FIXTURES, "eprint-sample.tar.gz"), root, { fetcher });
    expect(fromTar.docId).toBe("latex-eprint-sample.tar");
    expect(readFileSync(fromTar.mainTex, "utf-8")).toContain("\\documentclass");

    await expect(acquireSource(join(root, "missing"), root, { fetcher })).rejects.toThrow(
      /neither an arXiv id\/URL nor an existing path/
    );
  });
});
