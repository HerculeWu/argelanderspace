import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionButton } from "../src/ui/ActionButton";
import { getConfiguredIcon, parseIconSvg } from "../src/ui/icon-resource";
import icons from "../src/ui/icons.json";
import i18n from "../src/i18n";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  void i18n.changeLanguage("zh-CN");
});

describe("ActionButton", () => {
  it("keeps icon mode icon-only with a localized accessible name and tooltip", async () => {
    const { container, rerender } = render(<ActionButton mode="icon" label="Open settings" iconName="sliders-horizontal" data-ui="open-tweaks" />);
    const button = screen.getByRole("button", { name: "Open settings" });
    expect(button.querySelector("svg")?.getAttribute("class")).toBe("ico-sm");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.textContent).toBe("");
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Open settings");
    await i18n.changeLanguage("en");
    rerender(<ActionButton mode="icon" label="Settings" iconName="sliders-horizontal" data-ui="open-tweaks" />);
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("data-ui")).toBe("open-tweaks");
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Settings");
  });

  it("keeps text mode text-only and supports tooltip, disabled, busy and action behavior", () => {
    const onClick = vi.fn();
    const { container, rerender } = render(<ActionButton mode="text" label="Save draft" tooltip="Save changes" onClick={onClick}>Save</ActionButton>);
    const button = screen.getByRole("button", { name: "Save draft" });
    expect(button.textContent).toBe("Save");
    expect(button.querySelector("svg")).toBeNull();
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Save changes");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<ActionButton mode="text" label="Save draft" tooltip="Save changes" disabled>Save</ActionButton>);
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("exposes busy and disabled state without putting text beside the icon", () => {
    render(<ActionButton mode="icon" label="Save" iconName="sun" data-ui="toggle-theme" busy />);
    const button = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("");
  });

  it("preserves bespoke control styling without injecting the generic button surface", () => {
    const { rerender } = render(<ActionButton mode="icon" iconName="x" label="Close pane" tooltip="Close pane" unstyled className="pane-h-btn" data-ui="close-pane" />);
    const icon = screen.getByRole("button", { name: "Close pane" });
    expect(icon.className).toBe("pane-h-btn");
    expect(icon.closest('.ui-tooltip-anchor')?.querySelector('[role="tooltip"]')?.textContent).toBe("Close pane");
    rerender(<ActionButton mode="text" label="Select view" tooltip="Select view" unstyled className="pane-tool" data-ui="choose-pane-view">Library</ActionButton>);
    const text = screen.getByRole("button", { name: "Select view" });
    expect(text.className).toBe("pane-tool");
    expect(text.textContent).toBe("Library");
    rerender(<ActionButton mode="icon" iconName="x" label="Busy" unstyled className="pane-h-btn" data-ui="close-pane" busy />);
    const busy = screen.getByRole("button", { name: "Busy" }) as HTMLButtonElement;
    expect(busy.className).toBe("pane-h-btn");
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
  });

  it("falls back to visible text instead of an empty icon button when the icon is missing or unsafe", () => {
    const { rerender } = render(<ActionButton mode="icon" label="Delete item" iconName="missing-icon" />);
    expect(screen.getByRole("button", { name: "Delete item" }).textContent).toBe("Delete item");
    rerender(<ActionButton mode="icon" label="Delete item" iconName="unsafe" />);
    expect(screen.getByRole("button", { name: "Delete item" }).textContent).toBe("Delete item");
    rerender(<ActionButton mode="icon" label="Delete item" iconName="missing-icon" unstyled className="btn icon ghost" />);
    const fallback = screen.getByRole("button", { name: "Delete item" });
    expect(fallback.textContent).toBe("Delete item");
    expect(fallback.classList.contains("icon")).toBe(false);
    expect(fallback.style.width).toBe("auto");
  });
});

describe("parseIconSvg", () => {
  it("keeps all shared icon entries language/action neutral and within the safe SVG subset", () => {
    expect(Object.keys(icons)).not.toContain("mode");
    expect(Object.keys(icons)).not.toContain("action");
    for (const [uiId, resource] of Object.entries(icons)) {
      expect(uiId).toMatch(/^[a-z][a-z0-9-]+$/);
      const variants = typeof resource === "string" ? [["single", resource]] : Object.entries(resource);
      for (const [name, source] of variants) {
        expect(typeof source).toBe("string");
        expect(getConfiguredIcon(name, uiId)).not.toBeNull();
      }
    }
    expect(getConfiguredIcon("trash-2", "set-task-status")).toBeNull();
    expect(getConfiguredIcon("refresh-cw", "missing-ui")).toBeNull();
  });

  it("locates every owner-reported icon action by its F12 data-ui, including repeated state variants", () => {
    for (const id of [
      "navigate-view", "undo-pdf-annotation", "redo-pdf-annotation", "navigate-pdf-annotation",
      "edit-pdf-annotation-body", "delete-pdf-annotation", "go-to-pdf-page", "copy-pdf-page-link",
      "fit-pdf-width", "fit-pdf-page", "download-original-pdf", "render-manuscript",
      "export-manuscript", "cancel-task-note", "save-task-note", "set-task-status",
      "delete-task", "gether-doc",
    ]) expect(icons).toHaveProperty(id);
    expect(Object.keys(icons["navigate-view"])).toEqual(["file-text", "library", "pen-line", "telescope"]);
    expect(Object.keys(icons["set-task-status"])).toEqual(["circle", "circle-alert", "circle-check", "circle-dot"]);
  });

  it("accepts a restricted inline SVG and rejects active, external and unsupported content", () => {
    expect(parseIconSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2L8 8"/></svg>')).not.toBeNull();
    const unsafe = [
      '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 24 24"><path onload="alert(1)" d="M2 2"/></svg>',
      '<svg viewBox="0 0 24 24"><image href="https://evil.test/x.svg"/></svg>',
      '<svg viewBox="0 0 24 24"><path fill="url(https://evil.test/#x)" d="M2 2"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 24 24"><text>&x;</text></svg>',
      '<svg viewBox="0 0 24 24"><foreignObject><div>unsafe</div></foreignObject></svg>',
    ];
    for (const svg of unsafe) expect(parseIconSvg(svg)).toBeNull();
  });
});
