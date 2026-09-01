import { useState } from "react";
import { Icon } from "../lib/icons";
import { cgKfmt } from "./CitationGraph";
import type { GraphNode, LibraryRef } from "./types";

function Tag({ children }: { children: string }) {
  return <span className="tag mono">{children.replace(/^#/, "")}</span>;
}

const RESOLVED_LABEL: Record<string, string> = {
  ads: "NASA ADS",
  crossref: "Crossref",
  openalex: "OpenAlex",
};

// Where the full text is / would come from, with a tone color.
function sourceBadge(r: LibraryRef): { text: string; color: string } {
  const lbl = r.sourceLabel || "";
  const GREEN = "oklch(0.74 0.13 158)", AMBER = "oklch(0.80 0.13 78)", BLUE = "oklch(0.70 0.12 235)";
  if (r.doc_id || r.pdf) return { text: lbl ? `已入库 · ${lbl}` : "已入库", color: GREEN };
  if (r.needs_upload) return { text: "需上传 PDF", color: AMBER };
  if (r.sourceStatus === "blocked") return { text: lbl ? `反爬墙 · ${lbl}` : "被反爬墙", color: AMBER };
  if (r.sourceStatus === "ready" || r.sourceReady) return { text: lbl ? `可获取 · ${lbl}` : "可获取", color: BLUE };
  return { text: lbl || "未知来源", color: "var(--text-dim, #8a8a8a)" };
}

function SourcePill({ r }: { r: LibraryRef }) {
  const b = sourceBadge(r);
  return (
    <span
      className="src-pill mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 11,
        lineHeight: "16px",
        color: b.color,
        border: `1px solid color-mix(in oklch, ${b.color} 45%, transparent)`,
        background: `color-mix(in oklch, ${b.color} 12%, transparent)`,
      }}
    >
      {b.text}
    </span>
  );
}

function bibtexOf(r: LibraryRef): string {
  return (
    "@" +
    (r.type === "conf" ? "inproceedings" : "article") +
    "{" +
    r.cite +
    ",\n" +
    "  title   = {" +
    r.title +
    "},\n" +
    "  author  = {" +
    r.authors.replace(/ & /g, " and ").replace(/ et al\./, " and others") +
    "},\n" +
    "  journal = {" +
    r.venue +
    "},\n  year    = {" +
    r.year +
    "}\n}"
  );
}

const TABS: [string, string][] = [
  ["meta", "详情"],
  ["info", "摘要"],
  ["bib", "BibTeX"],
  ["notes", "笔记"],
  ["files", "附件"],
];

export function RefDetail({
  r,
  node,
  onClose,
  onOpenDoc,
}: {
  r: LibraryRef;
  node: GraphNode | null;
  onClose: () => void;
  onOpenDoc: (docId?: string) => void;
}) {
  const [tab, setTab] = useState("meta");
  const [copied, setCopied] = useState(false);
  const cited = node?.c ?? r.citedBy;

  const copyBib = async () => {
    try {
      await navigator.clipboard.writeText(bibtexOf(r));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be blocked */
    }
  };

  return (
    <div className="ref-detail view-in">
      <div className="ref-detail-head">
        <div className="ref-type-badge">{r.type === "conf" ? "会议" : "期刊"}</div>
        <div className="ref-detail-actions">
          <button className="btn icon ghost" title="在 文档 中打开" onClick={() => onOpenDoc(r.doc_id)}>
            <Icon name="file-text" cls="ico-sm" />
          </button>
          <button className="btn icon ghost" title={r.star ? "已加星" : "加星"}>
            <Icon name="star" cls="ico-sm" />
          </button>
          <button className="btn icon ghost" onClick={onClose}>
            <Icon name="x" cls="ico-sm" />
          </button>
        </div>
      </div>
      <div className="ref-detail-title serif">{r.title}</div>
      <div className="ref-detail-auth">{r.authors}</div>
      <div className="ref-detail-meta">
        <span>{r.venue}</span>
        <span className="dotsep">·</span>
        <span className="mono">{r.year}</span>
        {cited != null && (
          <>
            <span className="dotsep">·</span>
            <span className="mono">被引 {cgKfmt(cited)}</span>
          </>
        )}
      </div>
      <div className="ref-detail-meta" style={{ marginTop: 6, gap: 8, flexWrap: "wrap" }}>
        <SourcePill r={r} />
        {r.resolvedBy && RESOLVED_LABEL[r.resolvedBy] && (
          <span className="mono" style={{ fontSize: 11, opacity: 0.65 }}>
            引用数据 · {RESOLVED_LABEL[r.resolvedBy]}
          </span>
        )}
      </div>
      <div className="ref-detail-tabs">
        {TABS.map(([k, l]) => (
          <button key={k} className={"rdt" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="ref-detail-body">
        {tab === "meta" && (
          <div className="ref-meta-list">
            <div className="rml-row">
              <span className="rml-k">类型</span>
              <span className="rml-v">{r.type === "conf" ? "会议论文" : "期刊文章"}</span>
            </div>
            <div className="rml-row">
              <span className="rml-k">年份</span>
              <span className="rml-v mono">{r.year}</span>
            </div>
            <div className="rml-row">
              <span className="rml-k">来源</span>
              <span className="rml-v">{r.venue}</span>
            </div>
            {cited != null && (
              <div className="rml-row">
                <span className="rml-k">被引量</span>
                <span className="rml-v mono">{cgKfmt(cited)}</span>
              </div>
            )}
            {r.doi && (
              <div className="rml-row">
                <span className="rml-k">DOI</span>
                <span className="rml-v mono">{r.doi}</span>
              </div>
            )}
            {r.arxiv_id && (
              <div className="rml-row">
                <span className="rml-k">arXiv</span>
                <span className="rml-v mono">{r.arxiv_id}</span>
              </div>
            )}
            <div className="rml-row">
              <span className="rml-k">引用键</span>
              <span className="rml-v mono">{r.cite}</span>
            </div>
            <div className="rml-row">
              <span className="rml-k">附件</span>
              <span className="rml-v">{r.pdf || r.doc_id ? "可在文档中打开" : "暂无"}</span>
            </div>
            {r.tags.length > 0 && (
              <div className="ref-tags" style={{ marginTop: 4 }}>
                {r.tags.map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "info" && (
          <div className="ref-abstract">
            {r.abstract ? (
              <p>{r.abstract}</p>
            ) : (
              <div className="placeholder-text ph-abstract">
                <span className="mono">摘要 / abstract</span>
              </div>
            )}
            {r.tags.length > 0 && (
              <div className="ref-tags">
                {r.tags.map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "bib" && (
          <div className="bib-block">
            <button className="bib-copy" onClick={copyBib}>
              <Icon name={copied ? "check" : "copy"} cls="ico-sm" />
              {copied ? "已复制" : "复制"}
            </button>
            <pre className="mono">{bibtexOf(r)}</pre>
          </div>
        )}
        {tab === "notes" &&
          (r.note ? (
            <div className="ref-abstract ref-note">
              <p>{r.note}</p>
            </div>
          ) : (
            <div className="placeholder-text ph-note">
              <span className="mono">暂无笔记</span>
            </div>
          ))}
        {tab === "files" && (
          <div className="ref-files">
            {r.doc_id ? (
              <button className="ref-file" title="在文档中打开" onClick={() => onOpenDoc(r.doc_id)}>
                <Icon name="file-text" cls="ico-sm" />
                <span className="mono">{r.cite}</span>
                <span className="ref-file-ok">已入库</span>
                <Icon name="arrow-up-right" cls="ico-sm" />
              </button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="mono" style={{ fontSize: 11, opacity: 0.65 }}>全文来源</span>
                  <SourcePill r={r} />
                </div>
                <div className="mono" style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.5 }}>
                  LaTeX 源码包（zip）上传入口开发中；可先入库 arXiv 源码（CLI `ingest
                  &lt;arxiv-id&gt;`）
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function GraphNodeDetail({
  node,
  links,
  byId,
  onClose,
  onSel,
  onAdd,
  adding,
}: {
  node: GraphNode;
  links: [string, string][];
  byId: Record<string, GraphNode>;
  onClose: () => void;
  onSel: (id: string) => void;
  onAdd: () => void;
  adding: boolean;
}) {
  const conn = links
    .filter(([a, b]) => a === node.id || b === node.id)
    .map(([a, b]) => byId[a === node.id ? b : a])
    .filter(Boolean);
  return (
    <div className="ref-detail view-in">
      <div className="ref-detail-head">
        <div className="ref-type-badge sug">推荐 · 未收录</div>
        <div className="ref-detail-actions">
          <button className="btn icon ghost" title="在新窗口打开">
            <Icon name="external-link" cls="ico-sm" />
          </button>
          <button className="btn icon ghost" onClick={onClose}>
            <Icon name="x" cls="ico-sm" />
          </button>
        </div>
      </div>
      <div className="ref-detail-title serif">{node.t}</div>
      <div className="ref-detail-auth">{node.a}</div>
      <div className="ref-detail-meta">
        <span>{node.v}</span>
        <span className="dotsep">·</span>
        <span className="mono">{node.y}</span>
        <span className="dotsep">·</span>
        <span className="mono">被引 {cgKfmt(node.c)}</span>
      </div>
      <button className="btn primary add-to-lib" disabled={adding} onClick={onAdd}>
        {adding ? (
          <>
            <Icon name="loader" cls="ico-sm spin" />
            正在抓取题录…
          </>
        ) : (
          <>
            <Icon name="plus" cls="ico-sm" />
            添加到文库
          </>
        )}
      </button>
      {adding && <div className="add-hint mono">正在获取元数据并写入文库…</div>}
      <div className="ref-detail-tabs">
        <div className="rdt on">引用关联 · {conn.length}</div>
      </div>
      <div className="cg-conn-list">
        {conn.map((c) => (
          <button key={c.id} className="cg-conn" onClick={() => onSel(c.id)}>
            <span className={"cg-conn-dot" + (c.ref ? " saved" : "")} />
            <span className="cg-conn-body">
              <span className="cg-conn-t">{c.t}</span>
              <span className="cg-conn-m mono">
                {c.a.split(" ")[0].replace(/,$/, "")} · {c.y}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
