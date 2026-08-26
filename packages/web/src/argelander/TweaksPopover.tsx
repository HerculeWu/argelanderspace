import { useEffect, useRef } from "react";
import { ACCENTS, accentHex, type Density, type ThemeName, type Tweaks } from "./theme";

const DENSITIES: Density[] = ["compact", "regular", "comfy"];
const THEMES: ThemeName[] = ["dark", "light"];

export function TweaksPopover({
  tweaks,
  set,
  onClose,
}: {
  tweaks: Tweaks;
  set: <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [onClose]);

  return (
    <div className="tweaks-pop" ref={ref}>
      <div className="tweak-sec">主题</div>
      <div className="tweak-seg">
        {THEMES.map((th) => (
          <button
            key={th}
            className={"tweak-seg-btn" + (tweaks.theme === th ? " on" : "")}
            onClick={() => set("theme", th)}
          >
            {th === "dark" ? "深色" : "浅色"}
          </button>
        ))}
      </div>

      <div className="tweak-sec">强调色</div>
      <div className="tweak-swatches">
        {Object.keys(ACCENTS).map((k) => (
          <button
            key={k}
            className={"tweak-swatch" + (tweaks.accent === k ? " on" : "")}
            title={ACCENTS[k].label}
            style={{ background: accentHex(k, tweaks.theme) }}
            onClick={() => set("accent", k)}
          />
        ))}
      </div>

      <div className="tweak-sec">信息密度</div>
      <div className="tweak-seg">
        {DENSITIES.map((d) => (
          <button
            key={d}
            className={"tweak-seg-btn" + (tweaks.density === d ? " on" : "")}
            onClick={() => set("density", d)}
          >
            {d === "compact" ? "紧凑" : d === "regular" ? "标准" : "宽松"}
          </button>
        ))}
      </div>

      <div className="tweak-sec">布局</div>
      <button className="tweak-toggle" onClick={() => set("labels", !tweaks.labels)}>
        <span>活动栏文字标签</span>
        <span className={"tweak-switch" + (tweaks.labels ? " on" : "")}>
          <span />
        </span>
      </button>
    </div>
  );
}
