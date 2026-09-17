/**
 * Discovery candidate inspector (Stage 14, D3): abstract + bibliographic
 * metadata + in-graph citations. NO BibTeX tab — trustworthy BibTeX only
 * comes from the Library (Add → ADS export); nothing is fabricated here from
 * discovery metadata.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DiscoveryGraph, DiscoveryPaper } from "@argelanderspace/contracts";
import { Icon } from "../lib/icons";
import { AbstractHtml } from "../lib/abstract";
import { cgKfmt } from "../graph/graphPhysics";

export function adsAbsUrl(bibcode: string): string {
  return `https://ui.adsabs.harvard.edu/abs/${encodeURIComponent(bibcode)}/abstract`;
}

export function DiscoveryDetail({
  paper,
  graph,
  onSelect,
  onClose,
  onAdd,
  onExploreHere,
  onViewInLibrary,
  adding,
  addFailed,
}: {
  paper: DiscoveryPaper;
  graph: DiscoveryGraph;
  onSelect: (bibcode: string) => void;
  onClose: () => void;
  onAdd: (bibcode: string) => void;
  onExploreHere: (bibcode: string) => void;
  onViewInLibrary: (workId: string) => void;
  adding: boolean;
  addFailed: boolean;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"abstract" | "citations">("abstract");
  const [allAuthors, setAllAuthors] = useState(false);

  const seed = paper.roles.includes("seed");
  const useful = paper.roles.includes("useful");
  const saved = paper.libraryId !== null;
  const byBibcode = new Map(graph.nodes.map((n) => [n.bibcode, n]));
  const outgoing = graph.edges
    .filter((e) => e.from === paper.bibcode)
    .map((e) => byBibcode.get(e.to))
    .filter((n): n is DiscoveryPaper => !!n);
  const incoming = graph.edges
    .filter((e) => e.to === paper.bibcode)
    .map((e) => byBibcode.get(e.from))
    .filter((n): n is DiscoveryPaper => !!n);

  const roleBadge = seed ? t("explore.role.origin") : useful ? t("explore.role.useful") : t("explore.role.related");
  const sourceLine = [
    paper.relatedRank !== undefined
      ? t("explore.sourceLine.similar", { rank: paper.relatedRank })
      : null,
    paper.usefulRank !== undefined ? t("explore.sourceLine.useful", { rank: paper.usefulRank }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <aside className="ref-detail view-in" data-testid="discovery-detail" aria-label={paper.title}>
      <div className="ref-detail-scroll">
        <div className="ref-detail-head">
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            <span className={"ref-type-badge" + (useful && !seed ? " useful" : "")}>
              {seed && <Icon name="target" cls="ico-sm" />}
              {roleBadge}
            </span>
            {saved && (
              <span className="tag mono" style={{ fontSize: 9, color: "var(--ok, oklch(0.74 0.13 158))" }}>
                {"✓ "}
                {t("explore.savedChip")}
              </span>
            )}
          </div>
          <div className="ref-detail-actions">
            <a
              className="btn icon ghost"
              href={adsAbsUrl(paper.bibcode)}
              target="_blank"
              rel="noreferrer"
              title={t("explore.openInAds")}
              aria-label={t("explore.openInAds")}
            >
              <Icon name="external-link" cls="ico-sm" />
            </a>
            <button
              className="btn icon ghost"
              onClick={onClose}
              title={t("common.close")}
              aria-label={t("common.close")}
              data-testid="close-discovery-detail"
            >
              <Icon name="x" cls="ico-sm" />
            </button>
          </div>
        </div>

        <h1 className="ref-detail-title serif">{paper.title}</h1>
        <div className="ref-detail-auth">
          {(allAuthors ? paper.authors : paper.authors.slice(0, 3)).join("; ")}
          {!allAuthors && paper.authors.length > 3 ? " et al." : ""}
          {paper.authors.length > 3 && (
            <button className="author-toggle" onClick={() => setAllAuthors((v) => !v)}>
              {t(allAuthors ? "explore.authorsLess" : "explore.authorsMore")}
            </button>
          )}
        </div>
        <div className="ref-detail-meta">
          <span>{paper.venue ?? "—"}</span>
          <span className="dotsep">·</span>
          <span className="mono">{paper.year ?? "—"}</span>
          {paper.citationCount !== null && (
            <>
              <span className="dotsep">·</span>
              <span className="mono">
                {t("library.detail.citedBy", { count: cgKfmt(paper.citationCount) })}
              </span>
            </>
          )}
        </div>
        {!seed && sourceLine && (
          <div className="discovery-source mono">
            {t("explore.sourceLine.head")}
            {" · "}
            {sourceLine}
          </div>
        )}

        <div className="ref-detail-tabs" role="tablist">
          <button
            className={"rdt" + (tab === "abstract" ? " on" : "")}
            onClick={() => setTab("abstract")}
          >
            {t("library.detail.tabs.info")}
          </button>
          <button
            className={"rdt" + (tab === "citations" ? " on" : "")}
            onClick={() => setTab("citations")}
            data-testid="discovery-citations-tab"
          >
            {t("explore.detail.citationsTab")}
          </button>
        </div>

        {tab === "abstract" && (
          <div>
            {paper.abstract ? (
              <AbstractHtml text={paper.abstract} className="ref-abstract" />
            ) : (
              <div className="abstract-missing">{t("explore.detail.noAbstract")}</div>
            )}
            <div className="ref-meta-list" style={{ marginTop: 14 }}>
              <div className="rml-row">
                <span className="rml-k">{t("library.detail.meta.venue")}</span>
                <span className="rml-v">{paper.venue ?? "—"}</span>
              </div>
              <div className="rml-row">
                <span className="rml-k">ADS</span>
                <span className="rml-v mono">
                  <a href={adsAbsUrl(paper.bibcode)} target="_blank" rel="noreferrer">
                    {paper.bibcode}
                  </a>
                </span>
              </div>
              {paper.doi && (
                <div className="rml-row">
                  <span className="rml-k">DOI</span>
                  <span className="rml-v mono">
                    <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">
                      {paper.doi}
                    </a>
                  </span>
                </div>
              )}
              {paper.arxivId && (
                <div className="rml-row">
                  <span className="rml-k">arXiv</span>
                  <span className="rml-v mono">
                    <a
                      href={`https://arxiv.org/abs/${paper.arxivId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {paper.arxivId}
                    </a>
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "citations" && (
          <div>
            <div className="citation-group-title">
              <Icon name="arrow-right" cls="ico-sm" />
              {t("explore.detail.referencesLabel")}
              <span className="mono">{outgoing.length}</span>
            </div>
            {outgoing.length > 0 ? (
              <div className="cg-conn-list">
                {outgoing.map((p) => (
                  <ConnRow key={p.bibcode} p={p} onSelect={onSelect} />
                ))}
              </div>
            ) : (
              <p className="record-note">{t("explore.detail.noneRefs")}</p>
            )}
            <div className="citation-group-title">
              <Icon name="arrow-left" cls="ico-sm" />
              {t("explore.detail.citedByLabel")}
              <span className="mono">{incoming.length}</span>
            </div>
            {incoming.length > 0 ? (
              <div className="cg-conn-list">
                {incoming.map((p) => (
                  <ConnRow key={p.bibcode} p={p} onSelect={onSelect} />
                ))}
              </div>
            ) : (
              <p className="record-note">{t("explore.detail.noneRefs")}</p>
            )}
            <p className="record-note">{t("explore.detail.graphOnly")}</p>
          </div>
        )}
      </div>

      <div className="detail-footer">
        {addFailed && (
          <div className="inline-error mono" role="alert">
            {t("explore.addError")}
          </div>
        )}
        {saved ? (
          <button
            className="btn success large"
            data-testid="view-in-library"
            onClick={() => onViewInLibrary(paper.libraryId!)}
          >
            <Icon name="check" cls="ico-sm" />
            {t("explore.savedInLibrary")}
            <Icon name="chevron-right" cls="ico-sm" />
          </button>
        ) : (
          <button
            className="btn primary large"
            data-testid="add-to-library"
            disabled={adding}
            onClick={() => onAdd(paper.bibcode)}
          >
            {adding ? (
              <Icon name="loader-circle" cls="ico-sm spin" />
            ) : (
              <Icon name="plus" cls="ico-sm" />
            )}
            {t(adding ? "explore.adding" : "explore.add")}
          </button>
        )}
        {seed ? (
          <div className="detail-footer-note">{t("explore.originNow")}</div>
        ) : (
          <button
            className="btn large"
            data-testid="explore-from-here"
            onClick={() => onExploreHere(paper.bibcode)}
          >
            <Icon name="compass" cls="ico-sm" />
            {t("explore.exploreHere")}
          </button>
        )}
        <div className="detail-footer-note">{t("explore.saveOnly")}</div>
      </div>
    </aside>
  );
}

function ConnRow({ p, onSelect }: { p: DiscoveryPaper; onSelect: (bibcode: string) => void }) {
  return (
    <button className="cg-conn" onClick={() => onSelect(p.bibcode)}>
      <span className={"cg-conn-dot" + (p.libraryId !== null ? " saved" : "")} />
      <span className="cg-conn-body">
        <span className="cg-conn-t">{p.title}</span>
        <span className="cg-conn-m mono">
          {(p.authors[0]?.split(",")[0] ?? "—") + ` · ${p.year ?? "—"}`}
        </span>
      </span>
    </button>
  );
}
