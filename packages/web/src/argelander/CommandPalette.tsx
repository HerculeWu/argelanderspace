import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";

interface Cmd {
  id: string;
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
    { id: "library", ic: "library", t: t("shell.palette.goLibrary"), run: () => onNav("library"), grp: t("shell.palette.groupNav") },
    { id: "doc", ic: "file-text", t: t("shell.palette.goDoc"), run: () => onNav("doc"), grp: t("shell.palette.groupNav") },
    { id: "plan", ic: "telescope", t: t("shell.palette.goPlan"), run: () => onNav("plan"), grp: t("shell.palette.groupNav") },
    { id: "write", ic: "pen-line", t: t("shell.palette.goWrite"), run: () => onNav("write"), grp: t("shell.palette.groupNav") },
    { id: "split", ic: "columns-2", t: t("shell.split"), run: () => onSplit(), grp: t("shell.palette.groupActions") },
  ];
  const f = cmds.filter((c) => !q || c.t.toLowerCase().includes(q.toLowerCase()));
  const groups = [...new Set(f.map((c) => c.grp))];

  return (
    <div className="cmdk-overlay" data-ui="command-palette-overlay" onClick={onClose}>
      <div className="cmdk" data-ui="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          <Icon name="search" cls="ico" />
          <input
            data-ui="command-search"
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("shell.palette.placeholder")}
          />
          <span className="kbd">{t("shell.palette.esc")}</span>
        </div>
        <div className="cmdk-list" data-ui="command-results">
          {groups.map((g) => (
            <div key={g}>
              <div className="cmdk-grp">{g}</div>
              {f
                .filter((c) => c.grp === g)
                .map((c) => (
                  <button
                    data-ui="command-option"
                    data-ui-key={c.id}
                    key={c.id}
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
          {!f.length && <div className="cmdk-empty" data-ui="command-empty">{t("shell.palette.empty")}</div>}
        </div>
      </div>
    </div>
  );
}
