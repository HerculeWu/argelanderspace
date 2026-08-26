/**
 * Bug-for-bug port of CPython 3.14 `difflib.SequenceMatcher`, reduced to the subset
 * `textfix` needs: construction with `isjunk=None` plus `get_opcodes()`.
 *
 * Ported line-by-line from the CPython 3.14.2 source so the produced opcodes are
 * identical (the textfix repairs depend on the exact diff alignment). Notes:
 *
 * - Operates on arrays of elements; textfix passes *code-point* arrays, matching
 *   Python's `str` indexing semantics (JS string indexing would be UTF-16 units).
 * - `isjunk` is always None here, so `bjunk` is always empty: the "purge junk" step
 *   and the two junk-sucking extension loops in `find_longest_match` are no-ops and
 *   are omitted (documented below). The autojunk "popular elements" heuristic IS
 *   ported — textfix enables it for large holders and it changes the opcodes.
 */

export type OpcodeTag = "replace" | "delete" | "insert" | "equal";

export interface Opcode {
  tag: OpcodeTag;
  i1: number;
  i2: number;
  j1: number;
  j2: number;
}

interface Triple {
  a: number;
  b: number;
  size: number;
}

/** `SequenceMatcher(None, a, b, autojunk=autojunk).get_opcodes()`. */
export function getOpcodes(a: string[], b: string[], autojunk: boolean): Opcode[] {
  return new SequenceMatcher(a, b, autojunk).opcodes();
}

class SequenceMatcher {
  private readonly a: string[];
  private readonly b: string[];
  /** for each element x in b: the indices into b where x appears (ascending) */
  private readonly b2j = new Map<string, number[]>();
  private matchingBlocks: Triple[] | undefined;

  constructor(a: string[], b: string[], autojunk: boolean) {
    this.a = a;
    this.b = b;
    // __chain_b: index b (junk purge omitted: isjunk is always None)
    for (let i = 0; i < b.length; i++) {
      const elt = b[i];
      if (elt === undefined) continue;
      const idxs = this.b2j.get(elt);
      if (idxs) idxs.push(i);
      else this.b2j.set(elt, [i]);
    }
    // Purge popular elements that are not junk
    const n = b.length;
    if (autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of this.b2j) {
        if (idxs.length > ntest) this.b2j.delete(elt);
      }
    }
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Triple {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    // find longest junk-free match
    // during an iteration of the loop, j2len[j] = length of longest junk-free
    // match ending with a[i-1] and b[j]
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const jIndices = b2j.get(a[i] ?? "") ?? [];
      for (const j of jIndices) {
        // a[i] matches b[j]
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // Extend the best by non-junk elements on each end. (The two junk-sucking
    // loops that follow in CPython are omitted: bjunk is always empty, so they
    // would never extend anything.)
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    return { a: besti, b: bestj, size: bestsize };
  }

  private getMatchingBlocks(): Triple[] {
    if (this.matchingBlocks !== undefined) return this.matchingBlocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
    const matchingBlocks: Triple[] = [];
    while (queue.length > 0) {
      const quad = queue.pop();
      if (!quad) break;
      const [alo, ahi, blo, bhi] = quad;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      // a[alo:i] vs b[blo:j] unknown
      // a[i:i+k] same as b[j:j+k]
      // a[i+k:ahi] vs b[j+k:bhi] unknown
      if (x.size > 0) {
        matchingBlocks.push(x);
        if (alo < x.a && blo < x.b) queue.push([alo, x.a, blo, x.b]);
        if (x.a + x.size < ahi && x.b + x.size < bhi) {
          queue.push([x.a + x.size, ahi, x.b + x.size, bhi]);
        }
      }
    }
    matchingBlocks.sort((x, y) => x.a - y.a || x.b - y.b || x.size - y.size);

    // collapse adjacent equal blocks
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Triple[] = [];
    for (const { a: i2, b: j2, size: k2 } of matchingBlocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1 > 0) nonAdjacent.push({ a: i1, b: j1, size: k1 });
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1 > 0) nonAdjacent.push({ a: i1, b: j1, size: k1 });
    nonAdjacent.push({ a: la, b: lb, size: 0 });
    this.matchingBlocks = nonAdjacent;
    return nonAdjacent;
  }

  opcodes(): Opcode[] {
    let i = 0;
    let j = 0;
    const answer: Opcode[] = [];
    for (const { a: ai, b: bj, size } of this.getMatchingBlocks()) {
      let tag: OpcodeTag | "" = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag !== "") answer.push({ tag, i1: i, i2: ai, j1: j, j2: bj });
      i = ai + size;
      j = bj + size;
      // the list of matching blocks is terminated by a sentinel with size 0
      if (size > 0) answer.push({ tag: "equal", i1: ai, i2: i, j1: bj, j2: j });
    }
    return answer;
  }
}
