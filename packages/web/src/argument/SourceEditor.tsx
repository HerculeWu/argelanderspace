/**
 * Editing an argument's sources (ticket 05, approved prototype variant C): each source is display text plus an optional
 * jump target. The target is chosen in steps: a Doc of the Work, then a section / figure / equation / table of a
 * shared-IR Doc (listed from the structure the Doc already has) or a page of a PDF Doc. Choosing a location while the text
 * is empty fills the text with `Section 3.2`, `Figure 4`, `Page 5`. A target whose Doc is no longer the Work's stays as it
 * is (only a reference) and is marked.
 */
import { type ArgumentSource, autoSourceText } from "@argelanderspace/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchDocDescription } from "../api/doc";
import { type DocStructure, type StructureOption, fetchDocStructure } from "../api/doc-structure";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";

/** A source while it is being edited: the target may be half chosen (a Doc without a location yet). */
export interface DraftSource {
  text: string;
  docId: string;
  anchor?: string;
  page?: number;
  /** What the chosen location is called (`Section 3.2`): the text it fills in when the text is left empty. */
  auto?: string;
}

export const toDraftSource = (s: ArgumentSource): DraftSource => ({
  text: s.text,
  docId: s.target?.doc_id ?? "",
  ...(s.target && "anchor" in s.target && s.target.anchor ? { anchor: s.target.anchor } : {}),
  ...(s.target && "page" in s.target && s.target.page ? { page: s.target.page } : {}),
});

/** Each Doc's format (`pdf`, `latex`, `text`), read once from its description, to name it in the Doc list. */
function useDocFormats(docIds: readonly string[]): Map<string, string> {
  const [formats, setFormats] = useState<Map<string, string>>(new Map());
  const asked = useRef(new Set<string>());
  const key = docIds.join("\n");
  useEffect(() => {
    const controller = new AbortController();
    for (const id of key.split("\n").filter(Boolean)) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void fetchDocDescription(id, controller.signal).then(
        (r) => r.ok && setFormats((m) => new Map(m).set(id, r.description.format)),
        () => asked.current.delete(id)
      );
    }
    return () => controller.abort();
  }, [key]);
  return formats;
}

type Structures = Map<string, { status: "loading" } | { status: "failed" } | { status: "ok"; structure: DocStructure }>;

/** The structure of each Doc the editor has been asked about, read once. */
function useDocStructures(docIds: readonly string[]): Structures {
  const [loaded, setLoaded] = useState<Structures>(new Map());
  const asked = useRef(new Set<string>());
  const key = docIds.join("\n");
  useEffect(() => {
    const controller = new AbortController();
    for (const id of key.split("\n").filter(Boolean)) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      setLoaded((m) => new Map(m).set(id, { status: "loading" }));
      fetchDocStructure(id, controller.signal).then(
        (r) => setLoaded((m) => new Map(m).set(id, r.ok ? { status: "ok", structure: r.structure } : { status: "failed" })),
        () => asked.current.delete(id) // aborted: a remount asks again
      );
    }
    return () => controller.abort();
  }, [key]);
  return loaded;
}

/** The sources as the graph stores them: a target only when it is complete (a Doc with exactly one location), text filled in from the location when empty. */
export function toSources(drafts: readonly DraftSource[]): ArgumentSource[] {
  return drafts.map((d) => {
    const hasAnchor = !!d.anchor;
    const hasPage = !!d.page && d.page > 0;
    if (d.docId && hasAnchor !== hasPage) {
      const text = d.text.trim() ? d.text : hasAnchor ? (d.auto ?? d.anchor ?? "") : autoSourceText("page", d.page as number);
      return { text, target: hasAnchor ? { doc_id: d.docId, anchor: d.anchor as string } : { doc_id: d.docId, page: d.page as number } };
    }
    return { text: d.text };
  });
}

const GROUPS: StructureOption["kind"][] = ["section", "figure", "table", "equation"];

export function SourceEditor({ sources, onChange, workDocIds }: { sources: DraftSource[]; onChange: (s: DraftSource[]) => void; workDocIds: readonly string[] }) {
  const { t } = useTranslation();
  const used = sources.map((s) => s.docId).filter(Boolean);
  const structures = useDocStructures([...new Set(used)]);
  const formats = useDocFormats([...new Set([...workDocIds, ...used])]);
  const formatName = (id: string) => {
    const f = formats.get(id);
    return f ? t(`argument.edit.sourceDocFormat.${f}` as "argument.edit.sourceDocFormat.pdf", { defaultValue: f.toUpperCase() }) : null;
  };
  const set = (i: number, s: DraftSource) => onChange(sources.map((x, k) => (k === i ? s : x)));
  const groupName = (k: StructureOption["kind"]) => t(`argument.edit.sourceGroup${k[0]!.toUpperCase()}${k.slice(1)}` as "argument.edit.sourceGroupSection");

  return (
    <div className="ag-sources-edit" data-ui="argument-source-editor">
      {sources.map((s, i) => {
        const known = s.docId ? structures.get(s.docId) : undefined;
        const structure = known?.status === "ok" ? known.structure : null;
        const docIds = s.docId && !workDocIds.includes(s.docId) ? [...workDocIds, s.docId] : workDocIds;
        return (
          <div className="ag-source-row" key={i} data-ui="argument-source-row" data-ui-key={i}>
            <input className="ag-input ag-source-text" data-ui="argument-source-text-input" aria-label={t("argument.edit.sourceText")} placeholder={t("argument.edit.sourceText")} value={s.text} onChange={(e) => set(i, { ...s, text: e.target.value })} />
            <ActionButton unstyled mode="icon" iconName="x" className="btn icon ghost" data-ui="remove-argument-source" label={t("argument.edit.sourceRemove")} tooltip={t("argument.edit.sourceRemove")} onClick={() => onChange(sources.filter((_, k) => k !== i))} />
            <select className="ag-input" data-ui="argument-source-doc" aria-label={t("argument.edit.sourceDoc")} value={s.docId} onChange={(e) => set(i, { text: s.text, docId: e.target.value })}>
              <option value="">{t("argument.edit.sourceNone")}</option>
              {docIds.map((id, k) => (
                <option key={id} value={id}>
                  {[id, formatName(id), k === 0 && workDocIds.includes(id) ? t("argument.edit.sourceMain") : null].filter(Boolean).join(" · ")}
                  {workDocIds.includes(id) ? "" : ` ${t("argument.edit.sourceOutsideWork")}`}
                </option>
              ))}
            </select>
            {s.docId && known?.status === "loading" && <span className="ag-hint ag-source-note" role="status">{t("argument.edit.sourceLoading")}</span>}
            {s.docId && known?.status === "failed" && <span className="ag-hint warn ag-source-note">{t("argument.edit.sourceStructureFailed")}</span>}
            {structure?.format === "ir" && (
              <select
                className="ag-input"
                data-ui="argument-source-anchor"
                aria-label={t("argument.edit.sourceAnchor")}
                value={s.anchor ?? ""}
                onChange={(e) => {
                  const option = structure.options.find((o) => o.anchor === e.target.value);
                  set(i, { ...s, anchor: e.target.value || undefined, auto: option?.autoText, text: s.text.trim() ? s.text : (option?.autoText ?? "") });
                }}
              >
                <option value="">{structure.options.length ? t("argument.edit.sourceAnchorPick") : t("argument.edit.sourceNoStructure")}</option>
                {s.anchor && !structure.options.some((o) => o.anchor === s.anchor) && <option value={s.anchor}>{s.anchor}</option>}
                {GROUPS.map((k) => {
                  const list = structure.options.filter((o) => o.kind === k);
                  return list.length > 0 ? (
                    <optgroup key={k} label={groupName(k)}>
                      {list.map((o) => (
                        <option key={o.anchor} value={o.anchor}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </select>
            )}
            {structure?.format === "pdf" && (
              <input
                className="ag-input"
                data-ui="argument-source-page"
                type="number"
                min={1}
                max={structure.pageCount}
                aria-label={t("argument.edit.sourcePageOf", { n: structure.pageCount })}
                placeholder={t("argument.edit.sourcePageOf", { n: structure.pageCount })}
                value={s.page ?? ""}
                onChange={(e) => {
                  const n = Math.trunc(Number(e.target.value));
                  const page = n >= 1 ? Math.min(n, structure.pageCount) : undefined;
                  set(i, { ...s, page, text: s.text.trim() ? s.text : page ? autoSourceText("page", page) : "" });
                }}
              />
            )}
          </div>
        );
      })}
      <button type="button" className="ag-add" data-ui="add-argument-source" onClick={() => onChange([...sources, { text: "", docId: "" }])}>
        <Icon name="plus" cls="ico-sm" />
        {t("argument.edit.sourceAdd")}
      </button>
    </div>
  );
}
