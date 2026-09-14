import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import {
  dateOf,
  fmtDate,
  planProgress,
  timelineFrac,
  timelineScale,
  type Plan,
} from "./model";

// Timeline mode (Stage 4, READ-ONLY): one bar per plan spanning
// created_at → due, filled by done/total, red when overdue with open tasks.
// Tasks with a due show as diamond milestones on their plan's bar (hover =
// title, click opens the task drawer — the current due only). The scale
// adapts (< 6 weeks → week ticks, else month ticks) with a today line.

export function TimelineMode({
  plans,
  today,
  onOpenTask,
  onSelectPlan,
}: {
  plans: Plan[];
  today: string;
  onOpenTask: (taskId: string) => void;
  onSelectPlan: (planId: string) => void;
}) {
  const { t } = useTranslation();
  const scale = timelineScale(plans, today);
  if (!scale) {
    return <div className="plan-sv-empty">{t("plan.timeline.empty")}</div>;
  }
  const todayPct = timelineFrac(today, scale) * 100;
  return (
    <div className="plan-special view-in">
      <div className="plan-sv-head">
        <div className="plan-sv-title">
          <span className="plan-sv-ic">
            <Icon name="gantt-chart" cls="ico-lg" />
          </span>
          {t("plan.timeline.title")}
        </div>
        <div className="plan-sv-sub">
          {t("plan.timeline.sub", {
            scale: scale.weekly ? t("plan.timeline.scaleWeekly") : t("plan.timeline.scaleMonthly"),
          })}
        </div>
      </div>
      <div className="plan-sv-scroll">
        <div className="plan-tl-mode">
          <div className="plan-tl-head">
            <div className="plan-tl-head-spacer" />
            <div className="plan-tl-axis">
              {scale.ticks.map((t) => (
                <span
                  key={t.at}
                  className="plan-tl-tick"
                  style={{ left: `${timelineFrac(t.at, scale) * 100}%` }}
                >
                  {t.label}
                </span>
              ))}
            </div>
          </div>
          {plans.map((p) => {
            const start = dateOf(p.created_at);
            const l = timelineFrac(start, scale) * 100;
            const w = Math.max(0.8, (timelineFrac(p.due, scale) - timelineFrac(start, scale)) * 100);
            const prog = planProgress(p);
            const overdue = p.due < today && p.tasks.some((t) => t.status !== "done");
            return (
              <div key={p.id} className="plan-tl-row">
                <button className="plan-tl-label" title={t("plan.timeline.openPlan")} onClick={() => onSelectPlan(p.id)}>
                  <Icon name={p.icon} cls="ico-sm" />
                  <span>{p.name}</span>
                </button>
                <div className="plan-tl-track">
                  <div
                    className={`plan-tl-bar${overdue ? " overdue" : ""}`}
                    style={{ left: `${l}%`, width: `${w}%` }}
                  >
                    <div className="plan-tl-bar-fill" style={{ width: `${prog}%` }} />
                    <span className="plan-tl-bar-label">
                      {prog}% · {fmtDate(p.due)}
                    </span>
                  </div>
                  {p.tasks
                    .filter((t) => t.due)
                    .map((t) => (
                      <button
                        key={t.id}
                        className={`plan-tl-ms plan-s-${t.status}`}
                        style={{ left: `${timelineFrac(t.due as string, scale) * 100}%` }}
                        title={`${t.title} · ${fmtDate(t.due as string)}`}
                        onClick={() => onOpenTask(t.id)}
                      />
                    ))}
                </div>
              </div>
            );
          })}
          <div className="plan-tl-overlay">
            {scale.ticks.map((t) => (
              <span
                key={t.at}
                className="plan-tl-grid"
                style={{ left: `${timelineFrac(t.at, scale) * 100}%` }}
              />
            ))}
            <span className="plan-tl-today" style={{ left: `${todayPct}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
