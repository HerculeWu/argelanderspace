import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type SelectOption = {
  value: string;
  label: string;
  /** Options with the same `group` that follow each other are listed under one heading (what `<optgroup>` did). */
  group?: string;
  disabled?: boolean;
  /** Native tooltip of the row in the list. */
  title?: string;
};

export interface SelectProps {
  value: string;
  options: SelectOption[];
  /** Called with the chosen option's value; not called when the already selected option is chosen again. */
  onChange: (value: string) => void;
  /** Names both the trigger (`combobox`) and the list (`listbox`). */
  "aria-label": string;
  "data-ui"?: string;
  id?: string;
  /** Tooltip of the trigger. */
  title?: string;
  className?: string;
  disabled?: boolean;
  /** `field`: a bordered form control (30/32/36 high with the density). `inline`: the compact borderless Copilot style. */
  variant?: "field" | "inline";
  /** Shown in the trigger while `value` matches no option. */
  placeholder?: string;
}

// React 18 types do not know the `popover` attribute yet; it is passed through to the DOM as written.
const POPOVER_MANUAL = { popover: "manual" } as object;
const TYPEAHEAD_MS = 600;

const Chevron = () => (
  <svg className="ui-select-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);
const Check = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

type RowProps = { id: string; index: number; option: SelectOption; selected: boolean; active: boolean; onHover: (index: number) => void; onPick: (index: number) => void };
/** One option row. Memoised, so moving the active row re-renders only the two rows that change (the lists can hold ~1000 rows). */
const Row = memo(function Row({ id, index, option, selected, active, onHover, onPick }: RowProps) {
  return (
    <div id={id} role="option" tabIndex={-1} aria-selected={selected} aria-disabled={option.disabled || undefined}
      className="ui-select-option" data-value={option.value} data-active={active || undefined} data-selected={selected || undefined}
      title={option.title}
      onPointerMove={() => { if (!option.disabled) onHover(index); }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(index)}>
      <span className="ui-select-check" aria-hidden="true">{selected && <Check />}</span>
      <span className="ui-select-label">{option.label}</span>
    </div>
  );
}, (a, b) => a.id === b.id && a.index === b.index && a.selected === b.selected && a.active === b.active && a.onHover === b.onHover && a.onPick === b.onPick
  && a.option.value === b.option.value && a.option.label === b.option.label && a.option.disabled === b.option.disabled && a.option.title === b.option.title);

/**
 * The listbox that replaces the native `<select>`: a `combobox` button plus a `popover="manual"` list, so the list
 * sits in the top layer (no ancestor's `overflow` clips it) and is placed with floating-ui — below the trigger,
 * flipped above and shifted inside the window when it does not fit, height capped to the room left, following
 * scroll and resize. While open, focus is in the list and the active row is `aria-activedescendant`.
 * Keys: Up/Down, Home/End (and PageUp/PageDown), type-ahead (a space continues the typed text while it is
 * being typed), Enter/Space choose, Escape closes and returns to the trigger, Tab closes, a click outside closes;
 * disabled rows are skipped. Closed, a letter only opens the list at the match — it never changes the value.
 */
export function Select({ value, options, onChange, id, title, className, disabled, variant = "field", placeholder, ...rest }: SelectProps) {
  const label = rest["aria-label"];
  const uid = useId().replace(/:/g, "");
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = useRef({ text: "", at: 0 });
  const activeRef = useRef(-1);
  const reveal = useRef(false);
  activeRef.current = active;
  const selected = options.findIndex((o) => o.value === value);
  const enabled = useMemo(() => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0), [options]);
  const optId = (i: number) => `${uid}-o${i}`;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);
  const show = (at?: number) => {
    if (disabled) return;
    setActive(at ?? (selected >= 0 && !options[selected].disabled ? selected : (enabled[0] ?? -1)));
    setOpen(true);
  };
  const commit = (i: number) => {
    const option = options[i];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close(true);
  };
  // Stable handlers for the memoised rows (they always see the latest props through the ref).
  const latest = useRef({ commit, active: -1 });
  latest.current = { commit, active };
  const pick = useCallback((i: number) => latest.current.commit(i), []);
  const hover = useCallback((i: number) => { if (latest.current.active !== i) setActive(i); }, []);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  useLayoutEffect(() => {
    const pop = list.current;
    const anchor = trigger.current;
    if (!pop || !anchor || !open) return;
    try { pop.showPopover?.(); } catch { /* already open, or not connected */ }
    pop.focus({ preventScroll: true });
    reveal.current = true;
    const place = () => {
      void computePosition(anchor, pop, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [
          offset(4),
          flip({ padding: 8, fallbackStrategy: "bestFit" }),
          shift({ padding: 8 }),
          size({
            padding: 8,
            apply({ availableHeight, rects, elements }) {
              const style = elements.floating.style;
              style.maxHeight = `${Math.max(96, Math.min(320, availableHeight))}px`;
              style.minWidth = `${rects.reference.width}px`;
            },
          }),
        ],
      }).then(({ x, y }) => {
        pop.style.left = `${x}px`;
        pop.style.top = `${y}px`;
        // The first placement caps the height, so only now can the active row be scrolled into view.
        if (reveal.current) { reveal.current = false; scrollToActive(); }
      });
    };
    const stop = autoUpdate(anchor, pop, place);
    // A press anywhere outside closes the list, whether or not the browser would move focus for it (Safari does not
    // focus a pressed button, a press on plain page background blurs to nothing).
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !wrap.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      stop();
      try { pop.hidePopover?.(); } catch { /* already hidden */ }
    };
  }, [open]);

  const scrollToActive = () => list.current?.querySelector(`#${optId(activeRef.current)}`)?.scrollIntoView?.({ block: "nearest" });
  useEffect(() => {
    if (open && active >= 0) scrollToActive();
  }, [open, active]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = (from: number, direction: 1 | -1) => {
    const at = enabled.indexOf(from);
    if (at < 0) return direction > 0 ? enabled[0] : enabled[enabled.length - 1];
    return enabled[Math.min(enabled.length - 1, Math.max(0, at + direction))];
  };
  /** The row the typed text selects, or undefined. The same letter repeated cycles through the rows starting with it. */
  const typeahead = (key: string, from: number) => {
    const now = Date.now();
    const buffer = typed.current;
    if (now - buffer.at > TYPEAHEAD_MS) buffer.text = "";
    buffer.at = now;
    buffer.text += key.toLowerCase();
    const repeated = buffer.text.length > 1 && [...buffer.text].every((c) => c === buffer.text[0]);
    const needle = repeated ? buffer.text[0] : buffer.text;
    const order = repeated
      ? [...enabled.filter((i) => i > from), ...enabled.filter((i) => i <= from)]
      : [...enabled.filter((i) => i >= from), ...enabled.filter((i) => i < from)];
    return order.find((i) => options[i].label.toLowerCase().startsWith(needle));
  };
  const printable = (e: KeyboardEvent) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

  const onTriggerKey = (e: KeyboardEvent) => {
    if (disabled) return;
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      show();
    } else if (printable(e)) {
      e.preventDefault();
      show(typeahead(e.key, selected));
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    const key = e.key;
    if (key === "ArrowDown") { e.preventDefault(); setActive(step(active, 1)); }
    else if (key === "ArrowUp") { e.preventDefault(); setActive(step(active, -1)); }
    else if (key === "Home" || key === "PageUp") { e.preventDefault(); setActive(enabled[0]); }
    else if (key === "End" || key === "PageDown") { e.preventDefault(); setActive(enabled[enabled.length - 1]); }
    else if (key === " " && typed.current.text && Date.now() - typed.current.at <= TYPEAHEAD_MS) {
      e.preventDefault();
      const hit = typeahead(key, active);
      if (hit !== undefined) setActive(hit);
    }
    else if (key === "Enter" || key === " ") { e.preventDefault(); commit(active); }
    else if (key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    // Focus goes back to the trigger first, so the browser's Tab moves on from where the select is.
    // (inside a Dialog the focus trap may already have moved focus on and cancelled the key: then only close)
    else if (key === "Tab") close(!e.defaultPrevented);
    else if (printable(e)) {
      e.preventDefault();
      const hit = typeahead(key, active);
      if (hit !== undefined) setActive(hit);
    }
  };

  const current = options[selected];
  const rows: ReactNode[] = [];
  if (open) {
    const row = (k: number) => (
      <Row key={k} id={optId(k)} index={k} option={options[k]} selected={k === selected} active={k === active} onHover={hover} onPick={pick} />
    );
    for (let i = 0; i < options.length; ) {
      const group = options[i].group;
      let end = i + 1;
      if (group !== undefined) while (end < options.length && options[end].group === group) end++;
      const items: ReactNode[] = [];
      for (let k = i; k < end; k++) items.push(row(k));
      rows.push(group === undefined ? items : (
        <div key={`g${i}`} role="group" aria-labelledby={`${uid}-g${i}`}>
          <div id={`${uid}-g${i}`} className="ui-select-group" role="presentation">{group}</div>
          {items}
        </div>
      ));
      i = end;
    }
  }

  return (
    <span ref={wrap} className={`ui-select ${variant}${className ? ` ${className}` : ""}`} data-ui={rest["data-ui"]} data-open={open || undefined}>
      <button ref={trigger} id={id} type="button" className="ui-select-trigger" role="combobox" aria-haspopup="listbox"
        aria-expanded={open} aria-controls={`${uid}-list`} aria-label={label} title={title} disabled={disabled}
        onMouseDown={(e) => { if (open) e.preventDefault(); }}
        onClick={() => (open ? close(true) : show())} onKeyDown={onTriggerKey}>
        <span className="ui-select-value" data-placeholder={!current || undefined}>{current?.label ?? placeholder ?? ""}</span>
        <Chevron />
      </button>
      <div ref={list} id={`${uid}-list`} {...POPOVER_MANUAL} className="ui-select-list" role="listbox" tabIndex={-1}
        aria-label={label} aria-activedescendant={open && active >= 0 ? optId(active) : undefined} hidden={!open}
        onKeyDown={onListKey}
        // The list is inside the caller's <label> more often than not: a click in it must not be forwarded to the trigger.
        onClick={(e) => e.preventDefault()}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (!trigger.current?.contains(next) && !list.current?.contains(next)) setOpen(false);
        }}>
        {rows}
      </div>
    </span>
  );
}
