import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { fetchPapers } from "../api";
import { parseDocRoute, replaceDocUrl } from "../lib/deeplink";
import { useTweaks } from "./theme";
import { WorkspaceProvider, type Workspace } from "./workspace";
import { CommandPalette } from "./CommandPalette";
import { TweaksPopover } from "./TweaksPopover";
import { DocPane } from "../doc/DocPane";
import { LibraryView } from "../library/LibraryView";

interface NavItem {
  k: string;
  ic: string;
  label: string;
  grp: "core" | "ext";
  stub?: boolean;
}

const NAV: NavItem[] = [
  { k: "plan", ic: "telescope", label: "计划", grp: "core", stub: true },
  { k: "library", ic: "library", label: "文献", grp: "core" },
  { k: "doc", ic: "file-text", label: "文档", grp: "core" },
  { k: "terminal", ic: "terminal", label: "终端", grp: "core", stub: true },
  { k: "browser", ic: "globe", label: "浏览器", grp: "core", stub: true },
];
const NAV_MARKET: NavItem = { k: "ext", ic: "blocks", label: "扩展", grp: "ext", stub: true };
const NAV_MAP: Record<string, NavItem> = Object.fromEntries(
  [...NAV, NAV_MARKET].map((n) => [n.k, n])
);

interface Pane {
  id: number;
  view: string;
  size: number;
}

const MAX_PANES = 3;

export function Shell() {
  const [tweaks, setTweak] = useTweaks();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);

  const [papers, setPapers] = useState<string[]>([]);
  const [currentDoc, setCurrentDocState] = useState<string | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const clearPendingAnchor = useCallback(() => setPendingAnchor(null), []);

  const [panes, setPanes] = useState<Pane[]>([{ id: 1, view: "library", size: 1 }]);
  const [activeId, setActiveId] = useState(1);
  const nextId = useRef(2);
  const panesRef = useRef<HTMLDivElement>(null);
  const multi = panes.length > 1;
  const activePane = panes.find((p) => p.id === activeId) || panes[0];

  // load the ingested-papers list once, pick an initial document; a
  // `/doc/<id>[#anchor]` deep link takes precedence and opens the doc pane
  useEffect(() => {
    let alive = true;
    const route = parseDocRoute(window.location.pathname, window.location.hash);
    (async () => {
      let list: string[] = [];
      try {
        list = await fetchPapers();
      } catch {
        /* reader may be offline; Library still works on fixture data */
      }
      if (!alive) return;
      setPapers(list);
      if (route) {
        // unknown ids are opened anyway: DocPane shows its normal load error
        openDocRef.current(route.docId, route.anchor);
      } else {
        const want = new URL(window.location.href).searchParams.get("doc");
        setCurrentDocState(want && list.includes(want) ? want : list[0] ?? null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setActiveView = useCallback(
    (view: string) => setPanes((ps) => ps.map((p) => (p.id === activeId ? { ...p, view } : p))),
    [activeId]
  );
  const setPaneView = (id: number, view: string) => {
    setPanes((ps) => ps.map((p) => (p.id === id ? { ...p, view } : p)));
    setActiveId(id);
  };

  const splitFrom = useCallback(
    (id: number) => {
      setPanes((ps) => {
        if (ps.length >= MAX_PANES) return ps;
        const src = ps.find((p) => p.id === id) || ps[0];
        const nid = nextId.current++;
        const i = ps.findIndex((p) => p.id === id);
        const copy = ps.map((p) => ({ ...p, size: 1 }));
        copy.splice(i + 1, 0, { id: nid, view: src.view, size: 1 });
        setActiveId(nid);
        return copy;
      });
    },
    []
  );

  const closePane = (id: number) =>
    setPanes((ps) => {
      if (ps.length <= 1) return ps;
      const filtered = ps.filter((p) => p.id !== id).map((p) => ({ ...p, size: 1 }));
      if (id === activeId) setActiveId(filtered[0].id);
      return filtered;
    });

  const setCurrentDoc = useCallback((id: string) => {
    setCurrentDocState(id);
    replaceDocUrl(id); // UI-driven switch: any stale #anchor no longer applies
  }, []);

  const openDoc = useCallback(
    (docId?: string, anchor?: string | null) => {
      setCurrentDocState((cur) => docId ?? cur ?? papers[0] ?? null);
      if (docId) {
        replaceDocUrl(docId, anchor);
        setPendingAnchor(anchor ?? null);
      }
      // ensure a pane shows the document: prefer an existing doc pane, else the active one
      setPanes((ps) => {
        if (ps.some((p) => p.view === "doc")) return ps;
        return ps.map((p) => (p.id === activeId ? { ...p, view: "doc" } : p));
      });
    },
    [activeId, papers]
  );

  // deep links: react to browser back/forward and manual hash edits
  const openDocRef = useRef(openDoc);
  openDocRef.current = openDoc;
  useEffect(() => {
    const onNav = () => {
      const route = parseDocRoute(window.location.pathname, window.location.hash);
      if (route) openDocRef.current(route.docId, route.anchor);
    };
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);
    return () => {
      window.removeEventListener("popstate", onNav);
      window.removeEventListener("hashchange", onNav);
    };
  }, []);

  // divider drag-resize
  const onDividerDown = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    const rect = panesRef.current!.getBoundingClientRect();
    const startX = e.clientX;
    const start = panes.map((p) => p.size);
    const total = start.reduce((a, b) => a + b, 0);
    const min = total * 0.16;
    const move = (ev: MouseEvent) => {
      const d = ((ev.clientX - startX) / rect.width) * total;
      setPanes((ps) =>
        ps.map((p, idx) => {
          if (idx === i) return { ...p, size: Math.max(min, start[i] + d) };
          if (idx === i + 1) return { ...p, size: Math.max(min, start[i + 1] - d) };
          return p;
        })
      );
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // keyboard
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        splitFrom(activeId);
      } else if (e.key === "Escape") {
        setCmdOpen(false);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [activeId, splitFrom]);

  const workspace: Workspace = useMemo(
    () => ({ papers, currentDoc, setCurrentDoc, openDoc, pendingAnchor, clearPendingAnchor, tweaks }),
    [papers, currentDoc, setCurrentDoc, openDoc, pendingAnchor, clearPendingAnchor, tweaks]
  );

  const renderView = (p: Pane) => {
    switch (p.view) {
      case "library":
        return <LibraryView />;
      case "doc":
        return <DocPane />;
      default:
        return <StubPane nav={NAV_MAP[p.view] || NAV[0]} />;
    }
  };

  return (
    <WorkspaceProvider value={workspace}>
      <div className="app">
        <div className="titlebar">
          <div className="tb-left">
            <span className="wordmark">
              <span className="wordmark-mark">✦</span>ArgelanderSpace
            </span>
          </div>
          <div className="tb-center">文献工作台 · Literature</div>
          <div className="tb-right">
            <button
              className="btn icon ghost"
              title="向右分屏 (⌘\)"
              onClick={() => splitFrom(activeId)}
              style={panes.length >= MAX_PANES ? { opacity: 0.35, pointerEvents: "none" } : undefined}
            >
              <Icon name="columns-2" cls="ico-sm" />
            </button>
            <button
              className="btn icon ghost"
              title="切换主题"
              onClick={() => setTweak("theme", tweaks.theme === "dark" ? "light" : "dark")}
            >
              <Icon name={tweaks.theme === "dark" ? "sun" : "moon"} cls="ico-sm" />
            </button>
            <button
              className="btn icon ghost"
              title="外观设置"
              onClick={() => setTweaksOpen((o) => !o)}
            >
              <Icon name="sliders-horizontal" cls="ico-sm" />
            </button>
            {tweaksOpen && (
              <TweaksPopover tweaks={tweaks} set={setTweak} onClose={() => setTweaksOpen(false)} />
            )}
            <div className="win-ctrl">
              <span className="win-b">
                <Icon name="minus" cls="ico-sm" />
              </span>
              <span className="win-b">
                <Icon name="square" cls="ico-sm" />
              </span>
              <span className="win-b close">
                <Icon name="x" cls="ico-sm" />
              </span>
            </div>
          </div>
        </div>

        <div className="app-body">
          <div className="activity">
            {NAV.map((n) => (
              <button
                key={n.k}
                className={"act-btn" + (activePane.view === n.k ? " on" : "")}
                onClick={() => setActiveView(n.k)}
                title={n.label}
              >
                <Icon name={n.ic} cls="ico-lg" />
                {tweaks.labels && <span className="act-label">{n.label}</span>}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <button
              className={"act-btn" + (activePane.view === "ext" ? " on" : "")}
              onClick={() => setActiveView("ext")}
              title="扩展市场"
            >
              <Icon name="blocks" cls="ico-lg" />
              {tweaks.labels && <span className="act-label">扩展</span>}
            </button>
          </div>

          <div className="main">
            <div className="panes" ref={panesRef}>
              {panes.map((p, i) => (
                <PaneFragment
                  key={p.id}
                  pane={p}
                  index={i}
                  total={panes.length}
                  active={p.id === activeId}
                  multi={multi}
                  onActivate={() => setActiveId(p.id)}
                  onSwitch={(v) => setPaneView(p.id, v)}
                  onSplit={() => splitFrom(p.id)}
                  onClose={() => closePane(p.id)}
                  onDividerDown={(e) => onDividerDown(i, e)}
                  render={() => renderView(p)}
                />
              ))}
            </div>
          </div>
        </div>

        <CommandPalette
          open={cmdOpen}
          onClose={() => setCmdOpen(false)}
          onNav={(v) => setActiveView(v)}
          onSplit={() => splitFrom(activeId)}
        />
      </div>
    </WorkspaceProvider>
  );
}

function PaneFragment({
  pane,
  index,
  total,
  active,
  multi,
  onActivate,
  onSwitch,
  onSplit,
  onClose,
  onDividerDown,
  render,
}: {
  pane: Pane;
  index: number;
  total: number;
  active: boolean;
  multi: boolean;
  onActivate: () => void;
  onSwitch: (v: string) => void;
  onSplit: () => void;
  onClose: () => void;
  onDividerDown: (e: React.MouseEvent) => void;
  render: () => React.ReactNode;
}) {
  return (
    <>
      <div
        className={"pane" + (multi && active ? " active" : "")}
        style={{ flexGrow: pane.size, flexBasis: 0 }}
        onMouseDown={onActivate}
      >
        {multi && (
          <PaneHeader
            pane={pane}
            canClose
            canSplit={total < MAX_PANES}
            onSwitch={onSwitch}
            onSplit={onSplit}
            onClose={onClose}
          />
        )}
        <div className="pane-body">{render()}</div>
      </div>
      {index < total - 1 && (
        <div className="pane-divider" onMouseDown={onDividerDown}>
          <span />
        </div>
      )}
    </>
  );
}

function PaneHeader({
  pane,
  onSwitch,
  onSplit,
  onClose,
  canClose,
  canSplit,
}: {
  pane: Pane;
  onSwitch: (v: string) => void;
  onSplit: () => void;
  onClose: () => void;
  canClose: boolean;
  canSplit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const nav = NAV_MAP[pane.view] || NAV[0];
  useEffect(() => {
    if (!open) return;
    const h = () => setOpen(false);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [open]);
  return (
    <div className="pane-head">
      <div className="pane-tool-wrap" onClick={(e) => e.stopPropagation()}>
        <button className="pane-tool" onClick={() => setOpen((o) => !o)}>
          <Icon name={nav.ic} cls="ico-sm" />
          <span>{nav.label}</span>
          <Icon name="chevron-down" cls="ico-sm" />
        </button>
        {open && (
          <div className="pane-tool-menu view-in">
            {NAV.map((n) => (
              <button
                key={n.k}
                className={"pane-tool-opt" + (n.k === pane.view ? " on" : "")}
                onClick={() => {
                  onSwitch(n.k);
                  setOpen(false);
                }}
              >
                <Icon name={n.ic} cls="ico-sm" />
                <span>{n.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ flex: 1 }} />
      {canSplit && (
        <button className="pane-h-btn" title="向右分屏" onClick={onSplit}>
          <Icon name="panel-right" cls="ico-sm" />
        </button>
      )}
      {canClose && (
        <button className="pane-h-btn" title="关闭窗格" onClick={onClose}>
          <Icon name="x" cls="ico-sm" />
        </button>
      )}
    </div>
  );
}

function StubPane({ nav }: { nav: NavItem }) {
  return (
    <div className="stub-pane">
      <div className="stub-ic">
        <Icon name={nav.ic} cls="ico-lg" />
      </div>
      <div className="stub-title">{nav.label}</div>
      <div className="stub-sub">
        这是 ArgelanderSpace 工作台的一部分，目前聚焦于「文献」与「文档」。{nav.label} 视图将在后续阶段接入。
      </div>
    </div>
  );
}
