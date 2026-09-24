import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { StatusBtn } from "./atoms";
import { focusGroups, statusLabel, type Plan } from "./model";
import { DueBadge } from "./taskBits";

// Today's focus (Stage 4): a derived view with no extra storage — pinned
// (not done) → overdue → due today → due tomorrow; empty groups are not
// rendered, and the all-empty case shows guidance. Cards open the task drawer.

export function FocusView({
  plans,
  today,
  onOpenTask,
}: {
  plans: Plan[];
  today: string;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const groups = focusGroups(plans, today);
  const total = groups.reduce((a, g) => a + g.items.length, 0);
  return (
    <div className="plan-special view-in" data-ui="today-focus">
      <div className="plan-sv-head">
        <div className="plan-sv-title">
          <span className="plan-sv-ic">
            <Icon name="calendar-days" cls="ico-lg" />
          </span>
          {t("plan.focus.title")}
        </div>
        <div className="plan-sv-sub">{t("plan.focus.sub", { count: total })}</div>
      </div>
      <div className="plan-sv-scroll">
        {groups.length === 0 ? (
          <div className="plan-sv-empty">
            {t("plan.focus.empty")}
          </div>
        ) : (
          <div className="plan-focus-wrap">
            {groups.map((g) => (
              <div key={g.key} className="plan-focus-group" data-ui="focus-group" data-ui-key={g.key}>
                <div className="plan-focus-when">
                  <span className="plan-focus-when-dot" />
                  {g.label}
                </div>
                <div className="plan-focus-list">
                  {g.items.map(({ task, plan }) => (
                    <div key={task.id} className="plan-focus-card" data-ui="focus-task" data-ui-key={task.id} onClick={() => onOpenTask(task.id)}>
                      <StatusBtn status={task.status} />
                      <div className="plan-focus-card-body">
                        <div className="plan-focus-card-title">{task.title}</div>
                        <div className="plan-focus-card-meta">
                          <span className="tag">{plan.name}</span>
                          <span className={`plan-s-${task.status}`}>{statusLabel(task.status)}</span>
                          {task.due && <DueBadge due={task.due} today={today} />}
                        </div>
                      </div>
                      <Icon name="arrow-right" cls="ico-sm" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
