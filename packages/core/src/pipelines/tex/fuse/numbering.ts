/**
 * Print-faithful numbering for the fuse layer (roadmap Q2 + MS1 memory).
 *
 * Sources of truth, in order:
 *  1. mathnum events (compiler's printed numbers, including \tag values) —
 *    joined to display-math environments BY ENV-BLOCK + ORDER (amsmath
 *    multi-row envs report their \end line, so line alignment is unsafe);
 *  2. `.aux \newlabel` numbers (labeled floats/sections/equations) — with
 *    hyperref brace-stripping ("\newlabel{…}{{{B}}…}" → "B");
 *  3. source counting (the degraded path — clean-compile fallback without
 *    events): counters per kind, resynced to the trailing integer of every
 *    aux number we do learn.
 *
 * Unnumbered displays (\[…\], starred envs, \nonumber rows) never get a
 * number (Q2: no self-produced 1..N).
 */
import type { TexMathnumEvent } from "../facts/events.js";

/** Strip balanced outer brace pairs: hyperref aux tag numbers ("{B}" → "B"). */
export function stripOuterBraces(s: string): string {
  let out = s.trim();
  for (;;) {
    if (!out.startsWith("{") || !out.endsWith("}")) return out;
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") depth--;
      if (depth === 0 && i < out.length - 1) {
        balanced = false; // outer pair closes early — not a wrapper
        break;
      }
      if (depth < 0) {
        balanced = false;
        break;
      }
    }
    if (!balanced || depth !== 0) return out;
    out = out.slice(1, -1).trim();
  }
}

/** The trailing integer of a printed number ("2.3" → 3, "A12" → 12), if any. */
function trailingInt(s: string): number | null {
  const m = /(\d+)\s*$/.exec(s);
  return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : null;
}

/** Increment the trailing integer, keeping any prefix ("2.3" → "2.4"). */
function bumpTrailingInt(s: string): string | null {
  const m = /^(.*?)(\d+)$/.exec(s);
  if (m?.[2] === undefined) return null;
  return `${m[1]}${Number.parseInt(m[2], 10) + 1}`;
}

/**
 * A counted fallback counter with aux resync: `assign(auxNumber)` returns
 * the aux number when given (and resyncs the counter), else the counter's
 * next value.
 */
export class FallbackCounter {
  private current: string | null = null;
  private started = false;
  /** Section counters restart as letters after \appendix. */
  appendixMode = false;

  /** Advance and return the next counted value. */
  next(): string {
    if (!this.started) {
      this.started = true;
      this.current = this.appendixMode ? "A" : "1";
      return this.current;
    }
    if (this.current === null) {
      this.current = this.appendixMode ? "A" : "1";
      return this.current;
    }
    if (this.appendixMode) {
      const c = this.current;
      this.current = /^[A-Z]$/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 1) : "A";
      return this.current;
    }
    const bumped = bumpTrailingInt(this.current);
    this.current = bumped ?? String((trailingInt(this.current) ?? 0) + 1);
    return this.current;
  }

  /** Resync to a compiler-known number (returns it). */
  resync(printed: string): string {
    this.started = true;
    this.current = printed;
    return printed;
  }
}

/**
 * Cursor over the mathnum events. Display math can't float, so event order
 * is source order; each display env consumes exactly the events its rows
 * printed (the caller computes per-row expectations from the source:
 * \nonumber rows and \tag* rows emit no event).
 */
export class MathnumAssigner {
  private idx = 0;
  constructor(private readonly events: readonly TexMathnumEvent[]) {}

  get exhausted(): boolean {
    return this.idx >= this.events.length;
  }

  /** Peek the next event without consuming. */
  peek(): TexMathnumEvent | undefined {
    return this.events[this.idx];
  }

  /**
   * Consume one event expected to belong to `env`. On an env mismatch the
   * stream is desynced: warn, don't consume, and return undefined (the
   * caller falls back to aux/counting for this number; a spurious event is
   * then skipped on the next call's resync attempt).
   */
  take(env: string, warnings: string[]): string | undefined {
    const ev = this.events[this.idx];
    if (ev === undefined) return undefined;
    if (ev.env !== env) {
      // one-shot resync: if the NEXT event matches, the current one was
      // spurious (e.g. a leftover from a construct we don't model) — skip it.
      const next = this.events[this.idx + 1];
      if (next !== undefined && next.env === env) {
        warnings.push(
          `mathnum join: skipped spurious event ${ev.id} (env ${ev.env}, number "${ev.number}") while expecting ${env}`
        );
        this.idx++;
        return this.take(env, warnings);
      }
      warnings.push(
        `mathnum join desync: expected env ${env}, next event is ${ev.env} ("${ev.number}", ${ev.file ?? "?"}:${ev.line}); this env falls back to aux/counting`
      );
      return undefined;
    }
    this.idx++;
    return ev.number;
  }
}

/** Format the display number of a multi-row env from its printed row numbers. */
export function displayNumber(numbers: readonly string[]): string | undefined {
  if (numbers.length === 0) return undefined;
  if (numbers.length === 1) return numbers[0];
  const ints = numbers.map((n) => (/^\d+$/.test(n) ? Number.parseInt(n, 10) : null));
  const contiguous = ints.every((n, i) => n !== null && (i === 0 || n === (ints[i - 1] ?? 0) + 1));
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  if (contiguous && first !== undefined && last !== undefined) return `${first}–${last}`;
  return numbers.join(",");
}
