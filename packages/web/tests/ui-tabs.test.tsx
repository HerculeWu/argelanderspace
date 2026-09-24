import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs } from "../src/ui";

const ITEMS = [
  { value: "info", label: "Info" },
  { value: "abstract", label: "Abstract" },
  { value: "fulltext", label: "Full text" },
] as const;

function TabsHarness() {
  const [value, setValue] = useState<(typeof ITEMS)[number]["value"]>("info");
  return (
    <Tabs
      ariaLabel="Reference content"
      items={ITEMS}
      value={value}
      onValueChange={setValue}
    >
      <p>{`Panel: ${value}`}</p>
    </Tabs>
  );
}

describe("Tabs public interaction", () => {
  afterEach(cleanup);

  it("exposes the selected tab and switches its labelled panel through the public value callback", () => {
    render(<TabsHarness />);

    expect(screen.getByRole("tablist", { name: "Reference content" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Info" }).getAttribute("data-ui-key")).toBe("info");
    expect(screen.getByRole("tab", { name: "Info" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Info" }).textContent).toBe("Panel: info");

    fireEvent.click(screen.getByRole("tab", { name: "Abstract" }));
    expect(screen.getByRole("tab", { name: "Abstract" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Abstract" }).textContent).toBe("Panel: abstract");
    expect(screen.getByRole("tabpanel", { name: "Abstract" }).getAttribute("data-ui-key")).toBe("abstract");
  });

  it("activates and focuses tabs with Arrow, Home, and End keys", () => {
    render(<TabsHarness />);
    const info = screen.getByRole("tab", { name: "Info" });
    info.focus();

    fireEvent.keyDown(info, { key: "ArrowRight" });
    const abstract = screen.getByRole("tab", { name: "Abstract" });
    expect(abstract.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(abstract);

    fireEvent.keyDown(abstract, { key: "End" });
    const fullText = screen.getByRole("tab", { name: "Full text" });
    expect(fullText.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(fullText);

    fireEvent.keyDown(fullText, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Info" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Info" }), { key: "End" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Full text" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Info" }).getAttribute("aria-selected")).toBe("true");
  });
});
