import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
} from "react";

export interface TabItem<Value extends string = string> {
  value: Value;
  label: ReactNode;
}

export interface TabsProps<Value extends string> {
  ariaLabel: string;
  items: readonly TabItem<Value>[];
  value: Value;
  onValueChange: (value: Value) => void;
  children: ReactNode;
  className?: string;
  panelClassName?: string;
}

/** Controlled tabs with automatic arrow-key activation and a labelled panel. */
export function Tabs<Value extends string>({
  ariaLabel,
  items,
  value,
  onValueChange,
  children,
  className = "",
  panelClassName = "",
}: TabsProps<Value>) {
  const baseId = `tabs-${useId().replace(/:/g, "")}`;
  const tabs = useRef(new Map<Value, HTMLButtonElement>());
  const selectedIndex = Math.max(0, items.findIndex((item) => item.value === value));

  const move = (event: KeyboardEvent<HTMLButtonElement>, nextIndex: number) => {
    event.preventDefault();
    const next = items[nextIndex];
    if (!next) return;
    onValueChange(next.value);
    tabs.current.get(next.value)?.focus();
  };

  return (
    <div className={["ui-tabs-root", className].filter(Boolean).join(" ")} data-ui="tabs">
      <div className="ui-tabs" data-ui="tab-list" role="tablist" aria-label={ariaLabel}>
        {items.map((item, index) => {
          const selectedTab = item.value === value;
          const tabId = `${baseId}-tab-${index}`;
          return (
            <button
              key={item.value}
              data-ui="tab" data-ui-key={item.value}
              ref={(element) => {
                if (element) tabs.current.set(item.value, element);
                else tabs.current.delete(item.value);
              }}
              type="button"
              id={tabId}
              className="ui-tab"
              role="tab"
              aria-selected={selectedTab}
              aria-controls={`${baseId}-panel`}
              tabIndex={selectedTab ? 0 : -1}
              onClick={() => onValueChange(item.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") move(event, (index + 1) % items.length);
                else if (event.key === "ArrowLeft") move(event, (index - 1 + items.length) % items.length);
                else if (event.key === "Home") move(event, 0);
                else if (event.key === "End") move(event, items.length - 1);
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        id={`${baseId}-panel`}
        className={["ui-tab-panel", panelClassName].filter(Boolean).join(" ")}
        data-ui="tab-panel" data-ui-key={value}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${selectedIndex}`}
      >
        {children}
      </div>
    </div>
  );
}
