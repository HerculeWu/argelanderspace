# Data and configuration

Back to the [README](../../README.md).

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
                             # before PATH (see [Requirements](installation.md#requirements)); no restart needed
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
