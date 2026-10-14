/**
 * The environment report writes the home directory as `~` (desktop-app ticket 14): only where the home directory is a
 * whole leading part of a path — `/home/x2` and `/home/x.old` are other directories — and on Windows whatever the
 * separators and the case. The home directory and the platform are handed in.
 */
import { expect, test } from "vitest";
import { withoutHome } from "../src/diagnostics.js";

test("POSIX: the home directory and paths under it become ~; a longer name beside it does not", () => {
  const home = "/home/x";
  expect(withoutHome("/home/x", home, "linux")).toBe("~");
  expect(withoutHome("/home/x/", home, "linux")).toBe("~/");
  expect(withoutHome("/home/x/proj/a.tex", home, "linux")).toBe("~/proj/a.tex");
  expect(withoutHome("/home/x2/proj", home, "linux")).toBe("/home/x2/proj");
  expect(withoutHome("/home/x.old/proj", home, "linux")).toBe("/home/x.old/proj");
  expect(withoutHome("/home/x-y", home, "linux")).toBe("/home/x-y");
  // In a sentence, and more than once; a trailing separator on the home itself changes nothing.
  expect(withoutHome("in /home/x/a and /home/x: done", "/home/x/", "linux")).toBe(
    "in ~/a and ~: done"
  );
  // POSIX compares exactly: another case is another directory.
  expect(withoutHome("/HOME/X/a", home, "linux")).toBe("/HOME/X/a");
});

test("Windows: either separator, any case", () => {
  const home = "C:\\Users\\Wu";
  expect(withoutHome("C:\\Users\\Wu\\proj", home, "win32")).toBe("~\\proj");
  expect(withoutHome("C:/Users/Wu/texlive/bin", home, "win32")).toBe("~/texlive/bin");
  expect(withoutHome("c:\\users\\wu\\proj", home, "win32")).toBe("~\\proj");
  expect(withoutHome("c:/USERS/wu", home, "win32")).toBe("~");
  expect(withoutHome("C:\\Users\\Wu2\\proj", home, "win32")).toBe("C:\\Users\\Wu2\\proj");
  expect(withoutHome("C:/Users/Wu.old/x", home, "win32")).toBe("C:/Users/Wu.old/x");
  // A character whose lower case is longer (İ) before the home directory does not shift where it is cut.
  expect(withoutHome("İ C:\\Users\\Wu\\proj", home, "win32")).toBe("İ ~\\proj");
});

test("objects and arrays: every string, a {path, display} pair becomes one string", () => {
  const home = "/home/x";
  expect(
    withoutHome(
      { a: ["/home/x/1", 2, null], b: { path: "/home/x/p", display: "~/p" }, c: "/home/x2" },
      home,
      "linux"
    )
  ).toEqual({ a: ["~/1", 2, null], b: "~/p", c: "/home/x2" });
});
