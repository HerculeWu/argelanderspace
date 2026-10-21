import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { Button } from "../ui";

/** A block of prepared text with a copy action; a refused clipboard is said as such, never as copied. */
export function PreparedText({ label, text, uiKey }: { label: string; text: string; uiKey: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    window.clearTimeout(timer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setState("copied");
      timer.current = window.setTimeout(() => setState("idle"), 1600);
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="tut-prepared" data-ui="tutorial-prepared-text" data-ui-key={uiKey}>
      <div className="tut-prepared-head">
        <span>{label}</span>
        <Button unstyled className={"btn ghost" + (state === "copied" ? " ok" : "")} data-ui="copy-tutorial-text" data-ui-key={uiKey} onClick={() => void copy()}>
          <Icon name={state === "copied" ? "check" : "copy"} cls="ico-sm" />
          {state === "copied" ? t("tutorial.ui.copied") : t("tutorial.ui.copy")}
        </Button>
      </div>
      <pre>{text}</pre>
      {state === "failed" && (
        <div className="tut-prepared-error" role="alert" data-ui="tutorial-copy-failed">
          {t("tutorial.ui.copyFailed")}
        </div>
      )}
    </div>
  );
}
