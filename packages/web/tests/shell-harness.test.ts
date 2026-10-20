/**
 * The order in which the Shell tests' fetch stand-in (`shell-harness.tsx`) answers: the settings stand-in first, then
 * the test file's own routes, then the paper list, and 404 for anything else.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeSettings } from "./settings-fake";
import { stubShellFetch } from "./shell-harness";

const get = async (url: string, init?: RequestInit) => {
  const answer = await fetch(url, init);
  return { status: answer.status, ok: answer.ok, body: await answer.json() };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Shell tests' fetch stand-in", () => {
  it("asks the settings stand-in before the file's routes", async () => {
    const settings = fakeSettings({ "ui.language": "en" });
    stubShellFetch({ settings: () => settings, routes: () => ({ ok: true, status: 200, json: async () => "route" }) as Response });
    const answer = await get("/api/settings");
    expect(answer.status).toBe(200);
    expect((answer.body as { values: Record<string, unknown> }).values["ui.language"]).toBe("en");
    expect(settings.gets).toBe(1);
    expect((await get("/api/other")).body).toBe("route");
  });

  it("without a settings stand-in, /api/settings is a URL like any other: 404", async () => {
    stubShellFetch();
    expect(await get("/api/settings")).toEqual({ status: 404, ok: false, body: {} });
  });

  it("asks the file's routes before the paper list; a route that answers nothing (also later) passes the request on", async () => {
    stubShellFetch({
      papers: () => ["d1"],
      routes: (url) => {
        if (url === "/api/a") return { ok: true, status: 200, json: async () => "a" } as Response;
        if (url === "/api/later") return Promise.resolve(undefined);
        return null;
      },
    });
    expect((await get("/api/a")).body).toBe("a");
    expect(await get("/api/papers")).toEqual({ status: 200, ok: true, body: { papers: ["d1"] } });
    expect(await get("/api/later")).toEqual({ status: 404, ok: false, body: {} });
  });

  it("a route can answer /api/papers itself", async () => {
    stubShellFetch({ routes: (url) => (url === "/api/papers" ? ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response) : null) });
    expect(await get("/api/papers")).toEqual({ status: 404, ok: false, body: {} });
  });

  it("answers the paper list with no papers unless given some, and 404 for any other URL", async () => {
    stubShellFetch();
    expect(await get("/api/papers")).toEqual({ status: 200, ok: true, body: { papers: [] } });
    expect(await get("/api/plans")).toEqual({ status: 404, ok: false, body: {} });
  });

  it("reads the settings stand-in at each request (a test may replace it)", async () => {
    let settings = fakeSettings({ "ui.language": "en" });
    stubShellFetch({ settings: () => settings });
    await get("/api/settings");
    settings = fakeSettings({ "ui.language": "zh-CN" });
    expect(((await get("/api/settings")).body as { values: Record<string, unknown> }).values["ui.language"]).toBe("zh-CN");
    expect(settings.gets).toBe(1);
  });
});
