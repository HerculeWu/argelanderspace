/**
 * The zoom control stack shared by every graph renderer: zoom in/out with the
 * current percentage, fit to window, and re-layout. Pure presentation; the
 * renderer owns the view state and passes the actions.
 */

import { useTranslation } from "react-i18next";
import { ActionButton } from "../ui";

export function GraphZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  onRelayout,
}: {
  /** Current scale, 1 = 100%. */
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onRelayout: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="cg-zoom" data-ui="graph-zoom-controls">
      <ActionButton unstyled mode="icon" iconName="plus" appearance="quiet" iconSize="small" className="cg-zbtn" label={t("graph.zoomIn")} tooltip={t("graph.zoomIn")} data-testid="zoom-in" data-ui="zoom-in" onClick={onZoomIn} />
      <span className="zoom-value mono">{Math.round(zoom * 100)}%</span>
      <ActionButton unstyled mode="icon" iconName="minus" appearance="quiet" iconSize="small" className="cg-zbtn" label={t("graph.zoomOut")} tooltip={t("graph.zoomOut")} data-ui="zoom-out" onClick={onZoomOut} />
      <ActionButton unstyled mode="icon" iconName="expand" className="cg-zbtn" label={t("graph.fitView")} tooltip={t("graph.fitView")} data-testid="fit-view" data-ui="fit-graph" onClick={onFit} />
      <ActionButton unstyled mode="icon" iconName="rotate-ccw" className="cg-zbtn" label={t("graph.relayout")} tooltip={t("graph.relayout")} data-ui="relayout-graph" onClick={onRelayout} />
    </div>
  );
}
