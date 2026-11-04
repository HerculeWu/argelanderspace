# Reporting a problem

Back to the [README](../../README.md).

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
