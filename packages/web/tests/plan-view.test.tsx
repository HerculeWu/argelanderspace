/**
 * PlanView behavior (Stage 4 / MS3): empty state → create plan → modal add
 * task → status cycle → drawer edit → pin → 今日聚焦 grouping → link
 * picker filtering → missing-doc graying → delete + undo → board/timeline
 * smoke → 409 reload — plus the MS3-review regressions (IME composition
 * Enter, deferred external reload, load-failure state, modal prefills).
 * The plans API is served through the real `api/plans` module over a stubbed
 * global fetch (a tiny in-test "server" with rev semantics); `api/ws` is
 * mocked, with plan.changed subscribers captured so tests can fire them.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlansFile, Task } from "@argelanderspace/contracts";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";
import { addDaysISO, todayISO } from "../src/plan/model";
import { PlanView } from "../src/plan/PlanView";
import { TimelineMode } from "../src/plan/TimelineMode";
import type { LibraryData } from "../src/library/types";

const wsMock = vi.hoisted(() => ({ planChangedCbs: [] as (() => void)[] }));
vi.mock("../src/api/ws", () => ({
  onPlanChanged: (cb: () => void) => {
    wsMock.planChangedCbs.push(cb);
    return () => {};
  },
  onLibraryChanged: () => () => {},
  onJobEvent: () => () => {},
}));

const WORKSPACE: Workspace = {
  papers: [],
  currentDoc: null,
  setCurrentDoc: () => {},
  openDoc: vi.fn(),
  pendingAnchor: null,
  clearPendingAnchor: () => {},
  docDeleted: () => {},
  tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
};

const LIBRARY: LibraryData = {
  project: { name: "测试项目", field: "Astro" },
  refs: [
    {
      id: "w1",
      title: "Galaxy Dynamics",
      authors: "Able",
      year: 2020,
      venue: "ApJ",
      type: "article",
      cite: "able2020",
      tags: [],
      pdf: true,
      read: false,
      star: false,
      doc_id: "doc-gal",
    },
    {
      id: "w2",
      title: "Dark Matter Halos",
      authors: "Baker",
      year: 2021,
      venue: "MNRAS",
      type: "article",
      cite: "baker2021",
      tags: [],
      pdf: false,
      read: false,
      star: false,
      doc_id: "doc-dm",
    },
    {
      id: "w3",
      title: "No Doc Paper",
      authors: "Clark",
      year: 2022,
      venue: "AJ",
      type: "article",
      cite: "clark2022",
      tags: [],
      pdf: false,
      read: false,
      star: false,
    },
  ],
  tags: [],
  graph: { nodes: [], links: [] },
};

let seq = 0;
function mkTask(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t_${String(seq).padStart(8, "0")}`,
    title: `任务${seq}`,
    status: "todo",
    due: "2026-12-31",
    links: [],
    focused: false,
    created_at: "2026-09-01T08:00:00.000Z",
    ...over,
  };
}

function mkDoc(tasks: Task[], over: Record<string, unknown> = {}): PlansFile {
  return {
    version: 1,
    rev: 0,
    plans: [
      {
        id: "p_00000001",
        name: "采样计划",
        due: "2026-12-31",
        icon: "target",
        created_at: "2026-08-01T08:00:00.000Z",
        tasks,
        ...over,
      },
    ],
  };
}

// ---- the in-test "server" ------------------------------------------------- //

let serverDoc: PlansFile;
let putBodies: PlansFile[];
let forceNext409: boolean;
let getCalls: number;
let plansGetFails: boolean;
let putGate: Promise<void> | null;
let putRelease: (() => void) | null;

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/plans" && method === "GET") {
        getCalls++;
        if (plansGetFails) {
          return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
        }
        return okJson(serverDoc);
      }
      if (url === "/api/plans" && method === "PUT") {
        if (putGate) {
          const gate = putGate;
          putGate = null;
          await gate; // hold the PUT in flight until the test releases it
        }
        const body = JSON.parse(String(init?.body)) as PlansFile;
        if (forceNext409) {
          forceNext409 = false;
          return { ok: false, status: 409, json: async () => ({ detail: "rev mismatch", rev: serverDoc.rev }) } as Response;
        }
        putBodies.push(body);
        serverDoc = { ...body, rev: body.rev + 1 };
        return okJson(serverDoc);
      }
      if (url === "/api/library") return okJson(LIBRARY);
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    })
  );
}

function lastPut(): PlansFile {
  const b = putBodies[putBodies.length - 1];
  if (!b) throw new Error("no PUT recorded");
  return b;
}

function byText(container: HTMLElement, selector: string, text: string): HTMLElement {
  const el = [...container.querySelectorAll<HTMLElement>(selector)].find((e) =>
    e.textContent?.includes(text)
  );
  if (!el) throw new Error(`not found: ${selector} "${text}"`);
  return el;
}

function rowOf(container: HTMLElement, title: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(".plan-task-row")].find(
    (r) => r.querySelector(".plan-task-title")?.textContent === title
  );
  if (!row) throw new Error(`task row not found: ${title}`);
  return row;
}

function renderPlan() {
  return render(
    <WorkspaceProvider value={WORKSPACE}>
      <PlanView />
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  serverDoc = mkDoc([]);
  putBodies = [];
  forceNext409 = false;
  getCalls = 0;
  plansGetFails = false;
  putGate = null;
  putRelease = null;
  wsMock.planChangedCbs.length = 0;
  vi.mocked(WORKSPACE.openDoc).mockClear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PlanView: plans empty → create → inline add", () => {
  it("shows the guided empty state and creates the first plan via PlanModal", async () => {
    serverDoc = { version: 1, rev: 0, plans: [] }; // truly empty → guided empty state
    const { container } = renderPlan();
    const cta = await waitFor(() => byText(container, ".plan-empty button", "新建第一个研究计划"));
    fireEvent.click(cta);

    // PlanModal: name + due are both required (submit stays disabled otherwise)
    const modal = await waitFor(() => document.querySelector(".plan-modal") as HTMLElement);
    const submit = byText(modal, "button", "创建计划") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const [nameInput, dueInput] = [...modal.querySelectorAll<HTMLInputElement>("input")];
    fireEvent.change(nameInput!, { target: { value: "误差分析" } });
    fireEvent.change(dueInput!, { target: { value: "2026-12-31" } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    // sidebar lists the new plan; the PUT carried rev 0 and the schema shape
    await waitFor(() => byText(container, ".plan-item-name", "误差分析"));
    await waitFor(() => expect(putBodies.length).toBe(1));
    expect(lastPut().rev).toBe(0);
    const plan = lastPut().plans[0]!;
    expect(plan.name).toBe("误差分析");
    expect(plan.due).toBe("2026-12-31");
    expect(plan.icon).toBe("target");
    expect(plan.id).toMatch(/^p_[0-9a-f]{8}$/);
    // and the freshly-created plan is the selected one (toolbar shows it)
    await waitFor(() => byText(container, ".plan-tb-title", "误差分析"));
  });

  it("新建任务 modal: due prefills from the plan and is required (3b regression)", async () => {
    serverDoc = mkDoc([]);
    const { container } = renderPlan();
    await waitFor(() => byText(container, ".plan-tb-title", "采样计划"));
    fireEvent.click(byText(container, "button", "新建任务"));

    const modal = await waitFor(() => document.querySelector(".plan-modal") as HTMLElement);
    const dueInput = modal.querySelector<HTMLInputElement>("#task-f-due")!;
    expect(dueInput.value).toBe("2026-12-31"); // prefilled from the plan's due
    expect(dueInput.required).toBe(true);
    const submit = byText(modal, "button", "添加任务") as HTMLButtonElement;

    const titleInput = modal.querySelector<HTMLInputElement>("#task-f-title")!;
    fireEvent.change(titleInput, { target: { value: "复核公式推导" } });
    await waitFor(() => expect(submit.disabled).toBe(false));

    // 3b 回归：清空日期后无法提交（title-only 任务不能再被创建）
    fireEvent.change(dueInput, { target: { value: "" } });
    await waitFor(() => expect(submit.disabled).toBe(true));
    expect(putBodies).toHaveLength(0);

    // 改回一个日期即可提交
    fireEvent.change(dueInput, { target: { value: "2026-10-01" } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(putBodies.length).toBe(1));
    const task = lastPut().plans[0]!.tasks[0]!;
    expect(task.title).toBe("复核公式推导");
    expect(task.due).toBe("2026-10-01");
    expect(task.status).toBe("todo");
    expect(task.id).toMatch(/^t_[0-9a-f]{8}$/);
  });
});

describe("PlanView: status cycle + drawer edit + pin", () => {
  it("the status button cycles todo → doing → done (group jumps)", async () => {
    serverDoc = mkDoc([mkTask({ title: "循环任务" })]);
    const { container } = renderPlan();
    const row = await waitFor(() => rowOf(container, "循环任务"));
    fireEvent.click(row.querySelector(".plan-st-btn")!);

    // the task lands in 进行中; the PUT recorded the new status
    await waitFor(() => {
      const group = byText(container, ".plan-list-group-head", "进行中");
      expect(group.parentElement!.textContent).toContain("循环任务");
    });
    await waitFor(() => expect(lastPut().plans[0]!.tasks[0]!.status).toBe("doing"));

    fireEvent.click(rowOf(container, "循环任务").querySelector(".plan-st-btn")!);
    await waitFor(() => expect(lastPut().plans[0]!.tasks[0]!.status).toBe("done"));
  });

  it("opens the drawer, edits the task via the prefilled TaskModal", async () => {
    serverDoc = mkDoc([mkTask({ title: "旧标题", status: "doing", due: "2026-10-01" })]);
    const { container } = renderPlan();
    fireEvent.click((await waitFor(() => rowOf(container, "旧标题"))).querySelector(".plan-task-title")!);

    const drawer = await waitFor(() => container.querySelector(".plan-drawer") as HTMLElement);
    fireEvent.click(drawer.querySelector('button[title="编辑任务"]')!);

    const modal = await waitFor(() => document.querySelector(".plan-modal") as HTMLElement);
    const titleInput = modal.querySelector<HTMLInputElement>("input")!;
    expect(titleInput.value).toBe("旧标题"); // 编辑 = 预填打开
    fireEvent.change(titleInput, { target: { value: "新标题" } });
    fireEvent.click(byText(modal, "button", "保存"));

    await waitFor(() => rowOf(container, "新标题"));
    await waitFor(() => {
      const t = lastPut().plans[0]!.tasks[0]!;
      expect(t.title).toBe("新标题");
      expect(t.due).toBe("2026-10-01"); // untouched fields preserved
      expect(t.status).toBe("doing");
    });
  });

  it("the drawer pin toggle persists focused", async () => {
    serverDoc = mkDoc([mkTask({ title: "待聚焦" })]);
    const { container } = renderPlan();
    fireEvent.click((await waitFor(() => rowOf(container, "待聚焦"))).querySelector(".plan-task-title")!);
    const drawer = await waitFor(() => container.querySelector(".plan-drawer") as HTMLElement);
    fireEvent.click(drawer.querySelector(".plan-drawer-head-actions .plan-pin")!);
    await waitFor(() => expect(lastPut().plans[0]!.tasks[0]!.focused).toBe(true));
  });
});

describe("PlanView: 今日聚焦 grouping", () => {
  it("groups pinned → overdue → today → tomorrow; done tasks never appear", async () => {
    const today = todayISO();
    serverDoc = mkDoc([
      mkTask({ title: "钉住的", focused: true, due: addDaysISO(today, -3) }),
      mkTask({ title: "逾期的", due: addDaysISO(today, -1) }),
      mkTask({ title: "今天的", due: today }),
      mkTask({ title: "明天的", due: addDaysISO(today, 1) }),
      mkTask({ title: "已完成钉", focused: true, status: "done" }),
      mkTask({ title: "无关的", due: addDaysISO(today, 30) }),
    ]);
    const { container } = renderPlan();
    await waitFor(() => rowOf(container, "钉住的"));
    fireEvent.click(byText(container, ".plan-item-name", "今日聚焦"));

    await waitFor(() => byText(container, ".plan-focus-when", "已聚焦"));
    const labels = [...container.querySelectorAll(".plan-focus-when")].map((e) => e.textContent);
    expect(labels).toEqual(["已聚焦", "已逾期", "今天到期", "明天到期"]);
    const cards = [...container.querySelectorAll(".plan-focus-card-title")].map((e) => e.textContent);
    expect(cards).toEqual(["钉住的", "逾期的", "今天的", "明天的"]);
    expect(cards).not.toContain("已完成钉");
    expect(cards).not.toContain("无关的");
  });

  it("the all-empty case shows guidance instead of groups", async () => {
    serverDoc = mkDoc([mkTask({ title: "普通任务" })]);
    const { container } = renderPlan();
    await waitFor(() => rowOf(container, "普通任务"));
    fireEvent.click(byText(container, ".plan-item-name", "今日聚焦"));
    await waitFor(() => expect(container.querySelector(".plan-sv-empty")).toBeTruthy());
    expect(container.querySelectorAll(".plan-focus-group")).toHaveLength(0);
  });
});

describe("PlanView: linked documents", () => {
  it("the picker filters CommandPalette-style and only offers refs with a doc", async () => {
    serverDoc = mkDoc([mkTask({ title: "挂链接" })]);
    const { container } = renderPlan();
    fireEvent.click((await waitFor(() => rowOf(container, "挂链接"))).querySelector(".plan-task-title")!);
    const drawer = await waitFor(() => container.querySelector(".plan-drawer") as HTMLElement);

    fireEvent.click(byText(drawer, "button", "添加关联文档"));
    const pick = await waitFor(() => drawer.querySelector(".plan-linkpick") as HTMLElement);
    // unfiltered: both doc-having refs, never the doc-less one
    expect(pick.textContent).toContain("Galaxy Dynamics");
    expect(pick.textContent).toContain("Dark Matter Halos");
    expect(pick.textContent).not.toContain("No Doc Paper");

    const input = pick.querySelector("input")!;
    fireEvent.change(input, { target: { value: "dark" } });
    await waitFor(() => {
      expect(pick.textContent).toContain("Dark Matter Halos");
      expect(pick.textContent).not.toContain("Galaxy Dynamics");
    });
    fireEvent.click(byText(pick, ".plan-linkpick-item", "Dark Matter Halos"));

    // link row shows the work title; the PUT recorded the doc_id link
    await waitFor(() => byText(drawer, ".plan-drawer-art-t", "Dark Matter Halos"));
    await waitFor(() =>
      expect(lastPut().plans[0]!.tasks[0]!.links).toEqual([{ doc_id: "doc-dm" }])
    );
    // clicking the link opens the doc pane
    fireEvent.click(byText(drawer, ".plan-drawer-art-t", "Dark Matter Halos"));
    expect(WORKSPACE.openDoc).toHaveBeenCalledWith("doc-dm");
  });

  it("a doc the library no longer has renders grayed as 文档不存在 and is NOT auto-removed", async () => {
    serverDoc = mkDoc([mkTask({ title: "失效链接", links: [{ doc_id: "ghost-doc" }] })]);
    const { container } = renderPlan();
    fireEvent.click((await waitFor(() => rowOf(container, "失效链接"))).querySelector(".plan-task-title")!);
    const drawer = await waitFor(() => container.querySelector(".plan-drawer") as HTMLElement);
    await waitFor(() => byText(drawer, ".plan-drawer-art.missing", "文档不存在"));
    await new Promise((r) => setTimeout(r, 30)); // give any rogue write a chance
    expect(putBodies).toHaveLength(0); // opening the drawer never rewrites links
  });
});

describe("PlanView: delete + 6s undo", () => {
  it("delete removes the task with a toast; 撤销 reinserts it at its index", async () => {
    serverDoc = mkDoc([mkTask({ title: "甲" }), mkTask({ title: "乙" }), mkTask({ title: "丙" })]);
    const { container } = renderPlan();
    fireEvent.click((await waitFor(() => rowOf(container, "乙"))).querySelector(".plan-task-title")!);
    const drawer = await waitFor(() => container.querySelector(".plan-drawer") as HTMLElement);
    fireEvent.click(byText(drawer, "button", "删除任务"));

    await waitFor(() => expect(container.querySelectorAll(".plan-task-row")).toHaveLength(2));
    const toast = await waitFor(() => container.querySelector(".plan-undo") as HTMLElement);
    expect(toast.textContent).toContain("已删除「乙」");
    fireEvent.click(byText(toast, "button", "撤销"));

    await waitFor(() => expect(container.querySelectorAll(".plan-task-row")).toHaveLength(3));
    const titles = [...container.querySelectorAll(".plan-task-title")].map((e) => e.textContent);
    expect(titles).toEqual(["甲", "乙", "丙"]); // 原位插回
  });
});

describe("PlanView: board + timeline smoke", () => {
  it("board mode renders the four columns", async () => {
    serverDoc = mkDoc([mkTask({ title: "看板任务" })]);
    const { container } = renderPlan();
    await waitFor(() => rowOf(container, "看板任务"));
    fireEvent.click(byText(container, ".plan-seg-btn", "看板"));
    await waitFor(() => expect(container.querySelectorAll(".plan-board-col")).toHaveLength(4));
    const heads = [...container.querySelectorAll(".plan-board-col-head")].map((e) => e.textContent);
    expect(heads.join()).toEqual(expect.stringContaining("待办"));
    expect(heads.join()).toEqual(expect.stringContaining("已完成"));
    expect(container.querySelector(".plan-board-card-title")?.textContent).toBe("看板任务");
  });

  it("timeline renders plan bars, due milestones and the today line", async () => {
    serverDoc = mkDoc([mkTask({ title: "里程碑", due: "2026-10-01" })]);
    const { container } = renderPlan();
    await waitFor(() => rowOf(container, "里程碑"));
    fireEvent.click(byText(container, ".plan-item-name", "时间线"));
    await waitFor(() => expect(container.querySelector(".plan-tl-bar")).toBeTruthy());
    expect(container.querySelector(".plan-tl-bar-label")?.textContent).toContain("12月31日");
    expect(container.querySelectorAll(".plan-tl-ms")).toHaveLength(1);
    expect(container.querySelector(".plan-tl-today")).toBeTruthy();
  });
});

describe("PlanView: 409 → reload", () => {
  it("a stale rev flashes a notice and the optimistic edit is reverted", async () => {
    serverDoc = mkDoc([mkTask({ title: "原始任务" })]);
    forceNext409 = true;
    const { container } = renderPlan();
    const row = await waitFor(() => rowOf(container, "原始任务"));
    fireEvent.click(row.querySelector(".plan-st-btn")!); // optimistic todo → doing

    // the 409 forces a reload: the task is back to 待办 and the notice shows
    await waitFor(() => expect(container.querySelector(".plan-notice")?.textContent).toContain("已重新载入"));
    await waitFor(() => {
      const todoGroup = byText(container, ".plan-list-group-head", "待办");
      expect(todoGroup.parentElement!.textContent).toContain("原始任务");
    });
    const heads = [...container.querySelectorAll(".plan-list-group-head")].map((e) => e.textContent);
    expect(heads.some((h) => h?.includes("进行中"))).toBe(false);
  });
});


// --------------------------------------------------------------------------- //
// MS3 review regressions
// --------------------------------------------------------------------------- //

describe("PlanView: IME composition Enter (B2)", () => {
  it("an Enter with isComposing=true only confirms the IME candidate — no submit", async () => {
    serverDoc = mkDoc([]);
    const { container } = renderPlan();
    await waitFor(() => byText(container, ".plan-tb-title", "采样计划"));
    fireEvent.click(byText(container, "button", "新建任务"));

    // the modal title input keeps the IME guard (QuickAdd is gone; the modal
    // is the only creation path now)
    const modal = await waitFor(() => document.querySelector(".plan-modal") as HTMLElement);
    const input = modal.querySelector<HTMLInputElement>("#task-f-title")!;
    fireEvent.change(input, { target: { value: "组词中" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true }); // IME 上屏
    await new Promise((r) => setTimeout(r, 30));
    expect(putBodies).toHaveLength(0); // nothing submitted
    expect(input.value).toBe("组词中"); // draft kept

    fireEvent.keyDown(input, { key: "Enter" }); // the real submit still works
    await waitFor(() => expect(putBodies.length).toBe(1));
    expect(lastPut().plans[0]!.tasks.some((t) => t.title === "组词中")).toBe(true);
  });
});

describe("PlanView: deferred external reload (review ①)", () => {
  it("a plan.changed arriving mid-PUT is deferred, not dropped: reload fires when the chain drains", async () => {
    serverDoc = mkDoc([mkTask({ title: "同步任务" })]);
    const { container } = renderPlan();
    const row = await waitFor(() => rowOf(container, "同步任务"));
    const initialGets = getCalls;

    putGate = new Promise<void>((r) => {
      putRelease = r;
    });
    fireEvent.click(row.querySelector(".plan-st-btn")!); // optimistic edit; PUT held in flight
    await waitFor(() => expect(putGate).toBeNull()); // the PUT actually started and is waiting

    wsMock.planChangedCbs.forEach((cb) => cb()); // external plans.json write arrives mid-flight
    await new Promise((r) => setTimeout(r, 40));
    expect(getCalls).toBe(initialGets); // suppressed while writing (echo protection)

    // the server now carries the external change; releasing our PUT must
    // trigger the deferred reload that picks it up
    putRelease!();
    await waitFor(() => expect(getCalls).toBeGreaterThan(initialGets));
  });
});

describe("PlanView: load-failure state (review ④)", () => {
  it("an unreachable server shows 无法连接服务器 + 重试, never the empty state; retry recovers", async () => {
    plansGetFails = true;
    serverDoc = { version: 1, rev: 0, plans: [] }; // what the GET will serve once the server is back
    const { container } = renderPlan();
    await waitFor(() => byText(container, ".plan-empty-title", "无法连接服务器"));
    expect(container.querySelector(".plan-empty button")?.textContent).toContain("重试");
    expect(container.textContent).not.toContain("新建第一个研究计划");

    plansGetFails = false; // server back
    fireEvent.click(byText(container, ".plan-empty button", "重试"));
    await waitFor(() => byText(container, ".plan-empty button", "新建第一个研究计划"));
  });
});

describe("PlanView: modals (review ⑨)", () => {
  it("PlanModal opened for edit is prefilled; saving preserves tasks", async () => {
    serverDoc = mkDoc([mkTask({ title: "保留我" })], {
      name: "旧计划名",
      desc: "旧描述",
      icon: "sigma",
      due: "2026-11-30",
    });
    const { container } = renderPlan();
    await waitFor(() => byText(container, ".plan-tb-title", "旧计划名"));
    fireEvent.click(container.querySelector('button[title="编辑计划"]')!);

    const modal = await waitFor(() => document.querySelector(".plan-modal") as HTMLElement);
    const nameInput = modal.querySelector<HTMLInputElement>("#plan-f-name")!;
    const dueInput = modal.querySelector<HTMLInputElement>("#plan-f-due")!;
    const descInput = modal.querySelector<HTMLInputElement>("#plan-f-desc")!;
    expect(nameInput.value).toBe("旧计划名");
    expect(dueInput.value).toBe("2026-11-30");
    expect(descInput.value).toBe("旧描述");
    expect(modal.querySelector(".plan-icon-opt.on")?.getAttribute("title")).toBe("sigma");

    fireEvent.change(nameInput, { target: { value: "新计划名" } });
    fireEvent.click(byText(modal, "button", "保存"));
    await waitFor(() => byText(container, ".plan-tb-title", "新计划名"));
    const plan = lastPut().plans[0]!;
    expect(plan.name).toBe("新计划名");
    expect(plan.due).toBe("2026-11-30");
    expect(plan.icon).toBe("sigma");
    expect(plan.tasks.map((t) => t.title)).toEqual(["保留我"]); // tasks untouched
  });

  it("TaskModal edit prefills the task's due; clearing it disables submit (due required)", async () => {
    serverDoc = mkDoc([mkTask({ title: "有截止", due: "2026-10-01" })]);
    const { container } = renderPlan();
    fireEvent.click((await waitFor(() => rowOf(container, "有截止"))).querySelector(".plan-task-title")!);
    const drawer = await waitFor(() => container.querySelector(".plan-drawer") as HTMLElement);
    fireEvent.click(drawer.querySelector('button[title="编辑任务"]')!);

    const modal = await waitFor(() => document.querySelector(".plan-modal") as HTMLElement);
    const dueInput = modal.querySelector<HTMLInputElement>("#task-f-due")!;
    expect(dueInput.value).toBe("2026-10-01"); // 编辑预填任务现有 due
    const submit = byText(modal, "button", "保存") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    // due 必填：清空后无法保存（不再有"清除"按钮，只能改日期）
    expect(modal.textContent).not.toContain("清除");
    fireEvent.change(dueInput, { target: { value: "" } });
    await waitFor(() => expect(submit.disabled).toBe(true));
    expect(putBodies).toHaveLength(0);
  });

  it("DeletePlanModal warns with the open-task count; confirm removes the plan", async () => {
    serverDoc = mkDoc([
      mkTask({ title: "未完一" }),
      mkTask({ title: "未完二", status: "doing" }),
      mkTask({ title: "已完", status: "done" }),
    ]);
    const { container } = renderPlan();
    await waitFor(() => rowOf(container, "未完一"));
    fireEvent.click(container.querySelector('button[title="删除计划"]')!);

    const modal = await waitFor(() => document.querySelector(".plan-modal") as HTMLElement);
    expect(document.activeElement).toBe(byText(modal, "button", "取消"));
    expect(modal.querySelector(".plan-modal-warning")?.textContent).toContain("2 项未完成的任务");
    fireEvent.click(byText(modal, "button", "确认删除"));

    await waitFor(() => byText(container, ".plan-empty button", "新建第一个研究计划"));
    expect(lastPut().plans).toEqual([]);
  });
});

describe("TimelineMode: reverse span (created_at > due) renders clamped (review ⑨)", () => {
  it("a plan whose due precedes its creation still renders a minimal bar, no crash", () => {
    const plan = {
      id: "p_00000001",
      name: "反向计划",
      due: "2026-09-01",
      icon: "target",
      created_at: "2026-10-01T08:00:00.000Z",
      tasks: [],
    };
    const { container } = render(
      <TimelineMode plans={[plan]} today="2026-09-15" onOpenTask={() => {}} onSelectPlan={() => {}} />
    );
    const bar = container.querySelector(".plan-tl-bar") as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.style.width).toBe("0.8%"); // clamped minimum, never negative
  });
});
