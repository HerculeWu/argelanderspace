/**
 * TaskModal overdue soft warning (Stage 7 MS1): a task due later than its
 * plan's due shows a non-blocking hint under the date field; submission
 * stays enabled (plan delays are a legitimate scenario).
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskModal } from "../src/plan/modals";

describe("TaskModal overdue hint", () => {
  afterEach(cleanup);

  function setup(planDue = "2026-10-01") {
    const onSubmit = vi.fn();
    const r = render(
      <TaskModal planName="P" planDue={planDue} onCancel={() => {}} onSubmit={onSubmit} />
    );
    const due = r.container.querySelector<HTMLInputElement>("#task-f-due");
    const title = r.container.querySelector<HTMLInputElement>("#task-f-title");
    if (due === null || title === null) throw new Error("fields not rendered");
    return { r, onSubmit, due, title };
  }

  it("shows the hint when the task due passes the plan due, and still submits", () => {
    const { r, onSubmit, due, title } = setup();
    // the create form prefills due from planDue — no hint initially
    expect(r.container.querySelector(".plan-field-hint")).toBeNull();

    fireEvent.change(due, { target: { value: "2026-11-15" } });
    const hint = r.container.querySelector(".plan-field-hint");
    expect(hint?.textContent).toContain("任务截止晚于计划截止");
    expect(hint?.textContent).toContain("2026-10-01");

    fireEvent.change(title, { target: { value: "推迟一步" } });
    fireEvent.click(r.getByText("添加任务"));
    expect(onSubmit).toHaveBeenCalledWith({
      title: "推迟一步",
      status: "todo",
      due: "2026-11-15",
    });
  });

  it("shows no hint when the due is on or before the plan due", () => {
    const { r, due } = setup();
    fireEvent.change(due, { target: { value: "2026-10-01" } });
    expect(r.container.querySelector(".plan-field-hint")).toBeNull();
    fireEvent.change(due, { target: { value: "2026-09-15" } });
    expect(r.container.querySelector(".plan-field-hint")).toBeNull();
  });
});
