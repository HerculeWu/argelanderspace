import { describe, expect, it } from "vitest";
import { DOCUMENT_BUSY, isDocumentBusyError, markDocumentBusy } from "../src/index.js";

describe("document busy", () => {
  it("is the 409 detail the server answers and the page compares with", () => {
    expect(DOCUMENT_BUSY).toBe("document busy");
  });

  it("a marked Error is busy and stays a plain Error with its message, name and stack", () => {
    const error = new Error(DOCUMENT_BUSY);
    const marked = markDocumentBusy(error);
    expect(marked).toBe(error);
    expect(isDocumentBusyError(marked)).toBe(true);
    expect(marked.name).toBe("Error");
    expect(marked.message).toBe("document busy");
    expect(Object.getPrototypeOf(marked)).toBe(Error.prototype);
    expect(marked.stack).toContain("document-busy.test.ts");
    expect("code" in marked).toBe(false);
  });

  it("an Error subclass with conflict busy (PdfAnnotationConflictError's field) is busy", () => {
    class Conflict extends Error {
      constructor(readonly conflict: "rev" | "busy") {
        super(conflict === "busy" ? DOCUMENT_BUSY : "rev mismatch");
      }
    }
    expect(isDocumentBusyError(new Conflict("busy"))).toBe(true);
    expect(isDocumentBusyError(new Conflict("rev"))).toBe(false);
  });

  it("the message alone, another conflict, a plain object or a string is not busy", () => {
    expect(isDocumentBusyError(new Error("document busy"))).toBe(false);
    expect(isDocumentBusyError(Object.assign(new Error("rev mismatch"), { conflict: "rev" }))).toBe(
      false
    );
    expect(isDocumentBusyError({ conflict: "busy", message: "document busy" })).toBe(false);
    expect(isDocumentBusyError("document busy")).toBe(false);
    expect(isDocumentBusyError(null)).toBe(false);
  });
});
