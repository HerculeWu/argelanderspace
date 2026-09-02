import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import { Icon } from "../lib/icons";
import { StatusBtn, StatusDot } from "./atoms";
import type { Plan, Task, TaskStatus } from "./model";
import { DueBadge, PinBtn, QuickAdd, TaskFlags } from "./taskBits";

// List mode (Stage 4): tasks grouped by status (进行中/待办/受阻/已完成),
// the done group collapsed by default, empty groups not rendered. Reordering
// works WITHIN a group only (cross-group = the status button, the design's
// single semantic entry); each group bottom carries an inline quick-add.

interface ListCallbacks {
  onCycle: (planId: string, taskId: string) => void;
  onOpen: (taskId: string) => void;
  onTogglePin: (planId: string, taskId: string) => void;
  onQuickAdd: (planId: string, title: string, status: TaskStatus) => void;
  onReorder: (planId: string, status: TaskStatus, activeId: string, overId: string) => void;
}

const GROUPS: { key: TaskStatus; label: string }[] = [
  { key: "doing", label: "进行中" },
  { key: "todo", label: "待办" },
  { key: "blocked", label: "受阻" },
  { key: "done", label: "已完成" },
];

export function ListMode({ plan, today, cb }: { plan: Plan; today: string; cb: ListCallbacks }) {
  const [doneOpen, setDoneOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const over = e.over;
    if (!over) return;
    const status = e.active.data.current?.status as TaskStatus | undefined;
    const overStatus = over.data.current?.status as TaskStatus | undefined;
    if (!status || overStatus !== status) return; // 跨组拖拽不做
    cb.onReorder(plan.id, status, String(e.active.id), String(over.id));
  };

  if (plan.tasks.length === 0) {
    return (
      <div className="plan-list-empty">
        暂无任务 — 点击右上角「新建任务」创建第一项，或在看板列底快速添加。
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="plan-list-mode">
        {GROUPS.map((g) => {
          const items = plan.tasks.filter((t) => t.status === g.key);
          if (items.length === 0) return null;
          const isDone = g.key === "done";
          return (
            <div key={g.key} className="plan-list-group">
              <div className="plan-list-group-head">
                {isDone ? (
                  <button className="plan-list-fold" onClick={() => setDoneOpen((o) => !o)}>
                    <Icon name={doneOpen ? "chevron-down" : "chevron-right"} cls="ico-sm" />
                  </button>
                ) : (
                  <StatusDot status={g.key} />
                )}
                <span>{g.label}</span>
                <span className="plan-list-group-n mono">{items.length}</span>
              </div>
              {(!isDone || doneOpen) && (
                <SortableContext items={items.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                  {items.map((t) => (
                    <SortableRow key={t.id} task={t} planId={plan.id} today={today} cb={cb} />
                  ))}
                </SortableContext>
              )}
              {!isDone && <QuickAdd status={g.key} onAdd={(title, st) => cb.onQuickAdd(plan.id, title, st)} />}
            </div>
          );
        })}
      </div>
    </DndContext>
  );
}

function SortableRow({
  task,
  planId,
  today,
  cb,
}: {
  task: Task;
  planId: string;
  today: string;
  cb: ListCallbacks;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { status: task.status },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`plan-task-row${task.status === "done" ? " is-done" : ""}${isDragging ? " dragging" : ""}`}
      onClick={() => cb.onOpen(task.id)}
      {...attributes}
      {...listeners}
    >
      <StatusBtn status={task.status} onCycle={() => cb.onCycle(planId, task.id)} />
      <div className="plan-task-main">
        <div className="plan-task-title">{task.title}</div>
      </div>
      {task.due && <DueBadge due={task.due} today={today} />}
      <TaskFlags task={task} />
      <PinBtn focused={task.focused} onToggle={() => cb.onTogglePin(planId, task.id)} />
    </div>
  );
}
