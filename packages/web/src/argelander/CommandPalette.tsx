import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";

interface Cmd {
  ic: string;
  t: string;
  run: () => void;
  grp: string;
}

export function CommandPalette({
  open,
  onClose,
  onNav,
  onSplit,
}: {
  open: boolean;
  onClose: () => void;
  onNav: (view: string) => void;
  onSplit: () => void;
}) {
  const [q, setQ] = useState("");
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const cmds: Cmd[] = [
    { ic: "library", t: t("shell.palette.goLibrary"), run: () => onNav("library"), grp: t("shell.palette.groupNav") },
    { ic: "file-text", t: t("shell.palette.goDoc"), run: () => onNav("doc"), grp: t("shell.palette.groupNav") },
    { ic: "telescope", t: t("shell.palette.goPlan"), run: () => onNav("plan"), grp: t("shell.palette.groupNav") },
    { ic: "columns-2", t: t("shell.split"), run: () => onSplit(), grp: t("shell.palette.groupActions") },
  ];
  const f = cmds.filter((c) => !q || c.t.toLowerCase().includes(q.toLowerCase()));
  const groups = [...new Set(f.map((c) => c.grp))];

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          <Icon name="search" cls="ico" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("shell.palette.placeholder")}
          />
          <span className="kbd">{t("shell.palette.esc")}</span>
        </div>
        <div className="cmdk-list">
          {groups.map((g) => (
            <div key={g}>
              <div className="cmdk-grp">{g}</div>
              {f
                .filter((c) => c.grp === g)
                .map((c, i) => (
                  <button
                    key={i}
                    className="cmdk-item"
                    onClick={() => {
                      c.run();
                      onClose();
                    }}
                  >
                    <Icon name={c.ic} cls="ico-sm" />
                    <span>{c.t}</span>
                    <Icon name="corner-down-left" cls="ico-sm cmdk-enter" />
                  </button>
                ))}
            </div>
          ))}
          {!f.length && <div className="cmdk-empty">{t("shell.palette.empty")}</div>}
        </div>
      </div>
    </div>
  );
}
