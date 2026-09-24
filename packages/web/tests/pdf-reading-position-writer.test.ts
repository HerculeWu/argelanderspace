import { describe, expect, test, vi } from "vitest";
import type { PdfReadingLocation, PdfReadingPosition } from "@argelanderspace/contracts";
import type { ReadingPositionSaveResult } from "../src/api/pdf-reading-position";
import { PdfReadingPositionWriter } from "../src/doc/PdfReadingPositionWriter";

const docId = "pdf-12345678-1234-4234-8234-123456789abc";
const sha = "a".repeat(64);
const initial: PdfReadingPosition = { version: 1, doc_id: docId, content_sha256: sha, rev: 0, position: null };
const location = (y: number): PdfReadingLocation => ({ page_index: 2, x: 0.4, y });
function lastState(state: ReturnType<typeof vi.fn>) {
  return state.mock.calls[state.mock.calls.length - 1]?.[0];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve: (value: T) => resolve(value), reject: (reason?: unknown) => reject(reason) };
}
const ok = (rev: number, position: PdfReadingLocation): ReadingPositionSaveResult => ({ ok: true, file: { ...initial, rev, position } });

describe("PDF reading-position writer", () => {
  test("serializes PUTs and coalesces a delayed older scroll behind the latest location", async () => {
    const first = deferred<ReadingPositionSaveResult>();
    const calls: Array<{ rev: number; position: PdfReadingLocation }> = [];
    const put = vi.fn((candidate: PdfReadingPosition) => {
      calls.push({ rev: candidate.rev, position: candidate.position! });
      return calls.length === 1 ? first.promise : Promise.resolve(ok(candidate.rev + 1, candidate.position!));
    });
    const state = vi.fn();
    const writer = new PdfReadingPositionWriter(docId, sha, initial, state, put);
    writer.offer(location(0.2));
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    writer.offer(location(0.8));
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(1);
    first.resolve(ok(1, location(0.2)));
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(calls).toEqual([{ rev: 0, position: location(0.2) }, { rev: 1, position: location(0.8) }]);
    await vi.waitFor(() => expect(lastState(state)).toMatchObject({ saving: false, failed: false, saved: true, failure: null }));
  });

  test("flushes pending old-Doc position on stop without accepting late UI state", async () => {
    const wait = deferred<ReadingPositionSaveResult>();
    const state = vi.fn();
    const put = vi.fn((_file: PdfReadingPosition) => wait.promise);
    const writer = new PdfReadingPositionWriter(docId, sha, initial, state, put);
    writer.offer(location(0.25));
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    writer.offer(location(0.75));
    writer.stop();
    wait.resolve(ok(1, location(0.25)));
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1]?.[0]).toMatchObject({ rev: 1, position: location(0.75) });
    await Promise.resolve();
    expect(lastState(state)).not.toMatchObject({ saving: false, failed: false, saved: true });
  });

  test("keeps a newer same-revision scroll offered while the retry GET is delayed", async () => {
    const latest = deferred<PdfReadingPosition>();
    const put = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, status: 409, detail: "document busy" })
      .mockImplementationOnce(async (file: PdfReadingPosition): Promise<ReadingPositionSaveResult> => ok(file.rev + 1, file.position!));
    const get = vi.fn(() => latest.promise);
    const state = vi.fn();
    const writer = new PdfReadingPositionWriter(docId, sha, initial, state, put, get);
    writer.offer(location(0.2));
    await vi.waitFor(() => expect(lastState(state)).toMatchObject({ saving: false, failed: true, saved: false, failure: "write" }));
    const retrying = writer.retry();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    writer.offer(location(0.8));
    latest.resolve(initial);
    await retrying;
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1]?.[0]).toMatchObject({ rev: 0, position: location(0.8) });
    await vi.waitFor(() => expect(lastState(state)).toMatchObject({ saving: false, failed: false, saved: true, failure: null }));
  });

  test("retains new position B when a newer foreign revision stores old pending A", async () => {
    const latest = deferred<PdfReadingPosition>();
    const put = vi.fn(async (): Promise<ReadingPositionSaveResult> => ({ ok: false, status: 409, detail: "reading position rev mismatch", rev: 1 }));
    const get = vi.fn(() => latest.promise);
    const state = vi.fn();
    const writer = new PdfReadingPositionWriter(docId, sha, initial, state, put, get);
    writer.offer(location(0.2));
    await vi.waitFor(() => expect(lastState(state)).toMatchObject({ saving: false, failed: true, saved: false, failure: "revision-conflict" }));
    const retrying = writer.retry();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    writer.offer(location(0.8));
    latest.resolve({ ...initial, rev: 1, position: location(0.2) });
    await retrying;
    expect(put).toHaveBeenCalledTimes(1);
    expect(lastState(state)).toMatchObject({ saving: false, failed: true, saved: false, failure: "revision-conflict" });
    await writer.retry();
    expect(get).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(lastState(state)).toMatchObject({ saving: false, failed: true, saved: false, failure: "revision-conflict" });
  });

  test("recovers a valid remote position after an initial snapshot failure with no local pending edit", async () => {
    const recovered = vi.fn();
    const state = vi.fn();
    const latest = { ...initial, rev: 4, position: location(0.6) };
    const get = vi.fn(async () => latest);
    const put = vi.fn();
    const writer = new PdfReadingPositionWriter(docId, sha, null, state, put, get, recovered);
    const retrying = writer.retry();
    expect(lastState(state)).toMatchObject({ saving: true, failed: true, failure: "restore" });
    await retrying;
    expect(recovered).toHaveBeenCalledWith(latest);
    expect(put).not.toHaveBeenCalled();
    expect(lastState(state)).toMatchObject({ saving: false, failed: false, saved: false, failure: null });
  });

  test("stopped retry GET cannot report success or invoke recovery into a new Doc", async () => {
    const wait = deferred<PdfReadingPosition>();
    const state = vi.fn();
    const recovered = vi.fn();
    const put = vi.fn();
    const writer = new PdfReadingPositionWriter(docId, sha, null, state, put, () => wait.promise, recovered);
    const retrying = writer.retry();
    await vi.waitFor(() => expect(state).toHaveBeenCalledTimes(1));
    writer.stop();
    const stateCalls = state.mock.calls.length;
    wait.resolve({ ...initial, rev: 3, position: location(0.3) });
    await retrying;
    expect(state).toHaveBeenCalledTimes(stateCalls);
    expect(recovered).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  test("a rejected PUT becomes a distinct write failure without an unhandled rejection", async () => {
    const state = vi.fn();
    const put = vi.fn(async () => { throw new Error("offline"); });
    const writer = new PdfReadingPositionWriter(docId, sha, initial, state, put);
    writer.offer(location(0.4));
    await vi.waitFor(() => expect(lastState(state)).toMatchObject({ saving: false, failed: true, saved: false, failure: "write" }));
    expect(put).toHaveBeenCalledTimes(1);
  });

  test("an old Reader PUT sequence after a new Reader snapshot yields a distinct safe rev conflict", async () => {
    let serverFile = initial;
    const commit = (candidate: PdfReadingPosition): ReadingPositionSaveResult => {
      if (candidate.doc_id !== serverFile.doc_id || candidate.content_sha256 !== serverFile.content_sha256)
        return { ok: false, status: 409, detail: "document changed" };
      if (candidate.rev !== serverFile.rev)
        return { ok: false, status: 409, detail: "reading position rev mismatch", rev: serverFile.rev };
      serverFile = { ...candidate, rev: serverFile.rev + 1 };
      return { ok: true, file: serverFile };
    };
    const oldFirst = deferred<ReadingPositionSaveResult>();
    const oldPut = vi.fn((candidate: PdfReadingPosition) => oldPut.mock.calls.length === 1
      ? oldFirst.promise.then((result) => { if (result.ok) serverFile = result.file; return result; })
      : Promise.resolve(commit(candidate)));
    const oldState = vi.fn();
    const oldReader = new PdfReadingPositionWriter(docId, sha, initial, oldState, oldPut);
    oldReader.offer(location(0.2));
    await vi.waitFor(() => expect(oldPut).toHaveBeenCalledTimes(1));
    const newReaderSnapshot = { ...serverFile };
    oldReader.offer(location(0.3));
    oldFirst.resolve(commit({ ...initial, position: location(0.2) }));
    await vi.waitFor(() => expect(serverFile.rev).toBe(2));
    await vi.waitFor(() => expect(lastState(oldState)).toMatchObject({ failed: false, saved: true }));

    const newState = vi.fn();
    const newPut = vi.fn(async (candidate: PdfReadingPosition) => commit(candidate));
    const newReader = new PdfReadingPositionWriter(docId, sha, newReaderSnapshot, newState, newPut);
    newReader.offer(location(0.8));
    await vi.waitFor(() => expect(lastState(newState)).toMatchObject({ failed: true, saved: false, failure: "revision-conflict" }));
    expect(newPut).toHaveBeenCalledWith(expect.objectContaining({ rev: 0, position: location(0.8) }));
    expect(serverFile).toMatchObject({ rev: 2, position: location(0.3) });
    expect(lastState(newState)).not.toMatchObject({ saved: true });
  });

  test("retry re-reads binding and refuses to overwrite a foreign revision", async () => {
    const put = vi.fn(async (): Promise<ReadingPositionSaveResult> => ({ ok: false, status: 409, detail: "reading position rev mismatch", rev: 1 }));
    const get = vi.fn(async () => ({ ...initial, rev: 1, position: location(0.4) }));
    const state = vi.fn();
    const writer = new PdfReadingPositionWriter(docId, sha, initial, state, put, get);
    writer.offer(location(0.9));
    await vi.waitFor(() => expect(lastState(state)).toMatchObject({ saving: false, failed: true, saved: false, failure: "revision-conflict" }));
    await writer.retry();
    expect(get).toHaveBeenCalledWith(docId, sha);
    expect(put).toHaveBeenCalledTimes(1);
    expect(lastState(state)).toMatchObject({ saving: false, failed: true, saved: false, failure: "revision-conflict" });
  });
});
