/**
 * The panel of one argument (approved prototype variant C): read first (ticket 04), then edit (ticket 05). Reading shows
 * the kind badge, short title, the audit findings that name it, the six Toulmin elements (Markdown with math, safe mode),
 * the arguments that feed Grounds / Warrant / Backing / Rebuttal inside the element they serve, "used by", and the sources.
 * Editing swaps the title, kind, the six fields, Warrant's `implicit` and the sources for inputs over a draft the panel
 * owns; links (add from a picker, remove) and delete are their own writes, not part of the draft. The draft is the
 * person's: an update from elsewhere never replaces it, a stale base shows the conflict box, and the draft survives a
 * refused save. Saving, linking and deleting are the caller's (one commit path, `commit.ts`).
 */
import { type Argument, type ArgumentDraft, type ArgumentEdge, type ArgumentEdgeRole, type ArgumentGraph, type ArgumentKind, type ArgumentSource, BLANK_ARGUMENT, sameArgument } from "@argelanderspace/contracts";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { mdWithMath } from "../lib/mdWithMath";
import { ActionButton, InlineMessage } from "../ui";
import { ArgumentPicker } from "./ArgumentPicker";
import { type DraftSource, SourceEditor, toDraftSource, toSources } from "./SourceEditor";
import { type Finding, findingKey } from "./findings";
import { argumentLayers } from "./layers";
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

const KINDS: ArgumentKind[] = ["normal", "native", "end"];

const Md = ({ text }: { text: string }) => <div className="plan-md-body ag-md" dangerouslySetInnerHTML={{ __html: mdWithMath(text, { safe: true }) }} />;

/** A source can be opened when it has a target and that Doc still belongs to the Work; nothing else is checked. */
export const sourceOpenable = (source: ArgumentSource, workDocIds: readonly string[]): boolean => !!source.target && workDocIds.includes(source.target.doc_id);

/** Where the reading pane goes: a structural anchor for a shared-IR Doc, `page-<n>` for a PDF Doc (the Reader's own page anchor). */
export const sourceAnchor = (target: NonNullable<ArgumentSource["target"]>): string | null => ("anchor" in target && target.anchor ? target.anchor : "page" in target && target.page ? `page-${target.page}` : null);


/** What the panel's Save came back with (the caller's commit, already in words the panel can show). */
export type PanelSaveOutcome = { kind: "ok" } | { kind: "conflict"; rev: number | null } | { kind: "refused"; messages: string[] };

interface DraftFields {
  title: string;
  kind: ArgumentKind;
  claim: string;
  grounds: string;
  warrant: string;
  backing: string;
  qualifier: string;
  rebuttal: string;
  warrant_implicit: boolean;
  sources: DraftSource[];
}
const draftOf = (a: Omit<Argument, "id">): DraftFields => ({
  title: a.title,
  kind: a.kind,
  claim: a.claim,
  grounds: a.grounds,
  warrant: a.warrant,
  backing: a.backing,
  qualifier: a.qualifier,
  rebuttal: a.rebuttal,
  warrant_implicit: a.warrant_implicit,
  sources: a.sources.map(toDraftSource),
});

export function ArgumentPanel({
  graph,
  argument,
  isNew = false,
  findings,
  describe,
  workDocIds,
  onSelect,
  onClose,
  onOpenSource,
  overlay = false,
  busy = false,
  unavailable = null,
  onSave,
  onDiscardNew,
  onDelete,
  onAddEdge,
  onRemoveEdge,
  onReload,
  onDirtyChange,
}: {
  graph: ArgumentGraph;
  /** The argument shown; for a new, unsaved one a blank with an empty id. */
  argument: Argument;
  /** Not in the graph yet: the panel opens in edit mode, Cancel discards it, linking waits for the first save. */
  isNew?: boolean;
  /** The audit findings that name this argument. */
  findings: readonly Finding[];
  describe: DescribeFinding;
  /** Doc ids that belong to the Work now. */
  workDocIds: readonly string[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenSource: (target: NonNullable<ArgumentSource["target"]>) => void;
  /** Floats over the canvas's right edge (a pane too narrow to hold it beside). */
  overlay?: boolean;
  /** A write is in flight: the controls that would start another wait. */
  busy?: boolean;
  /** Why nothing can be written now (the graph file is unreadable, the Work is gone): the draft stays, Save is off and this says why. */
  unavailable?: string | null;
  /** Save the draft over `base` (the stored argument it was started from; null when it creates one). */
  onSave: (draft: ArgumentDraft, base: Argument | null, id: string | null) => Promise<PanelSaveOutcome>;
  onDiscardNew: () => void;
  onDelete: () => void;
  onAddEdge: (edge: ArgumentEdge) => void;
  onRemoveEdge: (edge: ArgumentEdge) => void;
  /** Reads the graph again and hands it back (null when that failed). */
  onReload: () => Promise<ArgumentGraph | null>;
  /** The panel holds an unsaved draft (leave-draft protection). */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(isNew);
  const [draft, setDraft] = useState<DraftFields>(() => draftOf(argument));
  /** The stored argument the draft started from; null for one that is not stored (new, or deleted elsewhere meanwhile). */
  const [base, setBase] = useState<Argument | null>(isNew ? null : argument);
  /** The graph version the draft started from (what the conflict box says the version moved away from). */
  const [baseRev, setBaseRev] = useState(graph.rev);
  const [adding, setAdding] = useState<ArgumentEdgeRole | "use" | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [conflict, setConflict] = useState<{ rev: number | null } | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  useEffect(() => {
    if (isNew) titleRef.current?.focus();
  }, [isNew]);

  const byId = new Map(graph.arguments.map((a) => [a.id, a]));
  const stored = isNew ? undefined : byId.get(argument.id);
  const incoming = graph.edges.filter((e) => e.to === argument.id && byId.has(e.from));
  const outgoing = graph.edges.filter((e) => e.from === argument.id && byId.has(e.to));
  const kindName = (k: ArgumentKind) => t(k === "native" ? "argument.view.kind.native" : k === "end" ? "argument.view.kind.end" : "argument.view.kind.normal");
  const titleOf = (id: string) => byId.get(id)?.title || t("argument.view.panel.untitled");
  const roleName = (r: ArgumentEdgeRole) => ROLE_NAME[r];

  const reference = useMemo(() => draftOf(base ?? { ...BLANK_ARGUMENT }), [base]);
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(reference);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // what the stored argument has become since the draft started: the draft stays, saving waits for a reload
  const stale: "changed" | "gone" | null = !editing || base === null || isNew ? null : !stored ? "gone" : sameArgument(stored, base) ? null : "changed";
  const conflicted = conflict !== null || stale !== null;

  const layerOf = useMemo(() => argumentLayers(graph), [graph]);
  const here = layerOf[argument.id] ?? 0;
  const others = graph.arguments.filter((a) => a.id !== argument.id);
  const hasEdge = (from: string, to: string, role: ArgumentEdgeRole) => graph.edges.some((e) => e.from === from && e.to === to && e.role === role);
  const below = (list: Argument[]) => list.filter((a) => layerOf[a.id] === here - 1);
  const above = (list: Argument[]) => list.filter((a) => layerOf[a.id] === here + 1);

  const cancel = () => {
    if (isNew) {
      onDiscardNew();
      return;
    }
    setDraft(draftOf(argument));
    setBase(argument);
    setBaseRev(graph.rev);
    setConflict(null);
    setMessages([]);
    setEditing(false);
  };
  const save = async () => {
    if (!draft.title.trim() || saving || conflicted) return;
    setSaving(true);
    setMessages([]);
    try {
      const outcome = await onSave(
        {
          title: draft.title,
          kind: draft.kind,
          claim: draft.claim,
          grounds: draft.grounds,
          warrant: draft.warrant,
          backing: draft.backing,
          qualifier: draft.qualifier,
          rebuttal: draft.rebuttal,
          warrant_implicit: draft.warrant_implicit,
          sources: toSources(draft.sources),
        },
        base,
        isNew ? null : argument.id
      );
      if (outcome.kind === "ok") {
        setConflict(null);
        if (!isNew) setEditing(false);
      } else if (outcome.kind === "conflict") setConflict({ rev: outcome.rev });
      else setMessages(outcome.messages);
    } finally {
      setSaving(false);
    }
  };
  const reload = async () => {
    setReloading(true);
    try {
      const fresh = await onReload();
      if (!fresh) return;
      setBase(fresh.arguments.find((a) => a.id === argument.id) ?? null);
      setBaseRev(fresh.rev);
      setConflict(null);
    } finally {
      setReloading(false);
    }
  };
  /** Arrow keys move the kind choice along the three options (roving tabindex: only the chosen one is in the Tab order). */
  const moveKind = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "Home" ? "first" : e.key === "End" ? "last" : null;
    if (step === null) return;
    e.preventDefault();
    const at = KINDS.indexOf(draft.kind);
    const next = KINDS[step === "first" ? 0 : step === "last" ? KINDS.length - 1 : (at + step + KINDS.length) % KINDS.length]!;
    setField("kind", next);
    const group = e.currentTarget;
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-ui-key="${next}"]`)?.focus());
  };
  const setField = useCallback(<K extends keyof DraftFields>(key: K, value: DraftFields[K]) => setDraft((d) => ({ ...d, [key]: value })), []);

  // an argument can be linked in several roles at once: the key names the edge (the other end and the role), not just the end
  const linkRow = (e: ArgumentEdge, otherId: string, chip: React.ReactNode, icon: string) => (
    <div className="ag-link" key={`${e.from}>${e.to}:${e.role}`} data-ui="argument-link" data-ui-key={chip === null ? otherId : `${otherId}:${e.role}`}>
      <button type="button" className="ag-link-title" data-ui="select-linked-argument" onClick={() => onSelect(otherId)}>
        <Icon name={icon} cls="ico-sm" />
        <span>{titleOf(otherId)}</span>
      </button>
      {chip}
      <ActionButton unstyled mode="icon" iconName="x" className="btn icon ghost" data-ui="remove-argument-link" data-ui-key={`${otherId}:${e.role}`} label={t("argument.edit.removeLink", { title: titleOf(otherId) })} tooltip={t("argument.edit.removeLink", { title: titleOf(otherId) })} disabled={busy} onClick={() => onRemoveEdge(e)} />
    </div>
  );

  const linkToggle = (which: ArgumentEdgeRole | "use", label: string, uiId: string, key?: string) => (
    <ActionButton unstyled mode="icon" iconName="link" className="btn icon ghost" data-ui={uiId} data-ui-key={key} label={label} tooltip={isNew ? t("argument.edit.linkNeedsSave") : label} disabled={isNew} aria-expanded={adding === which} onClick={() => setAdding(adding === which ? null : which)} />
  );

  return (
    <aside className={`ref-detail ag-panel${overlay ? " ag-panel-overlay" : ""}`} data-ui="argument-detail" data-ui-key={isNew ? "new" : argument.id} data-placement={overlay ? "overlay" : "side"} data-mode={editing ? "edit" : "read"} aria-label={t("argument.view.panel.label")}>
      <div className="ref-detail-scroll">
        <div className="ref-detail-head">
          <span className={`ref-type-badge ag-kind kind-${editing ? draft.kind : argument.kind}`} data-ui="argument-kind-badge">
            {kindName(editing ? draft.kind : argument.kind)}
          </span>
          <div className="ref-detail-actions">
            {!editing && <ActionButton unstyled mode="icon" iconSize="small" iconName="pencil" className="btn icon ghost" data-ui="edit-argument" label={t("argument.edit.edit")} tooltip={t("argument.edit.edit")} onClick={() => { setDraft(draftOf(argument)); setBase(argument); setBaseRev(graph.rev); setEditing(true); }} />}
            {!isNew && <ActionButton unstyled mode="icon" iconSize="small" iconName="trash-2" className="btn icon ghost" data-ui="delete-argument" label={t("argument.edit.delete")} tooltip={t("argument.edit.delete")} disabled={busy} onClick={onDelete} />}
            <ActionButton unstyled mode="icon" iconSize="small" iconName="x" className="btn icon ghost" data-ui="close-argument-detail" label={t("argument.view.panel.close")} tooltip={t("argument.view.panel.close")} onClick={onClose} />
          </div>
        </div>

        {editing ? (
          <>
            <label className="ag-field-label" htmlFor={titleId}>
              {t("argument.edit.title")}
            </label>
            <input id={titleId} ref={titleRef} className="ag-input title" data-ui="argument-title-input" value={draft.title} placeholder={t("argument.edit.titleHint")} onChange={(e) => setField("title", e.target.value)} />
            {!draft.title.trim() && <div className="ag-hint warn">{t("argument.edit.titleMissing")}</div>}
            <div className="ag-field-label" id={`${titleId}-kind`}>
              {t("argument.edit.kind")}
            </div>
            <div className="ag-seg" role="radiogroup" aria-labelledby={`${titleId}-kind`} aria-describedby={`${titleId}-kind-help`} data-ui="argument-kind" onKeyDown={moveKind}>
              {KINDS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={draft.kind === k} tabIndex={draft.kind === k ? 0 : -1} className={draft.kind === k ? "on" : ""} data-ui="argument-kind-option" data-ui-key={k} onClick={() => setField("kind", k)}>
                  {kindName(k)}
                </button>
              ))}
            </div>
            <div className="ag-hint ag-kind-help" id={`${titleId}-kind-help`} data-ui="argument-kind-help">
              <span><b>{kindName("native")}</b> — {t("argument.edit.kindNativeHint")}</span>
              <span><b>{kindName("end")}</b> — {t("argument.edit.kindEndHint")}</span>
            </div>
          </>
        ) : (
          <h1 className="ref-detail-title serif" data-ui="argument-detail-title">
            {argument.title || t("argument.view.panel.untitled")}
          </h1>
        )}

        {findings.length > 0 && !isNew && (
          <div className="ag-findings" data-ui="argument-findings">
            <InlineMessage tone="warning" title={t("argument.view.panel.findings")}>
              <ul>
                {findings.map((f, i) => (
                  <li key={i} data-ui="argument-finding" data-ui-key={findingKey(f)}>
                    {describe(f)}
                  </li>
                ))}
              </ul>
            </InlineMessage>
          </div>
        )}

        {FIELDS.map((f) => {
          const text = editing ? draft[f.key] : argument[f.key];
          const links = f.role ? incoming.filter((e) => e.role === f.role) : [];
          // an empty optional element is hidden while reading; an empty required one says so unless another argument supplies it
          if (!editing && !f.required && !text.trim() && links.length === 0 && adding !== f.role) return null;
          return (
            <section className="ag-section" key={f.key} data-ui="argument-field" data-ui-key={f.key}>
              <div className="ag-section-head">
                <h4>{f.name}</h4>
                {f.key === "warrant" &&
                  (editing ? (
                    <label className="ag-check">
                      <input type="checkbox" data-ui="argument-warrant-implicit-input" checked={draft.warrant_implicit} onChange={(e) => setField("warrant_implicit", e.target.checked)} />
                      {t("argument.edit.implicitCheck")}
                    </label>
                  ) : (
                    argument.warrant_implicit && (
                      <span className="tag" data-ui="argument-warrant-implicit" title={t("argument.view.panel.implicitLabel")}>
                        {t("argument.view.panel.implicit")}
                      </span>
                    )
                  ))}
                <span className="ag-spacer" />
                {f.role && linkToggle(f.role, t("argument.edit.addFrom", { role: f.name }), "add-argument-link", f.role)}
              </div>
              {editing ? (
                <textarea className="ag-input area" data-ui="argument-field-input" data-ui-key={f.key} aria-label={f.name} rows={f.key === "claim" ? 3 : 2} value={draft[f.key]} onChange={(e) => setField(f.key, e.target.value)} />
              ) : text.trim() ? (
                <Md text={text} />
              ) : (
                links.length === 0 && (
                  <div className="ag-hint" data-ui="argument-field-empty">
                    {t("argument.view.panel.notFilled")}
                  </div>
                )
              )}
              {links.length > 0 && <div className="ag-links">{links.map((e) => linkRow(e, e.from, null, "corner-down-right"))}</div>}
              {f.role && adding === f.role && (
                (() => {
                  const free = others.filter((o) => !hasEdge(o.id, argument.id, f.role!));
                  return <ArgumentPicker uiKey={f.role!} near={below(free)} all={free} nearLabel={t("argument.edit.pickBelow")} countLabel={(n) => t("argument.edit.pickCountBelow", { n })} roleName={roleName} busy={busy} onPick={(id) => { onAddEdge({ from: id, to: argument.id, role: f.role! }); setAdding(null); }} />;
                })()
              )}
            </section>
          );
        })}

        <section className="ag-section" data-ui="argument-used-by">
          <div className="ag-section-head">
            <h4>{t("argument.view.panel.usedBy")}</h4>
            <span className="ag-spacer" />
            {linkToggle("use", t("argument.edit.addUse"), "add-argument-use")}
          </div>
          {outgoing.length === 0 && adding !== "use" && <div className="ag-hint">{t("argument.view.panel.usedByNone")}</div>}
          <div className="ag-links">
            {outgoing.map((e) => linkRow(e, e.to, <span className={`ag-role-chip role-${e.role}`}>{t("argument.view.panel.asRole", { role: ROLE_NAME[e.role] })}</span>, "corner-up-right"))}
          </div>
          {adding === "use" &&
            (() => {
              const free = others.filter((o) => (["grounds", "warrant", "backing", "rebuttal"] as ArgumentEdgeRole[]).some((r) => !hasEdge(argument.id, o.id, r)));
              return <ArgumentPicker uiKey="use" withRole near={above(free)} all={free} nearLabel={t("argument.edit.pickAbove")} countLabel={(n) => t("argument.edit.pickCountAbove", { n })} roleName={roleName} disabledFor={(id, role) => hasEdge(argument.id, id, role)} busy={busy} onPick={(id, role) => { onAddEdge({ from: argument.id, to: id, role }); setAdding(null); }} />;
            })()}
        </section>

        <section className="ag-section" data-ui="argument-sources">
          <div className="ag-section-head">
            <h4>{t("argument.view.panel.sources")}</h4>
          </div>
          {editing ? (
            <SourceEditor sources={draft.sources} onChange={(s) => setField("sources", s)} workDocIds={workDocIds} />
          ) : argument.sources.length === 0 ? (
            <div className="ag-hint">{t("argument.view.panel.sourcesNone")}</div>
          ) : (
            <div className="ag-source-list">
              {argument.sources.map((s, i) =>
                s.target && sourceOpenable(s, workDocIds) ? (
                  <button key={i} type="button" className="ag-source link" data-ui="open-argument-source" data-ui-key={i} title={t("argument.view.panel.openSource")} onClick={() => onOpenSource(s.target!)}>
                    <Icon name="file-text" cls="ico-sm" />
                    {s.text || s.target.doc_id}
                  </button>
                ) : (
                  <span key={i} className="ag-source" data-ui="argument-source-text" data-ui-key={i}>
                    {s.text}
                  </span>
                )
              )}
            </div>
          )}
        </section>
      </div>

      {editing && (
        <div className="detail-footer" data-ui="argument-editor-footer">
          {unavailable && (
            <InlineMessage tone="danger" uiId="argument-save-unavailable">
              {unavailable}
            </InlineMessage>
          )}
          {conflicted && (
            <InlineMessage tone="danger" title={t("argument.edit.conflictTitle")} uiId="argument-save-conflict">
              {stale === "gone" ? t("argument.edit.conflictGone") : stale === "changed" ? t("argument.edit.conflictStale") : conflict?.rev != null ? t("argument.edit.conflictBody", { a: baseRev, b: conflict.rev }) : t("argument.edit.conflictBodyUnknown")}
              <div style={{ marginTop: 6 }}>
                <ActionButton mode="text" label={t("argument.edit.reload")} tooltip={t("argument.edit.reload")} data-ui="reload-argument-graph" busy={reloading} busyLabel={t("argument.edit.reloading")} onClick={reload}>
                  {t("argument.edit.reload")}
                </ActionButton>
              </div>
            </InlineMessage>
          )}
          {messages.length > 0 && (
            <InlineMessage tone="danger" uiId="argument-save-invalid">
              <ul className="ag-issue-list">
                {messages.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </InlineMessage>
          )}
          <div className="ag-footer-actions">
            <ActionButton mode="text" label={t("argument.edit.cancel")} tooltip={t("argument.edit.cancel")} data-ui="cancel-argument-edit" onClick={cancel}>
              {t("argument.edit.cancel")}
            </ActionButton>
            <ActionButton mode="text" appearance="primary" label={t("argument.edit.save")} tooltip={t("argument.edit.save")} data-ui="save-argument" disabled={!draft.title.trim() || conflicted || unavailable !== null || (!isNew && !dirty)} busy={saving} busyLabel={t("argument.edit.saving")} onClick={save}>
              {t("argument.edit.save")}
            </ActionButton>
          </div>
        </div>
      )}
    </aside>
  );
}
