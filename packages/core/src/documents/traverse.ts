/**
 * Reading-order traversal of the section tree (Section.iter_blocks /
 * Section.iter_sections / Document.iter_blocks / Document.iter_sections in
 * bibgraph/schema.py).
 */

import type { Block, Document, Section } from "@argelanderspace/contracts";

/** Yield every section in the document's structure tree, depth-first, in reading order. */
export function* iterSections(doc: Pick<Document, "structure">): Generator<Section> {
  for (const s of doc.structure ?? []) {
    yield* walkSections(s);
  }
}

function* walkSections(section: Section): Generator<Section> {
  yield section;
  for (const c of section.children ?? []) {
    yield* walkSections(c);
  }
}

/** Yield every block in the document, in reading order. */
export function* iterBlocks(doc: Pick<Document, "structure">): Generator<Block> {
  for (const s of doc.structure ?? []) {
    yield* iterSectionBlocks(s);
  }
}

/** Yield every block in one section subtree, in reading order. */
export function* iterSectionBlocks(section: Section): Generator<Block> {
  yield* section.blocks ?? [];
  for (const c of section.children ?? []) {
    yield* iterSectionBlocks(c);
  }
}
