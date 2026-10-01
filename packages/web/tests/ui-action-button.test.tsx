import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionButton, type ActionButtonProps, type ButtonProps, type IconButtonProps } from "../src/ui";
import { getConfiguredIcon, parseIconSvg } from "../src/ui/icon-resource";
import icons from "../src/ui/icons.json";
import i18n from "../src/i18n";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  void i18n.changeLanguage("zh-CN");
});

describe("ActionButton", () => {
  it("renders the approved PDF pen artwork with its localized tool-toggle state and native activation", () => {
    const activate = vi.fn();
    const { rerender } = render(<ActionButton unstyled mode="icon" iconName="pencil" iconSize="small" data-ui="toggle-pdf-annotation-tools" aria-expanded={false} label="打开标注工具" onClick={activate} />);
    const button = screen.getByRole("button", { name: "打开标注工具" });
    // Approved Dazzle pen-line geometry, not a derived class snapshot.
    expect(button.querySelector("path")?.getAttribute("d")).toBe("M15.4998 5.50067L18.3282 8.3291M13 21H21M3 21.0004L3.04745 20.6683C3.21536 19.4929 3.29932 18.9052 3.49029 18.3565C3.65975 17.8697 3.89124 17.4067 4.17906 16.979C4.50341 16.497 4.92319 16.0772 5.76274 15.2377L17.4107 3.58969C18.1918 2.80865 19.4581 2.80864 20.2392 3.58969C21.0202 4.37074 21.0202 5.63707 20.2392 6.41812L8.37744 18.2798C7.61579 19.0415 7.23497 19.4223 6.8012 19.7252C6.41618 19.994 6.00093 20.2167 5.56398 20.3887C5.07171 20.5824 4.54375 20.6889 3.48793 20.902L3 21.0004Z");
    expect(button.textContent).toBe("");
    fireEvent.click(button);
    expect(activate).toHaveBeenCalledOnce();
    rerender(<ActionButton unstyled mode="icon" iconName="pencil" iconSize="small" data-ui="toggle-pdf-annotation-tools" aria-expanded label="Close annotation tools" disabled onClick={activate} />);
    const expanded = screen.getByRole("button", { name: "Close annotation tools" });
    expect(expanded.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(expanded);
    expect(activate).toHaveBeenCalledOnce();
  });
  it("opts into finite glyph roles while preserving native activation, names and busy protection", () => {
    const activated = vi.fn();
    const { rerender } = render(<ActionButton unstyled mode="icon" appearance="quiet" iconSize="small" label="放大" iconName="plus" data-ui="zoom-in" onClick={activated} />);
    const button = screen.getByRole("button", { name: "放大" });
    expect(button.querySelector("svg")?.classList.contains("ui-icon-size--small")).toBe(true);
    expect(button.classList.contains("ui-action--quiet")).toBe(true);
    expect(button.textContent).toBe("");
    fireEvent.click(button);
    expect(activated).toHaveBeenCalledOnce();
    rerender(<ActionButton unstyled mode="icon" appearance="quiet" iconSize="small" label="Zoom in" iconName="plus" data-ui="zoom-in" busy onClick={activated} />);
    const busy = screen.getByRole("button", { name: "Zoom in" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(busy);
    expect(activated).toHaveBeenCalledOnce();
  });

  it("keeps text and fallback actions readable with opt-in roles, refs and busy semantics", () => {
    const activated = vi.fn();
    const ref = { current: null as HTMLButtonElement | null };
    const { rerender } = render(<ActionButton ref={ref} mode="icon" label="删除" iconName="missing" appearance="secondary" tone="danger" iconSize="navigation" busy onClick={activated} />);
    const fallback = screen.getByRole("button", { name: "删除" });
    expect(ref.current).toBe(fallback);
    expect(fallback.textContent).toBe("删除");
    expect(fallback.querySelector("svg")).toBeNull();
    expect(fallback.style.minWidth).toBe("max-content");
    expect(fallback.classList.contains("ui-action--danger")).toBe(true);
    fireEvent.click(fallback);
    expect(activated).not.toHaveBeenCalled();
    rerender(<ActionButton mode="text" label="Save" appearance="primary" iconSize="regular" onClick={activated}>Save</ActionButton>);
    const text = screen.getByRole("button", { name: "Save" });
    expect(text.textContent).toBe("Save");
    expect(text.querySelector("svg")).toBeNull();
    fireEvent.click(text);
    expect(activated).toHaveBeenCalledOnce();
    rerender(<ActionButton mode="icon" label="Zoom" iconName="plus" data-ui="zoom-in" variant="ghost" iconSize="regular" />);
    const glyphOnly = screen.getByRole("button", { name: "Zoom" });
    expect(glyphOnly.classList.contains("ghost")).toBe(true);
    expect(glyphOnly.classList.contains("ui-action")).toBe(false);
    expect(glyphOnly.querySelector("svg")?.classList.contains("ui-icon-size--regular")).toBe(true);
  });

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

// Public compile-time contract: glyph-only opt-in remains compatible with legacy surfaces.
const glyphOnly: ActionButtonProps = { mode: "icon", label: "Zoom", iconName: "plus", variant: "ghost", iconSize: "small" };
// @ts-expect-error explicit appearance excludes legacy variant
const conflictingAction: ActionButtonProps = { mode: "text", label: "Save", children: "Save", appearance: "primary", variant: "primary" };
// @ts-expect-error same exclusion on the public native button
const conflictingButton: ButtonProps = { appearance: "quiet", variant: "ghost" };
// @ts-expect-error same exclusion on the compatible icon button
const conflictingIcon: IconButtonProps = { label: "Zoom", icon: null, appearance: "quiet", variant: "ghost" };
void [glyphOnly, conflictingAction, conflictingButton, conflictingIcon];
