# Command line

Back to the [README](../../README.md). The command is `argelanderspace` (from the desktop app's
launcher, a global install of the packed package, or `node packages/app/dist/bin.js` in a source build; see
[Installation](installation.md)).

## Quickstart

```bash
argelanderspace serve          # → http://127.0.0.1:1859
```

Then ingest a paper and open it in the reader:

```bash
argelanderspace ingest 2501.17225            # arXiv id → LaTeX pipeline
argelanderspace library build                # seed + enrich the citation graph
```

To learn the workbench with the in-app tutorial in the browser, run
`argelanderspace tutorial`: it sets up (or resumes) the tutorial folder
`~/ArgelanderSpace-Tutorial` from the bundled sample, starts the server in it and
prints the address to open (`--dir <folder>` for another folder, `--reset` to
start over). In the desktop app the tutorial starts from the welcome page.

## CLI

The commands that exist since the first releases:

```
argelanderspace ingest <input>      arXiv id/URL | local .tex/dir/tarball | DOI (a Work without a Doc)
argelanderspace library build       rebuild the library (seed → enrich ADS▸Crossref▸OpenAlex → plan → graph)
                                    [--offline] [--bib refs.bib]
argelanderspace acquire <refs.bib>  add a .bib's works and print the acquisition plan
                                    [--dry-run] [--fetch] [--fetch-remaining] [--offline]
argelanderspace serve               API + web UI + WebSocket progress  [--port N] [--web-dist DIR]
argelanderspace tutorial            the in-app tutorial in the browser: set up or resume the tutorial
                                    folder and serve it  [--dir DIR] [--port N] [--reset]
argelanderspace agent-plugin        print the Claude Code Agent plugin's path and the two commands that
                                    install it (changes no configuration)
```

plus the reading commands (`search`, `list`, `read`, `show`, `ref`, `annot`,
`pdf-path`), `note`, `label` and `argument get|put` described under **Agent
integration**.

Since 0.2 every operation the Copilot has for the Library, reading, annotation,
ADS discovery and argument graphs is also a CLI command, derived from one
operation catalog, so the two entries do the same thing with the same
protection:

| Group | Commands |
|---|---|
| `library` | `read`, `set-main-doc`, `delete-doc`, `import-works`, `attach-local-pdf`, `list-ads-libraries`, `read-ads-library`, `acquire-arxiv-pdf`, `attach-arxiv`, `read-jobs` (and `build`, above) |
| `discovery` | `search-ads`, `explore` |
| `reader`, `text` | `reader read`, `read-image`, `read-svg-image`, `read-page-image`; `text read-source` |
| `annotation` | `create`, `update`, `delete` (LaTeX / text Docs); `create-pdf`, `update-pdf`, `delete-pdf` (PDF Docs) |
| `argument` | `read`, `create`, `update`, `delete`, `undo-delete`, `add-edge`, `remove-edge`, `replace`, `clear` (and `get`, `put`, above) |
| `open` | `doc`, `work`, `argument-graph` — ask the running workbench to show a place |

Each prints one JSON object (the operation's result) and exits 0 on success, 1
when the operation answered `ok: false`, 2 on invalid parameters, 3 when the
user refused a confirmation card, 4 when the workbench quit while a card was
waiting, 130 on Ctrl-C. When a workbench is running for the same data folder the
command is handed to it (one writer); otherwise it runs in its own process.
Something that needs a person's confirmation in the Copilot (deleting a Doc,
replacing a Doc's arXiv text, replacing or clearing an argument graph that has
arguments) shows the same card in the running workbench and the command waits
for the answer; without a workbench it answers `workbench_required` and does
nothing. `argelanderspace <group> --help` lists the options; the derivation
rules and the exit codes are in [docs/operation-catalog.md](../operation-catalog.md)
and the operation-to-command table is in [skills/README.md](../../skills/README.md).

Global option: `--data-dir <dir>` (may appear before or after the subcommand;
not taken by `tutorial`, whose data is the tutorial folder).
Useful ingest flags: `--no-assets` (skip figure materialization), `--no-cache`,
`-o out.json` (also write the stored IR — a `TexDocIr` document — to a path).
(`--figure-dpi` is still accepted for compatibility but ignored: figures are
vector SVG now.)
