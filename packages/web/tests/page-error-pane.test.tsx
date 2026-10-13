/**
 * The pane a page error is reported with (desktop-app ticket 08): the pane that was open in the render that threw.
 * A render that throws is never committed, so its effects do not run — the real Shell under the real boundary, with
 * a page that throws the first time it renders.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import i18n from "../src/i18n";
import { PageErrorBoundary } from "../src/PageErrorBoundary";
import { resetPageErrorReportingForTests } from "../src/page-errors";

const h = vi.hoisted(() => ({ crash: null as string | null }));
vi.mock("../src/api/ws", () => ({
  onPlanChanged: () => () => {},
  onLibraryChanged: () => () => {},
  onJobEvent: () => () => {},
  onAnnotationChanged: () => () => {},
  onWriterChanged: () => () => {},
}));
vi.mock("../src/copilot/Copilot", () => ({ Copilot: () => null }));
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
beforeEach(async () => {
  await i18n.changeLanguage("en");
  resetPageErrorReportingForTests();
  reports = [];
  h.crash = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/page-errors") {
        reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ recorded: true });
      }
      return String(input) === "/api/papers"
        ? ({ ok: true, status: 200, json: async () => ({ papers: [] }) } as Response)
        : ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
    })
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  void i18n.changeLanguage("zh-CN");
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
