/**
 * The reading panel of one argument (ticket 04, approved prototype variant C, read state): kind badge, short title,
 * the audit findings that name it, the six Toulmin elements (Markdown with math, safe mode), the arguments that feed
 * Grounds / Warrant / Backing / Rebuttal inside the element they serve, "used by", and the sources. Read-only: the
 * edit, delete and link controls are ticket 05's.
 */
import type { Argument, ArgumentEdge, ArgumentEdgeRole, ArgumentGraph, ArgumentKind, ArgumentSource } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { mdWithMath } from "../lib/mdWithMath";
import { ActionButton, InlineMessage } from "../ui";
import type { Finding } from "./findings";
import { type DescribeFinding } from "./useFindingText";

type TextField = "claim" | "grounds" | "warrant" | "backing" | "qualifier" | "rebuttal";
/** Toulmin element names stay in English in both languages (CONTEXT.md). Claim, Grounds and Warrant are required elements. */
const FIELDS: { key: TextField; name: string; role?: ArgumentEdgeRole; required?: boolean }[] = [
  { key: "claim", name: "Claim", required: true },
  { key: "grounds", name: "Grounds", role: "grounds", required: true },
  { key: "warrant", name: "Warrant", role: "warrant", required: true },
  { key: "backing", name: "Backing", role: "backing" },
  { key: "qualifier", name: "Qualifier" },
  { key: "rebuttal", name: "Rebuttal", role: "rebuttal" },
];
export const ROLE_NAME: Record<ArgumentEdgeRole, string> = { grounds: "Grounds", warrant: "Warrant", backing: "Backing", rebuttal: "Rebuttal" };

const Md = ({ text }: { text: string }) => <div className="plan-md-body ag-md" dangerouslySetInnerHTML={{ __html: mdWithMath(text, { safe: true }) }} />;

/** A source can be opened when it has a target and that Doc still belongs to the Work; nothing else is checked. */
export const sourceOpenable = (source: ArgumentSource, workDocIds: readonly string[]): boolean => !!source.target && workDocIds.includes(source.target.doc_id);

/** Where the reading pane goes: a structural anchor for a shared-IR Doc, `page-<n>` for a PDF Doc (the Reader's own page anchor). */
export const sourceAnchor = (target: NonNullable<ArgumentSource["target"]>): string | null => ("anchor" in target && target.anchor ? target.anchor : "page" in target && target.page ? `page-${target.page}` : null);

export function ArgumentPanel({
  graph,
  argument,
  findings,
  describe,
  workDocIds,
  onSelect,
  onClose,
  onOpenSource,
}: {
  graph: ArgumentGraph;
  argument: Argument;
  /** The audit findings that name this argument. */
  findings: readonly Finding[];
  describe: DescribeFinding;
  /** Doc ids that belong to the Work now. */
  workDocIds: readonly string[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenSource: (target: NonNullable<ArgumentSource["target"]>) => void;
}) {
  const { t } = useTranslation();
  const byId = new Map(graph.arguments.map((a) => [a.id, a]));
  const incoming = graph.edges.filter((e) => e.to === argument.id && byId.has(e.from));
  const outgoing = graph.edges.filter((e) => e.from === argument.id && byId.has(e.to));
  const kindName = (k: ArgumentKind) => t(k === "native" ? "argument.view.kind.native" : k === "end" ? "argument.view.kind.end" : "argument.view.kind.normal");
  const titleOf = (id: string) => byId.get(id)?.title || t("argument.view.panel.untitled");

  const linkRow = (e: ArgumentEdge, otherId: string, chip: React.ReactNode, icon: string) => (
    <div className="ag-link" key={`${e.from}>${e.to}:${e.role}`} data-ui="argument-link" data-ui-key={otherId}>
      <button type="button" className="ag-link-title" data-ui="select-linked-argument" onClick={() => onSelect(otherId)}>
        <Icon name={icon} cls="ico-sm" />
        <span>{titleOf(otherId)}</span>
      </button>
      {chip}
    </div>
  );

  return (
    <aside className="ref-detail ag-panel" data-ui="argument-detail" data-ui-key={argument.id} aria-label={t("argument.view.panel.label")}>
      <div className="ref-detail-scroll">
        <div className="ref-detail-head">
          <span className={`ref-type-badge ag-kind kind-${argument.kind}`} data-ui="argument-kind-badge">
            {kindName(argument.kind)}
          </span>
          <div className="ref-detail-actions">
            <ActionButton unstyled mode="icon" iconName="x" className="btn icon ghost" data-ui="close-argument-detail" label={t("argument.view.panel.close")} tooltip={t("argument.view.panel.close")} onClick={onClose} />
          </div>
        </div>
        <h1 className="ref-detail-title serif" data-ui="argument-detail-title">
          {argument.title || t("argument.view.panel.untitled")}
        </h1>

        {findings.length > 0 && (
          <div className="ag-findings" data-ui="argument-findings">
            <InlineMessage tone="warning" title={t("argument.view.panel.findings")}>
              <ul>
                {findings.map((f, i) => (
                  <li key={i} data-ui="argument-finding" data-ui-key={f.kind}>
                    {describe(f)}
                  </li>
                ))}
              </ul>
            </InlineMessage>
          </div>
        )}

        {FIELDS.map((f) => {
          const text = argument[f.key];
          const links = f.role ? incoming.filter((e) => e.role === f.role) : [];
          // an empty optional element is hidden; an empty required one says so unless another argument supplies it
          if (!f.required && !text.trim() && links.length === 0) return null;
          return (
            <section className="ag-section" key={f.key} data-ui="argument-field" data-ui-key={f.key}>
              <div className="ag-section-head">
                <h4>{f.name}</h4>
                {f.key === "warrant" && argument.warrant_implicit && (
                  <span className="tag" data-ui="argument-warrant-implicit" title={t("argument.view.panel.implicitLabel")}>
                    {t("argument.view.panel.implicit")}
                  </span>
                )}
              </div>
              {text.trim() ? <Md text={text} /> : links.length === 0 && <div className="ag-hint" data-ui="argument-field-empty">{t("argument.view.panel.notFilled")}</div>}
              {links.length > 0 && <div className="ag-links">{links.map((e) => linkRow(e, e.from, null, "corner-down-right"))}</div>}
            </section>
          );
        })}

        <section className="ag-section" data-ui="argument-used-by">
          <div className="ag-section-head">
            <h4>{t("argument.view.panel.usedBy")}</h4>
          </div>
          {outgoing.length === 0 && <div className="ag-hint">{t("argument.view.panel.usedByNone")}</div>}
          <div className="ag-links">
            {outgoing.map((e) => linkRow(e, e.to, <span className={`ag-role-chip role-${e.role}`}>{t("argument.view.panel.asRole", { role: ROLE_NAME[e.role] })}</span>, "corner-up-right"))}
          </div>
        </section>

        <section className="ag-section" data-ui="argument-sources">
          <div className="ag-section-head">
            <h4>{t("argument.view.panel.sources")}</h4>
          </div>
          {argument.sources.length === 0 ? (
            <div className="ag-hint">{t("argument.view.panel.sourcesNone")}</div>
          ) : (
            <div className="ag-source-list">
              {argument.sources.map((s, i) =>
                s.target && sourceOpenable(s, workDocIds) ? (
                  <button key={i} type="button" className="ag-source link" data-ui="open-argument-source" data-ui-key={`${s.target.doc_id}`} title={t("argument.view.panel.openSource")} onClick={() => onOpenSource(s.target!)}>
                    <Icon name="file-text" cls="ico-sm" />
                    {s.text || s.target.doc_id}
                  </button>
                ) : (
                  <span key={i} className="ag-source" data-ui="argument-source-text">
                    {s.text}
                  </span>
                )
              )}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
