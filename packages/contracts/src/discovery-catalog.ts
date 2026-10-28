/**
 * Discovery-domain entries of the operation catalog (release-0.2 ticket 09): the read-only ADS search and the
 * exploration read. Interface actions of the explore page (`filter_discovery`, `set_discovery_tab`, `select_candidate`,
 * `step_exploration`, graph controls, ...) and the bound-view observation `read_discovery` are NOT here: they only
 * change or report what one browser tab shows (docs/operation-catalog.md). `save_candidate` is not here either: it is
 * the import of a paper into the library, bound to the candidates of the exploration a tab has open (Copilot only), and
 * the catalog's route to the same write is the library domain's import.
 */
import { z } from "zod";
import { DiscoveryGraphSchema } from "./discovery.js";
import { DiscoverySearchAdsSchema } from "./discovery-ops.js";
import { defineOperation } from "./operation-def.js";

/** Why a discovery read gave no answer; told apart on purpose. Neither carries the token. */
export const DiscoveryFailureResultSchema = z
  .object({
    ok: z.literal(false),
    status: z.enum(["error", "not_found", "unsupported", "interrupted"]),
    reason: z.enum([
      "no_token",
      "unauthorized",
      "rate_limited",
      "bad_query",
      "timeout",
      "unreachable",
      "invalid_response",
      "not_found",
      "unavailable",
      "stopped",
    ]),
    detail: z.string(),
    http: z.number().int().optional(),
    retryAfter: z.string().optional(),
  })
  .strict();

export const DiscoverySearchRecordSchema = z
  .object({
    bibcode: z.string(),
    title: z.string().optional(),
    authors: z.array(z.string()).optional(),
    authorCount: z.number().int().nonnegative().optional(),
    year: z.number().int().optional(),
    venue: z.string().optional(),
    citationCount: z.number().int().optional(),
    doi: z.string().optional(),
    arxivId: z.string().optional(),
    abstract: z.string().optional(),
    abstractTruncated: z.literal(true).optional(),
  })
  .strict();

export const DiscoverySearchAdsResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      status: z.literal("ok"),
      query: z.string(),
      /** How many records match in ADS; `returned` is how many are listed. */
      numFound: z.number().int().nonnegative(),
      returned: z.number().int().nonnegative(),
      records: z.array(DiscoverySearchRecordSchema),
    })
    .strict(),
  DiscoveryFailureResultSchema,
]);

export const DiscoveryExploreResultSchema = z.union([
  z.object({ ok: z.literal(true), status: z.literal("ok"), graph: DiscoveryGraphSchema }).strict(),
  DiscoveryFailureResultSchema,
]);

export const DISCOVERY_SEARCH_ADS_OPERATION = defineOperation({
  domain: "discovery",
  name: "search_ads",
  summary:
    "Search ADS read-only by query string (--query, --limit up to 50, --fields comma-separated); lists records, saves nothing.",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: DiscoverySearchAdsSchema.omit({ action: true }),
  result: DiscoverySearchAdsResultSchema,
});

/** The seed's exploration data (the explore page's own request), as data and without any page. */
export const DISCOVERY_EXPLORE_OPERATION = defineOperation({
  domain: "discovery",
  name: "explore",
  summary:
    "Read the ADS exploration of one paper (--bibcode): the paper, its related and useful papers and the citations among them, marked with the library works they already are. Saves nothing.",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: z.object({ bibcode: z.string().min(1).max(64) }).strict(),
  result: DiscoveryExploreResultSchema,
});
