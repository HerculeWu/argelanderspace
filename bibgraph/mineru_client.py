"""MinerU v4 high-precision (VLM) extraction client.

Flow (file-upload variant, recommended over URL submission):

  1. POST /api/v4/file-urls/batch   -> {batch_id, file_urls:[signed_put_url]}
  2. PUT the PDF bytes to the signed URL (no auth header, no content-type)
  3. GET  /api/v4/extract-results/batch/{batch_id}  (poll until done/failed)
  4. download `full_zip_url`, unzip -> content_list.json / middle.json / images/

The unzipped artifacts are cached under ``<out_dir>/mineru/`` so re-runs can be
done offline with ``MineruClient.load_cached`` (handy while iterating on the
parsers without spending API quota).
"""

from __future__ import annotations

import io
import json
import logging
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

from .config import MINERU_BASE_URL, MineruConfig

log = logging.getLogger("bibgraph.mineru")


@dataclass
class MineruResult:
    """Parsed artifacts from one MinerU extraction."""

    out_dir: Path
    content_list: list[dict[str, Any]]
    middle: dict[str, Any]
    full_md: str | None = None
    images_dir: Path | None = None
    batch_id: str | None = None
    raw_meta: dict[str, Any] | None = None


class MineruError(RuntimeError):
    pass


class MineruClient:
    def __init__(self, config: MineruConfig | None = None,
                 session: requests.Session | None = None):
        self.config = config or MineruConfig()
        self.session = session or requests.Session()
        self.base = MINERU_BASE_URL.rstrip("/")

    # ---- public API -------------------------------------------------------- #
    def extract(self, pdf_path: str | Path, out_dir: str | Path,
                poll_interval: float = 5.0, poll_timeout: float = 1800.0,
                use_cache: bool = True) -> MineruResult:
        """Run a full extraction and return parsed artifacts.

        If ``use_cache`` and a previous unzip exists under ``out_dir/mineru``,
        the cached artifacts are returned without calling the API.
        """
        pdf_path = Path(pdf_path)
        out_dir = Path(out_dir)
        cache_dir = out_dir / "mineru"
        if use_cache and (cache_dir / "content_list.json").exists():
            log.info("Using cached MinerU artifacts in %s", cache_dir)
            return self.load_cached(cache_dir)

        batch_id, put_url = self._request_upload_url(pdf_path)
        self._upload(put_url, pdf_path)
        zip_url = self._poll(batch_id, poll_interval, poll_timeout)
        return self._download_and_unzip(zip_url, cache_dir, batch_id)

    @staticmethod
    def load_cached(cache_dir: str | Path) -> MineruResult:
        cache_dir = Path(cache_dir)
        content_list = json.loads(_find(cache_dir, "*content_list.json").read_text("utf-8"))
        middle_p = _find_opt(cache_dir, "*middle.json")
        middle = json.loads(middle_p.read_text("utf-8")) if middle_p else {}
        md_p = _find_opt(cache_dir, "*.md")
        images = cache_dir / "images"
        return MineruResult(
            out_dir=cache_dir,
            content_list=content_list,
            middle=middle,
            full_md=md_p.read_text("utf-8") if md_p else None,
            images_dir=images if images.exists() else None,
        )

    # ---- internal steps ---------------------------------------------------- #
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.config.api_key()}",
                "Content-Type": "application/json", "Accept": "*/*"}

    def _request_upload_url(self, pdf_path: Path) -> tuple[str, str]:
        cfg = self.config
        file_entry: dict[str, Any] = {
            "name": pdf_path.name,
            "data_id": pdf_path.stem,
            "is_ocr": bool(cfg.is_ocr),
        }
        if cfg.page_ranges:
            file_entry["page_ranges"] = cfg.page_ranges
        body: dict[str, Any] = {
            "files": [file_entry],
            "model_version": cfg.model_version,
            "enable_formula": cfg.enable_formula,
            "enable_table": cfg.enable_table,
            "language": cfg.language,
        }
        if cfg.extra_formats:
            body["extra_formats"] = cfg.extra_formats

        url = f"{self.base}/api/v4/file-urls/batch"
        log.info("Requesting MinerU upload URL (model=%s, lang=%s, ocr=%s)",
                 cfg.model_version, cfg.language, bool(cfg.is_ocr))
        resp = self.session.post(url, headers=self._headers(), json=body, timeout=60)
        data = _api_json(resp)
        batch_id = data.get("batch_id")
        if not batch_id:
            raise MineruError(f"No batch_id in upload response: {data}")
        file_urls = data.get("file_urls") or []
        if not file_urls:
            raise MineruError(f"No upload URL returned: {data}")
        return batch_id, file_urls[0]

    def _upload(self, put_url: str, pdf_path: Path) -> None:
        log.info("Uploading %s (%.1f KB)", pdf_path.name,
                 pdf_path.stat().st_size / 1024)
        with open(pdf_path, "rb") as fh:
            # IMPORTANT: no Authorization and no Content-Type on the signed PUT.
            resp = requests.put(put_url, data=fh, timeout=300)
        if resp.status_code not in (200, 201):
            raise MineruError(
                f"Upload failed: HTTP {resp.status_code} {resp.text[:300]}")

    def _poll(self, batch_id: str, interval: float, timeout: float) -> str:
        url = f"{self.base}/api/v4/extract-results/batch/{batch_id}"
        deadline = None
        elapsed = 0.0
        last_state = None
        while True:
            resp = self.session.get(url, headers=self._headers(), timeout=60)
            data = _api_json(resp)
            results = data.get("extract_result") or []
            if results:
                r = results[0]
                state = r.get("state")
                if state != last_state:
                    log.info("MinerU task state: %s", state)
                    last_state = state
                if state == "done":
                    zip_url = r.get("full_zip_url")
                    if not zip_url:
                        raise MineruError(f"done but no full_zip_url: {r}")
                    return zip_url
                if state == "failed":
                    raise MineruError(
                        f"MinerU extraction failed: {r.get('err_msg')}")
                # progress for vlm/pipeline may be reported in 'extract_progress'
                prog = r.get("extract_progress")
                if prog:
                    log.info("  progress: %s/%s pages",
                             prog.get("extracted_pages"), prog.get("total_pages"))
            if elapsed >= timeout:
                raise MineruError(f"Timed out after {timeout}s (batch={batch_id})")
            time.sleep(interval)
            elapsed += interval

    def _download_and_unzip(self, zip_url: str, cache_dir: Path,
                            batch_id: str) -> MineruResult:
        log.info("Downloading result zip")
        resp = requests.get(zip_url, timeout=300)
        resp.raise_for_status()
        cache_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            zf.extractall(cache_dir)
        result = self.load_cached(cache_dir)
        result.batch_id = batch_id
        return result


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _api_json(resp: requests.Response) -> dict[str, Any]:
    """Validate a MinerU API response and return its ``data`` payload."""
    try:
        payload = resp.json()
    except ValueError:
        raise MineruError(f"Non-JSON response (HTTP {resp.status_code}): "
                          f"{resp.text[:300]}")
    code = payload.get("code")
    if code not in (0, "0", 200, None):
        raise MineruError(f"API error code={code}: {payload.get('msg')} "
                          f"(trace={payload.get('trace_id')})")
    if resp.status_code >= 400:
        raise MineruError(f"HTTP {resp.status_code}: {payload}")
    return payload.get("data") or {}


def _find(root: Path, pattern: str) -> Path:
    p = _find_opt(root, pattern)
    if p is None:
        raise MineruError(f"Expected file matching {pattern} under {root}")
    return p


def _find_opt(root: Path, pattern: str) -> Path | None:
    matches = sorted(root.rglob(pattern))
    return matches[0] if matches else None
