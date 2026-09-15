/**
 * Stage 10 Writer — cell rendering and editing (prototype renderFor /
 * editorFor), React-safe: the heuristic LaTeX preview is segmented in
 * model.ts and rendered as elements (no innerHTML).
 */

import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { Math } from "../lib/math";
import type { CellPlacement, CellType, WriterCell } from "@argelanderspace/contracts";
import { LatexSourceField } from "./latexSource";
import { floatNumber, inlineSegs, latexBlocks, parseSimpleCsv, type InlineSeg } from "./model";
import { assetUrl } from "../api/writer";

/** t() keys for each cell type label (prototype typeDefs). */
export const TYPE_LABEL_KEY = {
  latex: "writer.types.latex",
  "abstract-aa": "writer.types.abstractAa",
  figure: "writer.types.figure",
  table: "writer.types.table",
  code: "writer.types.code",
  ack: "writer.types.ack",
  appendix: "writer.types.appendix",
  recipient: "writer.types.recipient",
} as const satisfies Record<CellType, string>;

const ABSTRACT_PARTS = [
  { dataKey: "Context", labelKey: "writer.abstract.context" },
  { dataKey: "Aims", labelKey: "writer.abstract.aims" },
  { dataKey: "Methods", labelKey: "writer.abstract.methods" },
  { dataKey: "Results", labelKey: "writer.abstract.results" },
  { dataKey: "Conclusions", labelKey: "writer.abstract.conclusions" },
] as const;

/** Callbacks the editor shell hands down to every cell. */
export interface CellCtx {
  /** owning manuscript id (figure asset URLs) */
  docId: string;
  activeId: string | null;
  editingId: string | null;
  onActivate: (cellId: string) => void;
  onEdit: (cellId: string) => void;
  onCommit: (cellId: string) => void;
  onDelete: (cellId: string) => void;
  onComment: (cellId: string) => void;
  onOpenTypeMenu: (cellId: string, e: React.MouseEvent) => void;
  onField: (cellId: string, field: string, value: unknown) => void;
  onCaret: (cellId: string, field: string, el: HTMLInputElement | HTMLTextAreaElement) => void;
  onImageFile: (cellId: string, file: File) => void;
}

// ---------------------------------------------------------------- render ----

function Inline({ segs }: { segs: InlineSeg[] }) {
  return (
    <>
      {segs.map((s, i) =>
        s.kind === "cite" ? (
          <span key={i} className="w-cite">
            [{s.text}]
          </span>
        ) : s.kind === "xref" ? (
          <span key={i} className="w-xref">
            [{s.text}]
          </span>
        ) : s.kind === "math" ? (
          <Math key={i} latex={s.tex} />
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function placementStyle(placement: CellPlacement | undefined, width: number): React.CSSProperties {
  const align =
    placement === "left"
      ? { marginLeft: 0, marginRight: "auto" }
      : placement === "right"
        ? { marginLeft: "auto", marginRight: 0 }
        : { marginLeft: "auto", marginRight: "auto" };
  return { width: `${width}%`, ...align };
}

export function CellRender({
  cell,
  cells,
  ctx,
}: {
  cell: WriterCell;
  cells: WriterCell[];
  ctx: CellCtx;
}) {
  const { t } = useTranslation();
  const d = cell.data as Record<string, unknown>;

  if (cell.type === "latex") {
    const blocks = latexBlocks((d.source as string) ?? "");
    return (
      <div className="w-render">
        {blocks.map((b, i) =>
          b.kind === "math" ? (
            <div key={i} className="w-math">
              <Math latex={b.tex} display />
            </div>
          ) : b.kind === "section" ? (
            <h2 key={i}>
              <Inline segs={b.segments} />
            </h2>
          ) : b.kind === "subsection" ? (
            <h3 key={i}>
              <Inline segs={b.segments} />
            </h3>
          ) : (
            <p key={i}>
              <Inline segs={b.segments} />
            </p>
          ),
        )}
      </div>
    );
  }

  if (cell.type === "abstract-aa") {
    return (
      <div className="w-render">
        <div className="w-abstract">
          {ABSTRACT_PARTS.map(({ dataKey, labelKey }) =>
            d[dataKey] ? (
              <div className="w-abs-part" key={dataKey}>
                <span className="w-abs-label">{t(labelKey)}.</span>
                <Inline segs={inlineSegs(String(d[dataKey]))} />
              </div>
            ) : null,
          )}
        </div>
      </div>
    );
  }

  if (cell.type === "figure") {
    const n = floatNumber(cells, cell.id);
    return (
      <div className="w-render">
        <div
          className="w-figure-box"
          style={placementStyle(d.placement as CellPlacement, (d.width as number) || 80)}
        >
          {d.image ? (
            <img src={assetUrl(ctx.docId, String(d.image))} alt={String(d.caption ?? "")} />
          ) : (
            t("writer.figure.noImage")
          )}
        </div>
        <div className="w-caption" style={placementStyle(d.placement as CellPlacement, (d.width as number) || 80)}>
          <strong>
            {t("writer.figure.figure")} {n}.
          </strong>{" "}
          <Inline segs={inlineSegs(String(d.caption ?? ""))} />{" "}
          <span className="w-key">{String(d.label ?? "") || t("writer.xref.noLabel")}</span>
        </div>
      </div>
    );
  }

  if (cell.type === "table") {
    const n = floatNumber(cells, cell.id);
    const head = parseSimpleCsv(String(d.head ?? ""))[0] ?? [];
    const rows = parseSimpleCsv(String(d.csv ?? ""));
    return (
      <div className="w-render">
        <div style={placementStyle(d.placement as CellPlacement, (d.width as number) || 92)}>
          <div className="w-table-preview">
            <table className="w-preview">
              <thead>
                <tr>
                  {head.map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="w-caption">
            <strong>
              {t("writer.figure.table")} {n}.
            </strong>{" "}
            <Inline segs={inlineSegs(String(d.caption ?? ""))} />{" "}
            <span className="w-key">{String(d.label ?? "") || t("writer.xref.noLabel")}</span>
          </div>
        </div>
      </div>
    );
  }

  if (cell.type === "code") {
    const n = floatNumber(cells, cell.id);
    return (
      <div className="w-render">
        <div className="w-caption w-caption-top">
          <strong>
            {t("writer.figure.listing")} {n}.
          </strong>{" "}
          {String(d.caption ?? "")} <span className="w-key">{String(d.label ?? "")}</span>
        </div>
        <pre className="w-code-render">{String(d.code ?? "")}</pre>
      </div>
    );
  }

  if (cell.type === "ack") {
    return (
      <div className="w-render">
        <h3>{t("writer.ackTitle")}</h3>
        <p>
          <Inline segs={inlineSegs(String(d.source ?? ""))} />
        </p>
      </div>
    );
  }

  if (cell.type === "appendix") {
    return (
      <div className="w-render">
        <div className="w-appendix-marker">{t("writer.appendixMarker")}</div>
      </div>
    );
  }

  // recipient
  return (
    <div className="w-render">
      <div className="w-recipient">
        <strong>{String(d.name ?? "") || t("writer.types.recipient")}</strong>
        <br />
        {String(d.organization ?? "")}
        <br />
        {String(d.address ?? "")
          .split("\n")
          .map((line, i) => (
            <span key={i}>
              {line}
              <br />
            </span>
          ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- edit ----

interface FieldProps {
  cell: WriterCell;
  ctx: CellCtx;
}

function useField(cell: WriterCell, ctx: CellCtx) {
  const d = cell.data as Record<string, unknown>;
  return {
    value: (f: string) => String(d[f] ?? ""),
    textProps: (f: string) => ({
      value: String(d[f] ?? ""),
      "data-field": f,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        ctx.onField(cell.id, f, e.target.value),
      onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        ctx.onCaret(cell.id, f, e.currentTarget),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          ctx.onCommit(cell.id);
        }
      },
    }),
  };
}

function EditorFooter({ cell, ctx }: FieldProps) {
  const { t } = useTranslation();
  return (
    <div className="w-editor-actions">
      <span className="w-hint">{t("writer.cell.shiftEnterHint")}</span>
      <div className="w-editor-buttons">
        <button className="btn" onClick={() => ctx.onDelete(cell.id)}>
          {t("common.delete")}
        </button>
        <button className="btn primary" data-commit={cell.id} onClick={() => ctx.onCommit(cell.id)}>
          {t("writer.cell.render")}
        </button>
      </div>
    </div>
  );
}

function PlacementButtons({ cell, ctx }: FieldProps) {
  const d = cell.data as Record<string, unknown>;
  const cur = (d.placement as CellPlacement) || "center";
  return (
    <div className="w-segmented">
      {(["left", "center", "right"] as const).map((p) => (
        <button
          key={p}
          type="button"
          className={cur === p ? "on" : undefined}
          onClick={() => ctx.onField(cell.id, "placement", p)}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

export function CellEditor({ cell, ctx }: FieldProps) {
  const { t } = useTranslation();
  const f = useField(cell, ctx);
  const d = cell.data as Record<string, unknown>;

  if (cell.type === "latex") {
    return (
      <div className="w-editor">
        <div className="w-field">
          <label htmlFor={`wf-${cell.id}-source`}>{t("writer.field.latexSource")}</label>
          <LatexSourceField
            textareaProps={{ id: `wf-${cell.id}-source`, ...f.textProps("source") }}
            value={String(d.source ?? "")}
          />
        </div>
        <EditorFooter cell={cell} ctx={ctx} />
      </div>
    );
  }

  if (cell.type === "abstract-aa") {
    return (
      <div className="w-editor">
        {ABSTRACT_PARTS.map(({ dataKey, labelKey }) => (
          <div className="w-field" key={dataKey}>
            <label htmlFor={`wf-${cell.id}-${dataKey}`}>{t(labelKey)}</label>
            <textarea id={`wf-${cell.id}-${dataKey}`} className="w-serif" {...f.textProps(dataKey)} />
          </div>
        ))}
        <EditorFooter cell={cell} ctx={ctx} />
      </div>
    );
  }

  if (cell.type === "figure") {
    return (
      <div className="w-editor">
        <div className="w-field">
          <label htmlFor={`wf-${cell.id}-imageFile`}>{t("writer.field.image")}</label>
          <label className="w-drop-zone">
            {d.image ? (
              <img src={assetUrl(ctx.docId, String(d.image))} alt="" />
            ) : (
              t("writer.field.chooseImage")
            )}
            <input
              id={`wf-${cell.id}-imageFile`}
              className="w-file-input"
              type="file"
              accept="image/*"
              data-field="imageFile"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) ctx.onImageFile(cell.id, file);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <div className="w-form-grid">
          <div className="w-field">
            <span className="w-field-label">{t("writer.field.placement")}</span>
            <PlacementButtons cell={cell} ctx={ctx} />
          </div>
          <div className="w-field">
            <label htmlFor={`wf-${cell.id}-width`}>
              {t("writer.field.width")} · {String(d.width ?? 80)}%
            </label>
            <input
              id={`wf-${cell.id}-width`}
              type="range"
              min={35}
              max={100}
              value={(d.width as number) || 80}
              onChange={(e) => ctx.onField(cell.id, "width", Number(e.target.value))}
            />
          </div>
        </div>
        <div className="w-field">
          <label htmlFor={`wf-${cell.id}-caption`}>{t("writer.field.caption")}</label>
          <textarea id={`wf-${cell.id}-caption`} className="w-serif" {...f.textProps("caption")} />
        </div>
        <div className="w-field">
          <label htmlFor={`wf-${cell.id}-label`}>{t("writer.field.label")}</label>
          <input id={`wf-${cell.id}-label`} type="text" {...f.textProps("label")} />
        </div>
        <EditorFooter cell={cell} ctx={ctx} />
      </div>
    );
  }

  if (cell.type === "table") {
    return (
      <div className="w-editor">
        <div className="w-form-grid">
          <div className="w-field">
            <span className="w-field-label">{t("writer.field.placement")}</span>
            <PlacementButtons cell={cell} ctx={ctx} />
          </div>
          <div className="w-field">
            <label htmlFor={`wf-${cell.id}-width`}>
              {t("writer.field.width")} · {String(d.width ?? 92)}%
            </label>
            <input
              id={`wf-${cell.id}-width`}
              type="range"
              min={40}
              max={100}
              value={(d.width as number) || 92}
              onChange={(e) => ctx.onField(cell.id, "width", Number(e.target.value))}
            />
          </div>
        </div>
        <div className="w-field">
          <label htmlFor={`wf-${cell.id}-head`}>{t("writer.field.headerCsv")}</label>
          <textarea id={`wf-${cell.id}-head`} className="w-short" {...f.textProps("head")} />
        </div>
        <div className="w-field">
          <label htmlFor={`wf-${cell.id}-csv`}>{t("writer.field.dataCsv")}</label>
          <textarea id={`wf-${cell.id}-csv`} {...f.textProps("csv")} />
        </div>
        <div className="w-field">
          <label htmlFor={`wf-${cell.id}-caption`}>{t("writer.field.caption")}</label>
          <textarea id={`wf-${cell.id}-caption`} className="w-serif w-short" {...f.textProps("caption")} />
        </div>
        <div className="w-field">
          <label htmlFor={`wf-${cell.id}-label`}>{t("writer.field.label")}</label>
          <input id={`wf-${cell.id}-label`} type="text" {...f.textProps("label")} />
        </div>
        <EditorFooter cell={cell} ctx={ctx} />
      </div>
    );
  }

  if (cell.type === "code") {
    return (
      <div className="w-editor">
        <div className="w-form-grid">
          <div className="w-field">
            <label htmlFor={`wf-${cell.id}-language`}>{t("writer.field.language")}</label>
            <input id={`wf-${cell.id}-language`} type="text" {...f.textProps("language")} />
          </div>
          <div className="w-field">
            <label htmlFor={`wf-${cell.id}-label`}>{t("writer.field.label")}</label>
            <input id={`wf-${cell.id}-label`} type="text" {...f.textProps("label")} />
          </div>
        </div>
        <div className="w-field">
          <label htmlFor={`wf-${cell.id}-caption`}>{t("writer.field.caption")}</label>
          <input id={`wf-${cell.id}-caption`} type="text" {...f.textProps("caption")} />
        </div>
        <div className="w-field">
          <label htmlFor={`wf-${cell.id}-code`}>{t("writer.field.code")}</label>
          <textarea id={`wf-${cell.id}-code`} className="w-tall" {...f.textProps("code")} />
        </div>
        <label className="w-check">
          <input
            type="checkbox"
            checked={Boolean(d.lineNumbers)}
            onChange={(e) => ctx.onField(cell.id, "lineNumbers", e.target.checked)}
          />
          {t("writer.field.lineNumbers")}
        </label>
        <EditorFooter cell={cell} ctx={ctx} />
      </div>
    );
  }

  if (cell.type === "ack") {
    return (
      <div className="w-editor">
        <div className="w-field">
          <label htmlFor={`wf-${cell.id}-ackSource`}>{t("writer.field.ackSource")}</label>
          <textarea id={`wf-${cell.id}-ackSource`} className="w-serif" {...f.textProps("source")} />
        </div>
        <EditorFooter cell={cell} ctx={ctx} />
      </div>
    );
  }

  if (cell.type === "appendix") {
    return (
      <div className="w-editor">
        <div className="w-appendix-marker">{t("writer.field.appendixNote")}</div>
        <EditorFooter cell={cell} ctx={ctx} />
      </div>
    );
  }

  // recipient
  return (
    <div className="w-editor">
      <div className="w-field">
        <label htmlFor={`wf-${cell.id}-name`}>{t("writer.field.recipientName")}</label>
        <input id={`wf-${cell.id}-name`} type="text" {...f.textProps("name")} />
      </div>
      <div className="w-field">
        <label htmlFor={`wf-${cell.id}-organization`}>{t("writer.field.organization")}</label>
        <input id={`wf-${cell.id}-organization`} type="text" {...f.textProps("organization")} />
      </div>
      <div className="w-field">
        <label htmlFor={`wf-${cell.id}-address`}>{t("writer.field.address")}</label>
        <textarea id={`wf-${cell.id}-address`} {...f.textProps("address")} />
      </div>
      <EditorFooter cell={cell} ctx={ctx} />
    </div>
  );
}

// ------------------------------------------------------------- cell wrap ----

/** One cell in the paper flow: hover tools + unsupported banner + body. */
export function CellWrap({
  cell,
  cells,
  supported,
  ctx,
}: {
  cell: WriterCell;
  cells: WriterCell[];
  supported: boolean;
  ctx: CellCtx;
}) {
  const { t } = useTranslation();
  const editing = ctx.editingId === cell.id;
  const cls =
    "w-cell-wrap" +
    (ctx.activeId === cell.id ? " active" : "") +
    (editing ? " editing" : "");
  return (
    <section
      className={cls}
      id={`wcell-${cell.id}`}
      data-cell={cell.id}
      onMouseDown={(e) => {
        const el = e.target as HTMLElement;
        if (!el.closest("button,input,textarea,select,label")) ctx.onActivate(cell.id);
      }}
    >
      <div className="w-cell-tools">
        <button
          className="w-cell-type"
          title={t("writer.cell.typeMenu")}
          onClick={(e) => ctx.onOpenTypeMenu(cell.id, e)}
        >
          {t(TYPE_LABEL_KEY[cell.type])}
          <Icon name="chevron-down" cls="ico-sm" />
        </button>
        <div className="w-cell-right-tools">
          <button
            className="w-cell-tool"
            data-action="edit"
            title={t("writer.cell.edit")}
            onClick={() => ctx.onEdit(cell.id)}
          >
            <Icon name="pencil" cls="ico-sm" />
          </button>
          <button
            className="w-cell-tool"
            data-action="comment"
            title={t("writer.cell.comment")}
            onClick={() => ctx.onComment(cell.id)}
          >
            <Icon name="message-square" cls="ico-sm" />
          </button>
        </div>
      </div>
      {!supported && <div className="w-unsupported">{t("writer.cell.unsupported")}</div>}
      {editing ? <CellEditor cell={cell} ctx={ctx} /> : <CellRender cell={cell} cells={cells} ctx={ctx} />}
    </section>
  );
}
