/**
 * "Pick another argument" row for both directions of a link (ticket 05, approved prototype variant C). By default it lists
 * only the arguments one layer away (one below for something this argument rests on, one above for something that uses it)
 * so the list stays short in a large graph; "Show all arguments" lifts the filter and puts the near group first. When the
 * near group is empty it shows all by itself. Arguments that already have the role (or, for "used by", the chosen role) are
 * the caller's to leave out.
 */
import type { Argument, ArgumentEdgeRole } from "@argelanderspace/contracts";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionButton } from "../ui";
import { ARGUMENT_ROLES } from "./canvasModel";

export function ArgumentPicker({
  near,
  all,
  nearLabel,
  countLabel,
  withRole,
  roleName,
  disabledFor,
  busy,
  onPick,
  uiKey,
}: {
  /** The arguments one layer away in this direction (a subset of `all`). */
  near: Argument[];
  all: Argument[];
  nearLabel: string;
  /** How many near arguments there are, in this direction's words ("one layer below" / "one layer above"). */
  countLabel: (n: number) => string;
  /** "Used by": also choose which role this argument plays in the target. */
  withRole?: boolean;
  roleName: (role: ArgumentEdgeRole) => string;
  /** With a role: whether the pair already has this role (that role is not offered for it). */
  disabledFor?: (id: string, role: ArgumentEdgeRole) => boolean;
  busy?: boolean;
  onPick: (id: string, role: ArgumentEdgeRole) => void;
  uiKey: string;
}) {
  const { t } = useTranslation();
  const [id, setId] = useState("");
  const [role, setRole] = useState<ArgumentEdgeRole>("grounds");
  const [wide, setWide] = useState(false);
  const scopeId = useId();
  const showAll = wide || near.length === 0;
  const rest = all.filter((a) => !near.includes(a));
  const opt = (a: Argument) => (
    <option key={a.id} value={a.id}>
      {a.title || "—"}
    </option>
  );
  const taken = id !== "" && withRole && disabledFor?.(id, role);
  return (
    <div className="ag-picker-wrap" data-ui="argument-picker" data-ui-key={uiKey} data-scope={showAll ? "all" : "near"}>
      <div className="ag-picker">
        <select className="ag-input" data-ui="argument-picker-select" value={id} aria-label={t("argument.edit.pickArg")} onChange={(e) => setId(e.target.value)}>
          <option value="">{t("argument.edit.pickArg")}</option>
          {showAll ? (
            <>
              {near.length > 0 && <optgroup label={nearLabel}>{near.map(opt)}</optgroup>}
              {rest.length > 0 && <optgroup label={t("argument.edit.pickOther")}>{rest.map(opt)}</optgroup>}
            </>
          ) : (
            near.map(opt)
          )}
        </select>
        {withRole && (
          <select className="ag-input narrow" data-ui="argument-picker-role" value={role} aria-label={t("argument.edit.pickRole")} onChange={(e) => setRole(e.target.value as ArgumentEdgeRole)}>
            {ARGUMENT_ROLES.map((r) => (
              <option key={r} value={r} disabled={!!id && !!disabledFor?.(id, r)}>
                {roleName(r)}
              </option>
            ))}
          </select>
        )}
        <ActionButton
          mode="text"
          label={t("argument.edit.add")}
          data-ui="add-picked-argument"
          disabled={!id || !!taken || all.length === 0}
          busy={busy}
          onClick={() => {
            onPick(id, role);
            setId("");
          }}
        >
          {t("argument.edit.add")}
        </ActionButton>
      </div>
      <label className="ag-check ag-picker-scope" htmlFor={scopeId}>
        <input
          id={scopeId}
          type="checkbox"
          data-ui="argument-picker-show-all"
          checked={showAll}
          disabled={near.length === 0}
          onChange={(e) => {
            setWide(e.target.checked);
            setId("");
          }}
        />
        {t("argument.edit.pickAll")}
        <span className="ag-hint">{showAll ? "" : ` · ${countLabel(near.length)}`}</span>
      </label>
    </div>
  );
}
