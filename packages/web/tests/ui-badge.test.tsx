import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "../src/ui/index.js";

describe("Badge", () => {
  it("renders its public tone prop without replacing the visible state label", () => {
    render(<Badge tone="accent">Main document</Badge>);

    const badge = screen.getByText("Main document");
    expect(badge.tagName).toBe("SPAN");
    expect(badge.className).toContain("ui-badge");
    expect(badge.className).toContain("accent");
  });
});
