/**
 * Compiler-facts aggregation (Stage 5 MS1).
 *
 * The compile port collects the engine-agnostic artifacts of a latexmk run
 * into a build dir; this module turns them into one facts object for the
 * fusion layer (MS2). Every per-file parse degrades instead of throwing:
 * a missing artifact is simply absent, a read/parse failure becomes a
 * warning entry.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseAux, type TexAuxFacts } from "./aux.js";
import { parseBbl, type TexBblFacts, type TexReferenceFact } from "./bbl.js";
import { parseTexEvents, type TexEvent, type TexEventStream } from "./events.js";
import { parseFls } from "./fls.js";
import { parseToc, type TexTocEntry } from "./toc.js";

export { parseAux, type TexAuxFacts, type TexLabelFact } from "./aux.js";
export { parseBbl, type TexBblFacts, type TexReferenceFact } from "./bbl.js";
export {
  parseTexEvents,
  type TexCitationEvent,
  type TexEvent,
  type TexEventStream,
  type TexLabelEvent,
  type TexMathnumEvent,
  type TexSectionEvent,
} from "./events.js";
export { parseFls } from "./fls.js";
export { parseToc, type TexTocEntry } from "./toc.js";

/** Artifact paths to read (subset of `TexArtifacts` from `../ports.js`). */
export interface TexFactFiles {
  aux?: string;
  bbl?: string;
  toc?: string;
  /** .lof/.lot: the compiler's printed figure/table numbers (float truth). */
  lof?: string;
  lot?: string;
  fls?: string;
  events?: string;
}

export interface TexFacts {
  labels: TexAuxFacts["labels"];
  citations: string[];
  bibcites: Record<string, string>;
  toc: TexTocEntry[];
  /** .lof entries: figures in printed order with their true numbers. */
  lof: TexTocEntry[];
  /** .lot entries: tables in printed order with their true numbers. */
  lot: TexTocEntry[];
  /** Normalized, deduped INPUT path list from the -recorder .fls. */
  inputs: string[];
  references: TexReferenceFact[];
  events: TexEvent[];
  /** Per-file degradations, prefixed with the artifact basename. */
  warnings: string[];
}

function readLossy(path: string): string {
  return new TextDecoder("utf-8").decode(readFileSync(path));
}

export function parseTexFacts(files: TexFactFiles): TexFacts {
  const facts: TexFacts = {
    labels: {},
    citations: [],
    bibcites: {},
    toc: [],
    lof: [],
    lot: [],
    inputs: [],
    references: [],
    events: [],
    warnings: [],
  };

  const read = (path: string | undefined): { name: string; content: string } | null => {
    if (path === undefined) return null;
    try {
      return { name: basename(path), content: readLossy(path) };
    } catch (err) {
      // An absent artifact (no .toc without \tableofcontents, no .bbl without
      // a bibliography) is normal — silent. Anything else is a real problem.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        facts.warnings.push(`${basename(path)}: unreadable (${String(err)})`);
      }
      return null;
    }
  };

  const aux = read(files.aux);
  if (aux) {
    try {
      const parsed = parseAux(aux.content);
      facts.labels = parsed.labels;
      facts.citations = parsed.citations;
      facts.bibcites = parsed.bibcites;
      // float print-truth: real .lof/.lot files when present, else the
      // \@writefile records embedded in the .aux
      facts.lof = parsed.lof;
      facts.lot = parsed.lot;
    } catch (err) {
      facts.warnings.push(`${aux.name}: .aux parse failed (${String(err)})`);
    }
  }

  const bbl = read(files.bbl);
  if (bbl) {
    try {
      const parsed: TexBblFacts = parseBbl(bbl.content);
      facts.references = parsed.references;
      for (const w of parsed.warnings) facts.warnings.push(`${bbl.name}: ${w}`);
    } catch (err) {
      facts.warnings.push(`${bbl.name}: .bbl parse failed (${String(err)})`);
    }
  }

  const toc = read(files.toc);
  if (toc) {
    try {
      facts.toc = parseToc(toc.content);
    } catch (err) {
      facts.warnings.push(`${toc.name}: .toc parse failed (${String(err)})`);
    }
  }

  const lofFile = read(files.lof);
  if (lofFile) {
    try {
      facts.lof = parseToc(lofFile.content); // real file overrides aux-derived
    } catch (err) {
      facts.warnings.push(`${lofFile.name}: .lof parse failed (${String(err)})`);
    }
  }

  const lotFile = read(files.lot);
  if (lotFile) {
    try {
      facts.lot = parseToc(lotFile.content);
    } catch (err) {
      facts.warnings.push(`${lotFile.name}: .lot parse failed (${String(err)})`);
    }
  }

  const fls = read(files.fls);
  if (fls) {
    try {
      facts.inputs = parseFls(fls.content);
    } catch (err) {
      facts.warnings.push(`${fls.name}: .fls parse failed (${String(err)})`);
    }
  }

  const events = read(files.events);
  if (events) {
    try {
      const parsed: TexEventStream = parseTexEvents(events.content);
      facts.events = parsed.events;
      for (const w of parsed.warnings) facts.warnings.push(`${events.name}: ${w}`);
    } catch (err) {
      facts.warnings.push(`${events.name}: .argelander.jsonl parse failed (${String(err)})`);
    }
  }

  return facts;
}
