/**
 * Writer cell editing and layout. Body content comes from the shared IR
 * projection; the source editor is CodeMirror. No local LaTeX renderer.
 */

import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import type { CellPlacement, CellType, WriterCell, WriterNumberingResponse } from "@argelanderspace/contracts";
import { LatexSourceField, type WriterTextTarget } from "./latexSource";
import { WriterCellPreview } from "./preview";
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
  onCaret: (cellId: string, field: string, el: WriterTextTarget) => void;
  onImageFile: (cellId: string, file: File) => void;
  numbering?: WriterNumberingResponse | null;
  onJump?: (cellId: string) => void;
  onCite?: () => void;
}

// ---------------------------------------------------------------- render ----

export function CellRender({ cell, cells, ctx }: { cell: WriterCell; cells: WriterCell[]; ctx: CellCtx }) {
  const d = cell.data;
  const style: React.CSSProperties | undefined = cell.type === "figure" || cell.type === "table"
    ? { width: `${d.width}%`, marginLeft: d.placement === "left" ? 0 : "auto", marginRight: d.placement === "right" ? 0 : "auto" }
    : undefined;
  return <div style={style}><WriterCellPreview cell={cell} cells={cells} docId={ctx.docId} numbering={ctx.numbering} onJump={ctx.onJump} onCite={ctx.onCite} /></div>;
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
            id={`wf-${cell.id}-source`}
            label={t("writer.field.latexSource")}
            value={String(d.source ?? "")}
            onChange={(value) => ctx.onField(cell.id, "source", value)}
            onCaret={(target) => ctx.onCaret(cell.id, "source", target)}
            onCommit={() => ctx.onCommit(cell.id)}
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
