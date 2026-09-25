import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { useAnnotations } from "./AnnotationStore";
import { buildStructureTarget } from "./model";
import { ActionButton } from "../ui";

/**
 * Per-block annotation affordance (Stage 8 MS3), rendered inside every
 * `[data-block-id]` element (BlockView's seven kinds + SectionView headings):
 * - a hover-revealed edge button (CSS-only reveal, the `.fig-invert-btn`
 *   precedent) that opens the creation popover with the block's structure
 *   target (snapshot built here, at creation time);
 * - one clickable edge marker per existing STRUCTURE annotation on the block
 *   (click → activate + open the popover on it);
 * - MS4: ONE aggregate count marker for the block's TEXT annotations (the
 *   ranges themselves paint via the Custom Highlight API) — click opens the
 *   popover directly when the block has exactly one text annotation, and the
 *   multi-hit chooser when it has several;
 * - the `ann-has` / `ann-active` outline classes on the host block (edge
 *   treatment only — the block body is never tinted).
 */
export function AnnBlockEdge({ id }: { id: string }) {
  const store = useStore();
  const ann = useAnnotations();
  const { t } = useTranslation();
  const list = ann.byBlock.get(id) ?? [];
  const structList = list.filter((a) => a.target.type !== "text");
  const textList = list.filter((a) => a.target.type === "text");
  const activeHere = list.some((a) => a.id === ann.activeId);
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const host = ref.current?.closest("[data-block-id]");
    if (!host) return;
    host.classList.toggle("ann-has", list.length > 0);
    host.classList.toggle("ann-active", activeHere);
    return () => host.classList.remove("ann-has", "ann-active");
  }, [list.length, activeHere]);

  return (
    <span ref={ref} className="ann-edge" data-ui="latex-annotation-gutter" data-ui-key={id} contentEditable={false}>
      <ActionButton
        unstyled
        mode="icon"
        iconName="message-square-plus"
        label={t("annotation.action.add")}
        tooltip={t("annotation.action.add")}
        disabled={!ann.canAnnotate}
        hidden={!ann.canAnnotate}
        className="ann-edge-btn"
        data-ui="annotate-latex-block"
        onClick={(e) => {
          e.stopPropagation();
          const node = store.blockById.get(id);
          if (node) ann.openCreate(buildStructureTarget(node));
        }}
      />
      {list.length > 0 && (
        <span className="ann-markers">
          {structList.map((a) => (
            <button
              key={a.id}
              type="button"
              className={"ann-marker" + (a.id === ann.activeId ? " active" : "")} data-ui="latex-annotation-marker" data-ui-key={a.id}
              title={t("annotation.action.view")}
              aria-label={t("annotation.action.view")}
              onClick={(e) => {
                e.stopPropagation();
                ann.openView(a.id);
              }}
            />
          ))}
          {textList.length > 0 && (
            <button
              type="button"
              className={
                "ann-count" + (textList.some((a) => a.id === ann.activeId) ? " active" : "")
              }
              data-ui="latex-text-annotation-count"
              title={t("annotation.edge.textCount", { count: textList.length })}
              aria-label={t("annotation.edge.textCount", { count: textList.length })}
              onClick={(e) => {
                e.stopPropagation();
                if (textList.length === 1) {
                  ann.openView(textList[0]!.id);
                } else {
                  const r = e.currentTarget.getBoundingClientRect();
                  ann.openChooser(
                    textList.map((a) => a.id),
                    r.left,
                    r.bottom + 6
                  );
                }
              }}
            >
              {textList.length}
            </button>
          )}
        </span>
      )}
    </span>
  );
}
