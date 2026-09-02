# Stage 3.1 定稿计划（2026-09-01 grilling 三轮拍板，用户确认开工）

> **恢复指南**：本文件自足。前置读 `product-and-architecture.md`、`pitfalls.md`。main 顶部 = Stage 3 `021ddde` + memory 整理 + 本定稿。

## 状态

**2026-09-02：Stage 3.1 关闭——执行完毕、手动验收全部通过（含 re-upload 修复 `bfac790`）、全部 push。** commit 序列（main，除注明外）：memory 定稿 `97fc51a` → MS1 隔离 `954b0c2`（−49881 行，270 测试绿；5 符号归置 `documents/geom.ts` + references.ts 内联；raster 内联 openMupdf/pageSizeOf；planner 裁 HTML 适配器）→ MS2 zip 上传 `0a22d1e`（302 绿；失败探针自动化；顺手修 deeplink unknown-anchor flake：effect 异步 flush → waitFor）→ MS3 公式/表格/下限 `4982451`（313 绿；golden 2012.05220 重冻 +48/−16、2501.17225 零 diff；2607.17040 端到端 crossref 34/49→**49/49**、11 表全恢复、eq-3 完整；pandoc 3.1.3 负测拦截）→ MS4 收尾 `fc80aa7`（stub pane 3 文件 +1/−5；manual-test-stage3.1.md 278 行关键预期全部预实测；323 测试绿）→ 验收修复 `bfac790`（re-upload 按钮；325 绿）+ memory `9c7d1f3`。MS0 = `ocr-features` 分支 `9f0efce`（封存说明，分支已 push origin，不维护）。

2026-09-01：设计 grilling 完成（Q1–Q18 全锁定）。范围由原 roadmap 六项修订为五项：

- **item 5「公式丢失」改案**：实测真根因 = **pandoc 版本敏感**（验收环境系统 pandoc 3.1.3 剥 DisplayMath 环境外壳 → walk `ENV_RE` 失效 → 编号全无 + 误咬内层 `\begin{cases}` 削残公式），修复入口 = 硬下限 + ENV_RE 锚定 + 全量编号；**独立成立**的真丢失是 AASTeX `deluxetable`/`table*` 表格被 pandoc 降级（两版 pandoc 都发生），改案为"表格丢失修复"。
- **item 6「已读标识复查」撤销**（用户 2026-09-01：现状满意，非问题，从遗留清单删除）。取证附带确认：渲染链路无断点；web 无 read 写入口（仅 CLI `lib patch --read`）。

## 锁定决策（Q1–Q18）

1. **执行顺序**（Q1）：隔离 → 上传改造 → 公式/表格 → 收尾。milestone commit/push 逐次问用户（MS0 的 commit+push 已在定稿中授权）。
2. **ocr-features 分支**（Q2）：从 main 原样建 + 顶端封存说明 commit（根 `OCR-FEATURES.md`）+ push origin；不维护不 rebase，一次性快照。
3. **上传格式**（Q3/Q8）：webui **只收 zip**；解包复用 `packages/infra/src/lib/unzip.ts` 的 `extractZip`（自包含零依赖、stored+deflated、路径消毒；原拟随 MinerU 迁出，改判留守）；server 校验 = PK 头 + extractZip 试解。
4. **入口语义**（Q4）：attach-only——按钮在详情页、目标 work 须已存在；无 doc work 的预建路径 = CLI `library build --bib` / `acquire <bib>` / graph-node 添加。库级"上传建新 work"不做。
5. **幂等 docId**（Q9）：同一 work 重传 = 覆盖同一 doc；docId = `upload-<slug(44)>-<hash6>`（hash 取自完整 work id，修掉 48 字符截断撞车隐患）。
6. **身份焊死**（Q10）：目标 work 已知 → stamp（doi/arxiv 有则写；无则 `work.title` 覆盖 doc `meta.title`，保 title-slug 归并）+ 直挂 `w.doc_ids` + 返回前校验含新 docId（否则 job failed）。原 attachPdf 两隐患（落重复 work、不校验）就此关停。
7. **公式编号**（Q5/Q12）：一切 display-math 按序 1..N（含 `equation*`/`\[...\]`/`$$`/未知环境）；`\tag{x}` 提取为显示号、剥出 latex body（KaTeX 不支持 `\tag`，顺带修渲染）、**不推进计数器**（amsmath 语义）；per-row 环境（align 等）逐行编号保留；`\nonumber/\notag` 行尊重不发号；渲染层零改动（IR `float.number` 实时查表自动跟随，crossref raw 从 `(?)` 变 `(N)`）。
8. **表格修复**（Q11）：pandoc 前的**机械**源码重写（写死在管线代码里，无 LLM）：`deluxetable`→`table`+`tabular`（`\tablecaption`→`\caption` 保 `\label`、`\tablehead{\colhead…}`→表头行、`\startdata/\enddata` 删、`\tablecomments{…}`→尾随段落）、`table*`→`table`。
9. **pandoc 硬下限**（Q17）：管线入口 `probePandoc` 查 `--version`，低于"保留环境外壳"的版本（实测 3.9.0.2 满足，实现时查实最低版本，floor 暂按 3.9）即报错指路 shim；测试 helper `latex-ports.ts` 同步改明确报错（不再静默用系统 pandoc）。
10. **ENV_RE**（Q18）：加锚点只认字符串开头的环境声明（防误咬内层 `\begin{cases}`）；`subequations` 被 pandoc 合并丢 `\label` 记 known-issue 不修。
11. **documents/ 拆分**（Q13）：抠 5 符号（`ARXIV_RE`/`DOI_RE`/`bbox1000ToFrac`/`pointInRect`/`readBbox`）归置留守模块；PDF 专属文件整走。
12. **CLI DOI/URL**（Q14）：识别后友好报错指路（"PDF/HTML 摄入开发中，请用 arXiv id 或 webui 上传 LaTeX 源码包 zip"）；`looksLikeDoi` 内联进 `detect.ts`。
13. **golden 连锁**（Q15）：contracts `golden.test.ts` 断言改 2 颗 latex、负例换 latex；web `deeplink.test.tsx` 换 latex fixture、锚点注释重推；main 不留 OCR 夹具。
14. **/images MinerU 分支**（Q16）：删；存量 PDF 摄入文档图片失效，重摄入恢复。
15. **验收**（Q7）：新写 `docs/manual-test-stage3.1.md`（stage3 版留档不改）；上传失败探针（失败显示在详情面板且刷新后仍在）并入 MS2 验收。
16. **已读标识**（Q6）：撤项，不动。

## Milestone 切分

- **MS0 分支封存**（commit+push 已授权）：`git checkout -b ocr-features` → 根加 `OCR-FEATURES.md` 封存说明 → commit → `push -u origin ocr-features` → 回 main。
- **MS1 main 隔离**：删除/重接/测试拆分/fixtures/依赖/config/文案，全清单见取证存档 §E；四道门绿收尾（不留 commit，由主 agent 问用户后提交）。
- **MS2 上传改 zip**：server 端点（PK/extractZip 校验、spool 扩展名 .zip、`?id/?doi/?arxiv` 维持、sync 路径保留）+ `attachLatexZip`（extractZip→临时目录 → `ingestLatex(目录)` 目录模式 + `findMainTex` 打分复用 → 幂等 docId（实现注意：管线自产 docId 为 `latex-<目录 basename>`，需目录命名对齐或给管线加 docId 指定入口）→ stamp 焊死 + 直挂 `doc_ids` + 校验 → `lockedRebuild`）+ web（RefDetail 文案/accept=".zip"、api `uploadPdf`→`uploadLatexZip` content-type `application/zip`）+ web/server 上传测试重建（含失败探针）。
- **MS3 公式/表格/下限**：walk 全量编号 + `\tag` + ENV_RE 锚定；`probePandoc` 硬下限 + helper 明确报错；deluxetable/table* 预处理（core latex pipeline `latexToAst` 之前）；walk `contentBlocks` fallthrough 加诊断日志；`latex.test.ts:130-148,197-210` 期望更新；latex golden 两颗重冻（无脚本：手动跑管线产出覆盖 `tests/golden/arxiv-<id>.json`，需 shim）+ 人工抽查；2607.17040 端到端复测（编号 1-5 在、eq-3 完整、Table 1 成表、tab crossref 解析数从 34/49 上升）。
- **MS4 收尾**：stub pane 移除（清单 §D）；新写 `docs/manual-test-stage3.1.md`（摄入面收窄、zip 上传、公式编号、表格修复、pandoc 下限、stub 消失、失败探针）；memory 收尾更新（product-and-architecture 同步新行为）。

## 推后事项（用户明确推迟，勿在本阶段做）

- **正式发布前**：README 写明 pandoc 版本要求 + 提供安装检验脚本（Q17 用户指定）。
- **未来 stage**：CLI 收到未识别源时先创建条目、等待用户上传（Q14 用户指定方向）。
- **re-upload 推广到所有条目**（2026-09-02 验收提出，用户定为**必须保留更新通道**）：场景 = 文章先 arXiv 发布、后有正式出版版、arXiv 自身也会更新——并不罕见。当前实现只给 `upload-` 家族 doc 显示重传按钮（理由：zip 上传到非 upload 文档不会覆盖、而是在 arXiv/latex doc 旁产生并行第二 doc，"替换"预期落空且引入"哪份是正文"歧义；且 `LibraryRef` 只有单一 `doc_id` 可做前缀判断，payload 无 `doc_ids` 列表）。推广时需拍板：zip 对非 upload 文档的语义（替换主 doc / 并行第二 doc + UI 选主）、payload 补 `doc_ids`、已知盲区（先 zip 后 arXiv 摄入的条目主 doc_id 切换后按钮消失）。
- **webui 独立应用原则**（2026-09-02 用户明确）：webui 目标 = **独立应用**，不是 agent 的看板，无 agent 的用户也要能完成全部操作，不与 agent 强绑定。当前写路径（label 持久化、note 写入等）归 CLI/agent——后续 stage 逐步把操作面补进 webui，Stage 4/5 设计遵循此原则。
- Stage 4：计划页面（webui `计划` stub）+ agent 操作计划页面。Stage 5：论文写作。

## 取证存档（2026-09-01 五路子代理，直接采信）

### A. 公式编号机制与 pandoc 根因（agent-7）

- 唯一赋值点：`Walker.equationBlock`（`packages/core/src/pipelines/latex/walk.ts:456-504`）——`numbered` 判定 :460-461（env 非星号且在 `NUMBERED_ENVS` :41-49）；`PERROW_ENVS`(:51) 逐行编号 :463-489（行级 `\label`→行号入 labelMap，`\nonumber/\notag` 跳过，`NONUMBER_RE` :76-77）；equation/multline 单号 :490-496；未编号分支 `number` 留 undefined、label 记 null :497-501。环境检测在 `normalizeEquation`(:942-954)：`ENV_RE`(:67，**无锚点**) 抓外壳、剥 `\label`/`\nonumber`、多行环境重包 `aligned`。
- **pandoc 版本差异**（实测）：3.1.3 剥 DisplayMath 外壳（equation 外壳消失、align→aligned、flalign 退化成 Div 包纯文本）；3.9.0.2 保留外壳。3.1.3 下：编号全灭 + eq-3 被 `ENV_RE` 误咬内层 `\begin{cases}` 削残（KaTeX 必炸 = 阅读器里"公式丢失"）。同 tex 源同代码，差异 100% 由 pandoc 版本解释。`probePandoc`（`packages/infra/src/latex/pandoc.ts:33-39`）对任意版本放行。
- `\tag` 现状：完全不解析、残留 body（KaTeX 不支持）。PDF 路径有现成 `EQ_TAG_RE` 模式（`documents/structure.ts:34,110-116`，随隔离迁出）。
- crossref 显示链：walk 期 raw = `` `(N)` `` 或 `"(?)"`（walk.ts:830-833，num 来自 labelMap）→ IR `float.number` 实时查表（ir.ts:186）→ web chip `seg.raw || prettifyXref(target)`（segments.tsx:153）/markdown `[ref: … number: N]`（ir.ts:254-264）。全量编号后自动跟随，渲染层零改动。
- 测试期望更新点：`packages/core/tests/latex.test.ts:130-148`（eq-2 `equation*`、eq-4 `\[…\]` 现断言 undefined）+ :197-210 per-row；contracts 不动（`EquationBlockSchema.number` optional）。
- golden 重冻：**无 UPDATE 变量无脚本**——手动跑管线（test ports）覆盖 `tests/golden/arxiv-<id>.json`；`golden-latex.test.ts:37` PAPERS = 2501.17225/2012.05220；contracts `golden.test.ts` 对全部 golden 做 zod 校验。

### B. 表格丢失实证（agent-8，2607.17040 + pandoc 3.9）

- §2.2 开头 `deluxetable`（tex:162-176，Table 1）被 pandoc 降级为 `Div.deluxetable > Para`：caption/`\label`/`\colhead`/`\tablecomments` 全灭，walk 消费后成乱码段 p-9。全文 5 个 deluxetable 全灭；4 个 `table*`（tex:690/712/854/881）只保 tabular、丢 caption/label；2 个未加星 `table` 正常（Div attr id → tab-1/tab-2）。
- crossref 49 total / 34 resolved，**15 个 unresolved 全是 `tab:*`**（8 处引 deluxetable label + 7 处引 table* label）。
- walk 唯一静默丢弃点：`contentBlocks` fallthrough `return []`（walk.ts:429，RawBlock 等）——本文零命中，walk 无责；损失 100% 在 pandoc 解析阶段。
- 顺带实证：3.9 下 5 个 equation 编号 1-5 全在、"To study" 段后本来无公式（arXiv 官方 HTML 块序一致）。

### C. upload 链路与 work 来源（agent-9）

- 链路：web `RefDetail.tsx:344-364`（**仅 `doc_id` 为空时渲染**，input accept :228-234）→ `api/library.ts:44-57` uploadPdf → server `app.ts:334-413`（CSRF→id|doi|arxiv 必填→`%PDF` 魔数→`?sync=1` 同步 / 默认 async：`runner.submit("upload",…)`、spool `<dataDir>/jobs/spool/<jobId>.pdf` `jobs.ts:129-133`、202 返 job、done 后广播 library.changed）→ core `acquire/upload.ts attachPdf`(69-127：`findWork` :41-66 workId>doi/arxiv>标题全等、找不到 throw；docId `upload-<slug(w.id)>` :106 slug 截 48；`ingestPdf` :115-119；`stampSource` :120（`fetch-pdf.ts:45-57`，仅 doi/arxiv 非空才写）；`lockedRebuild` :123-126）→ `build.ts:52-76` rebuild = `seedFromOutput`（seed.ts:57-83 按 doc source.doi/arxiv_id+meta.title 算 canonicalId 归并）→ enrichAndPlan → buildGraph → 落盘。进度/失败呈现：WS job.* + `RefDetail.tsx:155-179`。
- CLI 本地 latex：`detect.ts:36-44` `isLocalLatexSource`（目录 | `.tex` | `TARBALL_RE`=tar|tar.gz|tgz|tar.bz2|tbz2|gz，**无 zip**）；`program.ts:68-78` → infra `ingestLatex(source: string, …)`；core 内部 `acquireSource`（`infra/src/latex/arxiv-source.ts:218-256`）：目录/`.tex` 原地用（:232/235）、tarball 解 `<outRoot>/<docId>/src`（:237-239）、单文件 gz 落成 main.tex 且校验 `\documentclass`（:146-180）；`findMainTex`(:186-211) 打分（`\begin{document}`+100、`\documentclass`+50、authors/affil −200、长度 tie-break）；`docIdFor`(:64-72) 本地 = `latex-<stem或目录basename>`。
- work 生命周期：只能 upsert 产生——`seedFromOutput`（origin ingested）/`addBibRecords`（origin bib）/`addNodeToLibrary`（origin graph-node）；**无 doc 的 work 合法**（`doc_ids` 默认 []），search/list/web 都照常渲染；ADS 只做 enrich 不建 work；根 `references.bib` 无代码引用（手工样例）。
- 复用面：job 化/spool/WS 进度失败/`lockedRebuild`/seed 归并全不变；要换 = `%PDF` 魔数、spool `.pdf` 扩展名、`accept=`、`ingestPdf`→`ingestLatex`。

### D. 已读标识 / stub pane（agent-10）

- 已读（撤项存档）：CSS `argelander.css:281`（标题灰化）/:282（`.sel` 同优先级覆盖回全亮）/:286（未读蓝点）；挂接 `LibraryView.tsx:242`（read/unread 类）/:249-255（蓝点，有 label 不显示）/:260（`· 已读`）；数据 `store.ts:174/208/288` → `graph.ts:242`；web 无写入口。链路无断点。
- stub pane 移除清单：`Shell.tsx:24`（terminal）、`:25`（browser）两行 NAV（同时驱动活动栏 :269 和切换菜单 :410，删即两处同步消失）；`CommandPalette.tsx:38-39` 两条；`argelander.css:225` 注释同步改。**保留**：plan(:21)/ext(:27+底部按钮 :281-288)、`StubPane` 本体(:441-453)、`NavItem.stub`(:17)、`.stub-*` CSS(:226-230)、globe 图标（LibraryView.tsx:60 在用）；terminal 图标定义无其他引用，可删。

### E. OCR 隔离面（agent-11，move/stay/重接全清单）

**删除——源码**：`core/src/pipelines/{pdf,html}`（含 html/base.ts `htmlAdapterInfos`）；`core/src/documents/` 的 `mineru.ts`、`pdf-links.ts`、`textfix.ts`、`sequence-matcher.ts`、`structure.ts` + `document.ts` 的 buildDocument PDF 编排半（`documentToJson`/`compact`/`annotatable` 留守，latex 在用）；`core/src/acquire/fetch-pdf.ts`（**先把 `stampSource` 内化进 upload.ts 再删**）；`infra/src/{mineru,html}`；`infra/src/pdf/` 除 `raster.ts` 外全部（pipeline/text-provider/links）；`infra/src/acquire/pdf-downloader.ts`。`infra/src/lib/unzip.ts` **改判留守**（MS2 复用）。
**留守关键**：`infra/src/pdf/raster.ts` + mupdf 本体（latex 栅格化用，`infra/src/latex/{pipeline,assets}.ts` 在引）；`raster.ts:17` import 待删 text-provider 的 `openMupdf`/`pageSizeOf`（各 4 行，内联进 raster 或拆 `pdf/mupdf-util.ts`）。
**重接边**：`core/src/index.ts:31,43,44,48,56,62,63` re-export 清理；`documents/document.ts:29-39`（Mineru 类型/pdf-links runtime/buildStructure/textfix 端口）；`documents/references.ts:14-15`（`readBbox`←mineru、`ARXIV_RE/DOI_RE`←pdf-links，latex references 间接依赖——按 Q13 抠符号）；`documents/citations.ts:21`、`crossrefs.ts:13`（`bbox1000ToFrac/pointInRect`←pdf-links）；`acquire/upload.ts:33`（stampSource 内化）；`acquire/execute.ts:32,128-131`（删 arxiv_pdf/ads_scan tier）；`acquire/pipelines.ts:17,28,41`（IngestPipelines/PdfDownloader 契约收窄）；`cli/src/detect.ts:17,20,31,49,51`（looksLikeDoi 内联 + DOI/URL 友好报错）+ `program.ts:25,32,80-113,216,296-306,342-345`；`server/src/deps.ts:14-22,36-42`、`app.ts:30,32-33,151,334-413`（upload MS2 重建）、`/images` mineru 分支 `app.ts:429,459` 删、`jobs.ts:128-133` spool 扩展名；`infra/src/index.ts:7,9,10,20-24` re-export。
**测试**：删 core `tests/pdf-pipeline.test.ts`、`tests/html.test.ts`、`tests/helpers/{pdf,html}-ports.ts`；`tests/documents.test.ts` **拆分**（buildDocument/buildStructure/repairText/classifyDest/parseReferences 随分支；annotate/citations/crossrefs/traverse/documentToJson 留守）；infra 删 `tests/{pdf-pipeline,fetcher}.test.ts` + mineru/html/mupdf-text/mupdf-links/pdf-downloader 套件，`tests/config.test.ts:20` 剪 mineru import；cli `tests/smoke.test.ts:79-87,121-128` 剪；server 删 `upload.test.ts`（MS2 重建）、`tests/helpers.ts:93-121` stubPipelines 收窄、`api.test.ts:280-281`、`ws.test.ts:99-100`、`jobs.test.ts:93,110` 调整；web `tests/refdetail-upload.test.tsx` MS2 重写；根 `tests/golden/` PDF/HTML 五颗（2603.03522/ads-1983ApJ...270..365M/arxivpdf-1610.08981/aa39341-20/962260）+ manifest 条目删；**连锁**：contracts `tests/golden.test.ts:31-33` 断言改 2 颗 latex + :57,:63 负例换 latex；web `tests/deeplink.test.tsx:18` 换 latex golden 当 fixture、:11-13 锚点注释重推。
**fixtures**：core `tests/fixtures/{pdfminer(1.7M),htmlcache(1.4M)}`、`sample_aanda.html`、`sample_content_list.json` 删；infra `2603.03522.pdf`、`ads-1983ApJ...270..365M.pdf`、`mineru-result.zip` 删；**`arxivpdf-1610.08981.pdf` 留守**（`mupdf-raster.test.ts:18` 矢量样本）。
**依赖**：core 删 `cheerio`/`domhandler`/`htmlparser2` + devDep `mupdf`（仅 pdf-ports 测试用）；infra 删 `cheerio`（仅 html/fetcher 用）；传递自动清退 parse5 系/iconv-lite/safer-buffer 等；app `tsup.config.ts:20` external mupdf **保留**；banner createRequire 垫片（为 cheerio 链服务）删依赖后实测再定（保留无害）。
**config**：`infra/src/config.ts:31,52` 删 `mineru_api_key` 键。
**文案**：README（:15-22,:44,:51,:61-68,:146,:158,:200 等）、`skills/README.md`（:46,:56,:99-100）、`skills/argelander-paper-ingest/SKILL.md`（:29,:34,:36,:62,:138,:144-147）、`contracts/src/api.ts:103-104`、`contracts/src/jobs.ts:19` 注释、`web/src/library/LibraryView.tsx:59` "从 PDF 导入"；acquire planner HTML 适配器注册表/READY 标记裁剪。
**分支同步**：以上全部在 `ocr-features` 分支原样保留（MS0 先建，天然满足）。
