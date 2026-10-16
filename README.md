# ArgelanderSpace

Ingest research papers into a structured **render IR** — section tree,
floats (figures / tables / equations / code / algorithms), a structured
bibliography, and natively segmented citations and cross-references — and manage
them in a **citation-graph library** with a local **reader workspace** (web UI
with document reader, per-document **annotations** (text/structure/whole-doc
targets with Markdown+math bodies), force-directed citation graph, **ADS-powered
literature discovery** (one seed paper → ADS similar + useful candidates on a
real-citation graph), **manual entry creation** (identifier / ADS bibcode /
BibTeX batch) with **automatic arXiv full-text import** when the entry has an
arXiv id, and live ingest progress over WebSocket).

One ingestion pipeline emits the IR:

| Pipeline | Input | Status |
|---|---|---|
| **arXiv LaTeX** | arXiv id / URL / local `.tex` / dir / tarball | ✅ the working fully-automatic source |

PDF (MinerU OCR) and publisher-HTML ingestion are **in development** — the code
is archived on the `ocr-features` branch and not part of `main` right now.

Each source tree is compiled in an isolated workspace (latexmk, pdflatex
first with an automatic xelatex retry) and fused with its own source AST
(unified-latex): the compiler's artifacts (.aux/.bbl/.toc/.fls plus an
instrumentation event stream of citations/labels/sections/equation numbers)
anchor print-faithful numbering — displayed numbers are the paper's true
printed numbers; unnumbered displays get none. Compile failures surface with
the error taxonomy and the `!`-line log excerpt. Figures materialize to SVG
via `pdftocairo` (poppler; Ghostscript for EPS) — optional; missing or failed
conversions degrade the figure gracefully, never the ingest. No Python anywhere.

ArgelanderSpace is a local single-user tool: the server binds `127.0.0.1` and
there is no authentication. LLM agents integrate through the CLI plus the pi
skills in `skills/` — see **Agent integration (skills)** below.

## Requirements

- **Node.js ≥ 24**
- **TeX** (TeX Live or MiKTeX: `latexmk` + `pdflatex`/`xelatex` +
  `bibtex`/`biber`) — required for LaTeX ingest and Writer rendering. It is
  **not installed with the app**; install it yourself. Everything else
  (reading PDFs, annotations, plans, mail, Copilot) works without it.
- Optional: **poppler-utils** (`pdftocairo`; vector PDF figures → SVG) and
  **ghostscript** (`gs`; EPS figures) — figures degrade without them, ingests
  still succeed.
- Optional (Linux): **bubblewrap** (`bwrap`) — the Writer's compile sandbox.
  Without it the Copilot never triggers a compile; pressing Render yourself
  still compiles (outside a sandbox).

How the app finds TeX: first the **TeX program directory** set in Settings →
TeX & environment (`tex_dir` in `config.toml`), then `PATH`, then the usual
install locations — macOS: MacTeX (`/Library/TeX/texbin`) and Homebrew
(`/opt/homebrew/bin`, `/usr/local/bin`); Windows: TeX Live
(`C:\texlive\<year>\bin\windows`), MiKTeX and Ghostscript's install folder.
On Windows a program is found by the `PATHEXT` extensions (`latexmk.exe`). The
directory TeX was found in is put first on latexmk's `PATH`. A changed
`tex_dir` applies to the next check and the next compile without a restart.
Linux is the only platform this was tested on; the macOS and Windows lookup is
implemented and unit-checked with constructed layouts, not tried on those
platforms.

Where to see what is missing: Settings → **TeX & environment** lists each
program (found or not, where, its version line, and what is unavailable
without it) and whether the system keychain can be used; "Check again" re-runs
it (`GET /api/environment`).

## Installing the desktop app

The desktop app carries its own Node, so it needs nothing but TeX (above) for
LaTeX ingest. Packages are on the repository's GitHub Releases page, for four
platforms: Linux x64 (`.deb` and `.AppImage`), macOS on Apple silicon and on
Intel (`.dmg`, `aarch64` and `x64`) and Windows x64 (the installer
`ArgelanderSpace_<version>_x64-setup.exe`). There is no automatic update:
install a newer package over the old one; your settings, credentials, logs
and recent projects live in your user folders and stay.

**Linux.** `sudo apt install ./argelanderspace_<version>_amd64.deb` (it pulls
in WebKitGTK; remove with `sudo apt remove argelanderspace`), or make the
`.AppImage` executable (`chmod +x`) and run it. The AppImage needs FUSE 2
(`libfuse2`, `libfuse2t64` on Ubuntu 24.04); without it, start it with
`--appimage-extract-and-run`. The AppImage does not offer the command-line
tool (Settings → Command line & agents says so): it runs from a temporary
folder that is gone once the app closes, so a tool installed from it would
stop working. Use the `.deb`, or the npm package, if agents should use the
app's CLI.

### macOS and Windows

The packages are **not signed** by Apple or Microsoft (the project has no
signing certificates), so both systems stop the app the first time. That is
expected; this is how to let it open:

**macOS.** Open the `.dmg` and drag the app into Applications. The app is
signed ad hoc (locally, not by a known developer), so the first start is
refused ("Apple could not verify …" / "… cannot be opened").

1. Click **Done** (or **OK**) in that message.
2. Open **System Settings → Privacy & Security**, scroll to **Security**, find
   the line about the app and click **Open Anyway**; confirm with your password
   or Touch ID, then **Open Anyway** once more in the next message.
3. From then on it opens normally. On macOS 14 and earlier, Control-click the
   app in Applications and choose **Open**, then **Open** again, does the same.

If you prefer the Terminal: `xattr -dr com.apple.quarantine
/Applications/ArgelanderSpace.app` removes the download mark from that app
only (do this only for a package you downloaded from this repository's
Releases page).

*Not yet confirmed on a real Mac:* after an update the system may ask again
whether the app may use the items it saved in your keychain (the ADS token and
mail passwords), because an app that is not signed by a known developer can
look like a new app after each update. What to choose there, and what the app
does if you deny, will be written here once it has been tried on a Mac.

**Windows.** Run the installer `.exe`. It installs for your user only (no
administrator rights). SmartScreen may say "Windows protected your PC": click
**More info**, check that the app is ArgelanderSpace, then **Run anyway**.
To remove it, use **Settings → Apps**, or run `uninstall.exe` in
`%LOCALAPPDATA%\ArgelanderSpace`.

## Quickstart

```bash
npx argelanderspace serve          # → http://127.0.0.1:1859
```

Then ingest a paper and open it in the reader:

```bash
npx argelanderspace ingest 2501.17225            # arXiv id → LaTeX pipeline
npx argelanderspace library build                # seed + enrich the citation graph
```

## CLI

```
argelanderspace ingest <input>      arXiv id/URL | local .tex/dir/tarball
argelanderspace library build       rebuild the library (seed → enrich ADS▸Crossref▸OpenAlex → plan → graph)
                                    [--offline] [--bib refs.bib]
argelanderspace acquire <refs.bib>  add a .bib's works and print the acquisition plan
                                    [--dry-run] [--fetch] [--fetch-remaining] [--offline]
argelanderspace serve               API + web UI + WebSocket progress  [--port N] [--web-dist DIR]
```

Global option: `--data-dir <dir>` (may appear before or after the subcommand).
Useful ingest flags: `--no-assets` (skip figure materialization), `--no-cache`,
`-o out.json` (also write the stored IR — a `TexDocIr` document — to a path).
(`--figure-dpi` is still accepted for compatibility but ignored: figures are
vector SVG now.)

## Agent integration (skills)

LLM agents (pi-style CLI agents) drive ArgelanderSpace through the same CLI —
no MCP. The repo ships three pi skills under `skills/` that encode the
workflows, plus one self-contained skill that finds new papers on NASA ADS:

| Skill | What it does |
|---|---|
| `argelander-paper-ingest` | arXiv id / local LaTeX → `ingest` → `library build` → confirm in `search` → asks the user for a note (agent drafts the suggestion) for every paper |
| `argelander-read-paper` | Deep-read one ingested doc: resolves equations/figures/tables via `show`, citations via `ref`, keeps paper claims vs cited work apart, cites evidence as deep links |
| `argelander-query-paper-library` | Ranks the whole library against a research question (`note` is the primary signal), shows a shortlist, hands picks to read-paper, synthesizes with work ids + deep links |
| `argelander-find-papers` | Standalone, read-only: searches NASA ADS for seed papers, expands with `similar` / `useful`, returns a ranked list. Uses its own script and `~/.ads/dev_key`, not the CLI — a separate copy from the token saved in the workbench |
| `argelander-argument-graph` | Reads one ingested paper and writes its argument graph (Toulmin arguments, Native/End arguments, edges, sources) into the workbench with `argument put`; asks before replacing an existing graph and reports End arguments, main chains and audit findings |

Install by symlinking into pi's skills directory (`~/.pi/agent/skills/`
globally, or `.pi/skills/` in a project):

```bash
mkdir -p ~/.pi/agent/skills
for s in argelander-paper-ingest argelander-read-paper argelander-query-paper-library argelander-find-papers argelander-argument-graph; do
  ln -sfn "$PWD/skills/$s" ~/.pi/agent/skills/$s
done
```

### In the desktop app

The desktop app carries the same CLI and its own Node, so an agent in a terminal
needs neither Node nor administrator rights:

- Not in the AppImage: there the group says why and offers no install (see
  [Installing the desktop app](#installing-the-desktop-app)).
- **Settings → Command line & agents → Install the command-line tool** puts a
  small launcher named `argelanderspace` (the npm package's command) in your
  own executable directory — `~/.local/bin` on Linux and macOS,
  `%LOCALAPPDATA%\Programs\argelanderspace\bin` (`argelanderspace.cmd`) on
  Windows. It runs the app's Node on the app's CLI. The app changes **none**
  of your system's or your own environment variables (`PATH` among them) and
  no shell configuration: when that directory is
  not on `PATH` the page shows the line to add yourself (for example
  `export PATH="$HOME/.local/bin:$PATH"` in your shell's configuration; on
  Windows, the directory for your user `PATH`), and you open a new terminal.
- The launcher carries a marker line. Installing never overwrites a file of
  that name without it (an npm global install into `~/.local`, for instance)
  — the page says so instead; **Uninstall** removes only the marked launcher.
- If the app is moved or removed, the launcher says which file is missing and
  to install the tool again (or delete the launcher), instead of a bare "not
  found".
- Windows: `cmd`, PowerShell and programs that start commands through a shell
  find `argelanderspace.cmd` by its bare name; a program that starts it
  without a shell (Node's `spawn` without `shell: true`, for one) does not —
  give such a program `shell: true`. The app's folder must be under your user
  folder (the installer's default) or Program Files if its path has characters
  outside ASCII (a Chinese user name is fine): `cmd` reads the launcher in the
  console's code page, so the launcher names those folders through
  `%LOCALAPPDATA%` and its kin.
- **Show the skills folder** opens the skills that ship with the app (the
  `skills/` of this repository, in the package's resources —
  `/usr/lib/argelanderspace/skills` for the Linux deb). Copy the ones you want
  into your agent's skills directory yourself (see above); the app writes
  nothing into any agent tool's directory.

The CLI–agent contract in one table (details + output conventions in
`skills/README.md`):

| Command | Purpose | Output |
|---|---|---|
| `search` | every work as one JSON line — full index, the agent judges relevance (no server-side filtering); an empty-note `hint:` goes to stderr when applicable | JSONL |
| `list` | library overview + one line per ingested doc | text |
| `read <docId> [--section id] [--manifest refs\|bib]` | LLM-friendly markdown, or JSONL manifests | markdown / JSONL |
| `show <docId> <floatId>` | one figure/table/equation/code/algorithm as JSON (+ `link`) | JSON |
| `ref <docId> <refIdOrKey>` | one bibliography entry as JSON (+ `cited_in`, `link`) | JSON |
| `annot <docId>` | a doc's current annotations as JSONL (reading order; `target` + `context` + `link` per row; read-only, stale-after-edit annotations hidden) | JSONL |
| `note <workId> [text...]` | set / print a work's note | JSON |
| `label <workId> [--label c] [--read b] [--star b] [--tags a,b]` | patch user state | JSON |

Every doc-referencing command prints a deep link
`http://localhost:<port>/doc/<docId>[#<anchor>]` (anchors: `#sec-N`, floats
`#eq-N`/`#fig-N`/`#tab-N`/`#code-N`/`#alg-N`, `#ref-N`, `#ann-<id>`) that opens
the web reader at exactly that spot.

## Data directory

One library per project: the default is `./literatures` under the project
root, resolved against the current working directory (no upward search — run
the CLI and `serve` from the project root). Override with `--data-dir` for a
single run, or with `data_dir` in the config file (below; a relative path).

```
literatures/
  output/    one <doc_id>/ per ingested paper: <doc_id>.json + src/ + build/ + assets/ + fetch caches
  library/   library.json (source of truth), library.bib, cache/ (graph.json + ads/crossref/openalex)
  jobs/      asynchronous refresh/ingest job records and the upload spool
  annotations/  per-doc user annotations: <doc_id>/current.json (+ archive/ after a content change)
```

The server polls the data dir and broadcasts `library.changed`, so a running
web UI picks up out-of-band CLI writes (`note`, `label`, `library build`)
without a manual reload. Notes render full-text (read-only) in the web UI's
note tab; color labels and read markers are rendered in the library view.

## Configuration

The config file is the one place the workbench is configured; a command-line
flag (`--data-dir`, `--port`) overrides it for a single run. Precedence:
**CLI flag > config file > default.** The workbench reads no environment
variables of its own for the data directory, the port, the global directories
or the web UI directory (`ARGELANDERSPACE_*` variables from earlier versions
are ignored).

The config file is optional: `$XDG_CONFIG_HOME/argelanderspace/config.toml`
(default `~/.config/argelanderspace/config.toml`). The web UI's Settings page
shows it and changes it one line at a time, keeping your comments and layout.
Keys this version does not know (for example ones from a newer version, or
your own notes) are ignored and left as they are. For a command, a known key
with a wrong value is an error naming the key; `serve` starts anyway, with the
default for that key (a file that cannot be parsed gives every default, data
locations included), and names the key on the terminal and in the web UI.
Values are never logged or echoed.

```toml
data_dir = "papers"          # default ./literatures; relative to the project root
                             # (an absolute path is a config error for a command, and
                             # serve uses ./literatures instead: use --data-dir)
port = 1859                  # server port and the port in CLI deep links (default 1859)
log_level = "info"           # lowest level `serve` writes to its log: debug, info, warn, error
auto_ingest_arxiv = true     # fetch the arXiv PDF when a work with an arXiv id is added
contact_email = "you@example.org"  # optional; sent to Crossref and OpenAlex with each
                             # request (their "polite pool"); without it no email is sent.
                             # Must be written like an address, or it is a config error
tex_dir = "/opt/texlive/bin" # optional; an absolute path: where TeX's programs are, looked in
                             # before PATH (see Requirements); no restart needed
# global_dir / global_cache_dir = "/abs/path"   # where Mail, credentials and the log live

[ui]                         # how the web UI looks (the Settings page writes these)
language = "en"              # zh-CN or en
theme = "dark"               # dark or light
accent = "azure"             # azure, teal, violet, amber, neutral
density = "regular"          # compact, regular, comfy

# API-key fallback (the env var wins when both are set):
openalex_api_key = "..."     # env OPENALEX_API_KEY
```

Before you share your `config.toml` with someone, check it for a
`contact_email` (it is your address) and for the API key above.

Environment variables:

| Variable | Purpose |
|---|---|
| `OPENALEX_API_KEY` | OpenAlex premium pool (sent as `api_key`; optional; a blank value counts as unset) |

**The NASA ADS token** is kept by the workbench itself: enter it on the
Settings page (*Literature services & credentials*), where you can also test
it, remove it, or import it from `~/.ads/dev_key`. It goes into the system
keychain; only when there is none, and only if you agree, into a restricted
file in the global data directory. The CLI uses the same saved token. Without
one, ADS degrades to `no-token` and the rest of the library keeps working. A locked keychain may make the system ask you to unlock it when a command reads the token.
`$ADS_DEV_KEY`, an `ads_dev_key` line in `config.toml` and `~/.ads/dev_key` are
no longer read (the import copies the file once and leaves it as it is).

## Reporting a problem

`serve` keeps a log of what it does: one file per start, in the `logs/` folder of
the global data directory (default `~/.local/share/argelanderspace/logs` on Linux;
the Settings page shows where it is under **Diagnostics**, and so does the notice
the page shows when it fails). The newest 20 files, at most 50 MB together, are
kept. The log is written so that it can be shared: it records events, identifiers,
status codes, timings and paths with your home directory written as `~` — never
credentials, mail, the text of papers, annotations, notes, manuscripts or Copilot
conversations, and never the titles of papers. **Diagnostics → Log level** changes
how much is recorded and takes effect at once.

To report a problem, open **Settings → Diagnostics → Export diagnostics…** and press
Export. Where the browser offers it (Chrome, Edge), the system's save window opens
first and the bundle is written to the file you choose; cancelling it makes nothing.
Elsewhere the bundle goes to the browser's downloads, wherever the browser's settings
put them. Nothing is uploaded, ever — there is no telemetry and no crash reporting,
and you decide whether and to whom to send the file. The zip holds:

- the log files of the log folder — only files named as the workbench names its
  logs; anything else you put in that folder is not taken;
- `environment-report.json`: the version, browser or desktop form, operating
  system, its kernel version and the architecture, Node version, your browser's
  identification, the environment check (where TeX and the other programs are,
  their versions, whether a keychain is there), the config file's values in effect,
  the project folder and its data folder and the port in use. Paths have your home
  directory written as `~`. It leaves out your contact email, the global directories
  and every secret key of the config file (`openalex_api_key`, `ads_dev_key`); the
  ADS token is reported only as saved (in the keychain, or in the file), not saved,
  or unreadable — never its value.

The dialog also offers **Include the latest compile-failure logs**. These are the
complete LaTeX logs the workbench keeps when an ingest or a manuscript render fails
to compile; they quote lines of the paper's or manuscript's source, which may be
unpublished work, so the box is never ticked by default. Ticked, the dialog lists
the files that will go in (the newest, up to 32 MB and 40 files together), and the
bundle holds exactly those.

## Stored IR (sketch)

Each `<doc_id>.json` IS the render IR (`version: 1`) — the same object the web
reader and the CLI markdown consume:

```jsonc
{
  "version": 1,
  "docId": "arxiv-2501.17225",
  "title": "...",
  "source":  { "type": "latex", "origin": "...", "main_tex": "...", "arxiv_id": "..." },
  "meta":    { "title": "...", "authors": [...], "engine": "pdflatex" },
  "sections": [ /* ordered section tree with print-faithful numbers; blocks:
                   paragraph/list/figure/table/equation/code/algorithm with
                   native text|math|cite|xref segments */ ],
  "refsManifest": [ /* section + float anchors for the refs manifest */ ],
  "bib":          [ /* bibliography manifest rows */ ],
  "references": [ { "id": "ref-1", "raw": "...", "authors": [...], "year": 2021,
                    "doi": "10...", "arxiv_id": null, ... } ],
  "citationsByBlock": { "p-7": ["ref-6"] }
}
```

In the agent-facing markdown (the `read` command), citations and
cross-references render as:

| token | meaning |
|---|---|
| `[cite: ref-12 | Author Year]` | citation → reference `ref-12` |
| `[ref: fig-3 | figure | number: 3 | <preview>]` | cross-ref → figure/equation/section |
| `[ref: figure-9 | unresolved]` | detected but unresolved cross-ref |
| `[Figure omitted | id: fig-3 | number: 3 | caption: … | path: …]` | a figure/table placeholder |

## Development

pnpm workspace (use `corepack pnpm`; Node ≥ 24):

| Package | Role |
|---|---|
| `packages/contracts` | zod contracts: stored render IR (`TexDocIr`), library payloads, job/WS DTOs |
| `packages/core` | pure domain logic: the tex ingest pipeline (compile ports, source tree, fusion, IR assembly), library/graph/planner (no I/O) |
| `packages/infra` | side-effect adapters: latexmk compile + pdftocairo/gs figures, arXiv fetcher, ADS/Crossref/OpenAlex, config file |
| `packages/server` | Hono server: REST endpoints, static SPA, job runner, `/ws` |
| `packages/cli` | the commander program (`ingest` / `library build` / `acquire` / `serve`) |
| `packages/web` | React reader workspace (vite) |
| `packages/app` | the publishable `argelanderspace` npm package: bundles cli+server+core+infra into one ESM file + the built SPA + the `argelander.sty` instrumentation asset |

```bash
corepack pnpm install
corepack pnpm -r build        # all packages, incl. the SPA and the app bundle
corepack pnpm -r test         # vitest suites (offline)
corepack pnpm -r typecheck
corepack pnpm lint            # biome
```

Packing the npm tarball (kept out of the repo):

```bash
corepack pnpm -r build
cd packages/app && npm pack
```

Testing notes:

- **Golden-file policy**: frozen stored-IR documents under `tests/golden/tex/`
  (two arXiv LaTeX papers, re-frozen from real latexmk compiles by the tex
  pipeline) are regression fixtures; a compiler-free re-run gate replays the
  fusion half over the frozen compile artifacts. Most fusion/parser unit tests
  consume frozen compile artifacts and need no TeX toolchain; real-compile
  tests gate on a `HAVE_LATEXMK`-style availability probe.
- The pre-migration Python tree (`bibgraph/`, `server/`, `tests/run_tests.py`)
  was removed after the manual smoke test of the TS app (2026-08); it lives on
  in git history.

## License

MIT (see `LICENSE`; copyright holder: Wenjie Wu).
