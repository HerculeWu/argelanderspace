# M3a 完成：arXiv LaTeX 管线移植进 packages/core（2026-08-26）

Milestone M3a（pipeline_latex.py + ingest_latex/{walk,references}.py + assets.py 的 bug-for-bug TS 移植）完成，**两篇 golden 逐字段 0 diff，豁免清单为空**。

## 模块映射（bibgraph/ → packages/core/src/pipelines/latex/）

- `pipeline_latex.py` → `pipeline.ts`（`ingestLatex(source, ports, opts)`；async 因为 acquisition 注入的是异步 port）+ `ports.ts`（`LatexPandocPort` / `LatexRasterPort` / `LatexAcquisitionPort` / `LatexPipelineConfig` 默认同 config.py）。
- `ingest_latex/walk.py` → `walk.ts`（Walker 双程 walk；`_inl`/`_anchor_matches` 不再猴补丁到对象上——holders 是私有列表，anchor matches 放在公开 `walker.anchorMatches: Map<object, Match[]>`，JSON 结构性不会泄漏）。
- `ingest_latex/references.py` → `references.ts`（.bbl/thebibliography/.bib-via-CSL 三条路径 + key→ref-id map）。
- `ingest_latex/assets.py` → `assets.ts`（AssetResolver 全量：locate/within 守卫/outName/缓存/copy-through），**矢量栅格化变为注入的 `LatexRasterPort`**。infra 的 `latex/assets.ts` 改为 `class AssetResolver extends CoreAssetResolver` 注入真 mupdf/gs（M2 API 不变，mupdf-raster 9 测试原样绿）。
- `ingest_latex/pandoc_ast.py` 的纯 helper（balanced 等）随 walk/references 各自内联；pandoc 调用本体仍是 M2 infra 的 `latex/pandoc.ts`。
- fs 小件（lossy read/withSuffix/glob/rglob/withinTree）→ `fs-util.ts`（core 用 node:fs 有 store.ts 先例，合规）。

## 接线在哪、为什么

`packages/infra/src/latex/pipeline.ts`：`ingestLatex` = core 组合 + 真适配器（pandoc CLI、ArxivFetcher/acquireSource、pdf/raster 的 pdfToPng/epsToPng）。放 infra 的理由：这三样是 subprocess/network/mupdf 副作用，core 保持 dep-clean；core 测试也不 import infra（避免 workspace 循环依赖导致 `pnpm -r build` 拓扑序不确定）。

## core 测试怎么拿到真能力（test-local ports）

`packages/core/tests/helpers/latex-ports.ts`：

- **pandoc**：spawnSync 真 pandoc，CLI 契约与 infra 适配器逐参相同（`-f latex -t json`、fragment 包装、`-f bibtex -t csljson`）；模块顶层把 astro bin 补进 PATH（同 infra 惯例）。
- **acquire**：arXiv id → `tests/fixtures/latex/<id>/`（归档的源树），cpSync 到 outRoot/<docId>/src，`origin` = e-print URL（与 golden `source.path` 一致）；本地 .tex 走极简目录/文件分支。不经网络、不经 untar（untar/fetcher 是 M2 测过的）。
- **raster**：写 1x1 占位 PNG 返回 true——`img_path` 只是 basename 字符串，走真 core AssetResolver 的 locate/outName 逻辑；PNG 字节不进 JSON。

## 夹具（裁剪决策）

`packages/core/tests/fixtures/latex/{2501.17225,2012.05220}/`：从 `.latexcache` tarball 解出后，**图（pdf/png 等 58 个文件）全部替换为 64 字节占位**，tex/bbl/bib/cls/sty/bst 逐字节保留；每个目录一个 `source.json` 清单（arxiv_id/doc_id/origin/main_tex，main_tex 与 golden `source.filename` 核对过）。30MB → ~900KB。图字节不影响 Document JSON（栅格化保真度由 infra M2 套件负责）。`sample_latex.tex` 放 `fixtures/sample-latex/` 独立子目录——否则 references 的 `.bbl` 深 glob 会捞到 latex/<id>/ 下的 .bbl（Python 夹具目录是隔离的）。

## Golden diff 结果

`packages/core/tests/golden-latex.test.ts`：两篇各跑真管线（离线），读**写出的** JSON 与 golden 递归逐字段 diff（报告前 50 条分歧路径）。**两者均 0 diff，`GOLDEN_ALLOWLIST = []`**（source.path 是 e-print URL 非本地路径；meta.output_path 在序列化后才写入，不进 JSON；img_path 命名无 content hash，全确定）。基线预验：astro env 下 Python 管线重跑两篇与 golden 逐字段一致（pandoc 版本无漂移）。

## 移植中踩到的坑（已在 TS 修正）

- **`emitCite` 的 pyTruthy**：`\citep[e.g.][]{a,b}` 组内第二个 citation 的 `citationPrefix: []` 在 Python 里是 falsy（不覆盖已有 prefix），JS `if ([])` 为真会把 "e.g." 抹掉。golden diff 抓到 4 处 raw 差（"(…)" vs "(e.g. …)"），改为 `Array.isArray(x) && x.length > 0` 后归零。
- 全局/粘性正则状态：`NONUMBER_RE` 拆成 test 用无 g + replace 用带 g 两个（Python re.sub 默认全替换；JS /g 正则的 .test 有 lastIndex 状态）。
- infra `assets.ts` 的 `locate` 用 `replaceAll('"', "")`，Python 是 `strip('"')`（只去首尾）——core 版按 Python；infra 旧实现未动（仅病态输入有差，记录在案不改）。
- vitest 会把 type-only import 整个剥掉，测试辅助里写错的相对路径 runtime 不炸、tsc 才炸——以 `-r typecheck` 为准。

## 上游 Python 侧观察（未修，bug-for-bug 保留）

- `_bib_files(main_tex, src_dir, raw)` 的 `main_tex` 形参在 Python 里就没用；TS 版直接删了该形参（模块私有，行为等价）。
- `walk.py::_emit_cite` 只保留组内**最后一个**非空 prefix/suffix（覆盖语义）——原样移植。
- `_parse_bibitems` 的 `start: int = 1` 形参从未被使用（enumerate(start=1) 在调用侧）——TS 未保留该死参数。

## 验收（2026-08-26 本机）

- `corepack pnpm -r build` ✓（5 包）、`-r typecheck` ✓（5 包）、`pnpm lint` ✓（0 error 0 warning，99 文件）。
- 测试：contracts 17/17、**core 48/48**（34 基线 + latex 单测 12 + golden 2）、**infra 75/75**（73 基线 + arxiv-id 检测 1 + 接线 smoke 1）。
- 13 个 `test_latex_*` 里 12 个在 `packages/core/tests/latex.test.ts`；`test_latex_arxiv_detection` 测的 `looksLikeArxiv`/`arxivId` 是 infra 函数，落在 `packages/infra/tests/arxiv-source.test.ts`。
- pandoc 门控：无 pandoc 时 golden/单测 describe.skipIf 跳过（与 Python `HAVE_PANDOC` 静默 return 对齐）。

## 留给 M3b/M3c（PDF/HTML 管线）

- golden gate 模板可直接套用：fixtures 归档 + test-local ports + `diffJson` 报告器（在 golden-latex.test.ts 里 export 了）。
- `annotation_latex`（cheerio DOM 读取）仍欠，随 M3 HTML 适配器。
