/**
 * The pane a page error is reported with (desktop-app ticket 08): the pane that was open in the render that threw.
 * A render that throws is never committed, so its effects do not run — the real Shell under the real boundary, with
 * a page that throws the first time it renders.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import { PageErrorBoundary } from "../src/PageErrorBoundary";
import { resetPageErrorReportingForTests } from "../src/page-errors";
import { installShellHarness } from "./shell-harness";

const h = vi.hoisted(() => ({ crash: null as string | null }));
vi.mock("../src/api/ws", async () => (await import("./shell-stubs")).quietWs());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotStub());
vi.mock("../src/plan/PlanView", () => ({
  PlanView: () => {
    if (h.crash === "plan") throw new TypeError("the plan page failed");
    return <div data-ui="stub-plan" />;
  },
}));
vi.mock("../src/writer/WriterView", () => ({
  WriterView: () => {
    if (h.crash === "write") throw new RangeError("the writer page failed");
    return <div data-ui="stub-write" />;
  },
}));

let reports: Record<string, unknown>[];
installShellHarness({
  routes: (url, init) => {
    if (url === "/api/page-errors") {
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ recorded: true });
    }
    return null;
  },
});
beforeEach(() => {
  resetPageErrorReportingForTests();
  reports = [];
  h.crash = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const mount = () =>
  render(
    <PageErrorBoundary reload={() => {}}>
      <Shell />
    </PageErrorBoundary>
  );
const paneShown = (container: HTMLElement): string | null | undefined =>
  container.querySelector('[data-ui="page-error-pane"]')?.textContent;

describe("the pane of a render error is the pane of the render that threw", () => {
  it("a page that throws the moment its pane is switched to: the notice and the report name that pane, not the one left", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('[data-ui="stub-plan"]')).not.toBeNull());
    h.crash = "write";
    fireEvent.click(container.querySelector('[data-ui="navigate-view"][data-ui-key="write"]') as HTMLElement);
    await waitFor(() => expect(container.querySelector('[data-ui="page-error"]')).not.toBeNull());
    expect(container.querySelector('[data-ui="page-error-name"]')?.textContent).toBe("RangeError");
    expect(paneShown(container)).toBe("write");
    await waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]).toMatchObject({ kind: "render", name: "RangeError", pane: "write" });
  });

  it("a page that throws in the very first render: the pane the page opened on, not `none`", async () => {
    h.crash = "plan";
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('[data-ui="page-error"]')).not.toBeNull());
    expect(paneShown(container)).toBe("plan");
    await waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]).toMatchObject({ kind: "render", name: "TypeError", pane: "plan" });
  });
});
