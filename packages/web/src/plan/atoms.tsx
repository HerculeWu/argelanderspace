import { useTranslation } from "react-i18next";
import { ActionButton } from "../ui";
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
  const { t } = useTranslation();
  const label = onCycle ? t(`plan.statusCycle.${status}`) : statusLabel(status);
  return (
    <ActionButton
      unstyled
      mode="icon"
      iconName={STATUS_ICON[status]}
      label={label}
      tooltip={label}
      className={`plan-st-btn plan-s-${status}`}
      disabled={!onCycle}
      data-ui="cycle-task-status"
      onClick={(e) => {
        e.stopPropagation();
        onCycle?.();
      }}
    />
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
        <ActionButton
          key={s}
          unstyled
          mode="icon"
          iconName={STATUS_ICON[s]}
          label={statusLabel(s)}
          tooltip={statusLabel(s)}
          className={`plan-drawer-st plan-s-${s}${status === s ? " on" : ""}`}
          data-ui="set-task-status"
          data-ui-key={s}
          aria-pressed={status === s}
          onClick={() => onSet(s)}
        />
      ))}
    </div>
  );
}
