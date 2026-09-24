# 文库、身份与正文获取

状态：现行，包含 Stage 13 手动建条目、Stage 15 LaTeX arXiv 获取及后续 Web arXiv PDF 获取语义。来源：`46093915` 的旧 product-and-architecture、contracts-and-decisions，以及 Stage 13/15 inbox；原文索引见 [history](history.md)。领域定义见 [CONTEXT](../CONTEXT.md)，冻结和用户数据保护见 [contracts](contracts.md)。

## Work 与 Doc 的身份

- work id：`doi:` / `arxiv:` 等；canonicalId 优先级 doi > arxiv > openalex > title-slug。用于 search/note/label 等文献管理。
- doc id：`arxiv-…` / 本地 `latex-…` / LaTeX zip 上传 `upload-…`；用于 read/show/ref/list/annot 与阅读器。`search` 行的 `doc_ids` 映射正文。
- LaTeX Doc 经身份归并可被多个 Work 引用；**本地 PDF Doc 恰好属于一个 Work**，归属权威仅为 Library `doc_ids`。主 Doc 为 **`doc_ids[0]`**；主位是用户选择，不是发表稿或最新版本判定。
- `ingest` 只写 output；**随后必须 `library build`** 才成为可 search/note/label 的 Work。docless Work 也可来自 bib 导入、历史 graph-node 或 DOI 建条目。
- CLI 支持 arXiv id/URL、本地 `.tex`、目录和 tarball。Web 的 Work 内正文入口包括 LaTeX zip attach、本地 PDF 上传和 arXiv PDF 获取；均要求 Work 已存在。本地 PDF 不进入 CLI/agent 接口。
- CLI 可解析 DOI 建 docless Work：DOI、`doi:` 或 URL 路径明确携带 DOI；Crossref 立即富化，失败留裸条目，重复 DOI 不写盘、不 rebuild。不可解析 DOI 的出版商 URL 或裸字符串仍报错，不能声称任意 URL 都能建条目。`10.48550/arXiv.*` 回 arXiv LaTeX 管线。

## 上传、多 Doc 与主位

所有 Work 都可上传。zip docId 为 `upload-<slug44>-<workId sha1前6>`，只随 Work 身份变化；同 Work 重传覆盖同一 upload Doc。向已有 arXiv/local 正文的 Work 上传会增加独立 upload Doc 并设主，旧 Doc 保留回看，UI 可“设为主”。

上传身份焊死：有 doi/arxiv 则 stamp source，没有则以 work.title 覆盖 doc meta.title，随后直挂 `doc_ids` 并校验；不能按失配标题挂到另一 Work。主位在 lockedRebuild 后锁内 re-assert，防并发 PATCH 覆盖；已有 library 的 seed dst-first 保序。

已有库 rebuild 保序不等于主位独立持久化：library 丢失后从零 rebuild 等残余问题仍由本地 I006 跟踪。本次 PDF 能力没有修复该存量边界。

### 本地 PDF（Web）

- `POST /api/library/upload-pdf?id=<work-id>` 接收原始 PDF bytes，可信服务端 PDFium (EmbedPDF 2.15.1) 检查可读性、加密状态、页数与页几何。上限 50 MiB、100 页，25 MiB 起显示资源警告；可信解析串行，进程空闲内存不足 512 MiB 时拒绝继续。不可用 OCR 或密码解锁，不以 MIME/文件名/magic 代替解析。
- 每次成功创建 `pdf-<UUID>` 独立 Doc，保存 `original.pdf`、明确 `format=pdf` 的元数据、绑定 hash 的空标注 sidecar 和 null 阅读位置 sidecar，全部完成后才挂 Library 关系。PDF 原文件永不原位替换。
- 完全相同字节仅在目标 Work 内返回既有 Doc，不重建或重置用户 sidecar；另一个 Work 接收相同 bytes 时建立独立物理副本、Doc 与用户状态。文件名/论文身份不会改挂目标 Work。首 Doc 成为主，向有正文 Work 新增 PDF 不抢主位，现有“设为主/全局删除”仍由条目内管理。
- build 只保留合法 Library 关联，不按 PDF 标题 seed Work，也不跨 Work 合并相同 bytes。孤立/损坏 PDF 不自动回挂或删除；唯一 owner 检查失败时 Reader 读取拒绝。
- `GET /description` 是格式/来源展示提示，不作内容一致性证明。Reader 通过 PDF snapshot 与原件端点校验元数据、annotation sidecar 和本次实际 bytes 的 SHA-256；原件 hash 不同为 409，损坏/丢失的原件、metadata 或 annotation JSON 为 500，均不得重置、归档或重绑。reading-position 独立校验；缺失/损坏/未来版本/hash不符时 snapshot 仍提供已验证正文及标注，并附 `reading_position.status=error`，显式告知未恢复、原进度 JSON 保持原样，不当成初始 null。PDF 初始工作台标注是可创建/编辑的空集合，原 PDF 自带内嵌标注只读；初始阅读位置为 null。Work 内工作台标注和位置保存沿 05–07 的 per-Doc sidecar 合同。
- EmbedPDF 2.15.1 worker/WASM 本地随 Web bundle 提供；原 PDF 内嵌标注锁定只读，Reader 只将哈希校验后的 buffer 交给 SDK，不调用带标注导出。许可文本随 app 分发，受测许可证范围见 `packages/app/dist/THIRD-PARTY-EMBEDPDF-NOTICES.txt`（构建生成）。

## Cite key 与统一书目字段

- rebuild 预灌已有键，只给缺失的新 Work 分配并避让冲突，不无条件重排。
- Stage 12 分配规则：分配时有 bibcode → cite_key = bibcode；没有则用原 citeKey()；**分配后永不改**，包括后来才富化出 bibcode 的条目。
- Stage 12 一次性存量改键与稿件同步替换是历史窄授权，不是今后重排授权。它修订了分配侧，没有解除分配后稳定性。
- Stage 13 手动 BibTeX 建条目尊重用户 key；与其他 Work 冲突逐条报错，不静默改名。`library build --bib` 仍系统分配，两条路径语义有意不同。
- DOI stub 可经 title bridging 归并，就地 planFor 和分配键，不隐式全库 rebuild。

**BibTeX 来源无特殊通道**：ADS export、用户给出的 BibTeX、生成兜底都填同一 Work 结构化字段。不存 BibTeX 原文 blob；`library.bib` 仍是唯一派生出口。

Stage 12：enrichAndPlan 中有 bibcode 且无已存字段时，批量 ADS export 拉取并解析 volume/number/pages/eid/month/journal_macro 等，只补空，不覆盖已有 title/authors/year/doi/eprint 等 normalize 结果。`--offline` 跳过；失败不阻塞，下次 build 自然重试；已存不自动刷新，不接 Crossref bibtex。

`workToBibtex` 输出全部非空字段，生成层转义 `& % # _`；**`$` 除外**，保标题数学。有 journal_macro 输出 `journal = {\aap}` 一类宏，无则转义纯文本；venue/journal 显示层仍纯文本。Writer 编译与 zip 导出注入同一组 `\providecommand` 期刊宏，不改 reader 管线，详见 [writer](writer.md)。

**I034 — 已接受语法边界**：分号分隔 cite key、全角逗号等命令错误由用户负责，以 LaTeX/bibtex 真值报错，不新增 server/web 诊断提示；用户明确要求语法辅助时再议。

## Web 手动建立条目（Stage 13）

入口为侧栏导入菜单三个真模式；旧“从浏览器抓取”假占位已删。统一 `POST /api/library/works`，guardCsrf + libraryLock，同步就地 upsert/planFor/assignCiteKey/save/广播，**不触发全库 rebuild、不走创建 job**，复用现有解析链。

| 模式 | 接受输入与失败语义 |
|---|---|
| identifier | DOI、`arXiv:<id>` 或 arxiv.org URL；裸 arXiv id 拒绝并教学前缀。解析链全 miss 仍建裸 stub，下次 build 可富化 |
| bibcode | ADS bibcode 单条；ADS 不可用/未命中 fail-fast，不建 stub；创建时 resolve + ADS export 补字段 |
| bib | BibTeX 全文批量；纯本地解析、逐条部分成功；尊重用户 cite key，冲突逐条显式报错 |

CLI 裸 arXiv id 正文摄入路径不变。裸 id 只在 Web identifier 建条目中被拒。

- 手动 bib 保留 title/authors（规范化姓）/year/journal/volume/number/pages/eid/month/doi/eprint 及 journal 宏识别；复用 parseBibtexText + parseAdsBibtexFields。entryType 沿用 isConf（conf，否则 article），不伪造通用 BibTeX 类型支持。
- 身份重合返回 exists，只补空字段，不覆盖既有字段或用户数据。单条成功/exists 关闭对话框并开详情；批量显示逐条创建/存在/失败结果，关闭后刷新列表并选中首个新建项。
- 单条创建时 resolveWork 全链；批量 bib 不做 N×外部请求，富化留后续 build。
- 图谱增量仅作即时尽力可视化：新节点和本地 saved↔saved 边；失败不使创建失败，全局收敛仍由全量 build/refresh 权威。Stage 14 已取消为 suggested 邻居发 OpenAlex 批量请求；批量 bib 只补裸节点。
- Web DOI 比 CLI 多 ADS/OpenAlex 富化属于 Web 新能力；CLI `addDoiWork`、`ingest <doi>` 和 `library build --bib` 既有行为不因此扩展。

## arXiv PDF 获取与既有 LaTeX 来源（Web）

### 默认 PDF 获取

新增 Work 自动任务仍只从既有 identifier、bibcode/Discovery 入库、以及既有解析链已解析出 arXiv ID 的 DOI 路径触发；没有 arXiv ID 不触发，批量 BibTeX 永不自动，不新增 DOI 反查。创建/exists 的 Work 响应仍同步返回；后续以持久 Job 获取 PDF。

- 自动提交和执行时均按 Work 的真实关联/显式 PDF metadata 检查是否已有任意 PDF；已有 PDF（即使其当前文件不可读）会阻止自动获取。只有 LaTeX Doc 不阻止。打开详情、重启和遍历旧库不触发补抓。
- `auto_ingest_arxiv` 默认 true 且提交时现读；false 只关闭自动 PDF 获取，手动仍可用。
- 手动 `POST /api/library/acquire-arxiv-pdf?id=<workId>` 需要现存 Work 和解析后的 arXiv ID；已有 PDF 不阻止用户主动再次获取。
- 来源使用 `https://arxiv.org/pdf/<canonical-id>` 获取本次返回的原始 PDF bytes，不做 `export.arxiv.org` 版本查询。metadata 记录 `acquired_via="arxiv_pdf"`、规范 `arxiv_id`、Server 取得时间、原始 byte length、SHA-256、页数和 PDFium 页几何；**不声称已核实官方 `vN`、提交日期或“官方最新版”**。
- 每次新的显式获取在成功后创建新的 `pdf-<UUID>` Doc，即使 bytes 与已有 PDF 完全相同也不去重。相同 Work/格式仍在 queued/running 的同一获取任务会被复用；Job 终态后的再次显式提交是新任务。上传 PDF 原有 same-Work identical-byte 去重完全不变。
- PDF 发布走既有 50 MiB / 100 pages / 512 MiB headroom 串行 PDFium 探测、不可变 stage bundle、DocMutationRegistry pin 和 libraryLock；新 Doc 只追加到用户指定 Work。旧 Doc 的 PDF、标注 sidecar、阅读位置 sidecar 与 `doc_ids` 主位原样保留。若 Work 无 Doc，新 PDF 自然为主；已有主位不改变。
- arXiv PDF 任务复用串行持久 JobRunner，payload format 为 `arxiv-pdf`；`job.done` 先于成功时的 `library.changed{cause:"upload"}`。boot-interrupted 不自动重跑，重复在途提交复用 Job；失败可以通过新的显式提交重试。此 PDF 错误不进入 Stage 15 LaTeX 的 `arxiv-fetch.jsonl` 或 PDF-only LaTeX 引导。

### 既有 LaTeX arXiv 获取保持独立

`POST /api/library/attach-arxiv?id=<workId>` 仍是 Stage 15 LaTeX 源码获取/刷新入口：既有 arXiv LaTeX Doc 沿旧 Doc ID/原位刷新、编译、错误分类与归档契约处理；CLI LaTeX ingest、PDF-only 冻结 CLI 文案和 Writer 不变。PDF-only Work 可显式获取一个独立 LaTeX Doc 并追加在现有 PDFs 后，不抢 PDF 主位；同 Work 若已有其他 LaTeX Doc/LaTeX zip 且不是要刷新的 arXiv Doc，则旧 Scenario C 仍拒绝新增 arXiv LaTeX，不放宽 ZIP 重传或 risk 规则。它不是 PDF 获取端点。arXiv LaTeX 来源和用户 zip 仍是详情里的显式 LaTeX 路径。`auto_ingest_arxiv` 现控制默认自动 PDF 获取，不启动旧 LaTeX 自动刷新。

批量 bib、详情打开、重启、旧库回填、PDF 原位替换、自动官方版本追踪、CLI/agent PDF ingest、OCR/出版商 HTML、任务取消、全局任务页和跨进程同 Doc 并发均不在本范围。

## 离线与派生数据

`library build --offline` 已 gate ADS、Crossref、OpenAlex，缓存仍可读；不推断所有 CLI 命令全局断网。DOI stub 富化、摄入缓存命中和 arXiv 恒新鲜 job 各自按路径判断。

库图 `graph.json` 是版本化派生缓存，saved-only 自愈规则见 [discovery](discovery.md)；`library.json` 损坏不能当缓存 miss。metadata 缓存的字节兼容规则见 [engineering](engineering.md)。
