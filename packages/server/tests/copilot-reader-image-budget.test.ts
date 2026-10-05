/**
 * The image budget rule of the reader tool (copilot ticket 20): a page image costs what a model is charged for its
 * pixels (`imageTokens`), never the length of its base64 text; too big is refused whole.
 */

import { PDF_IMAGE_HISTORY_MAX_BYTES, PDF_IMAGE_MAX_BYTES } from "@argelanderspace/contracts";
import { expect, test } from "vitest";
import { createReaderTool } from "../src/copilot-reader-tool.js";

const SHA = "a".repeat(64);
function tool(png: Buffer, width: number, height: number, budget: number, used = 0) {
  return createReaderTool({
    reader: {
      read: async () => ({ kind: "not_found" }),
      write: async () => ({ kind: "not_found" }),
      pdf: {
        read: async () => ({ kind: "not_found" }),
        image: async () => ({
          kind: "ok",
          png,
          contentSha256: SHA,
          pageIndex: 0,
          pageCount: 1,
          width,
          height,
          hasTextLayer: true,
        }),
      },
    },
    viewAction: async () => ({ status: "displayed" }),
    admitting: () => true,
    modelAcceptsImages: () => true,
    budget: () => budget,
    imageBytesUsed: () => used,
  });
}
const call = async (t: ReturnType<typeof tool>) => {
  const result = await t.execute(
    "call-1",
    { action: "read_page_image", docId: "d", pageIndex: 0, sha256: SHA },
    undefined,
    undefined,
    undefined as never
  );
  const text = result.content[0];
  return {
    json: JSON.parse(text && text.type === "text" ? text.text : "{}"),
    images: result.content.filter((part) => part.type === "image"),
  };
};

test("an image with a long base64 text but few pixels fits: the rule is pixels, not text length", async () => {
  // 300 000 bytes of PNG (400 000 base64 characters) for 600 x 800 pixels = 640 tokens = 1 280 bytes of token budget,
  // under both byte caps
  const { json, images } = await call(tool(Buffer.alloc(300_000, 7), 600, 800, 20_000));
  expect(json).toMatchObject({ ok: true, status: "ok" });
  expect(images).toHaveLength(1);
});

test("an image of many pixels is refused whole, with its size and a way forward, even when its text is short", async () => {
  const { json, images } = await call(tool(Buffer.alloc(1_000, 7), 3072, 4096, 20_000));
  expect(json).toMatchObject({ ok: false, status: "rejected" });
  expect(json.detail).toMatch(/3072x4096/);
  expect(json.detail).toMatch(/smaller longEdge/);
  expect(images).toHaveLength(0);
});

test("a large-bytes, few-pixels image is refused by the per-image byte cap, whatever its token cost", async () => {
  const { json, images } = await call(
    tool(Buffer.alloc(PDF_IMAGE_MAX_BYTES + 1, 7), 600, 800, 10_000_000)
  );
  expect(json).toMatchObject({ ok: false, status: "rejected" });
  expect(json.detail).toMatch(/more than the \d+ bytes one image may be/);
  expect(json.detail).toMatch(/smaller longEdge/);
  expect(images).toHaveLength(0);
  // exactly at the cap is fine
  const ok = await call(tool(Buffer.alloc(PDF_IMAGE_MAX_BYTES, 7), 600, 800, 10_000_000));
  expect(ok.json).toMatchObject({ ok: true });
});

test("the images already in the history count: past the history total the next one is refused whole", async () => {
  const png = Buffer.alloc(1_000_000, 7);
  const fits = await call(tool(png, 600, 800, 10_000_000, PDF_IMAGE_HISTORY_MAX_BYTES - 1_000_000));
  expect(fits.json).toMatchObject({ ok: true });
  const { json, images } = await call(
    tool(png, 600, 800, 10_000_000, PDF_IMAGE_HISTORY_MAX_BYTES - 999_999)
  );
  expect(json).toMatchObject({ ok: false, status: "rejected" });
  expect(json.detail).toMatch(/together/);
  expect(json.detail).toMatch(/fewer pages|new conversation/);
  expect(images).toHaveLength(0);
});
