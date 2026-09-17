/**
 * Zod schemas for the ADS literature-discovery payload
 * (`GET /api/library/discovery`, Stage 14).
 *
 * The Discovery graph is a *temporary* read-only projection: one ADS seed
 * plus `similar()` (related) and `useful()` (methods/foundations) candidates,
 * with edges that mean exactly one thing — a real citation between two
 * visible nodes. It deliberately does NOT reuse `GraphNodeSchema`: that
 * schema belongs to the persistent Library citation graph and lacks the
 * bibliographic detail the discovery inspector needs.
 *
 * Raw `references` lists are provider data used server-side to derive edges;
 * they are intentionally absent from this wire contract.
 */

import { z } from "zod";

/** Why a paper is present: the origin, an ADS similar() hit, an ADS useful() hit. */
export const DiscoveryRoleSchema = z.enum(["seed", "related", "useful"]);

export const DiscoveryPaperSchema = z.object({
  bibcode: z.string(),
  title: z.string(),
  /** Display-preserving author strings (not reduced to family names). */
  authors: z.array(z.string()),
  year: z.number().int().nullable(),
  venue: z.string().nullable(),
  abstract: z.string().nullable(),
  citationCount: z.number().int().nullable(),
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  roles: z.array(DiscoveryRoleSchema),
  /** ADS similar() return order (1-based), when this is a related hit. */
  relatedRank: z.number().int().positive().optional(),
  /** ADS useful() return order (1-based), when this is a useful hit. */
  usefulRank: z.number().int().positive().optional(),
  /**
   * Persistent Library work id when already saved, else null. `libraryId
   * !== null` is the single source of truth for "in library" — no separate
   * boolean is duplicated.
   */
  libraryId: z.string().nullable(),
});

/** One real citation: `from` (citing) → `to` (cited). The only edge kind. */
export const DiscoveryEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.literal("citation"),
});

/** Partial-degradation signals; the graph is still usable. */
export const DiscoveryWarningSchema = z.object({
  code: z.enum(["useful_unavailable"]),
});

export const DiscoveryGraphSchema = z.object({
  version: z.literal(1),
  provider: z.literal("ads"),
  /** Seed ADS bibcode. */
  seed: z.string(),
  nodes: z.array(DiscoveryPaperSchema),
  edges: z.array(DiscoveryEdgeSchema),
  warnings: z.array(DiscoveryWarningSchema),
});

// --------------------------------------------------------------------------- //
// Inferred types
// --------------------------------------------------------------------------- //

export type DiscoveryRole = z.infer<typeof DiscoveryRoleSchema>;
export type DiscoveryPaper = z.infer<typeof DiscoveryPaperSchema>;
export type DiscoveryEdge = z.infer<typeof DiscoveryEdgeSchema>;
export type DiscoveryWarning = z.infer<typeof DiscoveryWarningSchema>;
export type DiscoveryGraph = z.infer<typeof DiscoveryGraphSchema>;
