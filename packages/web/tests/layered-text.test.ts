/** Short-label wrapping and width estimate (pure): Latin breaks at words, Chinese stays character by character. */
import { describe, expect, it } from "vitest";
import { labelWidth, textUnits, wrapLabel } from "../src/graph/layered/text";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";

/** The wrapping before Latin word breaks existed (fix round A), kept here to pin full-width text. */
function legacyWrap(s: string, max = 9): string[] {
  const WIDE = /[⺀-￿]/;
  const lines: string[] = [];
  const chars = [...s];
  let cur = "";
  let w = 0;
  let i = 0;
  for (; i < chars.length; i++) {
    const cw = WIDE.test(chars[i]!) ? 1 : 0.55;
    if (w + cw > max && cur) {
      lines.push(cur);
      cur = "";
      w = 0;
      if (lines.length === 2) break;
    }
    cur += chars[i];
    w += cw;
  }
  if (lines.length < 2 && cur) lines.push(cur);
  else if (i < chars.length) lines[1] = [...lines[1]!].slice(0, -1).join("") + "…";
  return lines.map((l) => l.trim());
}

const chinese = (g: { arguments: { title: string }[] }) => g.arguments.map((a) => a.title);
const ALL_TITLES = (["clean", "flawed", "large"] as const).flatMap((k) => chinese(ARGUMENT_FIXTURES[k]()));
const PURE_CJK = ALL_TITLES.filter((t) => !/[A-Za-z0-9]/.test(t));

describe("wrapLabel: full-width text", () => {
  it("fixture titles without Latin letters wrap exactly as before, and some of them need two lines", () => {
    expect(PURE_CJK.length).toBeGreaterThan(10);
    for (const t of PURE_CJK) expect(wrapLabel(t)).toEqual(legacyWrap(t));
    expect(PURE_CJK.some((t) => wrapLabel(t).length === 2)).toBe(true);
  });

  it("breaks between any two characters, at most two lines, ellipsis replaces the last character", () => {
    expect(wrapLabel("一二三四五六七八九十甲乙丙丁")).toEqual(legacyWrap("一二三四五六七八九十甲乙丙丁"));
    expect(wrapLabel("一二三四五六七八九十甲乙丙丁")).toEqual(["一二三四五六七八九", "十甲乙丙丁"]);
    expect(wrapLabel("一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑")).toEqual(["一二三四五六七八九", "十甲乙丙丁戊己庚…"]);
    expect(wrapLabel("短")).toEqual(["短"]);
    expect(wrapLabel("")).toEqual([]);
  });
});

describe("wrapLabel: Latin text", () => {
  it("breaks at spaces, never inside a word that fits a line", () => {
    const lines = wrapLabel("Stellar mass function of nearby clusters");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Stellar mass");
    expect(lines[1]!.startsWith("function of")).toBe(true);
    // the first line is the last whole word that fits, not a cut inside "function"
    expect("Stellar mass function".startsWith(lines[0]!)).toBe(true);
    expect(wrapLabel("Binary fraction")).toEqual(["Binary fraction"]);
  });

  it("every line is a run of whole words when each word fits", () => {
    for (const t of ["Proper motions are precise enough", "Convergent point method", "Orbit integration", "Cluster is dissolving", "Tail asymmetry"]) {
      const lines = wrapLabel(t);
      const words = t.split(" ");
      for (const l of lines) for (const w of l.replace(/…$/, "").split(" ")) expect(words).toContain(w);
    }
  });

  it("breaks after a hyphen", () => {
    expect(wrapLabel("Photometric-metallicity")).toEqual(["Photometric-", "metallicity"]);
    expect(wrapLabel("N-body tails")[0]).toBe("N-body tails");
    expect(wrapLabel("Cross-validation of results")).toEqual(["Cross-validation", "of results"]);
    expect(wrapLabel("Metallicity-dependent trends")).toEqual(["Metallicity-", "dependent trends"]);
  });

  it("breaks a single word longer than a line inside the word, within the width", () => {
    const lines = wrapLabel("Spectroscopically");
    expect(lines.length).toBe(2);
    expect(lines.join("")).toBe("Spectroscopically");
    for (const l of lines) expect(textUnits(l)).toBeLessThanOrEqual(9);
    const caps = wrapLabel("WWWWWWWWWWWW MMMM");
    for (const l of caps) expect(textUnits(l)).toBeLessThanOrEqual(9);
  });

  it("ends with an ellipsis that fits when the text is longer than two lines", () => {
    const lines = wrapLabel("Proper motions are precise enough to separate members");
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
    for (const l of lines) expect(textUnits(l)).toBeLessThanOrEqual(9);
    // the ellipsis follows a whole word when it fits
    expect(lines[1]).toMatch(/^[A-Za-z ]+…$/);
  });

  it("mixed Chinese and English breaks at the word boundary and between Chinese characters", () => {
    const lines = wrapLabel("Gaia DR3 的自行精度足够");
    expect(lines[0]!.startsWith("Gaia DR3")).toBe(true);
    for (const l of lines) expect(textUnits(l)).toBeLessThanOrEqual(9);
    expect(wrapLabel("N 体模型预测 S 形潮汐尾")[0]!.startsWith("N 体")).toBe(true);
  });

  it("is deterministic", () => {
    for (const t of ["A b c d e f g h i j k l m n o p", "WWW MMM OOO QQQ", "一二 three 四五"]) expect(wrapLabel(t)).toEqual(wrapLabel(t));
  });
});

describe("textUnits", () => {
  it("is full width for Chinese and per-class for Latin characters", () => {
    expect(textUnits("一二三")).toBe(3);
    expect(textUnits("")).toBe(0);
    expect(textUnits("iiii")).toBeLessThan(textUnits("nnnn"));
    expect(textUnits("nnnn")).toBeLessThan(textUnits("NNNN"));
    expect(textUnits("NNNN")).toBeLessThan(textUnits("WWWW"));
    expect(textUnits("mmmm")).toBeGreaterThan(textUnits("nnnn"));
    expect(textUnits("1234")).toBeGreaterThan(textUnits("iiii"));
  });

  it("wide capitals are estimated no narrower than a full-width character's 0.8", () => {
    for (const ch of "WMOQ") expect(textUnits(ch)).toBeGreaterThanOrEqual(0.84);
    expect(textUnits("WWWWWWWW")).toBeGreaterThan(textUnits("wwwwwwww"));
    expect(textUnits("OOOO")).toBeGreaterThan(textUnits("oooo"));
  });

  it("labelWidth follows the widest line, so wide letters reserve more than narrow ones", () => {
    expect(labelWidth("WWWW MMMM")).toBeGreaterThan(labelWidth("iiii llll"));
    expect(labelWidth("")).toBe(labelWidth("—"));
  });
});
