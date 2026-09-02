import { useEffect, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { Modal, DrawerStatusRow } from "./atoms";
import type { Plan, Task, TaskStatus } from "./model";

// The plan page's modals (Stage 4): PlanModal and TaskModal are each shared
// between create and edit (edit = the same modal opened prefilled), plus the
// delete-plan double confirm. note/links/focused deliberately live OUTSIDE
// the modals (drawer / inline), per the design.

/** The 8 lucide names the icon picker offers (`target` is the schema default). */
export const PLAN_ICONS = [
  "target",
  "telescope",
  "book-marked",
  "database",
  "brain-circuit",
  "sigma",
  "flask-conical",
  "microscope",
];

export interface PlanFormValues {
  name: string;
  due: string; // ISO date, required (deadline semantics)
  desc?: string;
  icon: string;
}

export function PlanModal({
  initial,
  onCancel,
  onSubmit,
}: {
  /** Absent = create; present = edit (prefilled). */
  initial?: Plan;
  onCancel: () => void;
  onSubmit: (values: PlanFormValues) => void;
}) {
  const edit = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [due, setDue] = useState(initial?.due ?? "");
  const [desc, setDesc] = useState(initial?.desc ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "target");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const valid = name.trim() !== "" && due !== "";
  const submit = () => {
    if (!valid) return;
    onSubmit({ name: name.trim(), due, desc: desc.trim() || undefined, icon });
  };
  return (
    <Modal
      title={edit ? "编辑计划" : "新建研究计划"}
      sub={edit ? "修改名称、截止或描述" : undefined}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" disabled={!valid} onClick={submit}>
            <Icon name={edit ? "check" : "plus"} cls="ico-sm" />
            {edit ? "保存" : "创建计划"}
          </button>
        </>
      }
    >
      <div className="plan-field">
        <label className="plan-field-label" htmlFor="plan-f-name">
          计划名称
        </label>
        <input
          ref={ref}
          id="plan-f-name"
          className="plan-field-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // IME 组词中的 Enter 只是上屏，不是提交
            if (e.key === "Enter") submit();
          }}
          placeholder="例如 误差分析 · 投稿准备"
        />
      </div>
      <div className="plan-field">
        <label className="plan-field-label" htmlFor="plan-f-due">
          截止日期
        </label>
        <input
          id="plan-f-due"
          className="plan-field-input"
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
      </div>
      <div className="plan-field">
        <label className="plan-field-label" htmlFor="plan-f-desc">
          描述 <span className="plan-field-opt">可选</span>
        </label>
        <input
          id="plan-f-desc"
          className="plan-field-input"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // IME 组词中的 Enter 只是上屏，不是提交
            if (e.key === "Enter") submit();
          }}
          placeholder="一句话说明这个计划的目标…"
        />
      </div>
      <div className="plan-field">
        <div className="plan-field-label">图标</div>
        <div className="plan-icon-grid">
          {PLAN_ICONS.map((ic) => (
            <button
              key={ic}
              className={`plan-icon-opt${icon === ic ? " on" : ""}`}
              onClick={() => setIcon(ic)}
              title={ic}
            >
              <Icon name={ic} cls="ico" />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export interface TaskFormValues {
  title: string;
  status: TaskStatus;
  /** ISO date — required (Stage-4 smoke ruling); the create form prefills plan.due. */
  due: string;
}

export function TaskModal({
  planName,
  planDue,
  initial,
  defaultStatus = "todo",
  onCancel,
  onSubmit,
}: {
  planName: string;
  /** The owning plan's due — the create form's due prefills from it (Stage-4
   *  smoke ruling: task.due is required, defaulting to the plan's deadline). */
  planDue: string;
  /** Absent = create; present = edit (prefilled). */
  initial?: Task;
  defaultStatus?: TaskStatus;
  onCancel: () => void;
  onSubmit: (values: TaskFormValues) => void;
}) {
  const edit = Boolean(initial);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [status, setStatus] = useState<TaskStatus>(initial?.status ?? defaultStatus);
  const [due, setDue] = useState(initial?.due ?? planDue);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  // due is REQUIRED (the 3b smoke bug: title-only tasks must not be creatable)
  const valid = title.trim() !== "" && due !== "";
  const submit = () => {
    if (!valid) return;
    onSubmit({ title: title.trim(), status, due });
  };
  return (
    <Modal
      title={edit ? "编辑任务" : "新建任务"}
      sub={`${edit ? "编辑于" : "添加到"} · ${planName}`}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" disabled={!valid} onClick={submit}>
            <Icon name={edit ? "check" : "plus"} cls="ico-sm" />
            {edit ? "保存" : "添加任务"}
          </button>
        </>
      }
    >
      <div className="plan-field">
        <label className="plan-field-label" htmlFor="task-f-title">
          任务标题
        </label>
        <input
          ref={ref}
          id="task-f-title"
          className="plan-field-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // IME 组词中的 Enter 只是上屏，不是提交
            if (e.key === "Enter") submit();
          }}
          placeholder="描述这一步要做什么…"
        />
      </div>
      <div className="plan-field">
        <div className="plan-field-label">状态</div>
        <DrawerStatusRow status={status} onSet={setStatus} />
      </div>
      <div className="plan-field">
        <label className="plan-field-label" htmlFor="task-f-due">
          截止日期
        </label>
        <input
          id="task-f-due"
          className="plan-field-input"
          type="date"
          required
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
      </div>
    </Modal>
  );
}

/** plan 删除的二次确认：有未 done 任务时警告带数量。 */
export function DeletePlanModal({
  plan,
  onCancel,
  onConfirm,
}: {
  plan: Plan;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const open = plan.tasks.filter((t) => t.status !== "done").length;
  return (
    <Modal
      title="删除计划"
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary plan-danger" onClick={onConfirm}>
            <Icon name="trash-2" cls="ico-sm" />
            确认删除
          </button>
        </>
      }
    >
      <div className="plan-modal-warning">
        确定删除计划「{plan.name}」吗？
        {open > 0 ? ` 其中还有 ${open} 项未完成的任务，将一并删除。` : " 该计划目前没有未完成的任务。"}
        此操作不可撤销。
      </div>
    </Modal>
  );
}
