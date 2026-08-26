/**
 * Publisher-HTML ingestion (port of `bibgraph/ingest_html/__init__.py` +
 * `pipeline_html.py`): per-publisher adapters (A&A, OUP), the shared inline
 * renderer, and the pipeline composition. Importing this module registers the
 * adapters (like the Python package's import-time side effects).
 */

// Importing the adapter modules populates the registry (base.HTML_ADAPTERS).
export { aandaAdapter, cleanTableHtml, urlJoin } from "./aanda.js";
export * from "./base.js";
export * from "./dom.js";
export * from "./inline.js";
export * from "./mathml.js";
export { oupAdapter } from "./oup.js";
export * from "./pipeline.js";
export * from "./ports.js";
export * from "./serialize.js";
export * from "./source.js";
