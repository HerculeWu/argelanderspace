import { useEffect, useRef } from "react";
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
 * - one clickable edge marker per existing annotation on the block (click →
 *   activate + open the popover on it);
 * - the `ann-has` / `ann-active` outline classes on the host block (edge
 *   treatment only — the block body is never tinted).
 */
export function AnnBlockEdge({ id }: { id: string }) {
  const store = useStore();
  const ann = useAnnotations();
  const list = ann.byBlock.get(id) ?? [];
  const activeHere = list.some((a) => a.id === ann.activeId);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
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
          {list.map((a) => (
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
        </span>
      )}
    </span>
  );
}
