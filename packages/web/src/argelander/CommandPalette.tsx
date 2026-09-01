import { useEffect, useRef, useState } from "react";
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const cmds: Cmd[] = [
    { ic: "library", t: "转到 · 文献库", run: () => onNav("library"), grp: "导航" },
    { ic: "file-text", t: "转到 · 文档查看器", run: () => onNav("doc"), grp: "导航" },
    { ic: "telescope", t: "转到 · 计划", run: () => onNav("plan"), grp: "导航" },
    { ic: "columns-2", t: "向右分屏", run: () => onSplit(), grp: "操作" },
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
            placeholder="搜索命令、文件、文献…"
          />
          <span className="kbd">esc</span>
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
          {!f.length && <div className="cmdk-empty">无匹配结果</div>}
        </div>
      </div>
    </div>
  );
}
