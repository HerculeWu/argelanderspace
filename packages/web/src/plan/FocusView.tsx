import { Icon } from "../lib/icons";
import { StatusBtn } from "./atoms";
import { focusGroups, STATUS_LABEL, type Plan } from "./model";
import { DueBadge } from "./taskBits";

// 今日聚焦 (Stage 4): a derived view with no extra storage — 已聚焦 (pinned,
// not done) → 已逾期 → 今天到期 → 明天到期; empty groups are not rendered,
// and the all-empty case shows guidance. Cards open the task drawer.

export function FocusView({
  plans,
  today,
  onOpenTask,
}: {
  plans: Plan[];
  today: string;
  onOpenTask: (taskId: string) => void;
}) {
  const groups = focusGroups(plans, today);
  const total = groups.reduce((a, g) => a + g.items.length, 0);
  return (
    <div className="plan-special view-in">
      <div className="plan-sv-head">
        <div className="plan-sv-title">
          <span className="plan-sv-ic">
            <Icon name="calendar-days" cls="ico-lg" />
          </span>
          今日聚焦
        </div>
        <div className="plan-sv-sub">按时间排布的下一步行动 · 共 {total} 项</div>
      </div>
      <div className="plan-sv-scroll">
        {groups.length === 0 ? (
          <div className="plan-sv-empty">
            今天没有需要聚焦的任务 — 在任务行上 pin 关注项，或为任务设置今天/明天的截止日期。
          </div>
        ) : (
          <div className="plan-focus-wrap">
            {groups.map((g) => (
              <div key={g.key} className="plan-focus-group">
                <div className="plan-focus-when">
                  <span className="plan-focus-when-dot" />
                  {g.label}
                </div>
                <div className="plan-focus-list">
                  {g.items.map(({ task, plan }) => (
                    <div key={task.id} className="plan-focus-card" onClick={() => onOpenTask(task.id)}>
                      <StatusBtn status={task.status} />
                      <div className="plan-focus-card-body">
                        <div className="plan-focus-card-title">{task.title}</div>
                        <div className="plan-focus-card-meta">
                          <span className="tag">{plan.name}</span>
                          <span className={`plan-s-${task.status}`}>{STATUS_LABEL[task.status]}</span>
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
