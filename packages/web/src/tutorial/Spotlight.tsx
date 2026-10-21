/** Four shades around the anchor and an accent ring on it (prototype B). The shades never take a click. */
export function Spotlight({ rect, pulse }: { rect: DOMRect; pulse: boolean }) {
  const pad = 6;
  const t = Math.max(rect.top - pad, 0);
  const l = Math.max(rect.left - pad, 0);
  const r = Math.min(rect.right + pad, window.innerWidth);
  const b = Math.min(rect.bottom + pad, window.innerHeight);
  return (
    <>
      <div className="tut-shade" data-ui="tutorial-shade" data-ui-key="top" style={{ top: 0, left: 0, right: 0, height: t }} />
      <div className="tut-shade" data-ui="tutorial-shade" data-ui-key="bottom" style={{ top: b, left: 0, right: 0, bottom: 0 }} />
      <div className="tut-shade" data-ui="tutorial-shade" data-ui-key="left" style={{ top: t, left: 0, width: l, height: b - t }} />
      <div className="tut-shade" data-ui="tutorial-shade" data-ui-key="right" style={{ top: t, left: r, right: 0, height: b - t }} />
      <div className={"tut-ring" + (pulse ? " pulse" : "")} data-ui="tutorial-highlight" style={{ top: t, left: l, width: r - l, height: b - t }} />
    </>
  );
}
