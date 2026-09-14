import { useLayoutEffect, useRef } from "react";
import { Icon } from "../lib/icons";
import { useStore } from "../store";
import { useAnnotations } from "./AnnotationStore";
import { buildStructureTarget } from "./model";

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
    <span ref={ref} className="ann-edge" contentEditable={false}>
      <button
        type="button"
        disabled={!ann.canAnnotate}
        hidden={!ann.canAnnotate}
        className="ann-edge-btn"
        title="添加标注"
        aria-label="添加标注"
        onClick={(e) => {
          e.stopPropagation();
          const node = store.blockById.get(id);
          if (node) ann.openCreate(buildStructureTarget(node));
        }}
      >
        <Icon name="message-square-plus" cls="ico-sm" />
      </button>
      {list.length > 0 && (
        <span className="ann-markers">
          {structList.map((a) => (
            <button
              key={a.id}
              type="button"
              className={"ann-marker" + (a.id === ann.activeId ? " active" : "")}
              title="查看标注"
              aria-label="查看标注"
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
              title={`${textList.length} 条文本标注`}
              aria-label={`${textList.length} 条文本标注`}
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
