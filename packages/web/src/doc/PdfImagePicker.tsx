import { PDF_RECTANGLE_MIN } from "@argelanderspace/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionButton, Dialog, InlineMessage } from "../ui";

type Region = { x: number; y: number; width: number; height: number };
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const PREVIEW_EDGE = 900;

/**
 * "Add image from the source PDF" (copilot ticket 29, prototype A's `pdf` dialog): pick a page, optionally drag a
 * region of it in fractions of the VISIBLE page (the PDF Reader's area-tool geometry), preview, add. The page and region
 * are parameters of this one add; nothing about them is stored. The preview is the server's own render of the verified
 * original (the same one the Copilot reads), never a screenshot. Pages are one-based here and zero-based on the wire.
 */
export function PdfImagePicker({
  pdfDocId,
  sha256,
  busy,
  message,
  onAdd,
  onClose,
}: {
  pdfDocId: string;
  sha256: string;
  busy: boolean;
  message: { tone: "info" | "warning" | "danger"; text: string } | null;
  onAdd: (request: { pageIndex: number; region?: Region }) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [failed, setFailed] = useState<"changed" | "error" | null>(null);
  const [page, setPage] = useState(1);
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">("loading");
  const [region, setRegion] = useState<Region | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const pageInput = useRef<HTMLInputElement>(null);
  const base = `/api/paper/${encodeURIComponent(pdfDocId)}/pdf`;

  useEffect(() => {
    const abort = new AbortController();
    void fetch(`${base}/pages?hash=${sha256}&first=0&last=0`, { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (abort.signal.aborted) return;
        if (response.status === 409) return setFailed("changed");
        if (!response.ok) return setFailed("error");
        const body = (await response.json()) as { page_count?: number };
        if (typeof body.page_count === "number" && body.page_count > 0) setPageCount(body.page_count);
        else setFailed("error");
      })
      .catch(() => { if (!abort.signal.aborted) setFailed("error"); });
    return () => abort.abort();
  }, [base, sha256]);

  useEffect(() => { setImageState("loading"); setRegion(null); }, [page]);

  const point = (event: React.PointerEvent) => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
  };
  const rectOf = (a: { x: number; y: number }, b: { x: number; y: number }): Region => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
  const usable = (r: Region) => r.width >= PDF_RECTANGLE_MIN && r.height >= PDF_RECTANGLE_MIN;

  const ready = pageCount !== null && imageState === "ready";
  return (
    <Dialog
      uiId="text-source-pdf-picker"
      width={660}
      title={t("doc.text.pdfPicker.title")}
      closeLabel={t("common.close")}
      initialFocusRef={pageInput}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <ActionButton mode="text" data-ui="cancel-text-pdf-image" label={t("common.cancel")} tooltip={t("common.cancel")} disabled={busy} onClick={onClose}>{t("common.cancel")}</ActionButton>
          <ActionButton mode="text" appearance="primary" data-ui="add-text-pdf-image" label={t("doc.text.pdfPicker.add")} tooltip={t("doc.text.pdfPicker.add")} busy={busy} busyLabel={t("doc.text.assetsUploading")} disabled={!ready} onClick={() => void onAdd({ pageIndex: page - 1, ...(region && usable(region) ? { region } : {}) })}>{t("doc.text.pdfPicker.add")}</ActionButton>
        </>
      }
    >
      <div className="text-pdf-picker" data-ui="text-pdf-picker">
        {failed ? (
          <InlineMessage tone="danger" uiId="text-pdf-picker-error" title={t(failed === "changed" ? "doc.text.pdfPicker.changed" : "doc.text.pdfPicker.error")}>{""}</InlineMessage>
        ) : (
          <>
            <div className="text-pdf-picker-bar">
              <label>
                {t("doc.text.pdfPicker.page")}{" "}
                <input
                  ref={pageInput}
                  type="number"
                  min={1}
                  max={pageCount ?? 1}
                  value={page}
                  data-ui="text-pdf-picker-page"
                  disabled={pageCount === null || busy}
                  onChange={(event) => setPage(Math.min(pageCount ?? 1, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))}
                />
              </label>
              <span data-ui="text-pdf-picker-count">{pageCount === null ? t("doc.loadingPaper") : t("doc.text.pdfPicker.of", { count: pageCount })}</span>
              <span className="text-doc-spacer" />
              <span data-ui="text-pdf-picker-scope" role="status">{region && usable(region) ? t("doc.text.pdfPicker.regionChosen") : t("doc.text.pdfPicker.wholePage")}</span>
              <ActionButton mode="text" data-ui="text-pdf-picker-clear" label={t("doc.text.pdfPicker.clear")} tooltip={t("doc.text.pdfPicker.clear")} disabled={!region || busy} onClick={() => setRegion(null)}>{t("doc.text.pdfPicker.clear")}</ActionButton>
            </div>
            {pageCount !== null && (
              <div
                ref={frame}
                className="text-pdf-picker-frame"
                data-ui="text-pdf-picker-preview"
                data-state={imageState}
                onPointerDown={(event) => {
                  if (!ready || busy) return;
                  const at = point(event);
                  if (!at) return;
                  drag.current = at;
                  setRegion({ ...at, width: 0, height: 0 });
                  try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a synthetic pointer has no capture */ }
                }}
                onPointerMove={(event) => {
                  const start = drag.current;
                  const at = point(event);
                  if (start && at) setRegion(rectOf(start, at));
                }}
                onPointerUp={(event) => {
                  const start = drag.current;
                  drag.current = null;
                  const at = point(event);
                  if (start && at) {
                    const next = rectOf(start, at);
                    setRegion(usable(next) ? next : null);
                  }
                }}
              >
                <img
                  key={page}
                  alt={t("doc.text.pdfPicker.previewAlt", { page })}
                  draggable={false}
                  src={`${base}/pages/${page - 1}/image?hash=${sha256}&edge=${PREVIEW_EDGE}`}
                  onLoad={() => setImageState("ready")}
                  onError={() => setImageState("error")}
                />
                {imageState === "loading" && <div className="text-pdf-picker-overlay">{t("doc.loadingPaper")}</div>}
                {imageState === "error" && <div className="text-pdf-picker-overlay" role="alert" data-ui="text-pdf-picker-image-error">{t("doc.text.pdfPicker.error")}</div>}
                {region && region.width > 0 && region.height > 0 && (
                  <div className="text-pdf-picker-region" data-ui="text-pdf-picker-region" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />
                )}
              </div>
            )}
            {message && message.tone !== "info" && (
              <InlineMessage tone={message.tone} uiId="text-pdf-picker-message" title={t("doc.text.assetsFailedTitle")}>{message.text}</InlineMessage>
            )}
            <small className="text-pdf-picker-help">{t("doc.text.pdfPicker.help")}</small>
          </>
        )}
      </div>
    </Dialog>
  );
}
