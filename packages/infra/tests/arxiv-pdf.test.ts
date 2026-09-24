import { describe, expect, it, vi } from "vitest";
import { fetchArxivPdf } from "../src/arxiv-pdf.js";

const pdf = Buffer.from("%PDF-1.4\nfixture\n%%EOF\n");
function response(
  bytes: Buffer,
  contentType = "application/pdf",
  url = "https://arxiv.org/pdf/2601.01234"
) {
  const result = new Response(bytes, { status: 200, headers: { "content-type": contentType } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

describe("fetchArxivPdf", () => {
  it("requests the current PDF for the canonical base ID and returns untouched bytes", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request) => response(pdf));
    await expect(
      fetchArxivPdf("2601.01234", { fetchImpl: fetchImpl as typeof fetch })
    ).resolves.toEqual(pdf);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://arxiv.org/pdf/2601.01234",
      expect.objectContaining({ redirect: "manual" })
    );
  });

  it("checks every redirect target before following and permits bounded same-origin PDF redirects", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "https://arxiv.org/pdf/2601.01234")
        return new Response(null, {
          status: 302,
          headers: { location: "/pdf/2601.01234v2.pdf?download=1" },
        });
      expect(input).toBe("https://arxiv.org/pdf/2601.01234v2.pdf?download=1");
      return response(pdf, "application/pdf", "https://arxiv.org/pdf/2601.01234v2.pdf?download=1");
    });
    await expect(
      fetchArxivPdf("2601.01234", { fetchImpl: fetchImpl as typeof fetch })
    ).resolves.toEqual(pdf);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const hostile = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://export.arxiv.org/api/query" },
        })
    );
    await expect(
      fetchArxivPdf("2601.01234", { fetchImpl: hostile as typeof fetch })
    ).rejects.toThrow("does not identify the requested paper");
    expect(hostile).toHaveBeenCalledTimes(1);
  });

  it("stops redirect loops at the hop limit", async () => {
    const loop = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/pdf/2601.01234" } })
    );
    await expect(fetchArxivPdf("2601.01234", { fetchImpl: loop as typeof fetch })).rejects.toThrow(
      "too many arXiv PDF redirects"
    );
    expect(loop).toHaveBeenCalledTimes(6);
  });

  it("rejects a same-host redirect that changes the requested paper before fetching its target", async () => {
    const direct = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/pdf/2601.54321" } })
    );
    await expect(
      fetchArxivPdf("2601.01234", { fetchImpl: direct as typeof fetch })
    ).rejects.toThrow("does not identify the requested paper");
    expect(direct).toHaveBeenCalledTimes(1);

    let calls = 0;
    const indirect = vi.fn(async (input: string | URL | Request) => {
      calls++;
      if (calls === 1)
        return new Response(null, { status: 302, headers: { location: "/pdf/2601.01234v2" } });
      expect(input).toBe("https://arxiv.org/pdf/2601.01234v2");
      return new Response(null, { status: 302, headers: { location: "/pdf/2601.54321v4" } });
    });
    await expect(
      fetchArxivPdf("2601.01234", { fetchImpl: indirect as typeof fetch })
    ).rejects.toThrow("does not identify the requested paper");
    expect(indirect).toHaveBeenCalledTimes(2);
  });

  it("rejects a final response whose URL identifies a different arXiv paper", async () => {
    const fetchImpl = async () =>
      response(pdf, "application/pdf", "https://arxiv.org/pdf/2601.54321");
    await expect(
      fetchArxivPdf("2601.01234", { fetchImpl: fetchImpl as typeof fetch })
    ).rejects.toThrow("does not identify the requested paper");
  });

  it("keeps legacy IDs on the arxiv.org PDF path and rejects oversized responses before reading", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(input).toBe("https://arxiv.org/pdf/astro-ph/0701001");
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-length": String(50 * 1024 * 1024 + 1),
        },
      });
    });
    await expect(
      fetchArxivPdf("astro-ph/0701001", { fetchImpl: fetchImpl as typeof fetch })
    ).rejects.toThrow(/exceeds/);
  });

  it("rejects HTML, unexpected redirects and invalid identifiers", async () => {
    await expect(
      fetchArxivPdf("2601.01234", {
        fetchImpl: (async () => response(pdf, "text/html")) as typeof fetch,
      })
    ).rejects.toThrow("did not return a PDF");
    await expect(
      fetchArxivPdf("2601.01234", {
        fetchImpl: (async () =>
          response(pdf, "application/pdf", "https://example.com/file.pdf")) as typeof fetch,
      })
    ).rejects.toThrow("does not identify the requested paper");
    await expect(
      fetchArxivPdf("https://example.com/x", { fetchImpl: vi.fn() as typeof fetch })
    ).rejects.toThrow("invalid arXiv ID");
  });
});
