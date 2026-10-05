/**
 * The SVG figure renderer's safety and bounds (copilot ticket 30): an SVG is untrusted input, refused whole when it
 * could do more than draw, and never drawn larger than the caller asked, whatever its own size says.
 */
import { describe, expect, test } from "vitest";
import {
  checkSvg,
  loadResvgEngine,
  renderSvgFigure,
  SVG_MAX_BYTES,
  SVG_MAX_LONG_EDGE,
  type SvgEngine,
} from "../src/svg-raster.js";

const wrap = (inner: string, attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${inner}</svg>`;

describe("checkSvg", () => {
  test.each([
    ["a script", wrap("<script>alert(1)</script>")],
    ["a script in another case", wrap("<SCRIPT >x</SCRIPT>")],
    ["an event handler", wrap('<rect onclick="x()" width="1" height="1"/>')],
    ["an onload on the root", `<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>`],
    ["a foreignObject", wrap("<foreignObject><div/></foreignObject>")],
    ["an iframe", wrap('<iframe src="x"/>')],
    ["an http image", wrap('<image href="http://evil.example/a.png"/>')],
    ["an xlink image", wrap('<image xlink:href="https://evil.example/a.png"/>')],
    ["a file image", wrap('<image href="file:///etc/passwd"/>')],
    ["a relative file", wrap('<image href="other.png"/>')],
    ["an external use", wrap('<use xlink:href="other.svg#a"/>')],
    ["a data text/html href", wrap('<image href="data:text/html;base64,PGI+"/>')],
    ["a javascript href", wrap('<a href="javascript:alert(1)"><rect/></a>')],
    ["an external url()", wrap('<rect fill="url(http://evil.example/p)"/>')],
    ["a style url()", wrap("<style>rect{fill:url('http://evil.example/p')}</style>")],
    ["an @import", wrap("<style>@import 'a.css';</style>")],
    ["a DOCTYPE", `<!DOCTYPE svg SYSTEM "x.dtd">${wrap("")}`],
    ["an ENTITY", `<!DOCTYPE svg [<!ENTITY a "b">]>${wrap("<text>&a;</text>")}`],
    ["an xml-stylesheet", `<?xml-stylesheet href="a.css"?>${wrap("")}`],
    // the recheck review's bypasses: a `href='#` that is not an attribute must not hide the real href after it
    [
      "a href hidden behind one in text",
      wrap("<desc>href='#</desc><image href=\"/abs/a.png\"/><desc>'</desc>"),
    ],
    [
      "a href hidden behind one in a comment",
      wrap("<!-- href='# --><image href=\"/abs/a.png\"/><!-- ' -->"),
    ],
    [
      "a href hidden behind one in a value",
      wrap('<g class="href=\'#"><image href="/abs/a.png"/></g><g class="\'"/>'),
    ],
    ["a bad href after a good one", wrap('<use href="#a"/><image href="/abs/a.png"/>')],
    // resvg reads a `#…` value on <image> (and an unknown id on <feImage>) as a file path, not as a fragment
    ["a # file name on an image", wrap('<image href="#probe.png" width="1" height="1"/>')],
    [
      "a # name on an image even when the file declares that id",
      wrap('<g id="probe.png"/><image href="#probe.png"/>'),
    ],
    ["a # path on an image", wrap('<image href="#/../red.png"/>')],
    ["the placeholder's own name on an image", wrap('<image href="#inline"/>')],
    ["an unknown id on an feImage", wrap('<filter id="f"><feImage href="#probe.png"/></filter>')],
    ["a fragment with a slash", wrap('<g id="a"/><use href="#a/../b"/>')],
    ["a declared id that looks like a path", wrap('<g id="a/../b"/><use href="#a/../b"/>')],
    ["a fragment with leading space", wrap('<g id="a"/><use href=" #a"/>')],
    ["a NUL character", wrap("<g/>\u0000")],
    ["an absolute file image", wrap('<image href="/etc/hostname"/>')],
    ["a device file image", wrap("<image href='/dev/zero'/>")],
    ["an unquoted href", wrap("<image href=/abs/a.png />")],
    ["an feImage", wrap('<filter id="f"><feImage href="/abs/a.png"/></filter>')],
    ["a url() hidden behind one in text", wrap('<desc>url(#</desc><rect fill="url(/abs/p)"/>')],
    ["a CSS escape", wrap("<style>rect{fill:u\\72l(/abs/p)}</style>")],
    ["an @font-face", wrap("<style>@font-face{font-family:x;src:local(y)}</style>")],
    ["too many elements", wrap("<g/>".repeat(20_001))],
    ["not an SVG", "<html><body>hi</body></html>"],
  ])("refuses %s", (_name, svg) => {
    const verdict = checkSvg(svg);
    expect(verdict.ok).toBe(false);
  });

  test("a plain drawing passes: fragments, gradients and inline raster pictures are the file's own", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(
      checkSvg(
        wrap(
          `<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient><g id="a"><rect width="5" height="5" fill="url(#g)"/></g></defs><use xlink:href="#a"/><use href="#a"/><image href="${png}" width="2" height="2"/><text>one two on</text>`,
          'viewBox="0 0 10 10"'
        )
      ).ok
    ).toBe(true);
  });

  test("an feImage may point at an element of the same file", () => {
    expect(
      checkSvg(
        wrap(
          '<defs><g id="pic"><rect width="1" height="1"/></g></defs><filter id="f"><feImage href="#pic"/></filter>'
        )
      ).ok
    ).toBe(true);
  });

  test("an inline picture whose base64 happens to spell href or url is still accepted", () => {
    const png = "data:image/png;base64,iVBORw0KHrEf=Gurl+hrefAAAA";
    expect(checkSvg(wrap(`<image xlink:href='${png}' width="2" height="2"/>`)).ok).toBe(true);
  });

  test("the reason names the offence and never repeats the file's content", () => {
    const verdict = checkSvg(wrap("<script>SECRET-PAYLOAD</script>"));
    expect(verdict).toMatchObject({ ok: false });
    expect(JSON.stringify(verdict)).not.toContain("SECRET-PAYLOAD");
  });
});

/** A fake engine that records what it was asked, so the bounds are checked without any real renderer. */
function fakeEngine(own: { width: number; height: number }) {
  const calls: { measure: number; render: { mode: string; value: number }[] } = {
    measure: 0,
    render: [],
  };
  const engine: SvgEngine = {
    measure: () => {
      calls.measure++;
      return own;
    },
    render: (_svg, fit) => {
      calls.render.push(fit);
      const long = fit.value;
      const ratio = own.width / own.height;
      return {
        png: Buffer.from("png"),
        width: ratio >= 1 ? long : Math.round(long * ratio),
        height: ratio >= 1 ? Math.round(long / ratio) : long,
      };
    },
  };
  return { engine, calls };
}

describe("renderSvgFigure", () => {
  const svg = Buffer.from(wrap("<rect width='1' height='1'/>", 'viewBox="0 0 10 10"'));

  test("the picture is bounded by the caller's long edge, never by the SVG's own size", async () => {
    const huge = fakeEngine({ width: 1e9, height: 1e9 });
    const out = await renderSvgFigure(svg, 512, huge.engine);
    expect(out).toMatchObject({ kind: "ok", width: 512, height: 512 });
    expect(huge.calls.render).toEqual([{ mode: "width", value: 512 }]);
    const tall = fakeEngine({ width: 100, height: 400 });
    expect(await renderSvgFigure(svg, 600, tall.engine)).toMatchObject({ kind: "ok", height: 600 });
    expect(tall.calls.render[0]).toEqual({ mode: "height", value: 600 });
  });

  test("an unsafe SVG never reaches the engine", async () => {
    const spy = fakeEngine({ width: 10, height: 10 });
    const bad = Buffer.from(wrap("<script>x</script>"));
    expect(await renderSvgFigure(bad, 512, spy.engine)).toMatchObject({ kind: "unsafe" });
    expect(spy.calls.measure).toBe(0);
    expect(spy.calls.render).toEqual([]);
  });

  test("extreme proportions, no size, an engine failure, an oversized file and a non-SVG are each refused", async () => {
    expect(
      await renderSvgFigure(svg, 512, fakeEngine({ width: 100000, height: 10 }).engine)
    ).toMatchObject({
      kind: "invalid",
    });
    expect(
      await renderSvgFigure(svg, 512, fakeEngine({ width: 0, height: 10 }).engine)
    ).toMatchObject({
      kind: "invalid",
    });
    expect(
      await renderSvgFigure(svg, 512, fakeEngine({ width: Number.NaN, height: 10 }).engine)
    ).toMatchObject({
      kind: "invalid",
    });
    const broken: SvgEngine = {
      measure: () => {
        throw new Error("bad svg");
      },
      render: () => {
        throw new Error("never");
      },
    };
    expect(await renderSvgFigure(svg, 512, broken)).toMatchObject({ kind: "invalid" });
    expect(
      await renderSvgFigure(
        Buffer.alloc(SVG_MAX_BYTES + 1),
        512,
        fakeEngine({ width: 1, height: 1 }).engine
      )
    ).toEqual({
      kind: "too_large",
    });
    expect(
      await renderSvgFigure(Buffer.from("hello"), 512, fakeEngine({ width: 1, height: 1 }).engine)
    ).toEqual({
      kind: "not_svg",
    });
  });

  test("a build without the renderer says so instead of failing", async () => {
    expect(await renderSvgFigure(svg, 512, null)).toEqual({ kind: "unavailable" });
  });

  test("a picture over the hard ceiling is refused before the engine draws anything", async () => {
    for (const asked of [SVG_MAX_LONG_EDGE + 1, 1_000_000, 0, Number.NaN]) {
      const spy = fakeEngine({ width: 100, height: 50 });
      expect(await renderSvgFigure(svg, asked, spy.engine)).toMatchObject({ kind: "invalid" });
      expect(spy.calls.render).toEqual([]);
    }
  });

  test("an engine that draws larger than asked is not trusted", async () => {
    const liar: SvgEngine = {
      measure: () => ({ width: 10, height: 10 }),
      render: () => ({ png: Buffer.from("x"), width: 5000, height: 5000 }),
    };
    expect(await renderSvgFigure(svg, 512, liar)).toMatchObject({ kind: "invalid" });
  });
});

const engine = await loadResvgEngine();
describe.skipIf(!engine)("the real renderer (resvg)", () => {
  test("draws a real PNG at the asked size, quickly, from a huge viewBox too", async () => {
    const big = Buffer.from(
      wrap("<rect width='5' height='5'/>", 'viewBox="0 0 1000000000 1000000000"')
    );
    const started = Date.now();
    const out = await renderSvgFigure(big, 300);
    expect(out).toMatchObject({ kind: "ok", width: 300, height: 300 });
    if (out.kind !== "ok") return;
    expect(out.png.subarray(1, 4).toString()).toBe("PNG");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
