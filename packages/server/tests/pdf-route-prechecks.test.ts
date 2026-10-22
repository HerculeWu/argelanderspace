/**
 * The six PDF routes that start from a verified Doc (snapshot, reading-position GET/PUT, annotations/count,
 * annotations PUT, download) answer the same failure with the same status and detail, because they all go through
 * `pdfAccess` (backlog-sweep group 11, copilot ticket 55). Every failure branch of every route, over HTTP, with
 * synthetic data under a temp dir.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryPaths, publishPdfDoc } from "@argelanderspace/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { collectBroadcasts, makeWebDist, stubPipelines, stubSources } from "./helpers.js";
import { syntheticPdf } from "./pdf-fixture.js";

const W1 = "doi:10.1000/w1";
const W2 = "doi:10.1000/w2";
const PAGES = [{ width: 360, height: 480, rotation: 0 }];

let root: string;
let app: Hono;
let registry: DocMutationRegistry;
let paths: ReturnType<typeof libraryPaths>;
let doc: string;

const work = (id: string, docIds: string[]) => ({
  id,
  title: `Work ${id}`,
  authors: ["Author"],
  year: 2026,
  venue: "MNRAS",
  type: "article",
  doi: id.slice(4),
  cite_key: id.replace(/[^a-z0-9]/gi, ""),
  doc_ids: docIds,
});
const docFile = (name: string) => join(paths.outputDir, doc, name);
const library = () => JSON.parse(readFileSync(paths.libraryJson, "utf8"));
const writeLibrary = (file: unknown) =>
  writeFileSync(paths.libraryJson, JSON.stringify(file, null, 2));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pdf-route-prechecks-"));
  paths = libraryPaths(join(root, "data"));
  mkdirSync(paths.libraryDir, { recursive: true });
  mkdirSync(paths.outputDir, { recursive: true });
  writeLibrary({
    version: 1,
    project: { name: "Synthetic", short: "S", field: "" },
    works: [work(W1, []), work(W2, [])],
  });
  const metadata = publishPdfDoc(paths, {
    workId: W1,
    filename: "synthetic.pdf",
    bytes: syntheticPdf(),
    pages: PAGES,
  });
  doc = metadata.doc_id;
  registry = new DocMutationRegistry();
  app = createApp({
    paths,
    statusDir: statusDirFor(join(root, "data")),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    autoIngestArxiv: () => false,
    runner: new JobRunner({ dir: join(root, "jobs") }),
    docMutations: registry,
    broadcast: collectBroadcasts().broadcast,
    webDist: makeWebDist(),
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Probe = (id: string) => Promise<{ status: number; detail: unknown }>;
const get =
  (suffix: string): Probe =>
  async (id) => {
    const r = await app.request(`/api/paper/${id}/pdf${suffix}`);
    const type = r.headers.get("content-type") ?? "";
    return {
      status: r.status,
      detail: type.includes("json") ? ((await r.json()) as { detail?: unknown }).detail : undefined,
    };
  };
const put =
  (suffix: string, file: string): Probe =>
  async (id) => {
    const stored = JSON.parse(readFileSync(join(paths.outputDir, doc, file), "utf8"));
    const body = JSON.stringify(
      file === "reading-position.json" ? { ...stored, doc_id: id } : stored
    );
    const r = await app.request(`/api/paper/${id}/pdf${suffix}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { status: r.status, detail: ((await r.json()) as { detail?: unknown }).detail };
  };
const routes = {
  snapshot: get("/snapshot"),
  "reading-position GET": get("/reading-position"),
  count: get("/annotations/count"),
  download: get(""),
  "annotations PUT": put("/annotations", "annotations.json"),
  "reading-position PUT": put("/reading-position", "reading-position.json"),
};
type RouteName = keyof typeof routes;
const GET_ROUTES: RouteName[] = ["snapshot", "reading-position GET", "count", "download"];
const ALL: RouteName[] = [...GET_ROUTES, "annotations PUT", "reading-position PUT"];

const check = async (
  names: RouteName[],
  id: string,
  expected: { status: number; detail: unknown }
) => {
  for (const name of names)
    expect({ name, ...(await routes[name](id)) }, name).toEqual({ name, ...expected });
};

test("a bad id is 400 'bad doc id' on the GET routes", async () => {
  await check(GET_ROUTES, "..%5Cx", { status: 400, detail: "bad doc id" });
});

test("a busy Doc is 409 'document busy' on all six", async () => {
  registry.pinWriter(doc);
  try {
    await check(ALL, doc, { status: 409, detail: "document busy" });
  } finally {
    registry.unpinWriter(doc);
  }
});

test("an unowned Doc is 404 on all six", async () => {
  await check(ALL, "pdf-nope", { status: 404, detail: "paper 'pdf-nope' not found" });
});

test("two owners are 500 'inconsistent Work ownership' with the id on all six", async () => {
  const file = library();
  file.works.find((w: { id: string }) => w.id === W2).doc_ids.push(doc);
  writeLibrary(file);
  await check(ALL, doc, {
    status: 500,
    detail: `PDF document '${doc}' has inconsistent Work ownership`,
  });
});

test("missing metadata is 500 'cannot be verified' on the four GET routes", async () => {
  rmSync(docFile(`${doc}.json`));
  await check(GET_ROUTES, doc, { status: 500, detail: `PDF document '${doc}' cannot be verified` });
});

test("an original that no longer matches is 409 'document changed' on the four GET routes", async () => {
  writeFileSync(docFile("original.pdf"), Buffer.concat([syntheticPdf(), Buffer.from("x")]));
  await check(GET_ROUTES, doc, { status: 409, detail: "document changed" });
});

test("a damaged annotations sidecar is 500 'cannot be verified' on snapshot and count", async () => {
  writeFileSync(docFile("annotations.json"), "{ not json");
  await check(["snapshot", "count"], doc, {
    status: 500,
    detail: `PDF document '${doc}' cannot be verified`,
  });
});

test("a damaged reading position: snapshot stays 200 with a soft error; its own GET keeps its own words", async () => {
  writeFileSync(docFile("reading-position.json"), "{ not json");
  const snapshot = await app.request(`/api/paper/${doc}/pdf/snapshot`);
  expect(snapshot.status).toBe(200);
  expect(
    ((await snapshot.json()) as { reading_position: { status: string } }).reading_position.status
  ).toBe("error");
  expect(await routes["reading-position GET"](doc)).toEqual({
    status: 500,
    detail: "reading position unavailable",
  });
});

test("an unreadable original is 500 'cannot be verified' on the four GET routes", async () => {
  rmSync(docFile("original.pdf"));
  await check(GET_ROUTES, doc, { status: 500, detail: `PDF document '${doc}' cannot be verified` });
});

const PUTS: RouteName[] = ["annotations PUT", "reading-position PUT"];

test("order: a bad id that is also busy is 400, not busy", async () => {
  registry.pinWriter("..\\x");
  try {
    await check(GET_ROUTES, "..%5Cx", { status: 400, detail: "bad doc id" });
  } finally {
    registry.unpinWriter("..\\x");
  }
});

test("order: busy comes before ownership on the GET routes (unowned and busy is busy)", async () => {
  registry.pinWriter("pdf-nope");
  try {
    await check(GET_ROUTES, "pdf-nope", { status: 409, detail: "document busy" });
  } finally {
    registry.unpinWriter("pdf-nope");
  }
});

test("order: busy comes before inconsistent ownership on the GET routes", async () => {
  const file = library();
  file.works.find((w: { id: string }) => w.id === W2).doc_ids.push(doc);
  writeLibrary(file);
  registry.pinWriter(doc);
  try {
    await check(GET_ROUTES, doc, { status: 409, detail: "document busy" });
  } finally {
    registry.unpinWriter(doc);
  }
});

test("order: on the two PUTs ownership comes before busy (unowned and busy is 404)", async () => {
  registry.pinWriter("pdf-nope");
  try {
    await check(PUTS, "pdf-nope", { status: 404, detail: "paper 'pdf-nope' not found" });
  } finally {
    registry.unpinWriter("pdf-nope");
  }
});

test("order: ownership comes before metadata (two owners and no metadata is inconsistent)", async () => {
  const file = library();
  file.works.find((w: { id: string }) => w.id === W2).doc_ids.push(doc);
  writeLibrary(file);
  rmSync(docFile(`${doc}.json`));
  await check(GET_ROUTES, doc, {
    status: 500,
    detail: `PDF document '${doc}' has inconsistent Work ownership`,
  });
});

test("missing metadata: the two PUTs answer their own save errors and write nothing", async () => {
  rmSync(docFile(`${doc}.json`));
  const annotations = readFileSync(docFile("annotations.json"));
  const position = readFileSync(docFile("reading-position.json"));
  await check(["annotations PUT"], doc, {
    status: 500,
    detail: "PDF annotations could not be saved",
  });
  await check(["reading-position PUT"], doc, {
    status: 500,
    detail: "reading position could not be saved",
  });
  expect(readFileSync(docFile("annotations.json"))).toEqual(annotations);
  expect(readFileSync(docFile("reading-position.json"))).toEqual(position);
});

test("an owned Doc with no PDF files (metadata read as absent) is 500 'cannot be verified' on the four GET routes", async () => {
  const file = library();
  file.works.find((w: { id: string }) => w.id === W2).doc_ids.push("pdf-hollow");
  writeLibrary(file);
  await check(GET_ROUTES, "pdf-hollow", {
    status: 500,
    detail: "PDF document 'pdf-hollow' cannot be verified",
  });
});
