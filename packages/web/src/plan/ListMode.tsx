import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { StatusBtn, StatusDot } from "./atoms";
import type { Plan, Task, TaskStatus } from "./model";
import { DueBadge, PinBtn, TaskFlags } from "./taskBits";

// List mode (Stage 4): tasks grouped by status (进行中/待办/受阻/已完成),
// the done group collapsed by default, empty groups not rendered. Reordering
// works WITHIN a group only — cross-group hovers must find NO drop target at
// all (the design: 跨组改状态走状态按钮/抽屉, the single semantic entry).
// Tasks are created only via the 新建任务 modal (Stage-4 smoke ruling).

interface ListCallbacks {
  onCycle: (planId: string, taskId: string) => void;
  onOpen: (taskId: string) => void;
  onTogglePin: (planId: string, taskId: string) => void;
  onReorder: (planId: string, status: TaskStatus, activeId: string, overId: string) => void;
}

interface SortableData {
  sortable?: { containerId?: string };
  status?: TaskStatus;
}

/**
 * Only the dragged row's OWN group is a valid drop target: collision
 * candidates are filtered to the active row's sortable container, so
 * hovering another group opens no gap and dropping there resolves `over`
 * null (snap-back) — with dnd-kit's multi-container default the other group
 * would part its rows and LOOK accepted even though the mutation guard
 * blocked the write (the "跨组拖拽没有阻碍" smoke report).
 */
const sameGroupCollision: CollisionDetection = (args) => {
  const containerId = (args.active.data.current as SortableData | undefined)?.sortable?.containerId;
  const own = args.droppableContainers.filter(
    (c) => (c.data.current as SortableData | undefined)?.sortable?.containerId === containerId
  );
  return closestCenter({ ...args, droppableContainers: own });
};

/** Drop point = pointer position at activation + the drag delta (null when
 *  the event carries no pointer info — the hit-test is then skipped). */
function dropPoint(e: DragEndEvent): { x: number; y: number } | null {
  const ev = e.activatorEvent as Partial<PointerEvent> | undefined;
  if (typeof ev?.clientX !== "number" || typeof ev?.clientY !== "number") return null;
  const delta = e.delta ?? { x: 0, y: 0 };
  return { x: ev.clientX + delta.x, y: ev.clientY + delta.y };
}

const GROUPS: { key: TaskStatus; label: string }[] = [
  { key: "doing", label: "进行中" },
  { key: "todo", label: "待办" },
  { key: "blocked", label: "受阻" },
  { key: "done", label: "已完成" },
];

export function ListMode({ plan, today, cb }: { plan: Plan; today: string; cb: ListCallbacks }) {
  const [doneOpen, setDoneOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const over = e.over;
    if (!over) return;
    const status = e.active.data.current?.status as TaskStatus | undefined;
    const overStatus = over.data.current?.status as TaskStatus | undefined;
    if (!status || overStatus !== status) return; // 跨组拖拽不做
    // …and the pointer must have landed inside the ACTIVE row's own group:
    // released anywhere else → snap back, no mutation (回弹).
    const point = dropPoint(e);
    const groupEl = listRef.current?.querySelector(`[data-group="${status}"]`);
    if (point && groupEl) {
      const r = groupEl.getBoundingClientRect();
      if (point.x < r.left || point.x > r.right || point.y < r.top || point.y > r.bottom) return;
    }
    cb.onReorder(plan.id, status, String(e.active.id), String(over.id));
  };

  if (plan.tasks.length === 0) {
    return (
      <div className="plan-list-empty">暂无任务 — 点击右上角「新建任务」创建第一项。</div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={sameGroupCollision} onDragEnd={onDragEnd}>
      <div className="plan-list-mode" ref={listRef}>
        {GROUPS.map((g) => {
          const items = plan.tasks.filter((t) => t.status === g.key);
          if (items.length === 0) return null;
          const isDone = g.key === "done";
          return (
            <div key={g.key} className="plan-list-group" data-group={g.key}>
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
