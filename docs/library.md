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

## Copilot `library` 工具（Copilot 票 13）

- 与 Library 页同一入口：读取走页面自己的 `GET /api/library` 载荷与搜索谓词（`libraryRefMatches`），不读 `library.json` 或标注 archive；页面上下文是**当前筛选的全集**（不是已挂载行），其余库只给数量；`source: "demo"`（内置示例）永不标为完整，也不是已保存文库。
- 唯一的持久写是“设为主 Doc”（Files tab 按钮 = `PATCH /api/library/refs {doc_id}`），UI 与工具共用 `commitWorkPatch` → core `patchWorkNarrow`：在 `libraryLock` 内重读**原始** `library.json`，只改点名字段并保留其它 Work、未知键与 `project`；工具带 `expectedMainDocId`（所读主位），变了返回 `conflict` 且零写入，无关字段/追加 Doc 的并发变化保留。临时文件＋rename，失败保原 bytes。
- **局部修订（父代理 2026-10-03 接受）——`PATCH /api/library/refs`**：旧行为＝经类型化 `LibraryStore` 读改写，保存时丢弃类型模型不认识的键并规范化所有 Work；新行为＝窄 raw patch，只改点名字段（清空即删键），保留其它 Work、未知键与 `project`；响应、404 语义与 `library.changed{cause:"patch"}` 不变；原因＝Copilot 与 UI 必须共用不丢数据的写接缝（规格 §6.3）。旧 `patchWork` 仍用于上传/获取流程，行为不变。
- 写盘顺序：json 与 bib 先各写临时文件，再依次 rename（json 先）。暂存失败两者 bytes 都保持原样；两次 rename 之间失败极少见，可能 json 已更新而 bib 落后一次变更（下一次实际写入时才会重新生成），工具对保存失败返回 `error` 并要求重读，不声称“未改变”。写入在 `libraryLock` 后排队（与 rebuild 等串行），不会被拒为 busy；UI 的“设为主”只有浏览器本地的 `settingMain` 防重入。
- 图视图离散按钮（标签开关、放大/缩小/适应/重排）可由 Copilot 经绑定 view 按下；拖节点、平移、滚轮缩放是用户手势，不对等。页面没有刷新/排序控件，按 ADR 0005 不新增。
- note/tags/read/star 在 Library 页没有写入口，所以没有对应工具；右键色点是仅本标签页的显示叠加层，Copilot 的 `set_temp_label` 同样不落盘并在结果中如此声明。上传/获取与 Doc 删除见下文各票，Discovery 分属后续票。
- **导入（Copilot 票 14）**：`import_works{mode: identifier|bibcode|bib, text}` 是导入菜单三个对话框的提交，只接受对话框能收到的文本（标识符、bibcode、BibTeX 文本），没有路径或文件字段。它与 `POST /api/library/works` 共用同一处理（`runManualImport`：锁内解析/去重/落盘；之后同一 `importManualWorks`：默认 arXiv PDF 任务规则——identifier/bibcode 可排队，BibTeX 永不自动——与一次 `library.changed{add}`）。
  - **窄写入（局部修订，父代理 2026-10-04）**：旧行为＝导入经类型化 `LibraryStore.save` 整份重写 `library.json`，丢弃模型不认识的键（顶层与 Work 级）；新行为＝`saveWorksNarrow`：在 `libraryLock` 内重读原始文件，**新建**的 Work 只追加（绝不并入已存 Work），**匹配到**的已存 Work 以其原 id 窄更新（类型化字段覆盖，该 Work 的未知键保留），被折叠者按 id 删除，其余 Work、顶层、`project` 原样保留；没有任何存储值变化时不写盘。`library.bib` 由结果文件经同一类型化投影生成（对 HEAD 的类型化写入实测逐字节一致：测试里的 HEAD 原样副本对同一初始文件跑，覆盖新建、exists 补字段、合并模式桥接删除，含 core fixture）。写盘顺序与失败语义同 `patchWorkNarrow`：json、bib 先各写临时文件再依次 rename，暂存失败两者保持原样，两次 rename 之间失败可能 json 已更新而 bib 落后一次变更；此时页面路由返回 500 但 Work 已落盘（工具返回 `unknown` 并要求先读库）。原因：规格 §6.3，旧 schema 会 strip 未知键不能成为新 agent 路径丢数据的理由；页面导入随之受益。
  - **未知键只保留到下一次类型化整份保存**（票 15 修复轮 2 后的现状）：仍整份类型化重写、会丢未知键的只剩 CLI `library build` 与 CLI `addDoiWork`（`DELETE /api/paper/:doc_id` 的库步骤已在票 16 改为窄写，见下“Doc 删除”）；页面刷新、上传（含 zip 挂接）、arXiv 获取、PDF 发布、导入与主位 PATCH 都已窄写或经 `lockedRebuild` 补回键，见下“全文获取”。
  - **既有竞态已关闭**：LaTeX zip 上传与 arXiv attach 原先“锁外 load → 摄入 → 锁外 save”会冲掉期间的其他写入；两者的挂接现都是锁内重读后的窄写（摄入本身仍在锁外，但不再整份覆盖），门控管线测试复现并证明。
  - **新建 Work 的 id 冲突（本票选择＝拒绝并说明，不加后缀）**：无 DOI/arXiv/OpenAlex 的 Work 的 `work:` id 由标题前 48 个规范化字符＋年份派生，不同论文（系列论文 I/II、无标题同年）可得到同一个 id，而身份键不同。库内没有 id 唯一化规则，Doc 关联、图节点、PATCH 都以 id 寻址，临时加后缀等于新增身份方案，所以新建条目若 id 已被**另一篇**占用，则该条目报错（`created` 之外的 `error`，零写入，原因写明“id 由标题和年份派生已被某论文占用，请补 DOI/arXiv id 或改标题/年份”），同批其余条目照常。对页面的影响：旧行为（HEAD）会静默写入两条同 id 的 Work（之后按 id 选择/PATCH 只命中第一条，属既有缺陷）；现在页面与工具都拒绝并给出原因。
  - **结果语义**：逐条结果（created / exists / error）与对话框相同。`exists` 不会产生第二条，但**可能更新那条 Work**：`mergeInto` 补空字段（title/venue/doi/abstract/cite_key/journal 等）、`planFor` 重算 `acquisition`、`type` 在原为 article 时可被改成 conf；note/tags/read/star 等用户数据不动。是否真的改了存储对象按值比较：改了＝`library.changed{add}`（页面与工具一致，页面也据此刷新），没改＝不写盘不通知。工具状态：有新建或有更新＝`ok`（结果带 `updated` 的 Work id），文件原样＝`noop`，全部失败＝`error`（库未改），批量部分失败＝`ok`＋`import_partial`，中途抛错＝`unknown`（可能已存入部分条目；先用 `read` 以标识符或标题查询核实，`read` 的查询也匹配 DOI/arXiv/bibcode/work id，裸 stub 可被找到，页面搜索框不变）。
  - **桥接合并（已知既有缺陷，本票不改页面行为）**：一条导入记录同时命中两个已存 Work 时，`store.upsert` 把后者并入前者并删除它，`mergeInto` 只合并空字段/并集列表，被删 Work 的 note/star/read 随之丢失。页面入口仍如此；**agent 路径整条拒绝**（`rejected`，零写入，错误说明会合并哪几条 Work，请用户在 Library 页处理；批量中任一条会桥接则整批拒绝）。
  - `operationId`：同 id 同参数返回首次结果，同 id 异参数拒绝，begin 已记录而无结果＝`unknown`；业务去重按身份，与 operationId 独立；journal 的 begin 记录 mode＋截断文本摘要，resume 说明可读。导入不自动选中或打开对象，也不收藏推荐候选；要显示由 `select_work`。BibTeX 菜单项文案含 “RIS” 但实际只解析 BibTeX，本票不扩格式。

- **全文获取（Copilot 票 15）**：`library` 工具新增 `acquire_arxiv_pdf{refId}`、`attach_arxiv{refId}`、`read_jobs{refId?}`，对应 Files tab 获取对话框的两个 arXiv 提交与任务状态行。它们只收 work id，没有路径、URL 或文件字段。
  - **共用启动**：`POST /api/library/acquire-arxiv-pdf` 与 `POST /api/library/attach-arxiv` 的校验与排队抽成 `startArxivPdfAcquisition` / `describeArxivSource` + `startArxivSource`（`app.ts`），HTTP 状态码、响应体、重复在途返回同一 Job 不变；工具经 `LibraryOpDeps.acquisition` 调同一函数。Job 仍是原 JobRunner 的 `upload`（payload.format=`arxiv-pdf`）/`ingest` 串行任务、同一持久化与 `job.*` → `library.changed` 顺序；Copilot run 不是 Job，工具的等待只是对 `JobRunner.waitFor` 的 promise 订阅，不占串行槽。
  - **结果**：`ok`＝任务完成（结果带真实 `job.id`、`docId`）；`error`＝任务失败（`job.error`/`errorCode`，arXiv 失败日志同页面；**不保证库不变**：arXiv LaTeX 在 Doc 已挂接后 index 重建失败时库已改，PDF 关联失败会留下未挂接的 bundle，工具说明要求先读 work 再决定）；`pending`＝等待超时（默认 10 分钟）或用户按了 Stop 时任务尚未结束，任务自行继续、不取消；之后会话里的操作记录按 Job 表实时显示最终状态与 Doc。同 id 同参数返回首次结果；每次成功的 PDF 获取仍是新 Doc（相同 bytes 也不去重），在途同 Work 同格式任务被复用（`reused:true`）。Stop 先关新动作准入，不再提交新任务。
  - **替换需要真人确认**：`attach_arxiv` 遇到该 Work 已有自己的 arXiv LaTeX Doc（原位刷新）时，先做**只读**标注风险读取（core `readAnnotationRisk`：同 CLI `annot` 的读法——读 IR、读 current.json、算指纹；**绝不调 ensure/归档**，归档权威仍仅 server GET/PUT annotations 访问路径；指纹不符＝当前标注已失效，按 0 条显示，下次正常访问时才归档；任何读不出来的情形＝未知，不当作不符）。busy/缺失直接拒绝不出卡；其余出确认卡（已知 N／未知；未知时不显示标注版本），绑定 Work、Doc、标注计数与 rev、Doc 当前内容指纹、Work 的 Doc 列表摘要。点击时与提交前各重验一次（同样只读）；library/annotation 通知触发的重验也只读，不会因通知驱动归档。拒绝／Stop／重启零写入、不复活。无目标时（无 Doc、PDF-only 追加）与页面一样不确认；有非 arXiv 内容的 Work 仍拒绝。注意与页面对话框的差别：对话框打开时的风险读取走 GET（会 ensure，可能立即归档已失效的旧标注），agent 的卡片不会。
  - **附件（票 15 修复轮 2）**：Copilot 输入区按原型 A 增加“添加附件”（plus）与可移除的文件 chip。用户选的文件经 `POST /api/copilot/conversations/:id/attachments`（原始 bytes，`X-Filename`）由应用保存到 `<dataDir>/copilot/attachments/<会话>/<id>.bin/.json`（原子写，上限 50 MiB，记录 id、文件名、大小、类型、sha256），不是 Reader 的历史版本，也不随 Doc 删除恢复；发送时附件元数据（不含 bytes）随该条 user envelope 保存，发送前可移除，已发送的随聊天记录保留。agent 只能用「本会话某条消息已带出的附件 id」：他会话、伪造、未发送、已删除或内容与记录 sha256 不符的 id 一律 `not_found`，不接受路径/URL。
  - **上传动作**：`upload_pdf`、`upload_latex_zip`（该 Work 尚无上传源）、`replace_upload_source`（替换已有 `upload-*` Doc，需真人确认卡：Work、Doc、标注计数与指纹、附件 sha256 绑定；拒绝/Stop/重启零写入）。与页面上传共用 `startPdfUpload` / `startZipJob` 同一 JobRunner 任务、同一去重（同 Work 相同 bytes＝既有 Doc，工具状态 `noop`）、主位与 busy 规则；agent 只走异步任务，不开放 `sync=1`。zip 上传的挂接改为锁内窄写（`attachLatexZip` 的 `linkDoc`：按 id 重定位 Work；只有该 Work **原本有值**的 doi/arxiv_id 被改动才算身份变化，补全空字段（富化）不是；`appendDocIdNarrow`＋`patchWorkNarrow` 置主），页面 `sync=1` 一并受益。身份真的变了时挂接失败，任务以错误结束，说明**文档正文可能已被替换、未挂接，请读 work**（摄入先于挂接）。PDF/图片是否作为多模态内容送模型留给票 30。
  - **upload_latex_zip 与在途上传（票 15 修复轮 3）**：agent 提交时，该 Work 有 queued/running 的 zip 上传任务，或上传 Doc 被 writer pin/busy，则 `rejected`（与页面在上传期间禁用一致，不叠加也不改写用户刚传的正文）；agent 的 zip 任务带 `expectNoUpload`，任务轮到时、摄入之前在锁内复查上传 Doc 既不在 `doc_ids` 也无目录，否则以 `skipped` 结束、零写入、不发 `library.changed`。`replace_upload_source` 与 `upload_latex_zip` 在出卡/入队前先做可读 zip 校验。≥25 MiB 的 PDF：页面要用户勾“继续上传”，agent 路径对应一张真人确认卡（`accept_pdf_resource_warning`，绑定附件 sha256），拒绝/过期零写入、不起任务。附件的删除与发送在同一会话锁内互斥。
  - **已知遗留（D2，不在本票）**：附件的磁盘占用没有每会话总量/数量上限，未发送即放弃的附件、会话切换遗留的上传不会被自动清理；需要时另立票。
  - **局部修订（2026-10-04，票 15）——PDF Doc 发布的关联写入**：旧行为＝`publishPdfDoc` 经类型化 `LibraryStore.saveJson` 整份重写 library.json，丢弃未知键；新行为＝core `appendDocIdNarrow`：重读原始 `library.json`，只给目标 Work 的 `doc_ids` 追加该 Doc，其它 Work、顶层/`project` 未知键原样保留，仍只写 json（不碰 bib）；原因＝规格 §6.3，agent 新路径不能丢数据；上传 PDF 与 arXiv PDF 获取（含自动任务）共用同一发布函数，随之受益。
  - **局部修订（2026-10-04，票 15 修复轮 1）——arXiv LaTeX 获取的库写入**：旧行为＝摄入（分钟级）在锁外，之后锁外 `LibraryStore.load → save` 整份覆盖，并发的导入、PATCH、未知键会被冲掉，随后 `rebuild`（及 `reassertMainDoc` 的类型化 `patchWork`）再整份类型化重写；新行为＝服务端注入的 `linkDoc` 在 `libraryLock` 内重读原始 json、重验场景仍为 attach/append，用 `appendDocIdNarrow`＋`patchWorkNarrow` 只追加该 Doc 并（无 Doc 时）置主；`appendArxivDocToPdfWork`、`reassertMainDoc`（含 zip 上传）同改窄写；`lockedRebuild` 在同一把锁内于 rebuild 前快照原始 json，rebuild 后 `restoreUnknownKeys` 按 id 补回顶层（version/project/works 以外）与 Work 级类型模型之外的键，tmp+rename 只写 json（library.bib 是类型化投影，不变）。局限：id 被改或被合并的 Work 无法对回；补写失败时 json 停在类型化版本并以任务失败如实报告；CLI `library build` 仍丢未知键（不在本票）；页面“获取 LaTeX”、zip 上传后的主位重申与“刷新”随之受益。

- **Doc 删除（Copilot 票 16）**：`library` 工具新增 `delete_doc{docId}`，对应 Files tab 的“删除文档”对话框（`DELETE /api/paper/:doc_id`，**全局物理删除**；没有“仅从当前 Work 解除关联”变体，页面也没有）。
  - **共用处理**：路由与工具共用 `deleteDocGlobally`（`app.ts`）：400/404/409 判定、`DocMutationRegistry.tryBeginDelete` 删除槽（与写者 pin、在途 refresh 互斥；删除中的 Doc 拒绝新上传）、`libraryLock` 内物理删 `output/<doc>/` 与 `annotations/<doc>/`（含 archive）、库步骤、一次 `library.changed{patch}`。HTTP 状态码与响应体不变。
  - **确认＝对话框的确认**（用户裁决：确认按 UI 既有规则，不更严也不更松）：Doc 删除在页面上永远要点“永久删除”，所以工具永远等真人确认卡；模型不能自批，聊天里写“已批准”只是 steering。卡片复用对话框的范围文案（`library.detail.deleteDoc.scope`/`pdfScope`）与标注计数文案，并**列出所有持有该 Doc 的 Work**（标题、是否其主位、删后剩余 Doc 数）；对话框的“计数加载中禁用确认”在卡片上没有对应态——计数在出卡前由服务端读好，读不出来显示“无法获取标注数量”而不是 0（对话框同样允许在未知时继续）。卡片绑定 Doc、所有 Work 及其 `doc_ids`、格式、计数与标注 rev、内容绑定（LaTeX：指纹/过期标志；PDF：sidecar 绑定的 SHA-256），点击时与执行前各重验一次；变化即 `expired`，拒绝／Stop／重启零写入且不复活。**点击即提交**（与页面“永久删除”一致）：点击后的 Stop 不撤销删除，执行前的第二次复核不再受准入状态影响，只在对象已变时 `expired`。执行时在同一 `libraryLock` 临界区内再比一次持有该 Doc 的 Work 及其 `doc_ids`（含主位），不一致＝`expired` 零删除。只有发起 run 所绑定的视图能决定这张卡（其它标签页的点击 409，与票 12 的绑定视图规则一致，因为离开保护问的是点击所在标签页的 Doc）。卡片也带对话框的“此操作无法撤销”风险行与“全局删除”标题。
  - **计数只读**：LaTeX 用 `readAnnotationRisk`（同 CLI `annot` 的读法，**绝不 ensure/归档**，不读 archive 内容；指纹不符＝当前标注已失效按 0 显示，下次正常访问时才归档），PDF 读经校验的 sidecar；通知触发的重验同样只读。PDF 的归属不是恰好一个 Work 时计数为未知（与页面计数路由一致）；“删后保留的其他 Doc 数”按去重后的 `doc_ids` 计。**只能删某个 Work 的 Files tab 列出的 Doc**：无 Work 持有的孤儿 Doc 返回 `rejected`（页面也够不到它，需在应用外处理）；HTTP 路由行为不变。与对话框的差别：对话框的 LaTeX 计数走 GET annotations（会 ensure，可能立即归档已失效的旧批次），卡片不会。
  - **busy**：出卡前 Doc 被写者 pin、在途 refresh 或正在删除 → `rejected`，不出卡；出卡后变 busy → 点击被拒（`expired`，零写入）；执行时仍由 `tryBeginDelete` 复核（对应页面的 409）。404 不是成功：出卡前不存在或确认后已被删＝`not_found`/`expired`，不声称删除。
  - **局部修订（2026-10-05，票 16）——`DELETE /api/paper/:doc_id` 的库步骤**：旧行为＝`removeDocFromWorks` 经类型化 `LibraryStore.save` 整份重写 library.json（并重生成 library.bib），丢弃模型不认识的键（顶层与 Work 级）；新行为＝core `removeDocFromWorksNarrow`：锁内重读原始 library.json，只从各 Work 的 `doc_ids` 摘除该 Doc（按 `String` 比较，其余条目保持原值），其它 Work、未知键、`project` 原样保留，**只写 json（tmp＋rename）、不碰 library.bib**（`doc_ids` 不进 bib）；响应、404/409 语义、`library.changed{patch}` 与主位递补（剩余首项）不变。新增前置检查：库文件须先能解析，否则在删除任何文件前 500（旧行为会先删文件后因读库失败留下半删状态）。原因＝规格 §6.3，Doc 删除对 agent 开放后不得丢数据。旧 `removeDocFromWorks` 保留但已无调用方。
  - **失败如实描述**：先删文件后改库，不是原子操作。物理删除中途失败＝500、library.json 字节不变（旧行为）；库步骤失败（极少）＝文件已删而库仍列出该 Doc，路由 500，工具返回 `error` 并说明“文件可能已部分/全部删除而库仍列出”，要求先读库；重试可补完清理。跨进程同时操作同一 Doc 仍不支持。
  - **Shell 三态**：页面用 `ws.docDeleted(docId, remaining)`；工具成功后服务向发起视图发送仅服务端可发的 `doc_deleted{docId, remaining}` 视图动作（不在任何工具 schema 内，不随 Stop 取消，不等待结果），Shell 调同一 `docDeleted`：非当前只更新列表；当前且有剩＝切到 `remaining[0]`；无剩＝无当前 Doc 并重置地址。`remaining` 取按库顺序第一个删后仍有 Doc 的 Work 的剩余列表（Doc 同属多个 Work 时页面按所看的那个 Work，这是唯一差别）。视图已注册但暂时断线时，动作最多等 30 秒补投递；之后或视图已不存在则没有即时更新，重新载入时读真实列表；其它标签页的 Shell 与页面一样不即时更新。确认点击在要删的正是当前打开的 Doc 时先问与对话框相同的离开保护（未保存标注草稿），拒绝则保留卡片。
  - **聊天附件独立**：已发送的 Copilot 附件与旧聊天内容不随 Doc 删除清理或恢复（规格 §8.2）。旧消息里对象引用的“已删除”显示不在本票实现。

- **探索（Discovery，Copilot 票 17）**：探索是浏览器标签内的临时只读状态（[discovery](discovery.md)），服务端没有 session，所以 `library` 工具对它的入口分三类：①`PageContext.discovery`（`DiscoveryPage`）＝视图发布的当前页：过滤/搜索后的可见节点、其间真实引用边、全局计数、打开的候选（含摘要与图内引用）、历史、loading/error/saving、图标签态，探索时替换 `library`（上下文状态：有图＝complete，仅失败＝error，加载中＝unavailable）；Library 页的 `library.exploration` 给出可继续的历史。②`read_discovery` 只返回绑定视图最后一次报告（标注为观测值）。③控件＝绑定视图动作（`explore_work`、`explore_candidate`、`retry_exploration`、`cancel_exploration`、`step_exploration`、`exit_exploration`、`resume_exploration`、`filter_discovery`、`search_discovery`、`set_discovery_display`、`select_candidate`、`set_discovery_tab`、`dismiss_discovery_error`、`view_candidate_in_library`、`set_discovery_graph_labels`、`discovery_graph_control`），由页面用控件自己的回调执行；一次 explore 动作恰好一次固定的 ADS 请求，不自动多跳；失败（带 HTTP 状态）报 `error`、用户取消报 `not_displayed`，被动作等待的上报窗口对 explore 类动作为 120 秒（其余沿用短窗口）。过滤/搜索谓词与页面共用 contracts `discoveryVisibleNodes`；探索控件只作用于活动 pane，`save_candidate`/`select_candidate`/`explore_candidate`/`view_candidate_in_library` 共用可达集合（可见节点＋打开候选＋其图内引用）；页面节点不带摘要，仅打开的候选带。
  - **`save_candidate{bibcode}`（唯一写）**＝候选的“加入文库”：复用 `applyLibraryImport`（即 `POST /api/library/works {mode:bibcode}` 的共用处理，14 的窄写入、派生 id 冲突拒绝、桥接整条拒绝、默认 arXiv PDF 规则、一次 `library.changed{add}`），结果语义同 `import_works`（`noop` 仅在文件字节未变时）。候选必须是绑定视图所报告的探索中的节点（可见节点、打开的候选及其引用列表），否则 `rejected` 零写入；成功后服务向发起视图发送仅服务端可发的 `discovery_saved{bibcode,workId}`（不在任何工具 schema 内），页面像自己的 Add 一样就地标记 libraryId，不重新查询、不动选择/视口/seed。重复保存沿身份规则＝`exists`/`noop`。局限：候选成员关系按视图最后一次上报校验（观测值）；页面“Add”在已保存节点上不显示，工具对已保存节点仍走同一身份去重（noop）。
  - 动作所属：页面把“加入文库”进行中的 busy 仅作浏览器本地防重入，服务端在 `libraryLock` 后排队。图“跳到起点”按钮已进入 GraphCanvas 控制器。外部链接（ADS）、拖/平移/滚轮、作者展开折叠为仅用户。

## 文本 Doc（Copilot 票 25）

手工文本 Doc 是同一 Work 下的独立 Doc（id `text-<UUID>`），规格见本地 Copilot spec §10–11，决定见 [ADR 0006](adr/0006-text-input-to-shared-ir.md)。已实现的最小闭环：

- **存储**：`output/<docId>/text-source.json` 是唯一源状态（Markdown 字节往返、单调 `rev`、资产清单预留）；`<docId>.json` 仅是最后一次成功生成的 TextDocIr，草稿阶段没有它是合法状态，不是损坏。`TexDocIr` 的 schema 与序列化不变；读取侧用 `StoredDocIr` union（`source.type` 区分）。
- **创建**：`POST /api/library/text-docs {workId, operationId}`。`operationId` 先绑定新 docId 再建目录（隐藏 staging + rename + 对 `doc_ids` 的窄追加，已有主 Doc 不变；Work 无 Doc 时新 Doc 成为主位）；重试返回同一 Doc，已被删除的操作不复活（`done` 标记在 Work 关联之前写入；失败回滚后可由同一操作完成）。绑定记录在 `<dataDir>/library/text-doc-operations.json`（与 library.json 同锁；损坏时明确报错 `corrupt_operations`、保留原文件，不覆盖）。来源 PDF 须属于该 Work 且唯一归属，并校验原件字节与固定 SHA-256。页面的创建按钮在同一次尝试的重试中复用同一 operationId，直到成功或服务端明确回 409。`dataDir`/`output` 为符号链接是合法布局（路径先 realpath 再校验），Doc 目录与源文件本身为符号链接仍被拒绝。library rebuild 不按标题为 text Doc 重新 seed Work，也不因没有 IR 剪掉草稿。
- **保存/校验/生成**：`PUT /api/paper/:id/source`（expectedRev，未闭合语法也能存）、`POST …/source/validate`（无副作用）、`POST …/source/generate`（显式；发布前复核源 rev，陈旧候选拒绝；一次原子 rename 发布；成功才发 `text-doc.published`）。生成器不归档、不广播 `annotation.changed`，归档仍只在标注 GET/PUT 访问路径。
- **28 之前的临时限制**：候选的标注指纹与已发布内容不同且当前标注非空（或无法读取）时拒绝发布（409 `replacement_blocked` / 500），不绕过数据保护；确认流程由后续票接入。当前格式只支持标题/段落/单层列表（强调与行内代码去样式保文字；裸 URL/邮箱/`<…>` 自动链接按原样作文字），其余语法按构造给带行列的专用诊断码（`math_unsupported`、`cite_unsupported`、`ref_unsupported`、`link_unsupported`、`table_unsupported`……），不静默丢字或改写；`$…$`/`$$…$$`、`[cite:`、`[ref:` 在词法分析前按 mdWithMath 的保护顺序（代码与 URL 先屏蔽）检出。源编辑器是 CodeMirror（`TextSourceField`，行号、原生 IME、`\n` 为唯一行分隔符以保证字节往返；全文字符串只在保存时构建）。rebuild 对无法读取的 text Doc 保留 Work 关联并在摘要的 `damaged_text_docs` 报告（只要 `output/text-<UUID>/` 目录还在就保留，包括从未生成且源文件丢失的草稿，使页面仍能经 Work 打开或删除它）。诊断行号与编辑器一致（只有 `\n` 换行，孤立 `\r` 是行内普通字符）；一次最多列出 200 条，其余以 `too_many_diagnostics`（带 `count`）汇总，行内代码只在同一块内配对（不跨空行）。
- **来源 PDF 与删除**：来源 PDF 只是文件关系（Doc id + sha256），删除 PDF 不级联；删除文本 Doc 复用全局物理 DELETE（源、IR、当前/归档标注、全部 Work 关联）。旧 CLI 对 text IR 不承诺支持（`list` 显示 unreadable，退出码 0）。

## 离线与派生数据

`library build --offline` 已 gate ADS、Crossref、OpenAlex，缓存仍可读；不推断所有 CLI 命令全局断网。DOI stub 富化、摄入缓存命中和 arXiv 恒新鲜 job 各自按路径判断。

库图 `graph.json` 是版本化派生缓存，saved-only 自愈规则见 [discovery](discovery.md)；`library.json` 损坏不能当缓存 miss。metadata 缓存的字节兼容规则见 [engineering](engineering.md)。
