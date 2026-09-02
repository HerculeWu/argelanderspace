import { Icon } from "../lib/icons";
import { dueState, fmtDate, type Task } from "./model";

// Bits shared by the list rows and the board cards (Stage 4): the due badge
// (今天 amber / 逾期 red / 其余 gray), the hover pin button, and the
// note/link flags.

export function DueBadge({ due, today }: { due: string; today: string }) {
  const st = dueState(due, today);
  const title = st === "overdue" ? "已逾期" : st === "today" ? "今天到期" : "截止";
  return (
    <span className={`plan-due${st === "overdue" ? " overdue" : st === "today" ? " today" : ""}`} title={title}>
      <Icon name="calendar" cls="ico-sm" />
      {fmtDate(due)}
    </span>
  );
}

/** Pin entry (list rows / board cards / drawer): visible on hover or when pinned. */
export function PinBtn({ focused, onToggle }: { focused: boolean; onToggle: () => void }) {
  return (
    <button
      className={`plan-pin${focused ? " on" : ""}`}
      title={focused ? "取消聚焦" : "聚焦（加入今日聚焦）"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon name="pin" cls="ico-sm" />
    </button>
  );
}

/** The trailing flags on a task row/card: note-has-content + link count. */
export function TaskFlags({ task }: { task: Task }) {
  return (
    <>
      {task.note && (
        <span className="plan-noteflag" title="有备注">
          <Icon name="sticky-note" cls="ico-sm" />
        </span>
      )}
      {task.links.length > 0 && (
        <span className="plan-linkn" title="关联文档">
          <Icon name="link" cls="ico-sm" />
          {task.links.length}
        </span>
      )}
    </>
  );
}
