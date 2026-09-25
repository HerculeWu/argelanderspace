import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PdfHighlightColorPicker } from "../src/doc/PdfHighlightColorPicker";
import i18n from "../src/i18n";

describe("PDF highlight color picker", () => {
  it("offers nine accessible circular preset colors without a native color input", async () => {
    await i18n.changeLanguage("zh-CN");
    const onChange = vi.fn();
    render(<PdfHighlightColorPicker value="#ffd228" onChange={onChange} ui="pdf-highlight-color-test" />);
    fireEvent.click(screen.getByRole("button", { name: "高亮颜色" }));
    const swatches = screen.getAllByRole("button").filter((button) => button.getAttribute("data-ui") === "pdf-highlight-color-test-swatch");
    expect(swatches).toHaveLength(9);
    expect(swatches.map((button) => button.getAttribute("data-ui-key"))).toEqual([
      "#ffd228", "#ef8e27", "#df5252", "#d457a9", "#805bbb", "#387bd1", "#22a6b9", "#40a25b", "#7e8796",
    ]);
    expect(document.querySelector('input[type="color"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "蓝色" }));
    expect(onChange).toHaveBeenCalledWith("#387bd1");
  });
});
