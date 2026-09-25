import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";
import { fetchPapers } from "../api";
import { parseDocRoute, replaceDocUrl } from "../lib/deeplink";
import { exploreBus, parseExploreHash } from "../lib/explore-route";
import { useTweaks } from "./theme";
import { applyDocDeletion, confirmWorkspaceLeave, WorkspaceProvider, type Workspace } from "./workspace";
import { CommandPalette } from "./CommandPalette";
import { TweaksPopover } from "./TweaksPopover";
import { DocPane } from "../doc/DocPane";
import { LibraryView } from "../library/LibraryView";
import { PlanView } from "../plan/PlanView";
import { WriterView } from "../writer/WriterView";

interface NavItem {
  k: string;
  ic: string;
  labelKey: "shell.nav.plan" | "shell.nav.library" | "shell.nav.doc" | "shell.nav.write" | "shell.nav.ext";
  grp: "core" | "ext";
  stub?: boolean;
}

const NAV: NavItem[] = [
  { k: "plan", ic: "telescope", labelKey: "shell.nav.plan", grp: "core" },
  { k: "library", ic: "library", labelKey: "shell.nav.library", grp: "core" },
  { k: "doc", ic: "file-text", labelKey: "shell.nav.doc", grp: "core" },
  { k: "write", ic: "pen-line", labelKey: "shell.nav.write", grp: "core" },
];
const NAV_MARKET: NavItem = { k: "ext", ic: "blocks", labelKey: "shell.nav.ext", grp: "ext", stub: true };
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
  const { t } = useTranslation();
  const [tweaks, setTweak] = useTweaks();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);

  const [papers, setPapers] = useState<string[]>([]);
  const [currentDoc, setCurrentDocState] = useState<string | null>(null);
  const currentDocRef = useRef(currentDoc);
  currentDocRef.current = currentDoc;
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const clearPendingAnchor = useCallback(() => setPendingAnchor(null), []);

  const [panes, setPanes] = useState<Pane[]>([{ id: 1, view: "plan", size: 1 }]);
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
        return;
      }
      // Stage 14: a boot `#explore/<bibcode>` hash opens the library pane and
      // hands the seed to the explore bus (the LibraryView consumes it once
      // mounted — exploreBus keeps it pending until then)
      const exploreSeed = parseExploreHash(window.location.hash);
      if (exploreSeed) {
        setPanes((ps) =>
          ps.some((p) => p.view === "library")
            ? ps
            : ps.map((p) => (p.id === activeId ? { ...p, view: "library" } : p))
        );
        exploreBus.request(exploreSeed);
        return;
      }
      const want = new URL(window.location.href).searchParams.get("doc");
      const initialDoc = want && list.includes(want) ? want : list[0] ?? null;
      currentDocRef.current = initialDoc;
      setCurrentDocState(initialDoc);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setActiveView = useCallback(
    (view: string) => {
      const currentPane = panes.find((pane) => pane.id === activeId);
      if (currentPane?.view === "doc" && view !== "doc" && !confirmWorkspaceLeave()) return;
      setPanes((ps) => ps.map((p) => (p.id === activeId ? { ...p, view } : p)));
    },
    [activeId, panes]
  );
  const setPaneView = (id: number, view: string) => {
    const currentPane = panes.find((pane) => pane.id === id);
    if (currentPane?.view === "doc" && view !== "doc" && !confirmWorkspaceLeave()) return;
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

  const closePane = (id: number) => {
    const currentPane = panes.find((pane) => pane.id === id);
    if (currentPane?.view === "doc" && !confirmWorkspaceLeave()) return;
    setPanes((ps) => {
      if (ps.length <= 1) return ps;
      const filtered = ps.filter((p) => p.id !== id).map((p) => ({ ...p, size: 1 }));
      if (id === activeId) setActiveId(filtered[0].id);
      return filtered;
    });
  };

  const setCurrentDoc = useCallback((id: string) => {
    if (id === currentDocRef.current) return;
    if (!confirmWorkspaceLeave()) return;
    currentDocRef.current = id;
    setCurrentDocState(id);
    replaceDocUrl(id); // UI-driven switch: any stale #anchor no longer applies
  }, []);

  const openDoc = useCallback(
    (docId?: string, anchor?: string | null) => {
      const nextDoc = docId ?? currentDocRef.current ?? papers[0] ?? null;
      if (nextDoc !== currentDocRef.current && !confirmWorkspaceLeave()) {
        if (currentDocRef.current) replaceDocUrl(currentDocRef.current);
        return;
      }
      currentDocRef.current = nextDoc;
      setCurrentDocState(nextDoc);
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
      if (route) {
        openDocRef.current(route.docId, route.anchor);
        return;
      }
      // Stage 14: `#explore/<bibcode>` drives the discovery mode; losing the
      // explore hash exits explore mode (the session stays resumable)
      const seed = parseExploreHash(window.location.hash);
      if (seed) exploreBus.request(seed);
      else exploreBus.exit();
    };
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);
    return () => {
      window.removeEventListener("popstate", onNav);
      window.removeEventListener("hashchange", onNav);
    };
  }, []);

  // Stage 8 §8: a document delete lands here (the papers list is fetched only
  // once at boot, so the deleted id must be dropped locally; currentDoc
  // migrates per the three-state rule — the library.changed broadcast covers
  // the OTHER library surfaces, not this local transition).
  const papersRef = useRef(papers);
  papersRef.current = papers;
  const docDeleted = useCallback((docId: string, remaining: string[]) => {
    const next = applyDocDeletion(
      { papers: papersRef.current, currentDoc: currentDocRef.current },
      docId,
      remaining
    );
    setPapers(next.papers);
    if (next.currentDoc !== currentDocRef.current) {
      currentDocRef.current = next.currentDoc;
      setCurrentDocState(next.currentDoc);
      if (next.currentDoc) replaceDocUrl(next.currentDoc);
      else window.history.replaceState(null, "", "/"); // nothing left to show
    }
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
    () => ({ papers, currentDoc, setCurrentDoc, openDoc, pendingAnchor, clearPendingAnchor, docDeleted, tweaks }),
    [papers, currentDoc, setCurrentDoc, openDoc, pendingAnchor, clearPendingAnchor, docDeleted, tweaks]
  );

  const renderView = (p: Pane) => {
    switch (p.view) {
      case "plan":
        return <PlanView />;
      case "library":
        return <LibraryView />;
      case "doc":
        return <DocPane />;
      case "write":
        return <WriterView />;
      default:
        return <StubPane nav={NAV_MAP[p.view] || NAV[0]} />;
    }
  };

  // F12 locators: data-ui names a semantic role (never translated copy),
  // data-ui-key distinguishes repeated instances using an existing public id.
  // Scope selectors by workspace-pane key when multiple panes show the same view.
  return (
    <WorkspaceProvider value={workspace}>
      <div className="app" data-ui="app-shell">
        <div className="titlebar" data-ui="app-titlebar">
          <div className="tb-left">
            <span className="wordmark">
              <span className="wordmark-mark">✦</span>ArgelanderSpace
            </span>
          </div>
          <div className="tb-center">{t("shell.tagline")}</div>
          <div className="tb-right" data-ui="titlebar-actions">
            <ActionButton
              mode="icon"
              iconName="columns-2"
              unstyled
              className="btn icon ghost"
              data-ui="split-pane"
              label={t("shell.titlebar.split")}
              tooltip={t("shell.titlebar.split")}
              disabled={panes.length >= MAX_PANES}
              onClick={() => splitFrom(activeId)}
            />
            <ActionButton
              mode="icon"
              iconName={tweaks.theme === "dark" ? "sun" : "moon"}
              unstyled
              className="btn icon ghost"
              data-ui="toggle-theme"
              label={t("shell.titlebar.toggleTheme")}
              onClick={() => setTweak("theme", tweaks.theme === "dark" ? "light" : "dark")}
            />
            <ActionButton
              mode="icon"
              iconName="sliders-horizontal"
              unstyled
              className="btn icon ghost"
              data-ui="open-tweaks"
              label={t("shell.titlebar.tweaks")}
              tooltip={t("shell.titlebar.tweaks")}
              aria-expanded={tweaksOpen}
              onClick={() => setTweaksOpen((o) => !o)}
            />
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

        <div className="app-body" data-ui="app-workspace">
          <div className="activity" data-ui="primary-navigation">
            {NAV.map((n) => {
              const label = t(n.labelKey);
              const className = "nav-icon-action" + (activePane.view === n.k ? " on" : "");
              return <ActionButton key={n.k} unstyled mode="icon" iconName={n.k === "plan" ? "telescope" : n.k === "library" ? "library" : n.k === "doc" ? "file-text" : "pen-line"} label={label} tooltip={label} data-ui="navigate-view" data-ui-key={n.k} className={className} aria-current={activePane.view === n.k ? "page" : undefined} onClick={() => setActiveView(n.k)} />;
            })}
            <div style={{ flex: 1 }} />
            <ActionButton unstyled mode="icon" iconName="blocks" label={t("shell.nav.extMarket")} tooltip={t("shell.nav.extMarket")} data-ui="navigate-extensions" className={"nav-icon-action" + (activePane.view === "ext" ? " on" : "")} aria-current={activePane.view === "ext" ? "page" : undefined} onClick={() => setActiveView("ext")} />
          </div>

          <div className="main">
            <div className="panes" data-ui="workspace-panes" ref={panesRef}>
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
        data-ui="workspace-pane"
        data-ui-key={pane.id}
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
        <div className="pane-body" data-ui="pane-content">{render()}</div>
      </div>
      {index < total - 1 && (
        <div className="pane-divider" data-ui="resize-pane" onMouseDown={onDividerDown}>
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
  const { t } = useTranslation();
  const nav = NAV_MAP[pane.view] || NAV[0];
  useEffect(() => {
    if (!open) return;
    const h = () => setOpen(false);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [open]);
  return (
    <div className="pane-head" data-ui="pane-header">
      <div className="pane-tool-wrap" onClick={(e) => e.stopPropagation()}>
        <ActionButton unstyled mode="text" data-ui="choose-pane-view" className="pane-tool" label={t("shell.pane.switchView")} tooltip={t("shell.pane.switchView")} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span>{t(nav.labelKey)}</span>
        </ActionButton>
        {open && (
          <div className="pane-tool-menu view-in" data-ui="pane-view-menu">
            {NAV.map((n) => (
              <ActionButton
                key={n.k}
                unstyled
                mode="text"
                label={t(n.labelKey)}
                tooltip={t(n.labelKey)}
                data-ui="pane-view-option"
                data-ui-key={n.k}
                aria-current={n.k === pane.view ? "page" : undefined}
                className={"pane-tool-opt" + (n.k === pane.view ? " on" : "")}
                onClick={() => {
                  onSwitch(n.k);
                  setOpen(false);
                }}
              >
                <span>{t(n.labelKey)}</span>
              </ActionButton>
            ))}
          </div>
        )}
      </div>
      <div style={{ flex: 1 }} />
      {canSplit && (
        <ActionButton unstyled mode="icon" iconName="columns-2" data-ui="split-pane" className="pane-h-btn" label={t("shell.split")} tooltip={t("shell.split")} onClick={onSplit} />
      )}
      {canClose && (
        <ActionButton unstyled mode="icon" iconName="x" data-ui="close-pane" className="pane-h-btn" label={t("shell.closePane")} tooltip={t("shell.closePane")} onClick={onClose} />
      )}
    </div>
  );
}

function StubPane({ nav }: { nav: NavItem }) {
  const { t } = useTranslation();
  return (
    <div className="stub-pane" data-ui="unavailable-view">
      <div className="stub-ic">
        <Icon name={nav.ic} cls="ico-lg" />
      </div>
      <div className="stub-title">{t(nav.labelKey)}</div>
      <div className="stub-sub">
        {t("shell.stub.desc", { view: t(nav.labelKey) })}
      </div>
    </div>
  );
}
