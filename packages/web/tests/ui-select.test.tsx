import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, Select, type SelectOption } from "../src/ui";
import { selectList, selectRows, selectShown, selectTrigger } from "./select-helpers";

afterEach(cleanup);

const FRUIT: SelectOption[] = [
  { value: "apple", label: "Apple" },
  { value: "apricot", label: "Apricot" },
  { value: "banana", label: "Banana", disabled: true },
  { value: "cherry", label: "Cherry" },
  { value: "blue berry", label: "Blue berry" },
  { value: "blue sky", label: "Blue sky" },
];

function Harness({ initial = "apple", options = FRUIT, onChange, disabled, id }: { initial?: string; options?: SelectOption[]; onChange?: (v: string) => void; disabled?: boolean; id?: string }) {
  const [value, setValue] = useState(initial);
  return <Select id={id} data-ui="fruit" aria-label="Fruit" value={value} disabled={disabled} options={options} onChange={(next) => { onChange?.(next); setValue(next); }} />;
}
const setup = (props: Parameters<typeof Harness>[0] = {}) => {
  const view = render(<Harness {...props} />);
  const root = view.container.querySelector<HTMLElement>('[data-ui="fruit"]')!;
  return { root, trigger: selectTrigger(root), list: selectList(root) };
};
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(el, { key: k, ...init });
const active = (list: HTMLElement) => list.querySelector<HTMLElement>(`#${list.getAttribute("aria-activedescendant")}`)?.textContent;

describe("Select aria", () => {
  it("is a combobox button naming a listbox of options, with the data-ui on the wrapper", () => {
    const { root, trigger, list } = setup();
    expect(root.getAttribute("data-ui")).toBe("fruit");
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-label")).toBe("Fruit");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe(list.id);
    expect(list.getAttribute("role")).toBe("listbox");
    expect(list.getAttribute("aria-label")).toBe("Fruit");
    expect(selectShown(root)).toBe("Apple");
  });

  it("marks the selected and the disabled options and points aria-activedescendant at the active one", () => {
    const { root, trigger, list } = setup({ initial: "cherry" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const rows = selectRows(root);
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "false", "false", "true", "false", "false"]);
    expect(rows[2].getAttribute("aria-disabled")).toBe("true");
    expect(rows[0].hasAttribute("aria-disabled")).toBe(false);
    expect(active(list)).toBe("Cherry");
    expect(document.activeElement).toBe(list);
  });

  it("lists grouped options under a heading each (role group named by the heading)", () => {
    const options: SelectOption[] = [{ value: "", label: "None" }, { value: "a", label: "A", group: "First" }, { value: "b", label: "B", group: "First" }, { value: "c", label: "C", group: "Second" }];
    const { root, trigger } = setup({ initial: "", options });
    fireEvent.click(trigger);
    const groups = [...root.querySelectorAll<HTMLElement>('[role="group"]')];
    expect(groups.map((g) => g.querySelector(".ui-select-group")!.textContent)).toEqual(["First", "Second"]);
    for (const group of groups) expect(group.getAttribute("aria-labelledby")).toBe(group.querySelector(".ui-select-group")!.id);
    expect(groups.map((g) => g.querySelectorAll('[role="option"]').length)).toEqual([2, 1]);
    expect(root.querySelectorAll('[role="option"]')).toHaveLength(4);
  });
});

describe("Select value and choice", () => {
  it("is controlled: shows the given value, calls onChange with the chosen value, and not for the same value", () => {
    const onChange = vi.fn();
    const { root, trigger } = setup({ onChange });
    fireEvent.click(trigger);
    fireEvent.click(selectRows(root)[3]);
    expect(onChange).toHaveBeenCalledWith("cherry");
    expect(selectShown(root)).toBe("Cherry");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    fireEvent.click(selectRows(root)[3]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps a click in the list from reaching an enclosing <label>'s control (the label would re-open the list)", () => {
    const view = render(<label htmlFor="fruit-id">Fruit<Harness id="fruit-id" /></label>);
    const root = view.container.querySelector<HTMLElement>('[data-ui="fruit"]')!;
    fireEvent.click(selectTrigger(root));
    expect(fireEvent.click(selectRows(root)[1])).toBe(false); // default prevented: no label activation
    expect(selectShown(root)).toBe("Apricot");
    expect(selectTrigger(root).getAttribute("aria-expanded")).toBe("false");
  });

  it("does not change on a disabled option and keeps the list open", () => {
    const onChange = vi.fn();
    const { root, trigger } = setup({ onChange });
    fireEvent.click(trigger);
    fireEvent.click(selectRows(root)[2]);
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows the placeholder while the value matches no option, and a disabled selected option's label", () => {
    const view = render(<Select aria-label="X" value="" placeholder="Pick one" options={[{ value: "a", label: "A" }]} onChange={() => {}} />);
    expect(view.container.querySelector(".ui-select-value")!.textContent).toBe("Pick one");
    view.rerender(<Select aria-label="X" value="" options={[{ value: "", label: "Choose…", disabled: true }, { value: "a", label: "A" }]} onChange={() => {}} />);
    expect(view.container.querySelector(".ui-select-value")!.textContent).toBe("Choose…");
  });

  it("can be disabled: the trigger is disabled and the list does not open; disabling while open closes it", () => {
    const onChange = vi.fn();
    const { root, trigger } = setup({ disabled: true, onChange });
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    key(trigger, "ArrowDown");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    cleanup();
    const view = render(<Select aria-label="X" value="a" options={FRUIT} onChange={() => {}} />);
    fireEvent.click(view.getByRole("combobox"));
    expect(view.getByRole("combobox").getAttribute("aria-expanded")).toBe("true");
    view.rerender(<Select aria-label="X" value="a" disabled options={FRUIT} onChange={() => {}} />);
    expect(view.getByRole("combobox").getAttribute("aria-expanded")).toBe("false");
    expect(root).toBeTruthy();
  });

  it("passes id, title and className through, and keeps a rows title", () => {
    const view = render(<Select id="own-id" title="Trigger tip" className="mine" aria-label="X" value="a" options={[{ value: "a", label: "A", title: "Row tip" }]} onChange={() => {}} />);
    expect(view.container.querySelector("button")!.id).toBe("own-id");
    expect(view.container.querySelector("button")!.title).toBe("Trigger tip");
    expect(view.container.querySelector(".ui-select")!.classList.contains("mine")).toBe(true);
    fireEvent.click(view.getByRole("combobox"));
    expect(view.container.querySelector('[role="option"]')!.getAttribute("title")).toBe("Row tip");
  });
});

describe("Select keyboard", () => {
  it("opens from the trigger with Down, Up, Enter and Space, active on the selected option", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Enter", " "]) {
      cleanup();
      const { trigger, list } = setup({ initial: "cherry" });
      key(trigger, k);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(active(list)).toBe("Cherry");
    }
  });

  it("moves with Up/Down, skipping the disabled option and stopping at the ends; Home/End jump", () => {
    const { list, trigger } = setup();
    key(trigger, "ArrowDown");
    expect(active(list)).toBe("Apple");
    key(list, "ArrowUp");
    expect(active(list)).toBe("Apple");
    key(list, "ArrowDown");
    expect(active(list)).toBe("Apricot");
    key(list, "ArrowDown");
    expect(active(list)).toBe("Cherry");
    key(list, "End");
    expect(active(list)).toBe("Blue sky");
    key(list, "ArrowDown");
    expect(active(list)).toBe("Blue sky");
    key(list, "Home");
    expect(active(list)).toBe("Apple");
    key(list, "PageDown");
    expect(active(list)).toBe("Blue sky");
  });

  it("chooses the active option with Enter or Space, closes, and returns focus to the trigger", () => {
    for (const k of ["Enter", " "]) {
      cleanup();
      const onChange = vi.fn();
      const { trigger, list } = setup({ onChange });
      key(trigger, "ArrowDown");
      key(list, "ArrowDown");
      key(list, k);
      expect(onChange).toHaveBeenCalledWith("apricot");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(trigger);
    }
  });

  it("closes with Escape (focus back on the trigger, event not passed on), and with Tab", () => {
    const outer = vi.fn();
    const view = render(<div onKeyDown={outer}><Harness /></div>);
    const trigger = view.getByRole("combobox");
    const list = view.getByRole("listbox", { hidden: true });
    key(trigger, "ArrowDown");
    key(list, "Escape");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(outer).toHaveBeenCalledTimes(1); // only the ArrowDown on the trigger; the Escape stopped at the list
    key(trigger, "ArrowDown");
    key(list, "Tab");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when focus leaves to the outside, and keeps the value", () => {
    const onChange = vi.fn();
    const { trigger, list } = setup({ onChange });
    key(trigger, "ArrowDown");
    fireEvent.blur(list, { relatedTarget: document.body });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a click on the trigger toggles the list", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("type-ahead jumps to the next label starting with the typed text, skips disabled rows and never changes the value", () => {
    const onChange = vi.fn();
    const { trigger, list } = setup({ onChange });
    key(trigger, "ArrowDown");
    key(list, "c");
    expect(active(list)).toBe("Cherry");
    key(list, "b"); // "cb" matches nothing; the active row stays
    expect(active(list)).toBe("Cherry");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("type-ahead: a repeated letter cycles, and a space continues the typed text while typing", () => {
    vi.useFakeTimers();
    try {
      const { trigger, list } = setup();
      key(trigger, "ArrowDown");
      key(list, "b");
      expect(active(list)).toBe("Blue berry"); // Banana is disabled
      vi.advanceTimersByTime(700);
      key(list, "b");
      key(list, "b");
      expect(active(list)).toBe("Blue sky"); // "bb": the same letter again moves on to the next "b" row
      vi.advanceTimersByTime(700);
      key(list, "b");
      key(list, "l");
      key(list, "u");
      key(list, "e");
      key(list, " ");
      key(list, "s");
      expect(active(list)).toBe("Blue sky");
      expect(trigger.getAttribute("aria-expanded")).toBe("true"); // the space did not choose
    } finally {
      vi.useRealTimers();
    }
  });

  it("a letter on the closed trigger opens the list at the match without changing the value", () => {
    const onChange = vi.fn();
    const { root, trigger, list } = setup({ onChange });
    key(trigger, "c");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(active(list)).toBe("Cherry");
    expect(selectShown(root)).toBe("Apple");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("pointer movement makes a row active; a disabled row never becomes active", () => {
    const { root, trigger, list } = setup();
    key(trigger, "ArrowDown");
    fireEvent.pointerMove(selectRows(root)[3]);
    expect(active(list)).toBe("Cherry");
    fireEvent.pointerMove(selectRows(root)[2]);
    expect(active(list)).toBe("Cherry");
  });
});

describe("Select top layer", () => {
  it("is a manual popover shown while open and hidden otherwise (placement is checked in a real browser)", () => {
    const shown: string[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const had = { show: proto.showPopover, hide: proto.hidePopover };
    proto.showPopover = function (this: HTMLElement) { shown.push("show"); };
    proto.hidePopover = function (this: HTMLElement) { shown.push("hide"); };
    try {
      const { trigger, list } = setup();
      expect(list.getAttribute("popover")).toBe("manual");
      expect(list.hidden).toBe(true);
      fireEvent.click(trigger);
      expect(list.hidden).toBe(false);
      expect(shown).toEqual(["show"]);
      fireEvent.click(trigger);
      expect(list.hidden).toBe(true);
      expect(shown).toEqual(["show", "hide"]);
    } finally {
      proto.showPopover = had.show;
      proto.hidePopover = had.hide;
    }
  });
});

describe("Select inside a Dialog", () => {
  it("Escape in the open list closes only the list; with the list closed it reaches the dialog", () => {
    const onClose = vi.fn();
    const view = render(<Dialog title="T" closeLabel="Close" onClose={onClose}><Harness /></Dialog>);
    const trigger = view.getByRole("combobox");
    const list = view.getByRole("listbox", { hidden: true });
    key(trigger, "ArrowDown");
    key(list, "Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    key(trigger, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab in the open list still goes through the dialog's focus trap: on to the next control, or round to the first at the end", () => {
    const view = render(<Dialog title="T" closeLabel="Close" onClose={() => {}}><Harness /><button type="button">After</button></Dialog>);
    const trigger = view.getByRole("combobox");
    const list = view.getByRole("listbox", { hidden: true });
    key(trigger, "ArrowDown");
    expect(fireEvent.keyDown(list, { key: "Tab" })).toBe(true); // not the last control: the trap leaves Tab to the browser
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    // as the last focusable control the trap wraps to the first one, as it does from a plain button
    cleanup();
    const last = render(<Dialog title="T" closeLabel="Close" onClose={() => {}}><Harness /></Dialog>);
    const t2 = last.getByRole("combobox");
    key(t2, "ArrowDown");
    expect(fireEvent.keyDown(last.getByRole("listbox", { hidden: true }), { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(last.getByRole("button", { name: "Close" }));
  });
});

describe("Select closing", () => {
  it("a click on the trigger while open closes the list and leaves focus on the trigger", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a pointerdown outside the control, not on one inside the list or on the trigger", () => {
    const { root, trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.pointerDown(selectRows(root)[0]);
    fireEvent.pointerDown(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("unmounting with the list open hides the popover and stops following the trigger", () => {
    const calls: string[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const had = { show: proto.showPopover, hide: proto.hidePopover };
    proto.showPopover = () => { calls.push("show"); };
    proto.hidePopover = () => { calls.push("hide"); };
    const observers: { disconnected: boolean }[] = [];
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { rec = { disconnected: false }; constructor() { observers.push(this.rec); } observe() {} unobserve() {} disconnect() { this.rec.disconnected = true; } } as unknown as typeof ResizeObserver;
    try {
      const view = render(<Harness />);
      fireEvent.click(selectTrigger(view.container.querySelector('[data-ui="fruit"]')!));
      expect(calls).toEqual(["show"]);
      view.unmount();
      expect(calls).toEqual(["show", "hide"]);
      expect(observers.every((o) => o.disconnected)).toBe(true); // autoUpdate's observers are gone
    } finally {
      proto.showPopover = had.show;
      proto.hidePopover = had.hide;
      globalThis.ResizeObserver = RO;
    }
  });
});

describe("Select rows", () => {
  it("builds rows only while open, and moving the active row re-renders only the rows that change", () => {
    const renders = vi.fn();
    const options = Array.from({ length: 200 }, (_, i) => ({ value: `v${i}`, label: `Item ${i}` }));
    const Counting = () => { const [v, setV] = useState("v0"); renders(); return <Select data-ui="fruit" aria-label="F" value={v} options={options.map((o) => ({ ...o }))} onChange={setV} />; };
    const view = render(<Counting />);
    const root = view.container.querySelector<HTMLElement>('[data-ui="fruit"]')!;
    expect(selectRows(root)).toHaveLength(0);
    fireEvent.click(selectTrigger(root));
    expect(selectRows(root)).toHaveLength(200);
    const rows = selectRows(root);
    const before = rows.map((r) => r.outerHTML);
    key(selectList(root), "ArrowDown");
    const after = selectRows(root).map((r) => r.outerHTML);
    expect(after.filter((html, i) => html !== before[i])).toHaveLength(2); // the old and the new active row
    expect(selectRows(root)[5]).toBe(rows[5]); // untouched rows keep their DOM nodes
  });

  it("shows nothing for a value that matches no option, merges adjacent same-name groups and omits an empty group", () => {
    const options: SelectOption[] = [{ value: "a", label: "A", group: "G" }, { value: "b", label: "B", group: "G" }, { value: "c", label: "C" }];
    const view = render(<Select data-ui="fruit" aria-label="F" value="zzz" options={options} onChange={() => {}} />);
    const root = view.container.querySelector<HTMLElement>('[data-ui="fruit"]')!;
    expect(selectShown(root)).toBe("");
    fireEvent.click(selectTrigger(root));
    expect(root.querySelectorAll('[role="group"]')).toHaveLength(1);
  });
});
