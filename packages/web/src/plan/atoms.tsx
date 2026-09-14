import { useEffect } from "react";
import { Icon } from "../lib/icons";
import { STATUS_ICON, statusLabel, type TaskStatus } from "./model";

// Small shared atoms of the plan page (Stage 4): the status dot/button, the
// progress ring, the modal shell, and the drawer's four-status pick row.

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
      className={`plan-st-btn plan-s-${status}`}
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
          className={`plan-drawer-st plan-s-${s}${status === s ? " on" : ""}`}
          onClick={() => onSet(s)}
        >
          <Icon name={STATUS_ICON[s]} cls="ico-sm" />
          {statusLabel(s)}
        </button>
      ))}
    </div>
  );
}

/** Generic modal shell (overlay click + Escape close). */
export function Modal({
  title,
  sub,
  onClose,
  children,
  footer,
  width = 440,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="plan-modal-overlay" onClick={onClose}>
      <div className="plan-modal" style={{ width }} onClick={(e) => e.stopPropagation()}>
        <div className="plan-modal-head">
          <div className="plan-modal-titles">
            <div className="plan-modal-title">{title}</div>
            {sub && <div className="plan-modal-sub">{sub}</div>}
          </div>
          <button className="btn icon ghost" onClick={onClose}>
            <Icon name="x" cls="ico-sm" />
          </button>
        </div>
        <div className="plan-modal-body">{children}</div>
        {footer && <div className="plan-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
