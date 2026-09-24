import { Icon } from "../lib/icons";
import { STATUS_ICON, statusLabel, type TaskStatus } from "./model";

// Small shared atoms of the plan page (Stage 4): the status dot/button,
// progress ring, and the drawer's four-status pick row.

export function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`plan-dot plan-s-${status}`} />;
}

export function ProgressRing({
  value,
  size = 30,
  stroke = 3,
}: {
  value: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - value / 100);
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)", flex: "none" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={off}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset .5s cubic-bezier(.4,0,.2,1)" }}
      />
    </svg>
  );
}

/** The single-click status cycler on task rows/cards. */
export function StatusBtn({ status, onCycle }: { status: TaskStatus; onCycle?: () => void }) {
  return (
    <button
      className={`plan-st-btn plan-s-${status}`} data-ui="cycle-task-status"
      onClick={(e) => {
        e.stopPropagation();
        onCycle?.();
      }}
      title={statusLabel(status)}
    >
      <Icon name={STATUS_ICON[status]} cls="ico-sm" />
    </button>
  );
}

/** The drawer's four-state direct-pick row. */
export function DrawerStatusRow({
  status,
  onSet,
}: {
  status: TaskStatus;
  onSet: (s: TaskStatus) => void;
}) {
  const order: TaskStatus[] = ["todo", "doing", "blocked", "done"];
  return (
    <div className="plan-drawer-status-row">
      {order.map((s) => (
        <button
          key={s}
          className={`plan-drawer-st plan-s-${s}${status === s ? " on" : ""}`} data-ui="set-task-status" data-ui-key={s}
          onClick={() => onSet(s)}
        >
          <Icon name={STATUS_ICON[s]} cls="ico-sm" />
          {statusLabel(s)}
        </button>
      ))}
    </div>
  );
}
