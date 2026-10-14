/** The environment report guard (desktop-app ticket 13 revision): the shape and every enum value are checked. */
import { describe, expect, test } from "vitest";
import {
  ENVIRONMENT_TOOLS,
  type EnvironmentReport,
  isEnvironmentReport,
} from "../src/environment-api.js";

function valid(): EnvironmentReport {
  return {
    version: 1,
    platform: "linux",
    texDir: { state: "unset", path: null },
    tools: ENVIRONMENT_TOOLS.map((tool) => ({
      tool,
      found: false,
      source: null,
      path: null,
      version: null,
      affects: [],
    })),
    keychain: { state: "unknown", reason: "no_probe" },
    sandbox: "unavailable",
    writerSandboxTex: { state: "not_applicable", path: null },
  };
}

describe("isEnvironmentReport", () => {
  test("a report of this version passes", () => {
    expect(isEnvironmentReport(valid())).toBe(true);
  });
  test("an unknown value of any enum fails", () => {
    const bad = (change: (r: Record<string, unknown> & EnvironmentReport) => void) => {
      const r = structuredClone(valid()) as Record<string, unknown> & EnvironmentReport;
      change(r);
      return isEnvironmentReport(r);
    };
    expect(bad((r) => ((r.keychain as { reason: string }).reason = "other"))).toBe(false);
    expect(bad((r) => ((r.tools[0] as { source: string | null }).source = "elsewhere"))).toBe(
      false
    );
    expect(bad((r) => ((r.tools[0] as { affects: string[] }).affects = ["teleport"]))).toBe(false);
    expect(bad((r) => ((r.writerSandboxTex as { state: string }).state = "maybe"))).toBe(false);
    expect(bad((r) => ((r as { platform: string }).platform = "plan9"))).toBe(false);
    expect(bad((r) => ((r.tools[0] as { path: unknown }).path = "/usr/bin/latexmk"))).toBe(false);
    expect(bad((r) => delete (r as Partial<EnvironmentReport>).writerSandboxTex)).toBe(false);
  });
});
