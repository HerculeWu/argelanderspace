/**
 * MinerU v4 high-precision (VLM) extraction client
 * (`bibgraph/mineru_client.py`). Flow (file-upload variant):
 *
 *   1. POST /api/v4/file-urls/batch   -> {batch_id, file_urls:[signed_put_url]}
 *   2. PUT the PDF bytes to the signed URL (no auth header, no content-type)
 *   3. GET  /api/v4/extract-results/batch/{batch_id}  (poll until done/failed)
 *   4. download `full_zip_url`, unzip -> content_list.json / middle.json / images/
 *
 * The unzipped artifacts are cached under `<outDir>/mineru/` so re-runs are
 * offline (`loadCached`). All network goes through the injected `fetchImpl`;
 * tests use recorded fixtures and never touch the live API.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { MineruArtifacts, MineruContentList } from "@argelanderspace/core";
import { type FetchImpl, fetchBytes, sleep } from "../lib/http.js";
import { extractZip } from "../lib/unzip.js";

export const MINERU_BASE_URL = "https://mineru.net";
export const MINERU_API_KEY_ENV = "MINERU_API_KEY";

/** `config.MineruConfig` — one extraction task's options. */
export interface MineruConfig {
  /** "vlm" = high precision (layout+OCR+formula+code). */
  modelVersion?: string;
  /** 'ch' covers zh+en; 'en' for english papers. */
  language?: string;
  enableFormula?: boolean;
  enableTable?: boolean;
  /** e.g. "1-10"; undefined = whole document. */
  pageRanges?: string;
  extraFormats?: string[];
  /** undefined → auto-detect from text layer; true/false → force. */
  isOcr?: boolean | null;
}

export class MineruError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MineruError";
  }
}

/** `MineruResult` — parsed artifacts from one extraction. */
export interface MineruResult extends MineruArtifacts {
  outDir: string;
  imagesDir?: string;
}

/** `MineruConfig.api_key()`: `$MINERU_API_KEY`, or throw. */
export function mineruApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env[MINERU_API_KEY_ENV] ?? "").trim();
  if (!key) throw new MineruError(`Environment variable ${MINERU_API_KEY_ENV} is not set.`);
  return key;
}

/** Sorted recursive glob (`sorted(root.rglob(pattern))`, `*` suffix patterns). */
function findFirst(root: string, suffixPattern: string): string | undefined {
  const suffix = suffixPattern.replace(/^\*/, "");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(suffix)) out.push(p);
    }
  };
  walk(root);
  out.sort();
  return out[0];
}

export interface MineruClientOptions {
  config?: MineruConfig;
  /** API key override; default `mineruApiKey()` (throws when unset). */
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
}

export class MineruClient {
  private readonly config: Required<
    Pick<MineruConfig, "modelVersion" | "language" | "enableFormula" | "enableTable">
  > &
    MineruConfig;
  private readonly apiKey: string;
  private readonly base: string;
  private readonly fetchImpl: FetchImpl;
  private readonly log?: (msg: string) => void;

  constructor(opts: MineruClientOptions = {}) {
    const cfg = opts.config ?? {};
    this.config = {
      modelVersion: cfg.modelVersion ?? "vlm",
      language: cfg.language ?? "en",
      enableFormula: cfg.enableFormula ?? true,
      enableTable: cfg.enableTable ?? true,
      pageRanges: cfg.pageRanges,
      extraFormats: cfg.extraFormats ?? [],
      isOcr: cfg.isOcr ?? null,
    };
    this.apiKey = opts.apiKey ?? mineruApiKey();
    this.base = (opts.baseUrl ?? MINERU_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
  }

  // ---- public API -------------------------------------------------------- //

  /**
   * Run a full extraction and return parsed artifacts. With `useCache` and a
   * previous unzip under `<outDir>/mineru`, the cache is returned offline.
   *
   * Bug-for-bug: the cache probe checks for a LITERAL `content_list.json`
   * filename exactly like the Python, but real MinerU zips unpack to
   * `<uuid>_content_list.json` — so on real layouts the probe never fires and
   * a re-ingest re-runs the full flow. Fix after TS acceptance, not in M2.
   */
  async extract(
    pdfPath: string,
    outDir: string,
    opts: { pollInterval?: number; pollTimeout?: number; useCache?: boolean } = {}
  ): Promise<MineruResult> {
    const pollInterval = opts.pollInterval ?? 5.0;
    const pollTimeout = opts.pollTimeout ?? 1800.0;
    const useCache = opts.useCache ?? true;
    const cacheDir = join(outDir, "mineru");
    if (useCache && existsSync(join(cacheDir, "content_list.json"))) {
      this.log?.(`Using cached MinerU artifacts in ${cacheDir}`);
      return MineruClient.loadCached(cacheDir);
    }
    const { batchId, putUrl } = await this.requestUploadUrl(pdfPath);
    await this.upload(putUrl, pdfPath);
    const zipUrl = await this.poll(batchId, pollInterval, pollTimeout);
    return this.downloadAndUnzip(zipUrl, cacheDir, batchId);
  }

  /** Load previously unzipped artifacts from a cache dir. */
  static loadCached(cacheDir: string): MineruResult {
    const contentListPath = findFirst(cacheDir, "*content_list.json");
    if (!contentListPath) {
      throw new MineruError(`Expected file matching *content_list.json under ${cacheDir}`);
    }
    const contentList = JSON.parse(readFileSync(contentListPath, "utf-8")) as MineruContentList;
    const middlePath = findFirst(cacheDir, "*middle.json");
    const middle = middlePath
      ? (JSON.parse(readFileSync(middlePath, "utf-8")) as Record<string, unknown>)
      : undefined;
    const mdPath = findFirst(cacheDir, "*.md");
    const images = join(cacheDir, "images");
    return {
      outDir: cacheDir,
      contentList,
      middle,
      fullMd: mdPath ? readFileSync(mdPath, "utf-8") : undefined,
      imagesDir: isDir(images) ? images : undefined,
    };
  }

  // ---- internal steps ---------------------------------------------------- //

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "*/*",
    };
  }

  private async requestUploadUrl(pdfPath: string): Promise<{ batchId: string; putUrl: string }> {
    const cfg = this.config;
    const fileEntry: Record<string, unknown> = {
      name: basename(pdfPath),
      data_id: basename(pdfPath).replace(/\.[^.]*$/, ""),
      is_ocr: Boolean(cfg.isOcr),
    };
    if (cfg.pageRanges) fileEntry.page_ranges = cfg.pageRanges;
    const body: Record<string, unknown> = {
      files: [fileEntry],
      model_version: cfg.modelVersion,
      enable_formula: cfg.enableFormula,
      enable_table: cfg.enableTable,
      language: cfg.language,
    };
    if (cfg.extraFormats && cfg.extraFormats.length > 0) body.extra_formats = cfg.extraFormats;
    const url = `${this.base}/api/v4/file-urls/batch`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await apiJson(res);
    const batchId = data.batch_id as string | undefined;
    if (!batchId) throw new MineruError(`No batch_id in upload response: ${JSON.stringify(data)}`);
    const fileUrls = (data.file_urls as string[] | undefined) ?? [];
    const putUrl = fileUrls[0];
    if (!putUrl) throw new MineruError(`No upload URL returned: ${JSON.stringify(data)}`);
    return { batchId, putUrl };
  }

  private async upload(putUrl: string, pdfPath: string): Promise<void> {
    // IMPORTANT: no Authorization and no Content-Type on the signed PUT.
    const res = await this.fetchImpl(putUrl, {
      method: "PUT",
      body: new Uint8Array(readFileSync(pdfPath)),
      signal: AbortSignal.timeout(300_000),
    });
    if (res.status !== 200 && res.status !== 201) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      throw new MineruError(`Upload failed: HTTP ${res.status} ${text}`);
    }
  }

  private async poll(batchId: string, interval: number, timeout: number): Promise<string> {
    const url = `${this.base}/api/v4/extract-results/batch/${batchId}`;
    let elapsed = 0;
    let lastState: string | undefined;
    for (;;) {
      const res = await this.fetchImpl(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(60_000),
      });
      const data = await apiJson(res);
      const results = (data.extract_result as Array<Record<string, unknown>> | undefined) ?? [];
      const r = results[0];
      if (r) {
        const state = r.state as string | undefined;
        if (state !== lastState) {
          this.log?.(`MinerU task state: ${state}`);
          lastState = state;
        }
        if (state === "done") {
          const zipUrl = r.full_zip_url as string | undefined;
          if (!zipUrl) throw new MineruError(`done but no full_zip_url: ${JSON.stringify(r)}`);
          return zipUrl;
        }
        if (state === "failed") {
          throw new MineruError(`MinerU extraction failed: ${String(r.err_msg)}`);
        }
      }
      if (elapsed >= timeout) {
        throw new MineruError(`Timed out after ${timeout}s (batch=${batchId})`);
      }
      await sleep(interval);
      elapsed += interval;
    }
  }

  private async downloadAndUnzip(
    zipUrl: string,
    cacheDir: string,
    batchId: string
  ): Promise<MineruResult> {
    this.log?.("Downloading result zip");
    const { bytes } = await fetchBytes(this.fetchImpl, zipUrl, { timeout: 300 });
    mkdirSync(cacheDir, { recursive: true });
    extractZip(bytes, cacheDir);
    const result = MineruClient.loadCached(cacheDir);
    result.batchId = batchId;
    return result;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `_api_json`: validate a MinerU API response and return its `data` payload. */
async function apiJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new MineruError(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const code = payload.code;
  if (code !== 0 && code !== "0" && code !== 200 && code !== null && code !== undefined) {
    throw new MineruError(
      `API error code=${String(code)}: ${String(payload.msg)} (trace=${String(payload.trace_id)})`
    );
  }
  if (res.status >= 400) throw new MineruError(`HTTP ${res.status}: ${JSON.stringify(payload)}`);
  return (payload.data as Record<string, unknown> | undefined) ?? {};
}
