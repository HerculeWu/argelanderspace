/**
 * A text Doc's page carries the editor's source beside the Reader reading (copilot ticket 29 fix round 1, B3): when the
 * envelope does not fit, the inline source is dropped with a note that names `text read_source`, before anything fails
 * with `capacity`, and the reading keeps its own batching.
 */
import {
  type CopilotPrompt,
  ReadingLedger,
  readingVersion,
  TEXT_SOURCE_INLINE_MAX,
  TextSourcePageSchema,
} from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import { fitEnvelope, historyCost } from "../src/copilot-batching.js";

const DOC = "text-11111111-1111-4111-8111-111111111111";
const page = (markdown: string | null) => ({
  docId: DOC,
  view: "source" as const,
  phase: "ready" as const,
  rev: 1,
  save: "saved" as const,
  unsaved: false,
  characters: markdown?.length ?? 150_000,
  markdown,
  assets: [],
  generated: true,
  publishedSourceRev: 1,
  diagnostics: [],
  generation: "idle" as const,
});
const reading = (entries: number) => ({
  format: "text" as const,
  docId: DOC,
  epoch: { fingerprint: "f".repeat(64), annotationsRev: 0, annotations: "current" as const },
  text: { publishedSourceRev: 1 },
  entries: Array.from({ length: entries }, (_, i) => ({
    kind: "paragraph" as const,
    id: `p-${i}`,
    text: `paragraph ${i} ${"w ".repeat(40)}`,
  })),
  references: [],
  citationsByBlock: {},
  annotations: [],
  coverage: {
    sections: 0,
    blocks: entries,
    references: 0,
    annotations: 0,
    assets: 0,
    characters: entries * 90,
  },
});
const prompt = (markdown: string | null, entries = 0): CopilotPrompt =>
  ({
    version: 1,
    task: "t",
    context: {
      version: 1,
      viewId: "22222222-2222-4222-8222-222222222222",
      revision: 1,
      paneId: 1,
      view: "doc",
      otherPanes: [],
      status: "complete",
      plan: null,
      textSource: page(markdown),
      ...(entries
        ? {
            reader: {
              docId: DOC,
              format: "text",
              sync: { phase: "ready" },
              reading: reading(entries),
              position: null,
              selection: null,
              panels: { outlineCollapsed: false, rightCollapsed: false, rightTab: "references" },
              canGoBack: false,
            },
          }
        : {}),
    },
  }) as unknown as CopilotPrompt;
const sourceOf = (p: CopilotPrompt) =>
  (p.context as unknown as { textSource: { markdown: string | null; omitted?: string } })
    .textSource;

describe("the inline source never makes a message fail", () => {
  test("the schema itself caps the inline source and ties it to the character count", () => {
    const ok = { ...page("x".repeat(TEXT_SOURCE_INLINE_MAX)), characters: TEXT_SOURCE_INLINE_MAX };
    expect(TextSourcePageSchema.safeParse(ok).success).toBe(true);
    expect(
      TextSourcePageSchema.safeParse({
        ...ok,
        markdown: "x".repeat(TEXT_SOURCE_INLINE_MAX + 1),
        characters: TEXT_SOURCE_INLINE_MAX + 1,
      }).success
    ).toBe(false);
    expect(TextSourcePageSchema.safeParse({ ...ok, characters: 5 }).success).toBe(false);
  });

  test("a source page with no reading that does not fit is sent without its text and says where to read it", () => {
    const big = prompt("x".repeat(90_000));
    const room = 20_000;
    expect(historyCost(JSON.stringify(big))).toBeGreaterThan(room);
    const fitted = fitEnvelope(big, room, new ReadingLedger());
    expect(fitted).not.toBeNull();
    expect(sourceOf((fitted as { prompt: CopilotPrompt }).prompt).markdown).toBeNull();
    expect(sourceOf((fitted as { prompt: CopilotPrompt }).prompt).omitted).toContain("read_source");
    expect(
      historyCost(JSON.stringify((fitted as { prompt: CopilotPrompt }).prompt))
    ).toBeLessThanOrEqual(room);
  });

  test("with a reading, the reading keeps the room: the source goes first, the reading stays whole", () => {
    const withBoth = prompt("x".repeat(60_000), 30);
    const readingOnly = prompt(null, 30);
    const room = historyCost(JSON.stringify(readingOnly)) + 4_000;
    expect(historyCost(JSON.stringify(withBoth))).toBeGreaterThan(room);
    const fitted = fitEnvelope(withBoth, room, new ReadingLedger());
    expect(fitted?.coverage).toMatchObject({ status: "complete", kind: "reader", from: 0 });
    expect(fitted?.coverage?.to).toBe(30);
    expect(sourceOf(fitted?.prompt as CopilotPrompt).markdown).toBeNull();
    expect(sourceOf(fitted?.prompt as CopilotPrompt).omitted).toContain("read_source");
  });

  test("when everything fits nothing is dropped", () => {
    const small = prompt("# short\n", 3);
    const room = historyCost(JSON.stringify(small)) + 5_000;
    const fitted = fitEnvelope(small, room, new ReadingLedger());
    expect(sourceOf(fitted?.prompt as CopilotPrompt).markdown).toBe("# short\n");
    expect(fitted?.coverage?.status).toBe("complete");
    void readingVersion;
  });
});
