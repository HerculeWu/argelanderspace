import { useTranslation } from "react-i18next";
import type { PdfLinkAnnoObject, PdfLinkTarget, PdfPageObject } from "@embedpdf/models";
import { isPdfLinkTargetAllowed } from "./pdf-navigation";

type PdfPageGeometry = Pick<PdfPageObject, "size" | "rotation">;
const RECT_BOUND_TOLERANCE = 1e-6;

function normalizePdfLinkRect(rect: PdfLinkAnnoObject["rect"], page: PdfPageGeometry): { x: number; y: number; width: number; height: number } | null {
  const { width: pageWidth, height: pageHeight } = page.size;
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0) return null;
  const { x: originX, y: originY } = rect.origin;
  const { width: rectWidth, height: rectHeight } = rect.size;
  if (![originX, originY, rectWidth, rectHeight].every(Number.isFinite) || rectWidth <= 0 || rectHeight <= 0) return null;
  const x = originX / pageWidth;
  const y = originY / pageHeight;
  const right = x + rectWidth / pageWidth;
  const bottom = y + rectHeight / pageHeight;
  if (x < -RECT_BOUND_TOLERANCE || y < -RECT_BOUND_TOLERANCE || right > 1 + RECT_BOUND_TOLERANCE || bottom > 1 + RECT_BOUND_TOLERANCE) return null;
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const clippedRight = Math.min(1, right);
  const clippedBottom = Math.min(1, bottom);
  if (clippedRight <= left || clippedBottom <= top) return null;
  return { x: left, y: top, width: clippedRight - left, height: clippedBottom - top };
}

export function PdfLinkHitLayer({ pageIndex, pageCount, geometry, links, onNavigate }: { pageIndex: number; pageCount: number; geometry: PdfPageGeometry | undefined; links: PdfLinkAnnoObject[]; onNavigate: (target: PdfLinkTarget) => void }) {
  const { t } = useTranslation();
  if (!geometry) return null;
  return <div className="pdf-link-hit-layer" data-pdf-page-index={pageIndex} role="group" aria-label={t("pdfReader.pdfLinks")}>
    {links.filter((link) => link.pageIndex === pageIndex && isPdfLinkTargetAllowed(link.target, pageCount)).map((link) => {
      const target = link.target;
      if (!target) return null;
      const rect = normalizePdfLinkRect(link.rect, geometry);
      if (!rect) return null;
      // Link rects are in the SDK's original page space; the ancestor Rotate transforms this layer too.
      return <button key={link.id} type="button" data-pdf-native-link={link.id} aria-label={t("pdfReader.openPdfLink")} className="pdf-native-link" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} onClick={() => onNavigate(target)} />;
    })}
  </div>;
}
