import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";
import { dueState, fmtDate, type Task } from "./model";

// Bits shared by the list rows and the board cards (Stage 4): the due badge
// (due-today amber / overdue red / otherwise gray), the hover pin button, and
// the note/link flags.

export function DueBadge({ due, today }: { due: string; today: string }) {
  const { t } = useTranslation();
  const st = dueState(due, today);
  const title =
    st === "overdue"
      ? t("plan.focus.groups.overdue")
      : st === "today"
        ? t("plan.focus.groups.today")
        : t("plan.bits.due");
  return (
    <span className={`plan-due${st === "overdue" ? " overdue" : st === "today" ? " today" : ""}`} title={title}>
      <Icon name="calendar" cls="ico-sm" />
      {fmtDate(due)}
    </span>
  );
}

/** Pin entry (list rows / board cards / drawer): visible on hover or when pinned. */
export function PinBtn({ focused, onToggle }: { focused: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <ActionButton
      unstyled
      mode="icon"
      iconName="pin"
      label={focused ? t("plan.bits.unpin") : t("plan.bits.pin")}
      tooltip={focused ? t("plan.bits.unpin") : t("plan.bits.pin")}
      className={`plan-pin${focused ? " on" : ""}`}
      data-ui="toggle-task-focus"
      aria-pressed={focused}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    />
  );
}

/** The trailing flags on a task row/card: note-has-content + link count. */
export function TaskFlags({ task }: { task: Task }) {
  const { t } = useTranslation();
  return (
    <>
      {task.note && (
        <span className="plan-noteflag" title={t("plan.bits.hasNote")}>
          <Icon name="sticky-note" cls="ico-sm" />
        </span>
      )}
      {task.links.length > 0 && (
        <span className="plan-linkn" title={t("plan.drawer.links")}>
          <Icon name="link" cls="ico-sm" />
          {task.links.length}
        </span>
      )}
    </>
  );
}
