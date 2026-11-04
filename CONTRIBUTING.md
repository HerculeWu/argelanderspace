# Contributing

The internal design documents (domain glossary, ADRs, contracts, engineering guide) are in Chinese:
start from [AGENTS.md](AGENTS.md), [CONTEXT.md](CONTEXT.md) and [docs/architecture.md](docs/architecture.md).

## Development

pnpm workspace (use `corepack pnpm`; Node ≥ 24):

| Package | Role |
|---|---|
| `packages/contracts` | zod contracts: stored render IR (`TexDocIr`), library payloads, job/WS DTOs |
| `packages/core` | pure domain logic: the tex ingest pipeline (compile ports, source tree, fusion, IR assembly), library/graph/planner (no I/O) |
| `packages/infra` | side-effect adapters: latexmk compile + pdftocairo/gs figures, arXiv fetcher, ADS/Crossref/OpenAlex, config file |
| `packages/server` | Hono server: REST endpoints, static SPA, job runner, `/ws` |
| `packages/cli` | the commander program: the older commands (`ingest`, `library build`, `acquire`, `serve`, `tutorial`, `search`, `note`, …), the commands derived from the operation catalog, `agent-plugin` |
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
