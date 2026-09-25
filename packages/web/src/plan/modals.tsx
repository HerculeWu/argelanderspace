import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton, Dialog, Tooltip } from "../ui";
import { DrawerStatusRow } from "./atoms";
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
] as const;

const PLAN_ICON_LABEL_KEYS = {
  target: "plan.planModal.icons.target",
  telescope: "plan.planModal.icons.telescope",
  "book-marked": "plan.planModal.icons.book-marked",
  database: "plan.planModal.icons.database",
  "brain-circuit": "plan.planModal.icons.brain-circuit",
  sigma: "plan.planModal.icons.sigma",
  "flask-conical": "plan.planModal.icons.flask-conical",
  microscope: "plan.planModal.icons.microscope",
} as const;

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
  const { t } = useTranslation();
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
    <Dialog
      uiId="plan-editor-dialog"
      title={edit ? t("plan.action.editPlan") : t("plan.planModal.create")}
      description={edit ? t("plan.planModal.subEdit") : undefined}
      closeLabel={t("common.close")}
      width={440}
      onClose={onCancel}
      footer={
        <>
          <ActionButton mode="text" label={t("common.cancel")} tooltip={t("common.cancel")} data-ui="cancel-plan-form" onClick={onCancel}>{t("common.cancel")}</ActionButton>
          <ActionButton mode="text" label={edit ? t("common.save") : t("plan.planModal.submit")} tooltip={edit ? t("common.save") : t("plan.planModal.submit")} data-ui="submit-plan-form" variant="primary" disabled={!valid} onClick={submit}>
            {edit ? t("common.save") : t("plan.planModal.submit")}
          </ActionButton>
        </>
      }
    >
      <div className="plan-field">
        <label className="plan-field-label" htmlFor="plan-f-name">
          {t("plan.planModal.name")}
        </label>
        <input
          ref={ref}
          id="plan-f-name" data-ui="plan-name-input"
          className="plan-field-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // Enter mid-IME-composition confirms the candidate, not the form
            if (e.key === "Enter") submit();
          }}
          placeholder={t("plan.planModal.namePlaceholder")}
        />
      </div>
      <div className="plan-field">
        <label className="plan-field-label" htmlFor="plan-f-due">
          {t("plan.form.due")}
        </label>
        <input
          id="plan-f-due" data-ui="plan-due-input"
          className="plan-field-input"
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
      </div>
      <div className="plan-field">
        <label className="plan-field-label" htmlFor="plan-f-desc">
          {t("plan.planModal.desc")} <span className="plan-field-opt">{t("plan.planModal.optional")}</span>
        </label>
        <input
          id="plan-f-desc" data-ui="plan-description-input"
          className="plan-field-input"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // Enter mid-IME-composition confirms the candidate, not the form
            if (e.key === "Enter") submit();
          }}
          placeholder={t("plan.planModal.descPlaceholder")}
        />
      </div>
      <div className="plan-field">
        <div className="plan-field-label">{t("plan.planModal.icon")}</div>
        <div className="plan-icon-grid" data-ui="plan-icon-options">
          {PLAN_ICONS.map((ic) => {
            const label = t(PLAN_ICON_LABEL_KEYS[ic]);
            return (
              <Tooltip key={ic} content={label}>
                <button
                  className={`plan-icon-opt${icon === ic ? " on" : ""}`}
                  data-ui="plan-icon-option"
                  data-ui-key={ic}
                  aria-label={label}
                  onClick={() => setIcon(ic)}
                >
                  <Icon name={ic} cls="ico" />
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </Dialog>
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
  const { t } = useTranslation();
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
    <Dialog
      uiId="task-editor-dialog"
      title={edit ? t("plan.action.editTask") : t("plan.action.newTask")}
      description={edit ? t("plan.taskModal.subEdit", { name: planName }) : t("plan.taskModal.subCreate", { name: planName })}
      closeLabel={t("common.close")}
      width={440}
      onClose={onCancel}
      footer={
        <>
          <ActionButton mode="text" label={t("common.cancel")} tooltip={t("common.cancel")} data-ui="cancel-task-form" onClick={onCancel}>{t("common.cancel")}</ActionButton>
          <ActionButton mode="text" label={edit ? t("common.save") : t("plan.taskModal.submit")} tooltip={edit ? t("common.save") : t("plan.taskModal.submit")} data-ui="submit-task-form" variant="primary" disabled={!valid} onClick={submit}>
            {edit ? t("common.save") : t("plan.taskModal.submit")}
          </ActionButton>
        </>
      }
    >
      <div className="plan-field">
        <label className="plan-field-label" htmlFor="task-f-title">
          {t("plan.taskModal.title")}
        </label>
        <input
          ref={ref}
          id="task-f-title" data-ui="task-title-input"
          className="plan-field-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // Enter mid-IME-composition confirms the candidate, not the form
            if (e.key === "Enter") submit();
          }}
          placeholder={t("plan.taskModal.titlePlaceholder")}
        />
      </div>
      <div className="plan-field">
        <div className="plan-field-label">{t("plan.taskModal.status")}</div>
        <DrawerStatusRow status={status} onSet={setStatus} />
      </div>
      <div className="plan-field">
        <label className="plan-field-label" htmlFor="task-f-due">
          {t("plan.form.due")}
        </label>
        <input
          id="task-f-due" data-ui="task-due-input"
          className="plan-field-input"
          type="date"
          required
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
        {due !== "" && planDue !== "" && due > planDue && (
          <div className="plan-field-hint">{t("plan.taskModal.hintOverdue", { due: planDue })}</div>
        )}
      </div>
    </Dialog>
  );
}

/** Delete-plan double confirm: the warning names the open-task count. */
export function DeletePlanModal({
  plan,
  onCancel,
  onConfirm,
}: {
  plan: Plan;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = plan.tasks.filter((t) => t.status !== "done").length;
  return (
    <Dialog
      uiId="delete-plan-dialog"
      title={t("plan.action.deletePlan")}
      closeLabel={t("common.close")}
      width={440}
      initialFocusRef={cancelRef}
      onClose={onCancel}
      footer={
        <>
          <ActionButton ref={cancelRef} mode="text" label={t("common.cancel")} tooltip={t("common.cancel")} data-ui="cancel-delete-plan" onClick={onCancel}>{t("common.cancel")}</ActionButton>
          <ActionButton mode="text" label={t("plan.deletePlan.confirm")} tooltip={t("plan.deletePlan.confirm")} data-ui="confirm-delete-plan" variant="danger" onClick={onConfirm}>
            {t("plan.deletePlan.confirm")}
          </ActionButton>
        </>
      }
    >
      <div className="plan-modal-warning" data-ui="delete-plan-warning">
        {t("plan.deletePlan.warning", { name: plan.name })}
        {open > 0 ? t("plan.deletePlan.warningOpen", { count: open }) : t("plan.deletePlan.warningNone")}
        {t("plan.deletePlan.warningIrreversible")}
      </div>
    </Dialog>
  );
}
