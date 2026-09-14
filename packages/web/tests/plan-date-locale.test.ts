/**
 * Date localization (Stage 9 M3): fmtDate and the timelineScale month ticks
 * format through Intl in the ACTIVE i18next language — zh-CN by default,
 * English after a tweaks language switch. The afterEach restore keeps the
 * shared i18n instance on the default language for the rest of the suite.
 */

import { afterEach, describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import { fmtDate, timelineScale, type Plan } from "../src/plan/model";

// created→due spans 80 days (≥ 6 weeks), so timelineScale takes the monthly
// branch; the tick at 2026-11-01 is the label under test.
const plan = (created: string, due: string): Plan => ({
  id: "p_00000001",
  name: "p",
  due,
  icon: "target",
  created_at: `${created}T08:00:00.000Z`,
  tasks: [],
});

describe("date localization", () => {
  afterEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("zh-CN (default): numeric-month date and year+month ticks", () => {
    expect(fmtDate("2026-09-14")).toBe("9月14日");
    const s = timelineScale([plan("2026-10-01", "2026-12-20")], "2026-10-15");
    expect(s?.weekly).toBe(false);
    expect(s?.ticks.map((t) => t.label)).toContain("2026年11月");
  });

  it("en: abbreviated-month date and year+month ticks", async () => {
    await i18n.changeLanguage("en");
    expect(fmtDate("2026-09-14")).toBe("Sep 14");
    const s = timelineScale([plan("2026-10-01", "2026-12-20")], "2026-10-15");
    expect(s?.ticks.map((t) => t.label)).toContain("Nov 2026");
  });
});
