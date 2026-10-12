/**
 * The role choice that follows a drag on the canvas (ticket 05, approved prototype variant C): a small popover at the
 * drop point asking which Toulmin element the source's Claim plays in the target. A role the pair already has is disabled.
 * Not modal (the canvas stays visible); Esc and an outside press close it, the first free role takes the focus. Esc is
 * taken in the capture phase and consumed: it closes this popover only, never also the panel behind it. Closing by Esc or
 * the Cancel button (or choosing) asks for the focus to go back to the canvas node the drag started from.
 */
import type { ArgumentEdgeRole } from "@argelanderspace/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ActionButton } from "../ui";
import { ARGUMENT_ROLES } from "./canvasModel";

const WIDTH = 264;
const HEIGHT = 190;

export function RoleChooser({
  from,
  to,
  at,
  taken,
  roleName,
  onChoose,
  onCancel,
}: {
  from: string;
  to: string;
  at: { x: number; y: number };
  taken: ReadonlySet<ArgumentEdgeRole>;
  roleName: (role: ArgumentEdgeRole) => string;
  onChoose: (role: ArgumentEdgeRole) => void;
  /** `restoreFocus`: closed from the keyboard or its own buttons, so the focus returns to the source node (an outside press keeps it where the person clicked). */
  onCancel: (opts: { restoreFocus: boolean }) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useLayoutEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('button:not([disabled])[data-ui="choose-argument-role"]');
    (first ?? ref.current)?.focus();
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelRef.current({ restoreFocus: true });
      }
    };
    const press = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) cancelRef.current({ restoreFocus: false });
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", press, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", press, true);
    };
  }, []);
  const left = Math.max(8, Math.min(at.x, window.innerWidth - WIDTH - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - HEIGHT - 8));
  return (
    <div ref={ref} tabIndex={-1} className="ag-chooser" data-ui="argument-role-chooser" role="dialog" aria-label={t("argument.edit.roleChooser", { a: from, b: to })} style={{ left, top }}>
      <p>{t("argument.edit.roleChooser", { a: from, b: to })}</p>
      <div className="ag-chooser-roles">
        {ARGUMENT_ROLES.map((r) => (
          <ActionButton
            key={r}
            unstyled
            mode="text"
            className={`ag-role-chip big role-${r}`}
            data-ui="choose-argument-role"
            data-ui-key={r}
            label={roleName(r)}
            tooltip={taken.has(r) ? t("argument.edit.roleExists") : undefined}
            disabled={taken.has(r)}
            onClick={() => onChoose(r)}
          >
            {roleName(r)}
          </ActionButton>
        ))}
      </div>
      <ActionButton mode="text" className="ag-chooser-cancel" label={t("argument.edit.cancel")} data-ui="cancel-argument-role" onClick={() => onCancel({ restoreFocus: true })}>
        {t("argument.edit.cancel")}
      </ActionButton>
    </div>
  );
}
