# SVG import command (development only)

Run from the repository root with Node 24+ and the workspace's development dependencies installed:

```sh
node packages/web/scripts/svg-import.ts --source <pack> --confirmation <confirmed-pack.json> > audit.json
node packages/web/scripts/svg-import.ts normalize --source <pack> --confirmation <confirmed-pack.json> --destination <private-staging>
node packages/web/scripts/svg-import.ts promote --source <pack> --confirmation <confirmed-pack.json> --selection <selection.json> --destination <isolated-resources>
```

Omitting the operation selects read-only `audit`. JSON reports go to stdout; errors go to stderr with exit 1. Redirect reports only to private, non-source locations. `normalize` copies technically safe resources (even if permission is unconfirmed); `promote` requires every selected input to be both safe and confirmed. Ineligible **unselected** files remain visible in the report without blocking valid selections. Counts of stroke/fill-only inputs overlap technical outcome counts; malformed inputs may have no artwork classification.

## Inputs

The approved current Dazzle Line Icons pack uses one explicit, private confirmation record:

```json
{
  "pack": "dazzle-line-icons",
  "evidence": "user-confirmed",
  "files": { "arrow-left.svg": "<SHA-256 of the original file bytes>" }
}
```

Its author, collection URL and unspecified-version CC Attribution reference are prefilled by the command. This record represents the owner's permission evidence, **not** a license discovered by the tool. Record only the filenames/hashes actually covered by that confirmation. Changed or future files do not inherit it. Other packs/permission records are not supported by this bounded tool. No network verification occurs.

Selection is a non-empty array, with relative source filenames and existing `data-ui` identifiers (plus a variant where appropriate):

```json
[
  { "file": "arrow-left.svg", "uiId": "previous-pdf-page" },
  { "file": "moon.svg", "uiId": "toggle-theme", "variant": "moon" }
]
```

Duplicate/conflicting mappings and single-icon ↔ variant-map replacement are rejected. Other catalog entries/variants are retained. Original bytes, coordinates and the fixed 24×24 canvas are never rewritten. AppleDouble files and source symlinks are not scanned. An explicitly supplied audit destination is excluded from scanning; mutating destinations must be separate from the source, including symlink aliases.

## Outputs and publication boundary

Use **dedicated private output directories**. `normalize` replaces its output directory with safe SVG copies and `report.json`. `promote` creates/updates `icons.json`, `icons.provenance.json` and `THIRD_PARTY_LICENSES.md`, preserving other destination files and notices. Destination symlinks/special entries are refused. Each selected resource must pass the same `parseIconSvg` implementation used by the product; its allowlist and 4096-character limit are unchanged. Only harmless UTF-8 XML declarations/comments and root download dimensions are removed. Unsafe content is rejected, not erased. Explicit stroke widths become trusted-preset-owned; fill-only shapes never receive a stroke. No geometry redraw/cropping occurs.

All selection/provenance/notice validation and file writes complete in a sibling stage before publication. Directory renames publish the complete bundle; a caught publication failure restores the old directory. This is **not** a concurrent-reader or power-loss transaction: there is a brief rename gap, concurrent writers are unsupported, and a process crash can leave `.<destination-name>.svg-import-backup` next to the destination. The next run refuses an existing backup. Stop and explicitly inspect/restore that preserved directory; do not discard it blindly. Synthetic command tests cover selected-item rejection, staging refusal, byte preservation and repeatability, not every filesystem crash/rollback failure.

The selected bundle alone can be previewed/built without importing or serving the full source/staging pack. It is not an application icon migration. First production adoption must retain the approved catalog location, merge the generated attribution block into the root `THIRD_PARTY_LICENSES.md`, and carry that notice into Web/app outputs via their existing asset-copy flow. That later delivery gate must be verified separately; do not claim a repository-only notice or this isolated bundle completes product attribution delivery.
