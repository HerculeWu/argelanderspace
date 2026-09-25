import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "../argelander/workspace";
import { fetchLibrary } from "../api/library";
import { fetchPlans, putPlans } from "../api/plans";
import { onLibraryChanged, onPlanChanged } from "../api/ws";
import { Icon } from "../lib/icons";
import { newPlanId, newTaskId } from "../lib/planIds";
import type { LibraryData } from "../library/types";
import { BoardMode } from "./BoardMode";
import { FocusView } from "./FocusView";
import { ListMode } from "./ListMode";
import {
  fmtDate,
  moveToColumn,
  nextStatus,
  planProgress,
  reorderWithinStatus,
  todayISO,
  type Plan,
  type PlansFile,
  type Task,
  type TaskStatus,
} from "./model";
import { DeletePlanModal, PlanModal, TaskModal, type PlanFormValues, type TaskFormValues } from "./modals";
import { ActionButton } from "../ui";
import { ProgressRing } from "./atoms";
import { TaskDrawer } from "./TaskDrawer";
import { TimelineMode } from "./TimelineMode";

// The plan page (Stage 4): left secondary sidebar (project head + overall
// progress + plan list + today's-focus/timeline entries), the main plan area
// (toolbar with list/board toggle + new-task button), and the task drawer.
//
// State & write path: the whole {version, rev, plans} document is held in
// state; every edit is an optimistic local update followed by a whole-doc
// PUT through a serial write chain (rapid edits never interleave stale revs).
// Success adopts the response's bumped rev; a 409 (or a failed request)
// reloads from the server and flashes a notice. `plan.changed` WS events
// trigger a full reload — except the echo of our own PUT (the response
// already resynced us; an in-flight write must not be clobbered). An
// EXTERNAL change arriving while our write chain is busy is not skipped but
// deferred: it sets pendingExternal and reloads once the chain drains.
//
// Known boundary, accepted: the write chain is in-memory, so closing the tab
// with an in-flight PUT loses that last optimistic edit (the document on
// disk is one step behind); a durable queue is not worth it for a
// single-user local tool.

type Special = "focus" | "timeline" | null;

type ModalState =
  | { kind: "plan"; plan?: Plan }
  | { kind: "task"; planId: string; task?: Task; defaultStatus?: TaskStatus }
  | { kind: "deletePlan"; plan: Plan }
  | null;

export function PlanView() {
  const ws = useWorkspace();
  const { t } = useTranslation();
  const [doc, setDoc] = useState<PlansFile | null>(null);
  const docRef = useRef<PlansFile | null>(null);
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const localWrites = useRef(0);
  const pendingExternal = useRef(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [library, setLibrary] = useState<LibraryData | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);

  const [selId, setSelId] = useState<string | null>(null);
  const [special, setSpecial] = useState<Special>(null);
  const [mode, setMode] = useState<"list" | "board">("list");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [undo, setUndo] = useState<{ planId: string; index: number; task: Task } | null>(null);
  const undoTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const applyDoc = useCallback((d: PlansFile) => {
    docRef.current = d;
    setDoc(d);
  }, []);

  const reload = useCallback(async () => {
    const d = await fetchPlans();
    if (d) {
      applyDoc(d);
      setLoadFailed(false);
    } else if (!docRef.current) {
      // only the initial load has nothing to fall back on — later failed
      // reloads just keep the current document
      setLoadFailed(true);
    }
  }, [applyDoc]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Full reload on server-pushed plan changes. The echo of our own in-flight
  // PUTs is suppressed (their responses carry the fresh state already) — but
  // a change arriving while the write chain is busy might be EXTERNAL (CLI),
  // so it is deferred, not dropped: reload once the chain drains.
  useEffect(
    () =>
      onPlanChanged(() => {
        if (localWrites.current > 0) {
          pendingExternal.current = true;
          return;
        }
        void reload();
      }),
    [reload]
  );

  // Library payload: the sidebar's project head + the drawer's link
  // candidates (live-first; the fixture fallback is fine for both).
  const reloadLibrary = useCallback(async () => {
    const { data } = await fetchLibrary();
    setLibrary(data);
  }, []);
  useEffect(() => {
    void reloadLibrary();
  }, [reloadLibrary]);
  useEffect(() => onLibraryChanged(() => void reloadLibrary()), [reloadLibrary]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);

  const mutate = useCallback(
    (fn: (d: PlansFile) => PlansFile) => {
      const cur = docRef.current;
      if (!cur) return;
      const next = fn(cur);
      if (next === cur) return; // noop edit (e.g. a cancelled drag): no doc churn, no PUT
      applyDoc(next); // optimistic
      writeChain.current = writeChain.current.then(async () => {
        const snapshot = docRef.current;
        if (!snapshot) return;
        localWrites.current++;
        try {
          const res = await putPlans(snapshot);
          if (res.ok) {
            // adopt the bumped rev; keep newer optimistic edits, if any
            applyDoc(docRef.current === snapshot ? res.doc : { ...(docRef.current as PlansFile), rev: res.doc.rev });
          } else {
            await reload();
            flash(res.conflict ? t("plan.notice.conflict") : t("plan.notice.saveFailed"));
          }
        } finally {
          localWrites.current--;
          if (localWrites.current === 0 && pendingExternal.current) {
            // an external change arrived while we were writing — resync now
            pendingExternal.current = false;
            void reload();
          }
        }
      });
    },
    [applyDoc, reload, flash]
  );

  // ---- operations (all through mutate) ------------------------------------ //

  const patchTask = useCallback(
    (planId: string, taskId: string, patch: Partial<Omit<Task, "id">>) =>
      mutate((d) => ({
        ...d,
        plans: d.plans.map((p) =>
          p.id !== planId
            ? p
            : { ...p, tasks: p.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) }
        ),
      })),
    [mutate]
  );

  // Reference-identity contract: a noop fn (cancelled drag → reorder helpers
  // return the SAME array) bubbles up as the SAME plan/doc, which is what
  // makes mutate's `next === cur` skip reachable — no PUT, no rev bump.
  const patchTasks = useCallback(
    (planId: string, fn: (tasks: Task[]) => Task[]) =>
      mutate((d) => {
        const plan = d.plans.find((p) => p.id === planId);
        if (!plan) return d;
        const tasks = fn(plan.tasks);
        if (tasks === plan.tasks) return d;
        return { ...d, plans: d.plans.map((p) => (p.id !== planId ? p : { ...p, tasks })) };
      }),
    [mutate]
  );

  const cycleTask = useCallback(
    (planId: string, taskId: string) =>
      mutate((d) => ({
        ...d,
        plans: d.plans.map((p) =>
          p.id !== planId
            ? p
            : { ...p, tasks: p.tasks.map((t) => (t.id === taskId ? { ...t, status: nextStatus(t.status) } : t)) }
        ),
      })),
    [mutate]
  );

  const addTask = useCallback(
    (planId: string, values: TaskFormValues) =>
      mutate((d) => ({
        ...d,
        plans: d.plans.map((p) =>
          p.id !== planId
            ? p
            : {
                ...p,
                tasks: [
                  ...p.tasks,
                  {
                    id: newTaskId(),
                    title: values.title,
                    status: values.status,
                    due: values.due,
                    links: [],
                    focused: false,
                    created_at: new Date().toISOString(),
                  },
                ],
              }
        ),
      })),
    [mutate]
  );

  const deleteTask = useCallback(
    (planId: string, taskId: string) => {
      const plan = docRef.current?.plans.find((p) => p.id === planId);
      const index = plan?.tasks.findIndex((t) => t.id === taskId) ?? -1;
      const task = index >= 0 ? plan?.tasks[index] : undefined;
      if (!task) return;
      patchTasks(planId, (tasks) => tasks.filter((t) => t.id !== taskId));
      setOpenTaskId((cur) => (cur === taskId ? null : cur));
      setUndo({ planId, index, task });
      window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setUndo(null), 6000);
    },
    [patchTasks]
  );

  const undoDelete = useCallback(() => {
    if (!undo) return;
    window.clearTimeout(undoTimer.current);
    patchTasks(undo.planId, (tasks) => {
      if (tasks.some((t) => t.id === undo.task.id)) return tasks;
      const out = [...tasks];
      out.splice(Math.min(undo.index, out.length), 0, undo.task); // reinsert at the original index
      return out;
    });
    setUndo(null);
  }, [undo, patchTasks]);

  const addPlan = useCallback(
    (values: PlanFormValues) => {
      const id = newPlanId();
      mutate((d) => ({
        ...d,
        plans: [
          ...d.plans,
          {
            id,
            name: values.name,
            ...(values.desc ? { desc: values.desc } : {}),
            due: values.due,
            icon: values.icon,
            created_at: new Date().toISOString(),
            tasks: [],
          },
        ],
      }));
      setSelId(id);
      setSpecial(null);
      setOpenTaskId(null);
    },
    [mutate]
  );

  const updatePlan = useCallback(
    (planId: string, values: PlanFormValues) =>
      mutate((d) => ({
        ...d,
        plans: d.plans.map((p) =>
          p.id !== planId
            ? p
            : { ...p, name: values.name, due: values.due, desc: values.desc, icon: values.icon }
        ),
      })),
    [mutate]
  );

  const deletePlan = useCallback(
    (planId: string) => {
      mutate((d) => ({ ...d, plans: d.plans.filter((p) => p.id !== planId) }));
      setSelId((cur) => (cur === planId ? null : cur));
      setOpenTaskId(null);
    },
    [mutate]
  );

  // ---- derived ------------------------------------------------------------ //

  const today = todayISO();
  const plans = doc?.plans ?? [];
  const plan = plans.find((p) => p.id === selId) ?? plans[0] ?? null;
  // resolve the open task across ALL plans (focus cards open cross-plan tasks)
  const taskLoc = openTaskId
    ? (() => {
        for (const p of plans) {
          const t = p.tasks.find((t) => t.id === openTaskId);
          if (t) return { task: t, plan: p };
        }
        return null;
      })()
    : null;

  const selectPlan = (id: string) => {
    setSelId(id);
    setSpecial(null);
    setOpenTaskId(null);
  };

  const drawerCb = {
    onSetStatus: (planId: string, taskId: string, status: TaskStatus) =>
      patchTask(planId, taskId, { status }),
    onTogglePin: (planId: string, taskId: string) => {
      const t = plans.find((p) => p.id === planId)?.tasks.find((t) => t.id === taskId);
      if (t) patchTask(planId, taskId, { focused: !t.focused });
    },
    onEdit: (planId: string, task: Task) => setModal({ kind: "task", planId, task }),
    onSetNote: (planId: string, taskId: string, note: string | undefined) =>
      patchTask(planId, taskId, { note }),
    onAddLink: (planId: string, taskId: string, docId: string) => {
      const t = plans.find((p) => p.id === planId)?.tasks.find((t) => t.id === taskId);
      if (t && !t.links.some((l) => l.doc_id === docId))
        patchTask(planId, taskId, { links: [...t.links, { doc_id: docId }] });
    },
    onRemoveLink: (planId: string, taskId: string, docId: string) => {
      const t = plans.find((p) => p.id === planId)?.tasks.find((t) => t.id === taskId);
      if (t) patchTask(planId, taskId, { links: t.links.filter((l) => l.doc_id !== docId) });
    },
    onDelete: deleteTask,
    onOpenDoc: (docId: string) => ws.openDoc(docId),
    onClose: () => setOpenTaskId(null),
  };

  if (!doc) {
    if (loadFailed) {
      // fetchPlans returned null (server down / unreadable plans.json): show
      // an explicit failure state — never the empty state, which would
      // disguise "can't reach the server" as "no plans yet"
      return (
        <div className="plan-empty">
          <div className="plan-empty-ic">
            <Icon name="cloud-off" cls="ico-lg" />
          </div>
          <div className="plan-empty-title">{t("plan.loadFailed.title")}</div>
          <div className="plan-empty-sub">{t("plan.loadFailed.desc")}</div>
          <ActionButton unstyled mode="text" label={t("common.retry")} tooltip={t("common.retry")} className="btn primary" data-ui="retry-plans" onClick={() => void reload()}>
            {t("common.retry")}
          </ActionButton>
        </div>
      );
    }
    return (
      <div className="cg-loading" style={{ position: "relative", height: "100%" }}>
        <div className="cg-spinner" />
        <div className="cg-loading-t">{t("plan.loading")}</div>
      </div>
    );
  }

  const modes = [
    { k: "list" as const, ic: "list", label: t("plan.modes.list") },
    { k: "board" as const, ic: "columns-3", label: t("plan.modes.board") },
  ];

  return (
    <div className="view-row" data-ui="plan-view">
      <PlansSidebar
        plans={plans}
        project={library?.project ?? null}
        selId={plan?.id ?? null}
        special={special}
        onSelect={selectPlan}
        onSpecial={(k) => {
          setSpecial(k);
          setOpenTaskId(null);
        }}
        onAddPlan={() => setModal({ kind: "plan" })}
      />

      <div className="plan-main" data-ui="plan-main">
        {!special && plan && (
          <div className="plan-toolbar" data-ui="plan-toolbar" data-ui-key={plan.id}>
            <div className="plan-tb-left">
              <ProgressRing value={planProgress(plan)} size={34} stroke={3.5} />
              <div className="plan-tb-titles">
                <div className="plan-tb-title">{plan.name}</div>
                <div className="plan-tb-desc">
                  {plan.desc ? `${plan.desc} · ` : ""}
                  <span
                    className={
                      plan.due < today && plan.tasks.some((t) => t.status !== "done")
                        ? "plan-s-blocked"
                        : undefined
                    }
                  >
                    {t("plan.toolbar.due", { date: fmtDate(plan.due) })}
                  </span>
                </div>
              </div>
            </div>
            <div className="plan-tb-right">
              <div className="plan-seg">
                {modes.map((m) => (
                  <ActionButton
                    key={m.k}
                    unstyled
                    mode="icon"
                    iconName={m.ic}
                    label={m.label}
                    tooltip={m.label}
                    data-ui="plan-display-mode"
                    data-ui-key={m.k}
                    aria-pressed={mode === m.k}
                    className={`plan-seg-btn${mode === m.k ? " on" : ""}`}
                    onClick={() => setMode(m.k)}
                  />
                ))}
              </div>
              <ActionButton unstyled mode="icon" iconName="pencil" label={t("plan.action.editPlan")} tooltip={t("plan.action.editPlan")} className="btn icon ghost" data-ui="edit-plan" onClick={() => setModal({ kind: "plan", plan })} />
              <ActionButton unstyled mode="icon" iconName="trash-2" label={t("plan.action.deletePlan")} tooltip={t("plan.action.deletePlan")} className="btn icon ghost" data-ui="delete-plan" onClick={() => setModal({ kind: "deletePlan", plan })} />
              <ActionButton unstyled mode="text" label={t("plan.action.newTask")} tooltip={t("plan.action.newTask")} className="btn primary" data-ui="create-task" onClick={() => setModal({ kind: "task", planId: plan.id, defaultStatus: "todo" })}>
                {t("plan.action.newTask")}
              </ActionButton>
            </div>
          </div>
        )}

        <div className="plan-body" data-ui="plan-content">
          {special === "focus" ? (
            <FocusView plans={plans} today={today} onOpenTask={setOpenTaskId} />
          ) : special === "timeline" ? (
            <TimelineMode plans={plans} today={today} onOpenTask={setOpenTaskId} onSelectPlan={selectPlan} />
          ) : plan ? (
            <div className="plan-canvas" data-ui="plan-canvas" data-ui-key={plan.id} key={`${mode}-${plan.id}`}>
              <div className="plan-canvas-scroll view-in">
                {mode === "list" ? (
                  <ListMode
                    plan={plan}
                    today={today}
                    cb={{
                      onCycle: cycleTask,
                      onOpen: setOpenTaskId,
                      onTogglePin: drawerCb.onTogglePin,
                      onReorder: (planId, status, activeId, overId) =>
                        patchTasks(planId, (tasks) => reorderWithinStatus(tasks, status, activeId, overId)),
                    }}
                  />
                ) : (
                  <BoardMode
                    plan={plan}
                    today={today}
                    cb={{
                      onCycle: cycleTask,
                      onOpen: setOpenTaskId,
                      onTogglePin: drawerCb.onTogglePin,
                      onMove: (planId, activeId, status, overId) =>
                        patchTasks(planId, (tasks) => moveToColumn(tasks, activeId, status, overId)),
                    }}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="plan-empty">
              <div className="plan-empty-ic">
                <Icon name="target" cls="ico-lg" />
              </div>
              <div className="plan-empty-title">{t("plan.empty.title")}</div>
              <div className="plan-empty-sub">{t("plan.empty.desc")}</div>
              <ActionButton unstyled mode="text" label={t("plan.empty.cta")} tooltip={t("plan.empty.cta")} className="btn primary" data-ui="create-first-plan" onClick={() => setModal({ kind: "plan" })}>
                {t("plan.empty.cta")}
              </ActionButton>
            </div>
          )}
          {taskLoc && (
            <TaskDrawer
              task={taskLoc.task}
              plan={taskLoc.plan}
              today={today}
              refs={library?.refs ?? []}
              cb={drawerCb}
            />
          )}
        </div>
      </div>

      {modal?.kind === "plan" && (
        <PlanModal
          initial={modal.plan}
          onCancel={() => setModal(null)}
          onSubmit={(values) => {
            if (modal.plan) updatePlan(modal.plan.id, values);
            else addPlan(values);
            setModal(null);
          }}
        />
      )}
      {modal?.kind === "task" &&
        (() => {
          const modalPlan = plans.find((p) => p.id === modal.planId);
          if (!modalPlan) return null;
          return (
            <TaskModal
              planName={modalPlan.name}
              planDue={modalPlan.due}
              initial={modal.task}
              defaultStatus={modal.defaultStatus}
              onCancel={() => setModal(null)}
              onSubmit={(values) => {
                if (modal.task) patchTask(modal.planId, modal.task.id, values);
                else addTask(modal.planId, values);
                setModal(null);
              }}
            />
          );
        })()}
      {modal?.kind === "deletePlan" && (
        <DeletePlanModal
          plan={modal.plan}
          onCancel={() => setModal(null)}
          onConfirm={() => {
            deletePlan(modal.plan.id);
            setModal(null);
          }}
        />
      )}

      {undo && (
        <div className="plan-undo view-in" data-ui="task-delete-undo">
          <Icon name="trash-2" cls="ico-sm" />
          <span>{t("plan.undo.deleted", { title: undo.task.title })}</span>
          <ActionButton unstyled mode="text" label={t("plan.undo.action")} tooltip={t("plan.undo.action")} className="plan-undo-btn" data-ui="undo-task-delete" onClick={undoDelete}>
            {t("plan.undo.action")}
          </ActionButton>
          <ActionButton unstyled mode="icon" iconName="x" label={t("plan.action.dismissUndo")} tooltip={t("plan.action.dismissUndo")} className="plan-undo-x" data-ui="dismiss-task-delete-undo" onClick={() => setUndo(null)} />
        </div>
      )}
      {notice && <div className="plan-notice view-in" data-ui="plan-notice">{notice}</div>}
    </div>
  );
}

// ---- left secondary sidebar ------------------------------------------------ //

function PlansSidebar({
  plans,
  project,
  selId,
  special,
  onSelect,
  onSpecial,
  onAddPlan,
}: {
  plans: Plan[];
  project: { name: string; field?: string } | null;
  selId: string | null;
  special: Special;
  onSelect: (id: string) => void;
  onSpecial: (k: Exclude<Special, null>) => void;
  onAddPlan: () => void;
}) {
  const { t } = useTranslation();
  const overall = plans.length
    ? Math.round(plans.reduce((a, p) => a + planProgress(p), 0) / plans.length)
    : 0;
  const specials = [
    { k: "focus" as const, ic: "calendar-days", label: t("plan.focus.title") },
    { k: "timeline" as const, ic: "gantt-chart", label: t("plan.timeline.title") },
  ];
  return (
    <div className="plan-side" data-ui="plans-sidebar">
      <div className="plan-proj-head">
        <div className="plan-proj-badge">
          <Icon name="telescope" cls="ico-lg" />
        </div>
        <div className="plan-proj-meta">
          <div className="plan-proj-name">{project?.name ?? t("plan.side.plans")}</div>
          {project?.field && <div className="plan-proj-field">{project.field}</div>}
        </div>
      </div>
      <div className="plan-proj-prog">
        <div className="plan-proj-prog-bar">
          <span style={{ width: `${overall}%` }} />
        </div>
        <div className="plan-proj-prog-num mono">{overall}%</div>
      </div>

      <div className="plan-side-section">
        <div className="plan-side-label">{t("plan.side.plans")}</div>
        <ActionButton unstyled mode="icon" iconName="plus" label={t("plan.action.newPlan")} tooltip={t("plan.action.newPlan")} className="plan-side-add" data-ui="create-plan" onClick={onAddPlan} />
      </div>

      <div className="plan-list">
        {plans.map((p) => {
          const prog = planProgress(p);
          const open = p.tasks.filter((t) => t.status !== "done").length;
          const sub = p.tasks.length
            ? open > 0
              ? t("plan.progress.open", { count: open, date: fmtDate(p.due) })
              : t("plan.progress.done", { date: fmtDate(p.due) })
            : t("plan.progress.empty", { date: fmtDate(p.due) });
          return (
            <button
              key={p.id}
              data-ui="plan-item" data-ui-key={p.id}
              className={`plan-item${!special && p.id === selId ? " sel" : ""}`}
              onClick={() => onSelect(p.id)}
            >
              <span className="plan-item-ic">
                <Icon name={p.icon} cls="ico-sm" />
              </span>
              <span className="plan-item-body">
                <span className="plan-item-name">{p.name}</span>
                <span className="plan-item-sub">{sub}</span>
              </span>
              <span className="plan-item-prog">
                <ProgressRing value={prog} size={22} stroke={2.5} />
              </span>
            </button>
          );
        })}
      </div>

      <div className="plan-side-section">
        <div className="plan-side-label">{t("plan.side.views")}</div>
      </div>
      <div className="plan-list">
        {specials.map((s) => (
          <button
            key={s.k}
            data-ui="plan-special-view" data-ui-key={s.k}
            className={`plan-item${special === s.k ? " sel" : ""}`}
            onClick={() => onSpecial(s.k)}
          >
            <span className="plan-item-ic">
              <Icon name={s.ic} cls="ico-sm" />
            </span>
            <span className="plan-item-body">
              <span className="plan-item-name">{s.label}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
