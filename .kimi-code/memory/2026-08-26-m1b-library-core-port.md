# M1b 完成：library + acquire 纯逻辑移植进 packages/core（2026-08-26）

Milestone M1b（文献库 + 获取层 Python→TS，bug-for-bug）已完成并通过验收门。M1a 约定沿用：camelCase 函数名、JSON 字段保持 snake_case、Python 真值语义走 `pyOr`/`pyTruthy`（pyTruthy 新增于 documents/pyregex.ts）、防御性分歧在文件头注释记录。

## 模块映射（bibgraph/ → packages/core/src/）

- `library/store.py` → `library/store.ts`（Work 接口 + `workFromJson`/`workToDict`/`identityKeys`、`LibraryStore`（get/match/upsert/load/save/toBibtex）、`mergeInto`、`workToBibtex`、`libraryPaths(dataDir)`——Python 的 ROOT/LIBRARY_DIR 常量变为注入式 `LibraryPaths`，落实决策 3）
- `library/seed.py` → `library/seed.ts`（`seedFromOutput(store, outputDir)`、`docReferenceIds`）
- `library/graph.py` → `library/graph.ts`（`citeKey`+`suffix`、`offlineEdges`、`buildGraph(store, oa, outputDir)`（async）、`workToRef`、`compareEdges`）
- `library/build.py` → `library/build.ts`（`rebuild`（async，sources 注入）、`acquireReferences`、`libraryPayload`、`loadGraph`、`addNodeToLibrary`、`patchWork`、tally 摘要）
- `library/sources/{ads,crossref,openalex}.py` → `library/sources.ts`（**MetadataSource 端口** + 归一化记录类型 + `normalizeCrossref`/`stripJats`；HTTP 客户端本体属 M2 infra，ADS/OpenAlex 的 normalize 也随之留 M2——无测试钉住）
- `acquire/planner.py` → `acquire/planner.ts`（Publisher 数据表原样、`classify`、`planSources`、`planToDict`、`DEFAULT_HTML_ADAPTERS`）
- `acquire/resolve.py` → `acquire/resolve.ts`（`resolveWork`（async）、`ResolutionProvenance`）
- `acquire/bibtex.py` → `acquire/bibtex.ts` + `acquire/latexenc.ts` + `acquire/latexenc-data.ts`（生成）
- `acquire/run.py` → `acquire/run.ts`（`workFromBibrecord`/`addBibRecords`/`planFor`/`enrichAndPlan`）
- `acquire/upload.py` → `acquire/upload.ts`（`findWork`、`attachPdf`（async））
- `acquire/fetch_pdf.py` → `acquire/fetch-pdf.ts`（`pdfSlug`、`stampSource`、`arxivPdfDoc`/`adsScanDoc`）
- `acquire/execute.py` → `acquire/execute.ts`（`fetchReadyFulltext`/`fetchRemaining`、FREE_TIERS）
- 端口定义：`acquire/pipelines.ts`（`IngestPipelines`（ingestHtml/ingestLatex/ingestPdf）、`PdfDownloader`）；`src/types/bibtex-parser.d.ts`（见下）

## 端口接口（M2/M3 照此实现）

```ts
// library/sources.ts — 全部 async（Python 同步 requests → TS 原生 fetch）
interface AdsSource {
  readonly status: "ok" | "no-token" | "unauthorized" | "error";
  resolve(q: { doi?; arxiv?; title? }): Promise<AdsResolution | null>;
}
interface CrossrefSource {
  resolve(q: { doi?; title?; year?; journal?; firstAuthor?; expectPrefixes?: readonly string[] }): Promise<CrossrefResolution | null>;
}
interface OpenAlexSource {
  resolve(q: { doi?; arxiv?; title?; year? }): Promise<OpenAlexResolution | null>;
  fetchMany(ids: string[]): Promise<Map<string, OpenAlexResolution>>;  // Map 保序：buildGraph 稳定排序的 tie 顺序
}
interface MetadataSources { ads: AdsSource; crossref: CrossrefSource; oa: OpenAlexSource }

// acquire/pipelines.ts
interface IngestPipelines {
  ingestHtml(doi: string): Promise<Document>;
  ingestLatex(arxivId: string): Promise<Document>;
  ingestPdf(pdfPath: string, opts: { outDir: string; isOcr: boolean | null }): Promise<Document>;
}
interface PdfDownloader { download(url: string, destPath: string): Promise<void> }  // %PDF 魔数校验在实现侧

// acquire/planner.ts — HTML 适配器注册表（M3 的活注册表；默认静态快照 = 迁移时 Python ADAPTERS：aanda + oup 及其 doi_prefixes）
interface HtmlAdapterInfo { name: string; doiPrefixes: readonly string[] }
```

## 关键决策与事实

- **BibTeX（决策 12）**：`@retorquere/bibtex-parser` 加为 **core 的依赖**（非独立叶模块——解析器是纯逻辑且只有 core 用，独立包徒增 workspace 噪音）。用法：`raw: true, sentenceCase: false, verbatimFields: ["author"]`，仅当**文法器**——产出与 Python bibtexparser 完全一致的原始字段串（@string 展开、小写字段名、非标准类型保留均已差分验证）。**不用**它的翻译层：默认模式会 sentence-case 标题、解析 creator、`\&` 渲染不同，与 Python latexenc 不等价。
- **latexenc 全量移植**：`latex_to_unicode` 的 2394 对替换表 + 4 条二遍表 + 33 个 combining 字符从 bibtexparser 1.4.4 机械提取为 `latexenc-data.ts`（勿手改）。保留了两个真 bug 的行为：①combining 替换用**变更前** span 交换字符，同一字段多个重音会 scramble（`\'a\'e`→`á\`，与 CPython 逐字节一致）；②mojibake 多字符目标（`\;`、`\NotEqualTilde` 等 29 条）触发 TypeError——Python 侧被 `_clean_text` 的 `except Exception` 吞掉，TS 同样抛同样吞。
- 该包 10.0.1 **发布时没带 .d.ts**（types 指向不存在的 dist/types/）——`src/types/bibtex-parser.d.ts` 本地声明了用到的最小 API。
- **键序保真**：`resolution` 字典按 Python 插入序构造（providers, n_refs, [links], count）；workToDict 按 dataclass 字段序。收益：`rebuild` 差分验证 library.json **逐字节一致**。
- graph.json 用 JSON.stringify（无空格分隔符）≠ Python json.dumps 的 `", "`/`": "`——parse 后一致，文件只是缓存（已记录的分歧）。
- Python `_WRITE_LOCK` 未移植：TS 单线程 + M4 串行 job runner（决策 13/16）提供同等互斥。

## 差分验证（scratch，未入库）

- `references.bib` 34 条记录与 Python `parse_bibtex` **逐字段一致**。
- latexToUnicode 48 例 tricky 输入（含 scramble/TypeError/brace/math 案例）与 Python **全一致**。
- store 身份助手（normDoi/normArxiv/arxivFromDoi/normTitle/slug/canonicalId/displayAuthors）语料 **全一致**。
- **端到端 rebuild 差分**：同一假 output doc + 同一 references.bib + 同一表格驱动 stub 源，Python（monkeypatch 路径常量+源类）vs TS：library.json **逐字节一致**、library.bib **逐字节一致**、graph.json 与 summary parse 一致（works 33 / nodes 35 / links 6 / 各 tally 相同）。

## 验收与基线

- Python 基线不变：`tests/run_tests.py` 210 checks / 0 fail（58 函数；html 12/latex 13 → M3）。
- Vitest：34/34 绿 = M1a 21 + M1b 13（12 个移植：test_acq_*×9、test_crossref_normalize、test_resolve_chain_*×2——**任务书写 3 个 resolve 测试，Python 文件实际只有 2 个**（run_tests.py:1011,1032），按实际移植；+1 个 store round-trip（真实 library.json 夹具 parse 级一致 + library.bib 逐字节一致））。
- `corepack pnpm -r build` ✓ / `--filter @argelanderspace/core test` 34/34 ✓ / `-r typecheck` ✓ / `pnpm lint` ✓（0 error 0 warning）。

## 未修的潜在 Python bug（bug-for-bug 保留，验收后可立项）

- `LibraryStore.upsert` 桥接多个已存 work 时，survivor 选择依赖 Python set 的 hash 迭代序（PYTHONHASHSEED 非确定）——TS 用插入序 Set（确定），语义等价于单匹配情形。
- `enrichAndPlan` 每次重建都无条件重排 `cite_key`（覆盖用户可见键）——原样保留。
- Python `re.finditer` 循环内突变字符串导致的多重音 scramble（见上）——原样保留。
- `work_to_ref`/`add_node_to_library` 等处的 `.get` 对 present-but-null 值会 AttributeError——TS 防御为 undefined（M1a 同款防御约定）。
- patch_work 对非布尔 JSON 标量用 Python `bool()` 语义；JS `Boolean([])` 为 true 与 Python `bool([])`=False 分歧——API 契约只允许布尔，实际不可达（已注释）。
