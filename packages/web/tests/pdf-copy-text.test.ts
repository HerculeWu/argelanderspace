import { afterEach, describe, expect, test, vi } from "vitest";
import { copyPlainText } from "../src/doc/copy-text";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PDF selected-text copy", () => {
  test("reports success only when the browser clipboard write resolves", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    expect(await copyPlainText("selected quote")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("selected quote");
  });

  test("reports denied or unavailable clipboard access instead of fake success", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    expect(await copyPlainText("selected quote")).toBe(false);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    expect(await copyPlainText("selected quote")).toBe(false);
  });
});
