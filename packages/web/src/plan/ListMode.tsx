import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { StatusBtn, StatusDot } from "./atoms";
import type { Plan, Task, TaskStatus } from "./model";
import { DueBadge, PinBtn, TaskFlags } from "./taskBits";

// List mode (Stage 4): tasks grouped by status (doing/todo/blocked/done),
// the done group collapsed by default, empty groups not rendered. Reordering
// works WITHIN a group only — cross-group hovers must find NO drop target at
// all (the design: cross-group status changes go through the status
// button/drawer, the single semantic entry). Tasks are created only via the
// new-task modal (Stage-4 smoke ruling).

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
 * blocked the write (the "cross-group drag met no resistance" smoke report).
 */
const sameGroupCollision: CollisionDetection = (args) => {
  const containerId = (args.active.data.current as SortableData | undefined)?.sortable?.containerId;
  const own = args.droppableContainers.filter(
    (c) => (c.data.current as SortableData | undefined)?.sortable?.containerId === containerId
  );
  return closestCenter({ ...args, droppableContainers: own });
};

/** Drop point = pointer position at activation + the drag delta (null when
 *  the event carries no pointer info — the hit-test is then skipped). Works
 *  for both DragMoveEvent and DragEndEvent (same pointer fields). */
function dropPoint(e: {
  activatorEvent: Event;
  delta: { x: number; y: number };
}): { x: number; y: number } | null {
  const ev = e.activatorEvent as Partial<PointerEvent> | undefined;
  if (typeof ev?.clientX !== "number" || typeof ev?.clientY !== "number") return null;
  const delta = e.delta ?? { x: 0, y: 0 };
  return { x: ev.clientX + delta.x, y: ev.clientY + delta.y };
}

const GROUPS = [
  { key: "doing", labelKey: "plan.status.doing" },
  { key: "todo", labelKey: "plan.status.todo" },
  { key: "blocked", labelKey: "plan.status.blocked" },
  { key: "done", labelKey: "plan.status.doneGroup" },
] as const;

export function ListMode({ plan, today, cb }: { plan: Plan; today: string; cb: ListCallbacks }) {
  const { t } = useTranslation();
  const [doneOpen, setDoneOpen] = useState(false);
  const [dragStatus, setDragStatus] = useState<TaskStatus | null>(null);
  const [noDrop, setNoDrop] = useState(false);
  const [nudge, setNudge] = useState(false);
  const nudgeTimer = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => () => window.clearTimeout(nudgeTimer.current), []);

  // Rejection must be PERCEPTIBLE (smoke rounds 2-3: a silent snap-back reads
  // as "drag not rejected", and a no-drop cursor painted on the target group
  // is invisible under the dragged row): foreign groups dim, the DRAGGED ROW
  // wears no-drop whenever the pointer leaves its own group, and a rejected
  // drop flashes a hint naming the real path for cross-group moves.
  const flashNudge = () => {
    setNudge(true);
    window.clearTimeout(nudgeTimer.current);
    nudgeTimer.current = window.setTimeout(() => setNudge(false), 2500);
  };

  /** Is the point inside the status group's element? null = can't tell. */
  const inOwnGroup = (status: TaskStatus, point: { x: number; y: number } | null): boolean | null => {
    const groupEl = listRef.current?.querySelector(`[data-group="${status}"]`);
    if (!point || !groupEl) return null;
    const r = groupEl.getBoundingClientRect();
    return point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
  };

  const onDragStart = (e: DragStartEvent) => {
    const status = e.active.data.current?.status as TaskStatus | undefined;
    setDragStatus(status ?? null);
  };

  const onDragMove = (e: DragMoveEvent) => {
    const status = e.active.data.current?.status as TaskStatus | undefined;
    if (!status) return;
    const inside = inOwnGroup(status, dropPoint(e));
    if (inside !== null) setNoDrop((prev) => (prev === !inside ? prev : !inside));
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragStatus(null);
    setNoDrop(false);
    const status = e.active.data.current?.status as TaskStatus | undefined;
    if (!status) return;
    // The drop must land inside the ACTIVE row's own group; released anywhere
    // else → snap back + nudge, no mutation (cross-group status changes go
    // through the status button/drawer).
    if (inOwnGroup(status, dropPoint(e)) === false) {
      flashNudge();
      return;
    }
    const over = e.over;
    if (!over) return;
    const overStatus = over.data.current?.status as TaskStatus | undefined;
    if (overStatus !== status) return; // no cross-group drops
    cb.onReorder(plan.id, status, String(e.active.id), String(over.id));
  };

  if (plan.tasks.length === 0) {
    return (
      <div className="plan-list-empty">{t("plan.list.empty")}</div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sameGroupCollision}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDragStatus(null);
        setNoDrop(false);
      }}
    >
      <div className={`plan-list-mode${noDrop ? " plan-nodrop-active" : ""}`} data-ui="plan-task-list" ref={listRef}>
        {GROUPS.map((g) => {
          const items = plan.tasks.filter((t) => t.status === g.key);
          if (items.length === 0) return null;
          const isDone = g.key === "done";
          return (
            <div
              key={g.key}
              className={`plan-list-group${dragStatus !== null && g.key !== dragStatus ? " plan-no-target" : ""}`} data-ui="task-status-group" data-ui-key={g.key}
              data-group={g.key}
            >
              <div className="plan-list-group-head">
                {isDone ? (
                  <button className="plan-list-fold" data-ui="toggle-completed-tasks" onClick={() => setDoneOpen((o) => !o)}>
                    <Icon name={doneOpen ? "chevron-down" : "chevron-right"} cls="ico-sm" />
                  </button>
                ) : (
                  <StatusDot status={g.key} />
                )}
                <span>{t(g.labelKey)}</span>
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
        {nudge && (
          <div className="plan-notice plan-reject-nudge view-in">{t("plan.list.crossGroupNudge")}</div>
        )}
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
      className={`plan-task-row${task.status === "done" ? " is-done" : ""}${isDragging ? " dragging" : ""}`} data-ui="task-item" data-ui-key={task.id}
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
