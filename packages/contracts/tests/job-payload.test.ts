import { describe, expect, it } from "vitest";
import {
  HostSwitchJobSchema,
  isJobFormat,
  JOB_FORMAT,
  JOB_FORMATS,
  JobFormatSchema,
  JobPayloadSchema,
  type JobTarget,
  jobTarget,
} from "../src/index.js";

const W = "arxiv:2603.00301";
const DOC = "pdf-0b8f3c52-6d1e-4f7a-9c2b-1a2b3c4d5e6f";
const none: JobTarget = { workId: null, docId: null, arxivId: null, format: null, automatic: null };

describe("the five payload shapes", () => {
  const shapes = [
    {
      name: "ingest",
      kind: "ingest",
      payload: { workId: W, arxivId: "2603.00301" },
      target: { ...none, workId: W, arxivId: "2603.00301" },
    },
    {
      name: "arXiv PDF",
      kind: "upload",
      payload: {
        workId: W,
        docId: DOC,
        format: "arxiv-pdf",
        arxivId: "2603.00301",
        automatic: true,
      },
      target: {
        workId: W,
        docId: DOC,
        arxivId: "2603.00301",
        format: "arxiv-pdf",
        automatic: true,
      },
    },
    {
      name: "PDF upload",
      kind: "upload",
      payload: { workId: W, docId: DOC, format: "pdf" },
      target: { ...none, workId: W, docId: DOC, format: "pdf" },
    },
    {
      name: "LaTeX zip",
      kind: "upload",
      payload: { workId: null, doi: "10.1000/x", arxiv: "2603.00301" },
      // the zip's `arxiv` is not an arXiv id of the job's target
      target: none,
    },
    { name: "refresh", kind: "refresh", payload: { offline: false }, target: none },
  ] as const;

  it.each(shapes)(
    "$name: the convention accepts it and jobTarget reads it",
    ({ kind, payload, target }) => {
      expect(JobPayloadSchema.safeParse({ kind, payload }).success).toBe(true);
      expect(jobTarget({ payload })).toEqual(target);
    }
  );

  it("a kind with another kind's payload, a renamed field or an unknown format is not the convention", () => {
    expect(
      JobPayloadSchema.safeParse({
        kind: "ingest",
        payload: { workId: W, docId: DOC, format: "pdf" },
      }).success
    ).toBe(false);
    expect(
      JobPayloadSchema.safeParse({ kind: "upload", payload: { workId: W, arxivId: "2603.00301" } })
        .success
    ).toBe(false);
    expect(
      JobPayloadSchema.safeParse({
        kind: "upload",
        payload: { workId: W, doi: null, arxivId: null },
      }).success
    ).toBe(false);
    expect(
      JobPayloadSchema.safeParse({
        kind: "upload",
        payload: { workId: W, docId: DOC, format: "tex" },
      }).success
    ).toBe(false);
  });
});

describe("jobTarget reads any payload leniently", () => {
  const rows: Array<[string, unknown, JobTarget]> = [
    ["no payload", undefined, none],
    ["null", null, none],
    ["a string", "workId", none],
    ["a number", 5, none],
    ["an array", [W], none],
    ["an empty object", {}, none],
    ["an empty workId (given as it is)", { workId: "" }, { ...none, workId: "" }],
    ["a mistyped workId", { workId: 5 }, none],
    ["an unknown format (given as it is)", { format: "tex" }, { ...none, format: "tex" }],
    ["a mistyped format", { format: 1 }, none],
    ["the zip's arxiv field", { arxiv: "2401.1" }, none],
    ["a mistyped automatic", { automatic: "yes" }, none],
    ["automatic false", { automatic: false }, { ...none, automatic: false }],
  ];

  it.each(rows)("%s", (_name, payload, target) => {
    expect(jobTarget(payload === undefined ? {} : { payload })).toEqual(target);
  });

  it("does not look at the job's kind (an ingest job that names a format still gives it)", () => {
    expect(
      jobTarget({ kind: "ingest", payload: { workId: W, format: "pdf" } } as { payload: unknown })
    ).toEqual({
      ...none,
      workId: W,
      format: "pdf",
    });
  });

  // Moved from web work-jobs.test.ts (`jobWorkId`): the page reads the target Work from the payload and takes an
  // empty one as none (`jobTarget(job).workId || null`).
  it("reads the target Work of a zip job; null and an empty workId give the page no Work", () => {
    const zipPayload = { workId: W, doi: null, arxiv: null };
    expect(jobTarget({ payload: zipPayload }).workId || null).toBe(W);
    expect(jobTarget({ payload: null }).workId || null).toBeNull();
    expect(jobTarget({ payload: { workId: "" } }).workId || null).toBeNull();
  });
});

describe("the format values", () => {
  it("isJobFormat knows the two formats and nothing else", () => {
    expect(JOB_FORMATS).toEqual(["pdf", "arxiv-pdf"]);
    expect(isJobFormat(JOB_FORMAT.pdf)).toBe(true);
    expect(isJobFormat(JOB_FORMAT.arxivPdf)).toBe(true);
    for (const other of ["tex", "", null, undefined, 1, ["pdf"]])
      expect(isJobFormat(other)).toBe(false);
  });

  it("the switch prompt's format is this enum", () => {
    expect(JobFormatSchema.options).toEqual(["pdf", "arxiv-pdf"]);
    const job = { id: "upload-1", kind: "upload", status: "queued", workId: W, arxivId: null };
    expect(HostSwitchJobSchema.safeParse({ ...job, format: "arxiv-pdf" }).success).toBe(true);
    expect(HostSwitchJobSchema.safeParse({ ...job, format: null }).success).toBe(true);
    expect(HostSwitchJobSchema.safeParse({ ...job, format: "tex" }).success).toBe(false);
  });
});
