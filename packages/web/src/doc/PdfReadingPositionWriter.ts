import type { PdfReadingLocation, PdfReadingPosition } from "@argelanderspace/contracts";
import { fetchPdfReadingPosition, samePdfReadingLocation, savePdfReadingPosition } from "../api/pdf-reading-position";

type PutPosition = (file: PdfReadingPosition) => Promise<import("../api/pdf-reading-position").ReadingPositionSaveResult>;
type GetPosition = (docId: string, sha256: string) => Promise<PdfReadingPosition>;
export type PositionWriterFailure = "restore" | "read" | "revision-conflict" | "content-changed" | "write";
export type PositionWriterState = {
  saving: boolean;
  failed: boolean;
  saved: boolean;
  failure: PositionWriterFailure | null;
};

/** Serializes scroll saves and refuses to replay local positions across a foreign revision. */
export class PdfReadingPositionWriter {
  private revision: number;
  private pending: PdfReadingLocation | null = null;
  private inFlight = false;
  private retrying = false;
  private stopped = false;
  private failure: PositionWriterFailure | null;

  constructor(
    readonly docId: string,
    readonly contentSha256: string,
    initial: PdfReadingPosition | null,
    private readonly onState: (state: PositionWriterState) => void,
    private readonly put: PutPosition = savePdfReadingPosition,
    private readonly get: GetPosition = fetchPdfReadingPosition,
    private readonly onRecovered: (file: PdfReadingPosition) => void = () => undefined,
  ) {
    this.revision = initial?.rev ?? 0;
    this.failure = initial === null ? "restore" : null;
  }

  offer(position: PdfReadingLocation): void {
    if (this.stopped) return;
    this.pending = position;
    if (this.failure === null) void this.pump();
  }

  /** Flush the final Doc-bound location on unmount without publishing into a later session. */
  stop(finalPosition?: PdfReadingLocation): void {
    if (finalPosition && this.failure === null) this.pending = finalPosition;
    this.stopped = true;
    if (this.pending && this.failure === null) void this.pump();
  }

  /** Re-read before retry; preserve new local movement and never overwrite a foreign rev. */
  retry = async (): Promise<void> => {
    if (this.stopped || this.retrying) return;
    this.retrying = true;
    const failureAtStart = this.failure;
    this.onState({ saving: true, failed: this.failure !== null, saved: false, failure: this.failure });
    try {
      const latest = await this.get(this.docId, this.contentSha256);
      if (this.stopped) return;

      // Read the newest location only after GET settles. offer() may have replaced it
      // while the remote snapshot was in flight.
      const pending = this.pending;
      if (latest.rev < this.revision) {
        this.failure = "revision-conflict";
        this.onState({ saving: false, failed: true, saved: false, failure: this.failure });
        return;
      }

      if (latest.rev > this.revision && pending !== null && samePdfReadingLocation(latest.position, pending)) {
        // The server already contains exactly the newest desired location (e.g. a
        // PUT committed but its response was lost); acknowledge, do not write again.
        this.revision = latest.rev;
        this.pending = null;
        this.failure = null;
        this.onState({ saving: false, failed: false, saved: true, failure: null });
        return;
      }

      if (latest.rev > this.revision && pending !== null) {
        // A newer foreign position differs from the user's latest movement. Keep
        // that movement available for another explicit resolution; never replay A.
        this.failure = "revision-conflict";
        this.onState({ saving: false, failed: true, saved: false, failure: this.failure });
        return;
      }

      this.revision = latest.rev;
      this.failure = null;
      if (pending === null) this.onRecovered(latest);
      this.onState({ saving: false, failed: false, saved: false, failure: null });
      if (pending !== null) void this.pump();
    } catch {
      if (!this.stopped) {
        this.failure = failureAtStart === "restore" ? "restore" : "read";
        this.onState({ saving: false, failed: true, saved: false, failure: this.failure });
      }
    } finally {
      this.retrying = false;
    }
  };

  private pump = async (): Promise<void> => {
    if (this.inFlight || this.failure !== null || !this.pending) return;
    this.inFlight = true;
    if (!this.stopped) this.onState({ saving: true, failed: false, saved: false, failure: null });
    try {
      while (this.pending && this.failure === null) {
        const current = this.pending;
        this.pending = null;
        let result: Awaited<ReturnType<PutPosition>>;
        try {
          result = await this.put({
            version: 1,
            doc_id: this.docId,
            content_sha256: this.contentSha256,
            rev: this.revision,
            position: current,
          });
        } catch (error) {
          result = { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
        }
        if (!result.ok) {
          this.pending = this.pending ?? current;
          this.failure = result.status === 409 && result.detail === "reading position rev mismatch"
            ? "revision-conflict"
            : result.status === 409 && result.detail === "document changed"
              ? "content-changed"
              : "write";
          break;
        }
        this.revision = result.file.rev;
      }
    } finally {
      this.inFlight = false;
      if (!this.stopped) this.onState({ saving: false, failed: this.failure !== null, saved: this.failure === null && this.pending === null, failure: this.failure });
    }
  };
}
