import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import { StatusBtn, StatusDot } from "./atoms";
import type { Plan, Task, TaskStatus } from "./model";
import { DueBadge, PinBtn, TaskFlags } from "./taskBits";

// Board mode (Stage 4): four status columns, always rendered. A drag is the
// one gesture for cross-column status change + position inside the column
// (dropping on a card takes its place, dropping on the column body appends
// after its last card). Tasks never move across plans; they are created only
// via the new-task modal (Stage-4 smoke ruling).

interface BoardCallbacks {
  onCycle: (planId: string, taskId: string) => void;
  onOpen: (taskId: string) => void;
  onTogglePin: (planId: string, taskId: string) => void;
  onMove: (planId: string, activeId: string, status: TaskStatus, overId: string | null) => void;
}

const COLS = [
  { key: "todo", labelKey: "plan.status.todo" },
  { key: "doing", labelKey: "plan.status.doing" },
  { key: "blocked", labelKey: "plan.status.blocked" },
  { key: "done", labelKey: "plan.status.doneGroup" },
] as const;

export function BoardMode({ plan, today, cb }: { plan: Plan; today: string; cb: BoardCallbacks }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const over = e.over;
    if (!over) return;
    const activeId = String(e.active.id);
    const data = over.data.current as { status?: TaskStatus; col?: TaskStatus } | undefined;
    if (data?.col) {
      // dropped on the column body
      cb.onMove(plan.id, activeId, data.col, null);
    } else if (data?.status) {
      // dropped on a card: take its place in that column
      cb.onMove(plan.id, activeId, data.status, String(over.id));
    }
  };

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="plan-board-mode">
        {COLS.map((c) => (
          <BoardColumn key={c.key} col={c} plan={plan} today={today} cb={cb} />
        ))}
      </div>
    </DndContext>
  );
}

function BoardColumn({
  col,
  plan,
  today,
  cb,
}: {
  col: (typeof COLS)[number];
  plan: Plan;
  today: string;
  cb: BoardCallbacks;
}) {
  const { t } = useTranslation();
  const items = plan.tasks.filter((t) => t.status === col.key);
  const { setNodeRef, isOver } = useDroppable({ id: `col-${col.key}`, data: { col: col.key } });
  return (
    <div className={`plan-board-col${isOver ? " over" : ""}`}>
      <div className="plan-board-col-head">
        <StatusDot status={col.key} />
        <span>{t(col.labelKey)}</span>
        <span className="plan-board-col-n mono">{items.length}</span>
      </div>
      <div className="plan-board-col-body" ref={setNodeRef}>
        <SortableContext items={items.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {items.map((t) => (
            <SortableCard key={t.id} task={t} planId={plan.id} today={today} cb={cb} />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

function SortableCard({
  task,
  planId,
  today,
  cb,
}: {
  task: Task;
  planId: string;
  today: string;
  cb: BoardCallbacks;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { status: task.status },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`plan-board-card${task.status === "done" ? " is-done" : ""}${isDragging ? " dragging" : ""}`}
      onClick={() => cb.onOpen(task.id)}
      {...attributes}
      {...listeners}
    >
      <div className="plan-board-card-top">
        <StatusBtn status={task.status} onCycle={() => cb.onCycle(planId, task.id)} />
        <PinBtn focused={task.focused} onToggle={() => cb.onTogglePin(planId, task.id)} />
      </div>
      <div className="plan-board-card-title">{task.title}</div>
      {(task.due || task.note || task.links.length > 0) && (
        <div className="plan-board-card-meta">
          {task.due && <DueBadge due={task.due} today={today} />}
          <TaskFlags task={task} />
        </div>
      )}
    </div>
  );
}
