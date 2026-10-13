/**
 * The page's error reporting and its top-level boundary (desktop-app ticket 08): what leaves the page is cut down
 * to a kind, a class name, script locations and a pane; reporting cannot cause more reporting; a render error shows
 * a notice that says whether the error reached the log, and "Reload" reloads the whole page.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/i18n";
import i18n from "../src/i18n";
import { PageErrorBoundary } from "../src/PageErrorBoundary";
import {
  framesOf,
  installPageErrorReporting,
  notePane,
  REPORTS_PER_WINDOW,
  REPORT_WINDOW_MS,
  reduceError,
  reportPageError,
  resetPageErrorReportingForTests,
} from "../src/page-errors";

const SECRET = "the secret plan of the thesis";
type Sent = { url: string; init: RequestInit; body: Record<string, unknown> };
let sent: Sent[];
let answer: () => Promise<Response>;

function withStack(error: Error, lines: string[]): Error {
  error.stack = [`${error.name}: ${error.message}`, ...lines].join("\n");
  return error;
}

beforeEach(() => {
  resetPageErrorReportingForTests();
  sent = [];
  answer = async () => Response.json({ recorded: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return answer();
    })
  );
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.changeLanguage("zh-CN");
});

describe("what leaves the page", () => {
  it("is the kind, the class name, file:line:column of each script frame, and the pane — never the message", async () => {
    notePane("library");
    const error = withStack(new TypeError(`Cannot read properties of ${SECRET}`), [
      `    at renderRow (http://127.0.0.1:8000/assets/index-eZgqHfVD.js?v=${encodeURIComponent(SECRET)}:12:3456)`,
      "    at http://127.0.0.1:8000/assets/browser-BKLM0ThC-CjI6Ronm.js#frag:7:8",
      "    at async Promise.all (index 0)",
      "    at <anonymous>",
      `secretFn@http://127.0.0.1:8000/assets/direct-engine-BMwLK-Tl.js:3:4`,
      `    at eval (chrome-extension://abcdef/${SECRET}/inject.js:1:2)`,
      `    at Object.x (http://127.0.0.1:8000/doc/${SECRET}:1:2)`,
    ]);
    expect(await reportPageError("error", error)).toBe("recorded");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("/api/page-errors");
    expect(sent[0]?.init.method).toBe("POST");
    expect(sent[0]?.body).toEqual({
      kind: "error",
      name: "TypeError",
      stack: [
        "index-eZgqHfVD.js:12:3456",
        "browser-BKLM0ThC-CjI6Ronm.js:7:8",
        "direct-engine-BMwLK-Tl.js:3:4",
        "inject.js:1:2",
      ],
      pane: "library",
    });
    expect(String(sent[0]?.init.body)).not.toContain("secret");
    expect(String(sent[0]?.init.body)).not.toContain("127.0.0.1");
  });

  it("names a thrown non-Error NonError, and an error whose name is not a class name Error", () => {
    expect(reduceError("unhandledrejection", SECRET)).toEqual({
      kind: "unhandledrejection",
      name: "NonError",
      stack: [],
      pane: "none",
    });
    expect(reduceError("error", { message: SECRET, stack: `at x (a-12345678.js:1:2)` }).stack).toEqual([]);
    const renamed = new Error("x");
    renamed.name = `Name with ${SECRET}`;
    expect(reduceError("error", renamed).name).toBe("Error");
    expect(framesOf(withStack(new Error("x"), Array(100).fill("    at f (http://h/a-12345678.js:1:1)")))).toHaveLength(30);
  });
});

describe("reporting never causes more reporting", () => {
  it("a report the server cannot take is dropped: no throw, no rejection, no second request", async () => {
    answer = async () => {
      throw new TypeError("Failed to fetch");
    };
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const stop = installPageErrorReporting();
    expect(await reportPageError("error", new Error("x"))).toBe("not_recorded");
    answer = async () => new Response("nope", { status: 500 });
    expect(await reportPageError("error", new Error("x"))).toBe("not_recorded");
    answer = async () => new Response("not json", { status: 200 });
    expect(await reportPageError("error", new Error("x"))).toBe("not_recorded");
    answer = async () => Response.json({ recorded: false, reason: "per_minute" });
    expect(await reportPageError("error", new Error("x"))).toBe("not_recorded");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(4);
    expect(unhandled).not.toHaveBeenCalled();
    stop();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("an error raised while a report is put together is not reported", async () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "stack", {
      get() {
        // reading the stack fails and, as a side effect, reports again
        void reportPageError("error", new Error("nested"));
        throw new Error("getter");
      },
    });
    expect(await reportPageError("error", hostile)).toBe("recorded");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.stack).toEqual([]);
  });

  it("the page stops asking after its budget for a window, and asks again in the next one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
      for (let i = 0; i < REPORTS_PER_WINDOW + 20; i++) await reportPageError("error", new Error("again"));
      expect(sent).toHaveLength(REPORTS_PER_WINDOW);
      // still the same window: nothing more
      vi.setSystemTime(Date.now() + REPORT_WINDOW_MS - 1);
      expect(await reportPageError("error", new Error("again"))).toBe("not_recorded");
      expect(sent).toHaveLength(REPORTS_PER_WINDOW);
      // a window that has been open for a long time reports again, however many it has reported before
      for (let round = 1; round <= 3; round++) {
        vi.setSystemTime(Date.now() + REPORT_WINDOW_MS);
        for (let i = 0; i < REPORTS_PER_WINDOW + 5; i++) await reportPageError("error", new Error("again"));
        expect(sent).toHaveLength(REPORTS_PER_WINDOW * (round + 1));
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("with no budget left the thrown value is not looked at", async () => {
    for (let i = 0; i < REPORTS_PER_WINDOW; i++) await reportPageError("error", new Error("again"));
    let read = 0;
    const watched = Object.create(Error.prototype, {
      name: {
        get: () => {
          read += 1;
          return "Error";
        },
      },
      stack: {
        get: () => {
          read += 1;
          return "";
        },
      },
    }) as Error;
    expect(await reportPageError("error", watched)).toBe("not_recorded");
    expect(read).toBe(0);
    expect(sent).toHaveLength(REPORTS_PER_WINDOW);
  });

  it("a window error event that carries no error — a cross-origin script's, a ResizeObserver notice — is not reported and costs nothing", async () => {
    const stop = installPageErrorReporting();
    for (let i = 0; i < REPORTS_PER_WINDOW + 5; i++) {
      window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
      window.dispatchEvent(
        new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications.", error: null })
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(0);
    // the budget is untouched: a real error is still reported, and so is a thrown value that is not an Error
    window.dispatchEvent(new ErrorEvent("error", { error: new RangeError("x") }));
    window.dispatchEvent(new ErrorEvent("error", { error: "a thrown string" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.body.name)).toEqual(["RangeError", "NonError"]);
    stop();
  });

  it("window errors and unhandled rejections are reported by kind; after stopping, nothing is", async () => {
    notePane("mail");
    const stop = installPageErrorReporting();
    window.dispatchEvent(new ErrorEvent("error", { error: new RangeError(SECRET), message: SECRET }));
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new SyntaxError(SECRET);
    window.dispatchEvent(rejection);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.body)).toEqual([
      { kind: "error", name: "RangeError", stack: expect.any(Array), pane: "mail" },
      { kind: "unhandledrejection", name: "SyntaxError", stack: expect.any(Array), pane: "mail" },
    ]);
    expect(JSON.stringify(sent.map((s) => s.body))).not.toContain("secret");
    stop();
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("later") }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(2);
  });
});

describe("the top-level boundary", () => {
  function Page(): never {
    throw new TypeError(`render failed with ${SECRET}`);
  }
  const status = (container: HTMLElement) =>
    container.querySelector('[data-ui="page-error-status"]') as HTMLElement;
  /** The sentence about the log that is shown; the others are in the page only to hold its place. */
  const shown = (container: HTMLElement): string[] =>
    [...status(container).querySelectorAll("[data-variant]")]
      .filter((el) => el.getAttribute("aria-hidden") !== "true")
      .map((el) => el.textContent ?? "");
  beforeEach(() => {
    // React prints the caught error; keep the test output readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("shows the notice in place of the page: the class name and the pane, not the message; Reload reloads the whole page", async () => {
    notePane("write");
    const reload = vi.fn();
    const { container } = render(
      <PageErrorBoundary reload={reload}>
        <Page />
      </PageErrorBoundary>
    );
    const notice = container.querySelector('[data-ui="page-error"]') as HTMLElement;
    expect(notice).not.toBeNull();
    expect(notice.getAttribute("role")).toBe("alert");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("页面出错了");
    expect(container.querySelector('[data-ui="page-error-name"]')?.textContent).toBe("TypeError");
    expect(container.querySelector('[data-ui="page-error-pane"]')?.textContent).toBe("write");
    expect(notice.textContent).not.toContain("secret");
    expect(notice.textContent).not.toContain("render failed");
    // no desktop-only control, and nothing empty in its place
    expect(container.querySelector('[data-ui="page-error-show-logs"]')).toBeNull();
    expect(notice.querySelectorAll("button")).toHaveLength(1);

    // the render error is reported once, as a render error, cut down
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toMatchObject({ kind: "render", name: "TypeError", pane: "write" });
    expect(String(sent[0]?.init.body)).not.toContain("secret");
    // … and only once the server has said so does the notice say it is in the log
    await waitFor(() => expect(shown(container)).toEqual(["错误已记入日志，记录里没有你的内容。"]));
    // the two sentences are two elements: no space is put between them in code
    expect(container.querySelector('[data-ui="page-error-hint"]')?.textContent).toBe("重新加载通常可以继续工作。");
    expect(notice.textContent).not.toMatch(/。\s/);

    // a text button: no icon in it; the keyboard is on it as soon as the notice is there
    const button = screen.getByRole("button", { name: "重新加载" });
    expect(button.getAttribute("data-ui")).toBe("page-error-reload");
    expect(button.className).toContain("primary");
    expect(button.querySelector("svg")).toBeNull();
    expect(button.textContent).toBe("重新加载");
    expect(document.activeElement).toBe(button);

    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(reload).toHaveBeenCalledTimes(1);
    // the page itself is not mounted again: what brings it back is the reload
    expect(container.querySelector('[data-ui="page-error"]')).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("without a reload of its own it reloads the window's location", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(
      <PageErrorBoundary>
        <Page />
      </PageErrorBoundary>
    );
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("says so when the error did not reach the log; before the server has answered it says neither, and the sentence's place is held", async () => {
    let release: (response: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => (release = resolve));
    const { container } = render(
      <PageErrorBoundary reload={() => {}}>
        <Page />
      </PageErrorBoundary>
    );
    const structure = (): string =>
      [...container.querySelectorAll('[data-ui="page-error"] *')].map((el) => `${el.tagName}.${el.className}`).join(" ");
    expect(status(container).getAttribute("data-logged")).toBe("pending");
    expect(shown(container)).toEqual([]);
    // both sentences are laid out from the first frame, hidden: the answer changes which one shows, not the layout
    expect([...status(container).querySelectorAll("[data-variant]")].map((el) => el.getAttribute("data-variant"))).toEqual([
      "recorded",
      "not_recorded",
    ]);
    expect(container.querySelector('[data-ui="page-error-hint"]')?.textContent).toBe("重新加载通常可以继续工作。");
    const before = structure();
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(async () => {
      release(Response.json({ recorded: false, reason: "per_minute" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(status(container).getAttribute("data-logged")).toBe("not_recorded"));
    expect(shown(container)).toEqual(["这次错误没有记入日志。"]);
    expect(container.querySelector('[data-ui="page-error-hint"]')?.textContent).toBe("重新加载通常可以继续工作。");
    expect(structure()).toBe(before);
  });

  it("the copy follows the language", async () => {
    await i18n.changeLanguage("en");
    const { container } = render(
      <PageErrorBoundary reload={() => {}}>
        <Page />
      </PageErrorBoundary>
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("The page hit an error");
    expect(screen.getByRole("button", { name: "Reload" })).not.toBeNull();
    await waitFor(() =>
      expect(shown(container)).toEqual(["The error was written to the log, which contains none of your content."])
    );
    expect(container.querySelector('[data-ui="page-error-hint"]')?.textContent).toBe(
      "Reloading usually lets you continue."
    );
  });
});
