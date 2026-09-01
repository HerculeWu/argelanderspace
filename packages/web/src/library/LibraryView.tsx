import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { useWorkspace } from "../argelander/workspace";
import { fetchLibrary, addRef as apiAddRef } from "../api/library";
import { onLibraryChanged } from "../api/ws";
import { CitationGraph } from "./CitationGraph";
import { RefDetail, GraphNodeDetail } from "./RefDetail";
import type { GraphNode, LibraryData, LibraryRef } from "./types";

// color labels users assign by right-clicking a reference (replaces the star)
const LABEL_COLORS = [
  { k: "red", c: "oklch(0.70 0.16 25)", t: "重点" },
  { k: "amber", c: "oklch(0.80 0.13 78)", t: "待读" },
  { k: "green", c: "oklch(0.74 0.13 158)", t: "已精读" },
  { k: "blue", c: "oklch(0.70 0.12 235)", t: "方法" },
  { k: "violet", c: "oklch(0.70 0.13 292)", t: "灵感" },
];
const LABEL_HEX: Record<string, string> = Object.fromEntries(LABEL_COLORS.map((l) => [l.k, l.c]));

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
  { ic: "hash", t: "从 DOI / arXiv ID", d: "粘贴标识符自动抓取元数据" },
  { ic: "globe", t: "从浏览器抓取", d: "内置浏览器一键保存当前页" },
  { ic: "file-code-2", t: "导入 BibTeX / RIS", d: "批量导入既有文献库" },
];

export function LibraryView() {
  const ws = useWorkspace();
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
        <div className="cg-loading-t">正在载入文献库…</div>
      </div>
    );
  }
  return <LibraryBody payload={payload} live={live} onOpenDoc={ws.openDoc} onReload={reload} />;
}

function LibraryBody({
  payload,
  live,
  onOpenDoc,
  onReload,
}: {
  payload: LibraryData;
  live: boolean;
  onOpenDoc: (docId?: string) => void;
  onReload: () => void;
}) {
  const { refs, graph } = payload;
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
        <button className="lib-rail" title="展开文献列表" onClick={() => setSideCollapsed(false)}>
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
              导入文献
            </button>
            {importOpen && (
              <div className="import-menu view-in">
                {IMPORTS.map((im) => (
                  <button key={im.t} className="import-opt">
                    <span className="import-ic">
                      <Icon name={im.ic} cls="ico-sm" />
                    </span>
                    <span className="import-body">
                      <span className="import-t">{im.t}</span>
                      <span className="import-d">{im.d}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="lib-side-head">
            <span className="lib-side-title">文献</span>
            <span className="lib-side-count mono">{list.length}</span>
            <button className="lib-side-collapse" title="收起到侧边" onClick={() => setSideCollapsed(true)}>
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
                      {r.read && <span className="read-flag"> · 已读</span>}
                      {!r.doc_id && r.needs_upload && (
                        <span style={{ color: "oklch(0.80 0.13 78)" }}> · 需源码包</span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
            {!list.length && <div className="side-reflist-empty mono">无匹配文献</div>}
          </div>
        </div>
      )}

      {labelMenu && (
        <div
          className="label-menu"
          style={{ left: labelMenu.x, top: labelMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="label-menu-head mono">标记颜色</div>
          <div className="label-menu-row">
            {LABEL_COLORS.map((l) => (
              <button
                key={l.k}
                className={"label-swatch" + (menuRef && effLabel(menuRef) === l.k ? " on" : "")}
                title={l.t}
                style={{ background: l.c }}
                onClick={() => setLabel(labelMenu.refId, l.k)}
              />
            ))}
          </div>
          <button className="label-clear" onClick={() => setLabel(labelMenu.refId, null)}>
            <Icon name="x" cls="ico-sm" />
            清除标记
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
              placeholder="检索文献 · 在图谱中高亮…"
            />
          </div>
          <div style={{ flex: 1 }} />
          {!live && (
            <span className="lib-banner" title="后端未连接，正在展示演示数据">
              <Icon name="flask-conical" cls="ico-sm" />
              演示数据
            </span>
          )}
          <button
            className={"sug-toggle" + (showSug ? " on" : "")}
            onClick={toggleSug}
          >
            <Icon name={sugLoading ? "loader" : "sparkles"} cls={"ico-sm" + (sugLoading ? " spin" : "")} />
            {sugLoading ? "检索中…" : showSug ? "推荐 · 已开启" : "查找推荐文献"}
          </button>
          <button className="btn">
            <Icon name="download" cls="ico-sm" />
            导出 BibTeX
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
