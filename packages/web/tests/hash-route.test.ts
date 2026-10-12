/**
 * The route and navigation bus the exploration and the argument graph view share (hash-route.ts): the prefix-parameterised
 * hash route and the bus's choice of target and pending request. The exploration's own exports are covered by
 * explore-state.test.tsx, unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { argumentBus } from "../src/lib/argument-route";
import { exploreBus, exploreUrl, parseExploreHash } from "../src/lib/explore-route";
import { createHashRoute, createRouteBus } from "../src/lib/hash-route";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("createHashRoute", () => {
  const route = createHashRoute("thing");
  it("encodes and decodes the id behind its own prefix only", () => {
    expect(route.url("a/b:c")).toBe("/#thing/a%2Fb%3Ac");
    expect(route.parse("#thing/a%2Fb%3Ac")).toBe("a/b:c");
    expect(route.parse("#other/x")).toBeNull();
    expect(route.parse("#thing/")).toBeNull();
    expect(route.parse("#thing/%E0%A4%A")).toBeNull();
  });
  it("pushes one entry per URL and clears only its own hash", () => {
    const before = window.history.length;
    route.push("x");
    route.push("x");
    expect(window.history.length).toBe(before + 1);
    expect(window.location.hash).toBe("#thing/x");
    route.clear();
    expect(window.location.hash).toBe("");
    expect(window.history.length).toBe(before + 2);
    route.clear();
    expect(window.history.length).toBe(before + 2);
  });
  it("the exploration's names keep their behaviour", () => {
    expect(exploreUrl("2020ApJ...1A")).toBe("/#explore/2020ApJ...1A");
    expect(parseExploreHash("#explore/2020ApJ...1A")).toBe("2020ApJ...1A");
    expect(parseExploreHash("#argument/x")).toBeNull();
  });
});

describe("createRouteBus", () => {
  type T = { name: string; on: boolean };
  const make = () => {
    const opened: string[] = [];
    const bus = createRouteBus<T, { id: string; only?: string }>({
      active: (t) => t.on,
      open: (t, r) => opened.push(`${t.name}:${r.id}`),
      exit: (t) => void (t.on = false),
      accepts: (t, r) => r.only === undefined || r.only === t.name,
    });
    return { bus, opened };
  };
  it("serves the target that has the mode open, else the first", async () => {
    const { bus, opened } = make();
    const a = { name: "a", on: false };
    const b = { name: "b", on: true };
    bus.register(a);
    bus.register(b);
    bus.request({ id: "1" });
    expect(opened).toEqual(["b:1"]);
    b.on = false;
    bus.request({ id: "2" });
    expect(opened).toEqual(["b:1", "a:2"]);
  });
  it("holds a request until a target that accepts it registers, and serves it once", async () => {
    const { bus, opened } = make();
    bus.register({ name: "x", on: false });
    bus.request({ id: "1", only: "y" });
    expect(opened).toEqual([]);
    bus.register({ name: "z", on: false });
    await Promise.resolve();
    expect(opened).toEqual([]);
    bus.register({ name: "y", on: false });
    await Promise.resolve();
    expect(opened).toEqual(["y:1"]);
    bus.register({ name: "late", on: false });
    await Promise.resolve();
    expect(opened).toEqual(["y:1"]);
  });
  it("exit drops a pending request and closes the target that has the mode open", async () => {
    const { bus, opened } = make();
    bus.request({ id: "1" });
    const t = { name: "t", on: true };
    bus.exit();
    bus.register(t);
    await Promise.resolve();
    expect(opened).toEqual([]);
    bus.exit();
    expect(t.on).toBe(false);
  });
});

describe("the two buses over it", () => {
  it("the exploration bus passes the seed as before", async () => {
    const explore = vi.fn();
    const off = exploreBus.register({ isExploring: () => false, explore, exit: vi.fn() });
    exploreBus.request("S1");
    expect(explore).toHaveBeenCalledWith("S1");
    off();
  });
  it("the argument bus serves exactly the pane a request names", () => {
    const calls: string[] = [];
    const target = (paneId: number, open = false) => ({ paneId, isOpen: () => open, workId: () => (open ? "w" : null), open: (w: string, o: { push: boolean }) => calls.push(`${paneId}:${w}:${o.push}`), exit: vi.fn() });
    const offs = [argumentBus.register(target(1, true)), argumentBus.register(target(2))];
    argumentBus.request("w", { push: true, paneId: 2 });
    argumentBus.request("v");
    expect(calls).toEqual(["2:w:true", "1:v:false"]);
    offs.forEach((off) => off());
  });
});
