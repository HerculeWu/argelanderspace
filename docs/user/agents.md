# Agent integration

Back to the [README](../../README.md).

Two kinds of agent use ArgelanderSpace, and one set of **operation guides**
(`skills/`) serves both. A guide describes its steps with operations
(`library.import_works`, `reader.read`, `argument.replace`) and says, for each,
how it is called by the **Copilot** (the assistant inside the workbench: a tool
and an action) and by an **external agent** (Claude Code, pi or any agent with a
shell: the `argelanderspace` command). No MCP server is involved. The Copilot
loads all six guides from the folder that ships with the application.

| Guide | What it does |
|---|---|
| `argelander-find-papers` | Finds papers that are in no library yet: searches NASA ADS with `discovery.search_ads` (the token saved in the workbench; no key file is read), expands from seed papers with ADS `similar(…)` / `useful(…)` queries, returns a ranked list. Read-only |
| `argelander-paper-ingest` | Brings one paper in: `library.import_works` for the Work, then the body (arXiv LaTeX `library.attach_arxiv`, a PDF `library.attach_local_pdf` or `library.acquire_arxiv_pdf`, or a local LaTeX source with `ingest` + `library build`), then asks the user for a note and sets it |
| `argelander-read-paper` | Deep-reads one ingested doc (`reader.read`, or the CLI's markdown `read`): resolves equations/figures/tables and citations, keeps paper claims vs cited work apart, cites evidence as deep links; also reads and writes the user's annotations (`annotation …`) |
| `argelander-query-paper-library` | Ranks the whole library against a research question (the note is the primary signal), shows a shortlist, hands picks to read-paper, synthesizes with work ids + deep links |
| `argelander-argument-graph` | Reads one paper and writes its argument graph (Toulmin arguments, Native/End arguments, edges, sources) with `argument.replace`; a graph that already has arguments is replaced only after the user confirms on the card; reports End arguments, main chains and audit findings |
| `argelander-project-intake` | Moves a half-finished project in by interview: ADS libraries, Zotero/.bib, loose PDFs, servers, Overleaf or local manuscripts and a TODO file become Works and PDFs through the catalog operations (an external agent can do all of the library part); Plans and Tasks are created by the Copilot; progress lives in `argelanderspace-intake.md` |

Plans, the Writer, Mail and the shelf have no guide in this release. The
Copilot has no operation that writes a note, tags or flags or that ingests a
local source (it hands the user the command), and an external agent cannot
create Plans or Tasks.

## Install the guides

**Claude Code.** The npm package and the desktop app carry an Agent plugin that
holds the six guides (no MCP server, hooks or agents; the CLI itself must be on
`PATH` at the same version). Run

```bash
argelanderspace agent-plugin
```

It prints the plugin's absolute path and the two commands to type inside Claude
Code: `/plugin marketplace add <path>` and
`/plugin install argelanderspace@argelanderspace-local`. It is read-only and
changes no Claude Code configuration. The plugin's version is the package's
version: run it again and update the plugin after upgrading ArgelanderSpace.
Without the plugin you can copy the guides you want into Claude Code's skills
folder (`~/.claude/skills/` for all projects, `.claude/skills/` for one).

**pi.** Symlink the guides into pi's skills directory (`~/.pi/agent/skills/`
globally, or `.pi/skills/` in a project):

```bash
mkdir -p ~/.pi/agent/skills
for s in argelander-paper-ingest argelander-read-paper argelander-query-paper-library argelander-find-papers argelander-argument-graph argelander-project-intake; do
  ln -sfn "$PWD/skills/$s" ~/.pi/agent/skills/$s
done
```

## In the desktop app

The desktop app carries the same CLI and its own Node, so an agent in a terminal
needs neither Node nor administrator rights:

- Not in the AppImage: there the group says why and offers no install (see
  [Installing the desktop app](installation.md#installing-the-desktop-app)).
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
- The launcher runs the app's own CLI, so `argelanderspace agent-plugin` works
  with it as well (see **Install the guides** above for Claude Code).
- **Show the skills folder** opens the guides that ship with the app (the
  `skills/` of this repository, in the package's resources —
  `/usr/lib/argelanderspace/skills` for the Linux deb). Copy the ones you want
  into your agent's skills directory yourself (see above); the app writes
  nothing into any agent tool's directory.

The older commands the guides still use, in one table (the operation-to-command
table, the exit codes and the output conventions are in [`skills/README.md`](../../skills/README.md)):

| Command | Purpose | Output |
|---|---|---|
| `search` | every work as one JSON line — full index, the agent judges relevance (no server-side filtering); an empty-note `hint:` goes to stderr when applicable | JSONL |
| `list` | library overview + one line per ingested doc | text |
| `read <docId> [--section id] [--manifest refs\|bib]` | LLM-friendly markdown, or JSONL manifests | markdown / JSONL |
| `show <docId> <floatId>` | one figure/table/equation/code/algorithm as JSON (+ `link`) | JSON |
| `ref <docId> <refIdOrKey>` | one bibliography entry as JSON (+ `cited_in`, `link`) | JSON |
| `annot <docId>` | a doc's current annotations as JSONL (reading order; `target` + `context` + `link` per row; read-only, stale-after-edit annotations hidden) | JSONL |
| `argument get <workId>` / `argument put <workId> <file\|-> --rev n [--replace]` | the whole argument graph as JSON with `rev`; write it back (no confirmation card: prefer `argument replace`) | JSON |
| `pdf-path <docId>` | absolute path of a PDF Doc's original file | one line |
| `note <workId> [text...]` | set / print a work's note | JSON |
| `label <workId> [--label c] [--read b] [--star b] [--tags a,b]` | patch user state | JSON |

Every doc-referencing command prints a deep link
`http://localhost:<port>/doc/<docId>[#<anchor>]` (anchors: `#sec-N`, floats
`#eq-N`/`#fig-N`/`#tab-N`/`#code-N`/`#alg-N`, `#ref-N`, `#ann-<id>`) that opens
the web reader at exactly that spot.

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
