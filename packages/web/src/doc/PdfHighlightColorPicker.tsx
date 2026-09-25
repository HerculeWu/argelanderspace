import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "../ui";
import type { PdfHighlightColor } from "@argelanderspace/contracts";

const colors = [
  ["#ffd228", "yellow"], ["#ef8e27", "orange"], ["#df5252", "red"],
  ["#d457a9", "magenta"], ["#805bbb", "purple"], ["#387bd1", "blue"],
  ["#22a6b9", "cyan"], ["#40a25b", "green"], ["#7e8796", "gray"],
] as const satisfies ReadonlyArray<readonly [PdfHighlightColor, string]>;

export function PdfHighlightColorPicker({ value, onChange, disabled = false, ui }: {
  value: PdfHighlightColor;
  onChange: (color: PdfHighlightColor) => void;
  disabled?: boolean;
  ui: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const paletteRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    // The right workbench scrolls independently; keep all nine dots visible below the trigger.
    if (!open || ui !== "pdf-highlight-color-picker" || !paletteRef.current) return;
    const palette = paletteRef.current;
    palette.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const panel = palette.closest<HTMLElement>(".pdf-side");
    if (panel) {
      // Leave room for the Reader's asynchronous reading-position status strip.
      const overflow = palette.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom + 48;
      if (overflow > 0) panel.scrollTop += overflow;
    }
  }, [open, ui]);
  const name = (color: PdfHighlightColor) => {
    const entry = colors.find(([hex]) => hex === color);
    return t(`pdfReader.highlightColors.${entry?.[1] ?? "yellow"}`);
  };
  return <span className="pdf-highlight-color-picker" data-ui={ui}>
    <Tooltip content={t("pdfReader.highlightColor")}><button type="button" className="pdf-highlight-color-current" data-ui="pdf-highlight-color-current" data-ui-key={ui}
      aria-label={t("pdfReader.highlightColor")} aria-expanded={open} disabled={disabled} style={{ "--pdf-highlight-color": value } as CSSProperties}
      onClick={() => setOpen((wasOpen) => !wasOpen)} /></Tooltip>
    {open && <span ref={paletteRef} className="pdf-highlight-color-palette" data-ui={`${ui}-palette`} role="group" aria-label={t("pdfReader.highlightColor")}>
      {colors.map(([color]) => <Tooltip key={color} content={name(color)}><button type="button" className="pdf-highlight-color-swatch"
        data-ui={`${ui}-swatch`} data-ui-key={color} aria-label={name(color)}
        aria-pressed={value === color} style={{ "--pdf-highlight-color": color } as CSSProperties}
        disabled={disabled} onClick={() => { onChange(color); setOpen(false); }} /></Tooltip>)}
    </span>}
  </span>;
}
