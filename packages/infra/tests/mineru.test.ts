/**
 * MinerU client (mineru_client.py) — fully offline: the submit / upload /
 * poll / download flow runs against a stub fetch and the fixture result zip.
 * The live API is never called.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { MineruClient } from "../src/mineru/client.js";
import { bytesResponse, jsonResponse, stubFetch } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));
const ZIP = new Uint8Array(readFileSync(join(FIXTURES, "mineru-result.zip")));

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "m2-mineru-"));
}

function fakePdf(): string {
  const dir = tmp();
  const p = join(dir, "paper.pdf");
  writeFileSync(p, "%PDF-1.4 fake\n");
  return p;
}

/** Stub covering the whole happy-path flow. */
function happyFetch() {
  return stubFetch((c) => {
    if (c.url.endsWith("/api/v4/file-urls/batch")) {
      return jsonResponse({
        code: 0,
        data: { batch_id: "batch-1", file_urls: ["https://put.example/signed"] },
      });
    }
    if (c.url === "https://put.example/signed") return new Response(null, { status: 200 });
    if (c.url.endsWith("/api/v4/extract-results/batch/batch-1")) {
      return jsonResponse({
        code: 0,
        data: { extract_result: [{ state: "done", full_zip_url: "https://dl.example/r.zip" }] },
      });
    }
    if (c.url === "https://dl.example/r.zip") return bytesResponse(ZIP);
    throw new Error(`unexpected call: ${c.url}`);
  });
}

describe("MineruClient (mineru_client.py)", () => {
  test("extract: submit → upload → poll → unzip → parsed artifacts", async () => {
    const { fetchImpl, calls } = happyFetch();
    const client = new MineruClient({ apiKey: "K", fetchImpl });
    const outDir = join(tmp(), "out");
    const result = await client.extract(fakePdf(), outDir, { pollInterval: 0, pollTimeout: 10 });

    // request sequence and shapes
    expect(calls.map((c) => c.method)).toEqual(["POST", "PUT", "GET", "GET"]);
    const submit = JSON.parse(calls[0]?.bodyText ?? "{}") as Record<string, unknown>;
    expect(submit.model_version).toBe("vlm");
    expect(submit.language).toBe("en");
    expect(submit.enable_formula).toBe(true);
    expect((submit.files as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "paper.pdf",
      data_id: "paper",
      is_ocr: false,
    });
    // the signed PUT carries no Authorization header
    expect(calls[1]?.headers.Authorization).toBeUndefined();
    expect(calls[0]?.headers.Authorization).toBe("Bearer K");

    // artifacts from the fixture zip, cached under <outDir>/mineru
    expect(result.batchId).toBe("batch-1");
    expect(result.outDir).toBe(join(outDir, "mineru"));
    expect(result.contentList[0]?.text).toBe("Hello from MinerU");
    expect(result.middle?._parse_type).toBe("vlm");
    expect(result.fullMd).toContain("# Hello from MinerU");
    expect(result.imagesDir).toBe(join(outDir, "mineru", "images"));
    expect(existsSync(join(outDir, "mineru", "0c2354f1_content_list.json"))).toBe(true);
  });

  test("cache short-circuit: literal content_list.json present → offline (bug-for-bug)", async () => {
    // Python's use_cache check is `(cache_dir / "content_list.json").exists()` —
    // a LITERAL filename. Real MinerU zips unpack to `<uuid>_content_list.json`,
    // so the check never fires on a real layout and a re-run re-uploads (a
    // preserved Python bug). Here we plant the literal filename to exercise
    // the intended cache path.
    const { fetchImpl, calls } = happyFetch();
    const client = new MineruClient({ apiKey: "K", fetchImpl });
    const pdf = fakePdf();
    const outDir = join(tmp(), "out");
    await client.extract(pdf, outDir, { pollInterval: 0, pollTimeout: 10 });
    expect(calls.length).toBe(4);
    // plant the literal marker — the only shape the Python check recognizes
    const marker = join(outDir, "mineru", "content_list.json");
    writeFileSync(marker, readFileSync(join(outDir, "mineru", "0c2354f1_content_list.json")));
    const cached = await client.extract(pdf, outDir, { pollInterval: 0, pollTimeout: 10 });
    expect(calls.length).toBe(4); // served from disk
    expect(cached.contentList[0]?.text).toBe("Hello from MinerU");
    expect(cached.batchId).toBeUndefined(); // loadCached knows no batch id
  });

  test("uuid-prefixed-only cache does NOT short-circuit (preserved Python bug)", async () => {
    const { fetchImpl, calls } = happyFetch();
    const client = new MineruClient({ apiKey: "K", fetchImpl });
    const pdf = fakePdf();
    const outDir = join(tmp(), "out");
    await client.extract(pdf, outDir, { pollInterval: 0, pollTimeout: 10 });
    // the extracted tree has only 0c2354f1_content_list.json → the literal
    // content_list.json check misses and the full flow re-runs, as in Python.
    const again = await client.extract(pdf, outDir, { pollInterval: 0, pollTimeout: 10 });
    expect(calls.length).toBe(8);
    expect(again.batchId).toBe("batch-1");
  });

  test("is_ocr=true and page_ranges are sent through", async () => {
    const { fetchImpl, calls } = happyFetch();
    const client = new MineruClient({
      apiKey: "K",
      fetchImpl,
      config: { isOcr: true, pageRanges: "1-10" },
    });
    await client.extract(fakePdf(), join(tmp(), "o"), { pollInterval: 0, pollTimeout: 10 });
    const submit = JSON.parse(calls[0]?.bodyText ?? "{}") as Record<string, unknown>;
    expect((submit.files as Array<Record<string, unknown>>)[0]).toMatchObject({
      is_ocr: true,
      page_ranges: "1-10",
    });
  });

  test("failed task raises MineruError with err_msg", async () => {
    const { fetchImpl } = stubFetch((c) => {
      if (c.url.endsWith("file-urls/batch")) {
        return jsonResponse({
          code: 0,
          data: { batch_id: "b", file_urls: ["https://put.example/s"] },
        });
      }
      if (c.url === "https://put.example/s") return new Response(null, { status: 200 });
      return jsonResponse({
        code: 0,
        data: { extract_result: [{ state: "failed", err_msg: "corrupt PDF" }] },
      });
    });
    const client = new MineruClient({ apiKey: "K", fetchImpl });
    await expect(client.extract(fakePdf(), join(tmp(), "o"), { pollInterval: 0 })).rejects.toThrow(
      /MinerU extraction failed: corrupt PDF/
    );
  });

  test("API error code raises before any upload", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ code: 50010, msg: "quota exhausted", trace_id: "t-1", data: {} })
    );
    const client = new MineruClient({ apiKey: "K", fetchImpl });
    await expect(client.extract(fakePdf(), join(tmp(), "o"))).rejects.toThrow(/quota exhausted/);
  });

  test("non-JSON response raises a MineruError naming the HTTP status", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response("<html>Bad Gateway</html>", { status: 502 })
    );
    const client = new MineruClient({ apiKey: "K", fetchImpl });
    await expect(client.extract(fakePdf(), join(tmp(), "o"))).rejects.toThrow(
      /Non-JSON response \(HTTP 502\)/
    );
  });

  test("poll timeout raises", async () => {
    const { fetchImpl } = stubFetch((c) => {
      if (c.url.endsWith("file-urls/batch")) {
        return jsonResponse({
          code: 0,
          data: { batch_id: "b", file_urls: ["https://put.example/s"] },
        });
      }
      if (c.url === "https://put.example/s") return new Response(null, { status: 200 });
      return jsonResponse({ code: 0, data: { extract_result: [{ state: "running" }] } });
    });
    const client = new MineruClient({ apiKey: "K", fetchImpl });
    await expect(
      client.extract(fakePdf(), join(tmp(), "o"), { pollInterval: 0.05, pollTimeout: 0.05 })
    ).rejects.toThrow(/Timed out after 0\.05s/);
  });

  test("missing API key is a clear error", () => {
    const saved = process.env.MINERU_API_KEY;
    delete process.env.MINERU_API_KEY;
    try {
      expect(() => new MineruClient({})).toThrow(/MINERU_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.MINERU_API_KEY = saved;
    }
  });

  test("loadCached round-trips the unzipped layout", async () => {
    const { fetchImpl } = happyFetch();
    const client = new MineruClient({ apiKey: "K", fetchImpl });
    const outDir = join(tmp(), "out");
    await client.extract(fakePdf(), outDir, { pollInterval: 0 });
    const loaded = MineruClient.loadCached(join(outDir, "mineru"));
    expect(loaded.contentList[0]?.bbox).toEqual([50, 50, 500, 100]);
    expect(loaded.fullMd).toContain("# Hello");
  });
});
