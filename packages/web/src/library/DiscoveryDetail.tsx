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
import { ActionButton, Tooltip } from "../ui";
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
    <aside className="ref-detail view-in" data-testid="discovery-detail" data-ui="discovery-detail" data-ui-key={paper.bibcode} aria-label={paper.title}>
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
          <div className="ref-detail-actions" data-ui="discovery-detail-actions">
            <Tooltip content={t("explore.openInAds")}>
              <a
                className="btn icon ghost"
                href={adsAbsUrl(paper.bibcode)}
                data-ui="open-discovery-paper-in-ads"
                target="_blank"
                rel="noreferrer"
                aria-label={t("explore.openInAds")}
              >
                <Icon name="external-link" cls="ico-sm" />
              </a>
            </Tooltip>
            <ActionButton unstyled mode="icon" iconName="x" className="btn icon ghost" label={t("common.close")} tooltip={t("common.close")} onClick={onClose} data-testid="close-discovery-detail" data-ui="close-discovery-detail" />
          </div>
        </div>

        <h1 className="ref-detail-title serif">{paper.title}</h1>
        <div className="ref-detail-auth">
          {(allAuthors ? paper.authors : paper.authors.slice(0, 3)).join("; ")}
          {!allAuthors && paper.authors.length > 3 ? " et al." : ""}
          {paper.authors.length > 3 && (
            <ActionButton unstyled mode="text" label={t(allAuthors ? "explore.authorsLess" : "explore.authorsMore")} tooltip={t(allAuthors ? "explore.authorsLess" : "explore.authorsMore")} data-ui="toggle-discovery-authors" className="author-toggle" onClick={() => setAllAuthors((v) => !v)}>{t(allAuthors ? "explore.authorsLess" : "explore.authorsMore")}</ActionButton>
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
          <div className="discovery-source mono" data-ui="discovery-paper-roles">
            {t("explore.sourceLine.head")}
            {" · "}
            {sourceLine}
          </div>
        )}

        <div className="ref-detail-tabs" data-ui="discovery-detail-tabs" role="tablist">
          <ActionButton unstyled mode="text" label={t("library.detail.tabs.info")} tooltip={t("library.detail.tabs.info")} data-ui="show-discovery-abstract" className={"rdt" + (tab === "abstract" ? " on" : "")} onClick={() => setTab("abstract")}>{t("library.detail.tabs.info")}</ActionButton>
          <ActionButton unstyled mode="text" label={t("explore.detail.citationsTab")} tooltip={t("explore.detail.citationsTab")} data-ui="show-discovery-citations" className={"rdt" + (tab === "citations" ? " on" : "")} onClick={() => setTab("citations")} data-testid="discovery-citations-tab">{t("explore.detail.citationsTab")}</ActionButton>
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

      <div className="detail-footer" data-ui="discovery-detail-actions">
        {addFailed && (
          <div className="inline-error mono" role="alert" data-ui="discovery-add-error">
            {t("explore.addError")}
          </div>
        )}
        {saved ? (
          <ActionButton unstyled mode="text" label={t("explore.savedInLibrary")} tooltip={t("explore.savedInLibrary")} className="btn success large" data-testid="view-in-library" data-ui="view-saved-work" onClick={() => onViewInLibrary(paper.libraryId!)}>{t("explore.savedInLibrary")}</ActionButton>
        ) : (
          <ActionButton unstyled mode="text" label={t(adding ? "explore.adding" : "explore.add")} tooltip={t(adding ? "explore.adding" : "explore.add")} className="btn primary large" data-testid="add-to-library" data-ui="save-discovery-paper" disabled={adding} busy={adding} onClick={() => onAdd(paper.bibcode)}>{t(adding ? "explore.adding" : "explore.add")}</ActionButton>
        )}
        {seed ? (
          <div className="detail-footer-note">{t("explore.originNow")}</div>
        ) : (
          <ActionButton unstyled mode="text" label={t("explore.exploreHere")} tooltip={t("explore.exploreHere")} className="btn large" data-testid="explore-from-here" data-ui="explore-from-paper" onClick={() => onExploreHere(paper.bibcode)}>{t("explore.exploreHere")}</ActionButton>
        )}
        <div className="detail-footer-note">{t("explore.saveOnly")}</div>
      </div>
    </aside>
  );
}

function ConnRow({ p, onSelect }: { p: DiscoveryPaper; onSelect: (bibcode: string) => void }) {
  return (
    <button className="cg-conn" data-ui="citation-paper" data-ui-key={p.bibcode} onClick={() => onSelect(p.bibcode)}>
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
