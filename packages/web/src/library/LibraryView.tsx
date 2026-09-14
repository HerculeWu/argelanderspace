import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { useWorkspace } from "../argelander/workspace";
import { fetchLibrary, addRef as apiAddRef } from "../api/library";
import { onLibraryChanged } from "../api/ws";
import { CitationGraph } from "./CitationGraph";
import { RefDetail, GraphNodeDetail } from "./RefDetail";
import type { GraphNode, LibraryData, LibraryRef } from "./types";

// color labels users assign by right-clicking a reference (replaces the star)
const LABEL_COLORS = [
  { k: "red", c: "oklch(0.70 0.16 25)" },
  { k: "amber", c: "oklch(0.80 0.13 78)" },
  { k: "green", c: "oklch(0.74 0.13 158)" },
  { k: "blue", c: "oklch(0.70 0.12 235)" },
  { k: "violet", c: "oklch(0.70 0.13 292)" },
];
const LABEL_HEX: Record<string, string> = Object.fromEntries(LABEL_COLORS.map((l) => [l.k, l.c]));

// Label display names resolve at render time; keys must stay in sync with
// LABEL_COLORS above (an explicit typed mapping — no key concatenation).
const LABEL_NAME_KEYS = {
  red: "library.labels.red",
  amber: "library.labels.amber",
  green: "library.labels.green",
  blue: "library.labels.blue",
  violet: "library.labels.violet",
} as const;

/** Label key (or an already-CSS color value) → the dot's CSS color. */
export function labelColor(lab: string): string {
  return LABEL_HEX[lab] ?? lab;
}

/**
 * The dot's effective label: the session-local overlay (right-click menu)
 * wins; otherwise the persisted `label` field; unset refs keep the
 * star→amber seeding. Overlay `null` = explicitly cleared.
 */
export function effectiveLabel(
  r: LibraryRef,
  overlay: Record<string, string | null>
): string | undefined {
  return r.id in overlay ? (overlay[r.id] ?? undefined) : (r.label ?? (r.star ? "amber" : undefined));
}

function nodeToRef(n: GraphNode): LibraryRef {
  return {
    id: n.id,
    title: n.t,
    authors: n.a,
    year: n.y,
    venue: n.v,
    type: /ICLR|ICML|NeurIPS|CVPR|AISTATS/.test(n.v) ? "conf" : "article",
    cite: n.id,
    tags: [],
    pdf: false,
    read: false,
    star: false,
    citedBy: n.c,
    doi: n.doi,
    arxiv_id: n.arxiv_id,
    doc_id: n.doc_id,
  };
}

const IMPORTS = [
  { ic: "hash", titleKey: "library.import.doi.title", descKey: "library.import.doi.desc" },
  { ic: "globe", titleKey: "library.import.browser.title", descKey: "library.import.browser.desc" },
  { ic: "file-code-2", titleKey: "library.import.bibtex.title", descKey: "library.import.bibtex.desc" },
] as const;

export function LibraryView() {
  const ws = useWorkspace();
  const { t } = useTranslation();
  const [payload, setPayload] = useState<LibraryData | null>(null);
  const [live, setLive] = useState(false);

  const reload = useCallback(async () => {
    const { data, live } = await fetchLibrary();
    setPayload(data);
    setLive(live);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // live-refresh on server-side library mutations (refresh / patch / add /
  // upload-done) pushed over /ws
  useEffect(() => onLibraryChanged(() => void reload()), [reload]);

  if (!payload) {
    return (
      <div className="cg-loading" style={{ position: "relative", height: "100%" }}>
        <div className="cg-spinner" />
        <div className="cg-loading-t">{t("library.loading")}</div>
      </div>
    );
  }
  return (
    <LibraryBody
      payload={payload}
      live={live}
      onOpenDoc={ws.openDoc}
      onReload={reload}
      onDocDeleted={ws.docDeleted}
    />
  );
}

function LibraryBody({
  payload,
  live,
  onOpenDoc,
  onReload,
  onDocDeleted,
}: {
  payload: LibraryData;
  live: boolean;
  onOpenDoc: (docId?: string) => void;
  onReload: () => void;
  /** Stage 8 §8: forwarded to RefDetail — the workspace three-state transition
   *  after a document is physically deleted. */
  onDocDeleted: (docId: string, remaining: string[]) => void;
}) {
  const { refs, graph } = payload;
  const { t } = useTranslation();
  const byId = useMemo(() => Object.fromEntries(graph.nodes.map((n) => [n.id, n])), [graph]);
  const refToNode = useMemo(() => {
    const m: Record<string, string> = {};
    graph.nodes.forEach((n) => {
      if (n.ref) m[n.ref] = n.id;
    });
    return m;
  }, [graph]);

  const [selNode, setSelNode] = useState<string | null>(graph.nodes.find((n) => n.ref)?.id ?? null);
  const [q, setQ] = useState("");
  const [sideCollapsed, setSideCollapsed] = useState(false);

  // color labels: session-local overlay (refId → color key; null = cleared) on
  // top of the persisted `label` field; unset refs keep the star→amber seeding
  const [labels, setLabels] = useState<Record<string, string | null>>({});
  const effLabel = (r: LibraryRef): string | undefined => effectiveLabel(r, labels);
  const [labelMenu, setLabelMenu] = useState<{ x: number; y: number; refId: string } | null>(null);
  const setLabel = (refId: string, k: string | null) => {
    setLabels((m) => ({ ...m, [refId]: k }));
    setLabelMenu(null);
  };
  useEffect(() => {
    if (!labelMenu) return;
    const close = () => setLabelMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [labelMenu]);

  // add-to-library state (single source of truth: `added`)
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);
  const addedRefs = useRef<Record<string, LibraryRef>>({});
  const addToLibrary = async (nodeId: string) => {
    if (adding) return;
    setAdding(nodeId);
    const resp = await apiAddRef(nodeId); // null when backend absent → optimistic placeholder
    addedRefs.current[nodeId] = resp?.ref ?? nodeToRef(byId[nodeId]);
    setAdded((s) => new Set(s).add(nodeId));
    setAdding(null);
  };

  // recommendations
  const [showSug, setShowSug] = useState(false);
  const [sugCount, setSugCount] = useState(10);
  const [sugDepth, setSugDepth] = useState(1);
  const [sugLoading, setSugLoading] = useState(false);
  const sugTimer = useRef<number | undefined>(undefined);
  const toggleSug = () => {
    if (showSug) {
      setShowSug(false);
      setSelNode((prev) => {
        const n = prev && byId[prev];
        return n && !n.ref ? null : prev;
      });
      return;
    }
    if (sugLoading) return;
    setSugLoading(true);
    sugTimer.current = window.setTimeout(() => {
      setSugLoading(false);
      setShowSug(true);
    }, 1100);
  };
  useEffect(() => () => clearTimeout(sugTimer.current), []);

  const [importOpen, setImportOpen] = useState(false);

  const allRefs = useMemo(
    () => refs.concat([...added].map((id) => addedRefs.current[id] ?? nodeToRef(byId[id]))),
    [refs, added, byId]
  );
  const list = allRefs.filter(
    (r) => !q || (r.title + r.authors + r.cite).toLowerCase().includes(q.toLowerCase())
  );
  const curNode = selNode ? byId[selNode] : null;
  const curRef: LibraryRef | null = curNode
    ? curNode.ref
      ? refs.find((r) => r.id === curNode.ref) ?? null
      : added.has(curNode.id)
      ? addedRefs.current[curNode.id] ?? nodeToRef(curNode)
      : null
    : null;
  const menuRef = labelMenu ? (allRefs.find((r) => r.id === labelMenu.refId) ?? null) : null;

  return (
    <div className="view-row">
      {sideCollapsed ? (
        <button className="lib-rail" title={t("library.side.expand")} onClick={() => setSideCollapsed(false)}>
          <Icon name="panel-left-open" cls="ico-sm" />
        </button>
      ) : (
        <div className="lib-side">
          <div className="lib-import">
            <button
              className="btn primary"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={() => setImportOpen((v) => !v)}
            >
              <Icon name="plus" cls="ico-sm" />
              {t("library.import.button")}
            </button>
            {importOpen && (
              <div className="import-menu view-in">
                {IMPORTS.map((im) => (
                  <button key={im.titleKey} className="import-opt">
                    <span className="import-ic">
                      <Icon name={im.ic} cls="ico-sm" />
                    </span>
                    <span className="import-body">
                      <span className="import-t">{t(im.titleKey)}</span>
                      <span className="import-d">{t(im.descKey)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="lib-side-head">
            <span className="lib-side-title">{t("library.side.title")}</span>
            <span className="lib-side-count mono">{list.length}</span>
            <button className="lib-side-collapse" title={t("library.side.collapse")} onClick={() => setSideCollapsed(true)}>
              <Icon name="panel-left-close" cls="ico-sm" />
            </button>
          </div>
          <div className="side-reflist">
            {list.map((r) => {
              const nid = refToNode[r.id] || r.id;
              const lab = effLabel(r);
              return (
                <button
                  key={r.id}
                  className={"side-ref" + (nid === selNode ? " sel" : "") + (r.read ? " read" : " unread")}
                  onClick={() => setSelNode(nid)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setLabelMenu({ x: e.clientX, y: e.clientY, refId: r.id });
                  }}
                >
                  <span className="side-ref-mark">
                    {lab ? (
                      <span className="label-dot" style={{ background: labelColor(lab) }} />
                    ) : !r.read ? (
                      <span className="unread-dot" />
                    ) : null}
                  </span>
                  <span className="side-ref-body">
                    <span className="side-ref-title">{r.title}</span>
                    <span className="side-ref-meta mono">
                      {r.authors.split(/ (?:&|et) /)[0].replace(/,$/, "")} · {r.year} · {r.venue}
                      {r.read && <span className="read-flag">{t("library.side.readFlag")}</span>}
                      {!r.doc_id && r.needs_upload && (
                        <span style={{ color: "oklch(0.80 0.13 78)" }}>{t("library.side.needsSource")}</span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
            {!list.length && <div className="side-reflist-empty mono">{t("library.side.empty")}</div>}
          </div>
        </div>
      )}

      {labelMenu && (
        <div
          className="label-menu"
          style={{ left: labelMenu.x, top: labelMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="label-menu-head mono">{t("library.labelMenu.head")}</div>
          <div className="label-menu-row">
            {LABEL_COLORS.map((l) => (
              <button
                key={l.k}
                className={"label-swatch" + (menuRef && effLabel(menuRef) === l.k ? " on" : "")}
                title={t(LABEL_NAME_KEYS[l.k as keyof typeof LABEL_NAME_KEYS])}
                style={{ background: l.c }}
                onClick={() => setLabel(labelMenu.refId, l.k)}
              />
            ))}
          </div>
          <button className="label-clear" onClick={() => setLabel(labelMenu.refId, null)}>
            <Icon name="x" cls="ico-sm" />
            {t("library.labelMenu.clear")}
          </button>
        </div>
      )}

      <div className="lib-main">
        <div className="lib-toolbar">
          <div className="lib-search">
            <Icon name="search" cls="ico-sm" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("library.toolbar.searchPlaceholder")}
            />
          </div>
          <div style={{ flex: 1 }} />
          {!live && (
            <span className="lib-banner" title={t("library.toolbar.demoTitle")}>
              <Icon name="flask-conical" cls="ico-sm" />
              {t("library.toolbar.demoBadge")}
            </span>
          )}
          <button
            className={"sug-toggle" + (showSug ? " on" : "")}
            onClick={toggleSug}
          >
            <Icon name={sugLoading ? "loader" : "sparkles"} cls={"ico-sm" + (sugLoading ? " spin" : "")} />
            {sugLoading ? t("library.toolbar.sugLoading") : showSug ? t("library.toolbar.sugOn") : t("library.toolbar.sugOff")}
          </button>
          <button className="btn">
            <Icon name="download" cls="ico-sm" />
            {t("library.toolbar.exportBibtex")}
          </button>
        </div>

        <CitationGraph
          graph={graph}
          selId={selNode}
          onSel={setSelNode}
          query={q}
          showSug={showSug}
          loading={sugLoading}
          sugCount={sugCount}
          onSugCount={setSugCount}
          sugDepth={sugDepth}
          onSugDepth={setSugDepth}
          added={added}
          addingId={adding}
        />
      </div>

      {curRef ? (
        <RefDetail
          r={curRef}
          node={curNode}
          onClose={() => setSelNode(null)}
          onOpenDoc={onOpenDoc}
          onReload={onReload}
          onDocDeleted={onDocDeleted}
        />
      ) : curNode ? (
        <GraphNodeDetail
          node={curNode}
          links={graph.links}
          byId={byId}
          onSel={setSelNode}
          onClose={() => setSelNode(null)}
          onAdd={() => addToLibrary(curNode.id)}
          adding={adding === curNode.id}
        />
      ) : null}
    </div>
  );
}
