/**
 * TaskModal overdue soft warning (Stage 7 MS1): a task due later than its
 * plan's due shows a non-blocking hint under the date field; submission
 * stays enabled (plan delays are a legitimate scenario).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskModal } from "../src/plan/modals";

describe("TaskModal overdue hint", () => {
  afterEach(cleanup);

  function setup(planDue = "2026-10-01") {
    const onSubmit = vi.fn();
    render(<TaskModal planName="P" planDue={planDue} onCancel={() => {}} onSubmit={onSubmit} />);
    const due = screen.getByLabelText("截止日期") as HTMLInputElement;
    const title = screen.getByLabelText("任务标题") as HTMLInputElement;
    return { onSubmit, due, title };
  }

  it("shows the hint when the task due passes the plan due, and still submits", () => {
    const { onSubmit, due, title } = setup();
    // the create form prefills due from planDue — no hint initially
    expect(document.querySelector(".plan-field-hint")).toBeNull();

    fireEvent.change(due, { target: { value: "2026-11-15" } });
    const hint = document.querySelector(".plan-field-hint");
    expect(hint?.textContent).toContain("任务截止晚于计划截止");
    expect(hint?.textContent).toContain("2026-10-01");

    fireEvent.change(title, { target: { value: "推迟一步" } });
    fireEvent.click(screen.getByRole("button", { name: "添加任务" }));
    expect(onSubmit).toHaveBeenCalledWith({
      title: "推迟一步",
      status: "todo",
      due: "2026-11-15",
    });
  });

  it("shows no hint when the due is on or before the plan due", () => {
    const { due } = setup();
    fireEvent.change(due, { target: { value: "2026-10-01" } });
    expect(document.querySelector(".plan-field-hint")).toBeNull();
    fireEvent.change(due, { target: { value: "2026-09-15" } });
    expect(document.querySelector(".plan-field-hint")).toBeNull();
  });

  it("keeps the Plan form focus and Escape/cancel behavior through the shared Dialog", () => {
    const onCancel = vi.fn();
    render(<TaskModal planName="P" planDue="2026-10-01" onCancel={onCancel} onSubmit={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "新建任务" });
    expect(document.activeElement).toBe(screen.getByLabelText("任务标题"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
