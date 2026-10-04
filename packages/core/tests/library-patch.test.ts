import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  appendDocIdNarrow,
  patchWorkNarrow,
  removeDocFromWorksNarrow,
  restoreUnknownKeys,
} from "../src/library/patch.js";
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

test("appending a Doc adds only that Doc id and keeps unknown keys, the other Works, project and library.bib", () => {
  const { paths, file } = seed();
  writeFileSync(paths.libraryBib, "BIB-AS-IS", "utf8");
  expect(appendDocIdNarrow(paths, "doi:10.1/a", "d4")).toBe("ok");
  const after = disk(paths);
  expect(after.works[0].doc_ids).toEqual(["d1", "d2", "d3", "d4"]);
  expect(after.works[0]).toMatchObject({ x_work: "keep-work", label: "red", title: "Alpha" });
  expect(after.works[1]).toEqual(file.works[1]);
  expect(after.x_top).toEqual(file.x_top);
  expect(after.project).toEqual(file.project);
  // A Doc association is not part of the BibTeX projection: the derived file is not rewritten.
  expect(readFileSync(paths.libraryBib, "utf8")).toBe("BIB-AS-IS");
});

test("appending a linked Doc or to a missing Work writes nothing", () => {
  const { paths } = seed();
  const before = readFileSync(paths.libraryJson, "utf8");
  expect(appendDocIdNarrow(paths, "doi:10.1/a", "d2")).toBe("present");
  expect(appendDocIdNarrow(paths, "doi:10.1/zzz", "d9")).toBe("not_found");
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
  expect(existsSync(`${paths.libraryJson.replace(/\.json$/, ".json.tmp")}`)).toBe(false);
});

test("a hand-edited numeric Work id is still found by its string form (append and patch)", () => {
  const { paths, file } = seed();
  const raw = {
    ...file,
    works: [{ ...file.works[0], id: 123, doc_ids: ["d1", "d2"] }, file.works[1]],
  };
  writeFileSync(paths.libraryJson, JSON.stringify(raw, null, 2), "utf8");
  expect(appendDocIdNarrow(paths, "123", "d9")).toBe("ok");
  expect(patchWorkNarrow(paths, "123", { doc_id: "d9" })).toEqual({ status: "ok" });
  expect(disk(paths).works[0].doc_ids).toEqual(["d9", "d1", "d2"]);
});

test("restoring unknown keys after a typed rewrite puts back top-level and Work keys by id, and nothing else", () => {
  const { paths, file } = seed();
  const before = JSON.parse(JSON.stringify(file));
  // What a typed save leaves: no unknown keys, and a Work that no longer exists under its id.
  const typed = {
    version: 1,
    project: file.project,
    works: [
      {
        id: "doi:10.1/a",
        title: "Alpha",
        authors: ["Ann"],
        doc_ids: ["d1", "d2", "d3"],
        label: "red",
      },
      { id: "doi:10.1/renamed", title: "Beta", authors: ["Bob"], doc_ids: ["b1"] },
    ],
  };
  writeFileSync(paths.libraryJson, JSON.stringify(typed, null, 2), "utf8");
  writeFileSync(paths.libraryBib, "BIB-AS-IS", "utf8");
  expect(restoreUnknownKeys(paths, before)).toBe(1);
  const after = disk(paths);
  expect(after.x_top).toEqual(file.x_top);
  expect(after.works[0]).toMatchObject({ x_work: "keep-work", title: "Alpha" });
  // The Work whose id changed cannot be matched: its unknown key is not invented onto another Work.
  expect(after.works[1].x_other).toBeUndefined();
  expect(readFileSync(paths.libraryBib, "utf8")).toBe("BIB-AS-IS");
  // Nothing to restore the second time: no write.
  const bytes = readFileSync(paths.libraryJson, "utf8");
  expect(restoreUnknownKeys(paths, before)).toBe(0);
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(bytes);
});

test("a failing restore throws and leaves the typed file exactly as it was", () => {
  const { paths, file } = seed();
  const typed = {
    version: 1,
    project: file.project,
    works: [{ id: "doi:10.1/a", title: "Alpha", authors: ["Ann"], doc_ids: [] }],
  };
  writeFileSync(paths.libraryJson, JSON.stringify(typed, null, 2), "utf8");
  const bytes = readFileSync(paths.libraryJson, "utf8");
  mkdirSync(paths.libraryJson.replace(/\.json$/, ".json.tmp"));
  expect(() => restoreUnknownKeys(paths, file)).toThrow();
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(bytes);
});

test("a known key with an empty or odd value is the model's business, not an unknown key to put back", () => {
  const { paths, file } = seed();
  const before = JSON.parse(JSON.stringify(file));
  // Known keys with values the typed save drops (empty note, empty tags, a wrong-typed year), plus one real unknown key.
  Object.assign(before.works[0], { note: "", tags: [], year: "not a number", x_real: 1 });
  const typed = {
    version: 1,
    project: file.project,
    works: [
      {
        id: "doi:10.1/a",
        title: "Alpha",
        authors: ["Ann"],
        doc_ids: ["d1", "d2", "d3"],
        label: "red",
      },
      file.works[1],
    ],
  };
  writeFileSync(paths.libraryJson, JSON.stringify(typed, null, 2), "utf8");
  expect(restoreUnknownKeys(paths, before)).toBe(1);
  const restored = disk(paths).works[0];
  expect(restored.x_real).toBe(1);
  expect(restored.x_work).toBe("keep-work");
  expect("note" in restored).toBe(false);
  expect("tags" in restored).toBe(false);
  expect("year" in restored).toBe(false);
});

// ---- removeDocFromWorksNarrow (copilot ticket 16: DELETE /api/paper/:doc_id and the Copilot delete_doc) ------------

test("removing a Doc takes it out of every Work's doc_ids and keeps unknown keys, other Works and library.bib as stored", () => {
  const { paths, file } = seed();
  const raw = disk(paths);
  raw.works.push({ id: "doi:10.1/c", title: "Gamma", doc_ids: ["d2", "c1"], x_third: { a: [1] } });
  raw.works.push({ id: "doi:10.1/e", title: "Epsilon", doc_ids: ["d2"] });
  writeFileSync(paths.libraryJson, JSON.stringify(raw, null, 2), "utf8");
  writeFileSync(paths.libraryBib, "% bib sentinel\n", "utf8");
  const result = removeDocFromWorksNarrow(paths, "d2");
  expect(result).toEqual({
    changed: true,
    works: [
      { id: "doi:10.1/a", title: "Alpha", remaining: ["d1", "d3"] },
      { id: "doi:10.1/c", title: "Gamma", remaining: ["c1"] },
      { id: "doi:10.1/e", title: "Epsilon", remaining: [] },
    ],
  });
  const after = disk(paths);
  expect(after.works[0]).toEqual({ ...file.works[0], doc_ids: ["d1", "d3"] });
  expect(after.works[1]).toEqual(file.works[1]);
  expect(after.works[2]).toEqual({ ...raw.works[2], doc_ids: ["c1"] });
  expect(after.works[3]).toEqual({ ...raw.works[3], doc_ids: [] });
  expect(after.x_top).toEqual(file.x_top);
  expect(after.project).toEqual(file.project);
  // doc_ids are not part of the BibTeX projection: the file is not rewritten.
  expect(readFileSync(paths.libraryBib, "utf8")).toBe("% bib sentinel\n");
  expect(existsSync(paths.libraryJson.replace(/\.json$/, ".json.tmp"))).toBe(false);
});

test("the Doc id is compared as a string, and entries that are not the Doc stay exactly as stored", () => {
  const { paths } = seed();
  const raw = disk(paths);
  raw.works[0].doc_ids = [123, "keep", 456];
  writeFileSync(paths.libraryJson, JSON.stringify(raw, null, 2), "utf8");
  const result = removeDocFromWorksNarrow(paths, "123");
  expect(result.works).toEqual([{ id: "doi:10.1/a", title: "Alpha", remaining: ["keep", "456"] }]);
  expect(disk(paths).works[0].doc_ids).toEqual(["keep", 456]);
});

test("a Doc no Work holds, or a missing library file, writes nothing", () => {
  const { paths } = seed();
  const before = readFileSync(paths.libraryJson, "utf8");
  expect(removeDocFromWorksNarrow(paths, "nobody")).toEqual({ changed: false, works: [] });
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
  const empty = libraryPaths(mkdtempSync(join(tmpdir(), "library-patch-empty-")));
  expect(removeDocFromWorksNarrow(empty, "d1")).toEqual({ changed: false, works: [] });
  expect(existsSync(empty.libraryJson)).toBe(false);
});

test("an unreadable library file throws and stays as it was; a failed write keeps the original bytes", () => {
  const { paths } = seed();
  const good = readFileSync(paths.libraryJson, "utf8");
  // The temp path is occupied by a directory, so staging the new file fails.
  mkdirSync(paths.libraryJson.replace(/\.json$/, ".json.tmp"));
  expect(() => removeDocFromWorksNarrow(paths, "d1")).toThrow();
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(good);
  writeFileSync(paths.libraryJson, "{ not json", "utf8");
  expect(() => removeDocFromWorksNarrow(paths, "d1")).toThrow();
  expect(readFileSync(paths.libraryJson, "utf8")).toBe("{ not json");
});
