import { fireEvent } from "@testing-library/react";

/** Test access to a ui/Select by its wrapper (the element carrying `data-ui`): trigger, list, rows. */
export const selectTrigger = (root: Element) => root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
export const selectList = (root: Element) => root.querySelector<HTMLElement>('[role="listbox"]')!;
export const selectRows = (root: Element) => [...selectList(root).querySelectorAll<HTMLElement>('[role="option"]')];
/** The text the closed Select shows (what a native select showed as its selected option). */
export const selectShown = (root: Element) => root.querySelector(".ui-select-value")!.textContent;
export const selectIsDisabled = (root: Element) => selectTrigger(root).disabled;

export function openSelect(root: Element) {
  if (selectTrigger(root).getAttribute("aria-expanded") !== "true") fireEvent.click(selectTrigger(root));
  return selectList(root);
}
export function closeSelect(root: Element) {
  if (selectTrigger(root).getAttribute("aria-expanded") === "true") fireEvent.keyDown(selectList(root), { key: "Escape" });
}
/** What `[...select.options]` was: the option values (or labels), read from the opened list, then closed again. */
export function selectOptionValues(root: Element) {
  openSelect(root);
  const values = selectRows(root).map((row) => row.dataset.value!);
  closeSelect(root);
  return values;
}
export function selectOptionLabels(root: Element) {
  openSelect(root);
  const labels = selectRows(root).map((row) => row.textContent);
  closeSelect(root);
  return labels;
}
/** What `fireEvent.change(select, { target: { value } })` did: open the list and click that option. */
export function chooseOption(root: Element, value: string) {
  openSelect(root);
  const row = selectRows(root).find((candidate) => candidate.dataset.value === value);
  if (!row) throw new Error(`no option with value ${JSON.stringify(value)}`);
  fireEvent.click(row);
}
/** The grouped rows of the opened list (what `<optgroup>` elements were): heading text and its option labels, then closed again. */
export function selectGroups(root: Element) {
  openSelect(root);
  const groups = [...selectList(root).querySelectorAll<HTMLElement>('[role="group"]')].map((group) => `${group.querySelector(".ui-select-group")!.textContent}:${[...group.querySelectorAll('[role="option"]')].map((o) => o.textContent).join("|")}`);
  closeSelect(root);
  return groups;
}
/** Whether the row with that value is marked unselectable (`aria-disabled`), read from the opened list, then closed again. */
export function selectRowDisabled(root: Element, value: string) {
  openSelect(root);
  const row = selectRows(root).find((candidate) => candidate.dataset.value === value);
  const disabled = row?.getAttribute("aria-disabled") === "true";
  closeSelect(root);
  return disabled;
}
