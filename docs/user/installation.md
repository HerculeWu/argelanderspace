# Installation

Back to the [README](../../README.md).

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
stop working. Use the `.deb`, or a global install of the packed package (see
[Running from source](#running-from-source)), if agents should use the app's CLI.

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


## Running from source

The npm package is not published to the npm registry yet. To run the workbench
without the desktop app, build it from a clone of this repository (Node ≥ 24,
`corepack pnpm`):

```bash
corepack pnpm install
corepack pnpm -r build
node packages/app/dist/bin.js serve          # → http://127.0.0.1:1859
```

`node packages/app/dist/bin.js` is the `argelanderspace` command of this
documentation. To have that command on your `PATH`, pack the package and install
the tarball globally (see [CONTRIBUTING](../../CONTRIBUTING.md#development)):

```bash
cd packages/app && npm pack
npm install -g ./argelanderspace-<version>.tgz
```
