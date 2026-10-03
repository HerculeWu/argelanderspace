import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { patchWorkNarrow } from "../src/library/patch.js";
import { libraryPaths } from "../src/library/store.js";

function seed() {
  const dataDir = mkdtempSync(join(tmpdir(), "library-patch-"));
  const paths = libraryPaths(dataDir);
  mkdirSync(paths.libraryDir, { recursive: true });
  const file = {
    version: 1,
    project: { name: "Synthetic", short: "S", field: "", x_project: "keep" },
    x_top: { nested: [1, 2] },
    works: [
      {
        id: "doi:10.1/a",
        title: "Alpha",
        authors: ["Ann"],
        doc_ids: ["d1", "d2", "d3"],
        read: false,
        label: "red",
        x_work: "keep-work",
      },
      { id: "doi:10.1/b", title: "Beta", authors: ["Bob"], doc_ids: ["b1"], x_other: 5 },
    ],
  };
  writeFileSync(paths.libraryJson, JSON.stringify(file, null, 2), "utf8");
  return { paths, file };
}
const disk = (paths: ReturnType<typeof libraryPaths>) =>
  JSON.parse(readFileSync(paths.libraryJson, "utf8"));

test("setting the main Doc moves only that Doc and keeps every unknown key and other Work", () => {
  const { paths, file } = seed();
  expect(patchWorkNarrow(paths, "doi:10.1/a", { doc_id: "d3" }, { main_doc_id: "d1" })).toEqual({
    status: "ok",
  });
  const after = disk(paths);
  expect(after.works[0].doc_ids).toEqual(["d3", "d1", "d2"]);
  expect(after.works[0]).toMatchObject({ x_work: "keep-work", label: "red", title: "Alpha" });
  expect(after.works[1]).toEqual(file.works[1]);
  expect(after.x_top).toEqual(file.x_top);
  expect(after.project).toEqual(file.project);
  expect(readFileSync(paths.libraryBib, "utf8")).toContain("Alpha");
});

test("a changed main Doc is a conflict that writes nothing; an unrelated change is kept", () => {
  const { paths } = seed();
  const before = readFileSync(paths.libraryJson, "utf8");
  expect(patchWorkNarrow(paths, "doi:10.1/a", { doc_id: "d3" }, { main_doc_id: "d2" })).toEqual({
    status: "conflict",
    current: { main_doc_id: "d1", doc_ids: ["d1", "d2", "d3"] },
  });
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
  // Another field (and a new Doc at the end) changed meanwhile: the main Doc is still what was read.
  const raw = disk(paths);
  raw.works[0].read = true;
  raw.works[0].doc_ids.push("d4");
  writeFileSync(paths.libraryJson, JSON.stringify(raw, null, 2));
  expect(patchWorkNarrow(paths, "doi:10.1/a", { doc_id: "d4" }, { main_doc_id: "d1" })).toEqual({
    status: "ok",
  });
  expect(disk(paths).works[0]).toMatchObject({ read: true, doc_ids: ["d4", "d1", "d2", "d3"] });
});

test("no-ops and unknown objects write nothing", () => {
  const { paths } = seed();
  const before = readFileSync(paths.libraryJson, "utf8");
  expect(patchWorkNarrow(paths, "doi:10.1/a", { doc_id: "d1" })).toEqual({
    status: "noop",
    reason: "unchanged",
  });
  expect(patchWorkNarrow(paths, "doi:10.1/a", { doc_id: "nope" })).toEqual({
    status: "noop",
    reason: "not_linked",
  });
  expect(patchWorkNarrow(paths, "doi:10.1/zzz", { doc_id: "d1" })).toEqual({
    status: "not_found",
  });
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
});

test("a failure while staging keeps library.json and library.bib bytes, leaves no staged file, and reports the original error", () => {
  const { paths } = seed();
  writeFileSync(paths.libraryBib, "% previous bib");
  const before = readFileSync(paths.libraryJson, "utf8");
  // The bib staging path is a directory: the json stages fine, then the bib write fails (EISDIR).
  mkdirSync(paths.libraryBib.replace(/\.bib$/, ".bib.tmp"));
  let thrown: NodeJS.ErrnoException | undefined;
  try {
    patchWorkNarrow(paths, "doi:10.1/a", { doc_id: "d2" });
  } catch (error) {
    thrown = error as NodeJS.ErrnoException;
  }
  // Cleaning the directory away fails with ERR_FS_EISDIR; that must not replace the real cause.
  expect(thrown?.code).toBe("EISDIR");
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
  expect(readFileSync(paths.libraryBib, "utf8")).toBe("% previous bib");
  expect(existsSync(paths.libraryJson.replace(/\.json$/, ".json.tmp"))).toBe(false);
});

test("the older field patches keep their validation", () => {
  const { paths } = seed();
  expect(
    patchWorkNarrow(paths, "doi:10.1/b", {
      label: "x".repeat(40),
      read: true,
      tags: ["#t"],
      note: "n",
    })
  ).toEqual({ status: "ok" });
  expect(disk(paths).works[1]).toMatchObject({
    label: "x".repeat(32),
    read: true,
    tags: ["#t"],
    note: "n",
    x_other: 5,
  });
  expect(patchWorkNarrow(paths, "doi:10.1/b", { label: "", note: "", tags: [] })).toEqual({
    status: "ok",
  });
  const cleared = disk(paths).works[1];
  expect(cleared).not.toHaveProperty("label");
  expect(cleared).not.toHaveProperty("note");
  expect(cleared).not.toHaveProperty("tags");
});
