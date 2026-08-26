/**
 * Port of `bibgraph/ingest_latex/assets.py`: the production {@link AssetResolver}
 * — core's resolver (locate / within-guard / out_name / cache) wired to the real
 * mupdf + Ghostscript rasterizers from `pdf/raster.ts`. Kept as a subclass so the
 * M2 API (`new AssetResolver(srcDir, assetDir, { dpi, … })`) is unchanged.
 */

import {
  type AssetResolverOptions,
  AssetResolver as CoreAssetResolver,
} from "@argelanderspace/core";
import { epsToPng, pdfToPng } from "../pdf/raster.js";

/** Resolves a graphics path argument to a served asset basename (cached). */
export class AssetResolver extends CoreAssetResolver {
  constructor(srcDir: string, assetDir: string, opts: Omit<AssetResolverOptions, "raster"> = {}) {
    super(srcDir, assetDir, { ...opts, raster: { pdfToPng, epsToPng } });
  }
}

export type { AssetResolverOptions };
