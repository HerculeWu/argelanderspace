# 文库、身份与正文获取

状态：现行，包含 Stage 13 手动建条目与 Stage 15 arXiv 自动获取的最终规则。来源：`46093915` 的旧 product-and-architecture、contracts-and-decisions，以及 Stage 13/15 inbox；原文索引见 [history](history.md)。领域定义见 [CONTEXT](../CONTEXT.md)，冻结和用户数据保护见 [contracts](contracts.md)。

## Work 与 Doc 的身份

- work id：`doi:` / `arxiv:` 等；canonicalId 优先级 doi > arxiv > openalex > title-slug。用于 search/note/label 等文献管理。
- doc id：`arxiv-…` / 本地 `latex-…` / 上传 `upload-…`；用于 read/show/ref/list/annot 与阅读器。`search` 行的 `doc_ids` 映射正文。
- 同一 Doc 经身份归并可能被多个 Work 引用；主 Doc 为 **`doc_ids[0]`**。主位是位置指针，不是发表稿、补充材料或版本管理的自动分类。
- `ingest` 只写 output；**随后必须 `library build`** 才成为可 search/note/label 的 Work。docless Work 也可来自 bib 导入、历史 graph-node 或 DOI 建条目。
- CLI 支持 arXiv id/URL、本地 `.tex`、目录和 tarball。Web 上传仅收 LaTeX zip，必须先有 Work，attach-only。
- CLI 可解析 DOI 建 docless Work：DOI、`doi:` 或 URL 路径明确携带 DOI；Crossref 立即富化，失败留裸条目，重复 DOI 不写盘、不 rebuild。不可解析 DOI 的出版商 URL 或裸字符串仍报错，不能声称任意 URL 都能建条目。`10.48550/arXiv.*` 回 arXiv LaTeX 管线。

## 上传、多 Doc 与主位

所有 Work 都可上传。zip docId 为 `upload-<slug44>-<workId sha1前6>`，只随 Work 身份变化；同 Work 重传覆盖同一 upload Doc。向已有 arXiv/local 正文的 Work 上传会增加独立 upload Doc 并设主，旧 Doc 保留回看，UI 可“设为主”。

上传身份焊死：有 doi/arxiv 则 stamp source，没有则以 work.title 覆盖 doc meta.title，随后直挂 `doc_ids` 并校验；不能按失配标题挂到另一 Work。主位在 lockedRebuild 后锁内 re-assert，防并发 PATCH 覆盖；已有 library 的 seed dst-first 保序。

已有库 rebuild 保序不等于主位独立持久化：library 丢失后从零 rebuild 等残余问题仍由本地 I006 跟踪。本次文档迁移没有修复它。

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

## 添加时自动获取 arXiv 正文（Stage 15）

创建/exists 同步返回 Work；随后由 server 排队持久获取 job。自动触发范围：identifier 的显式 arXiv（含 DataCite DOI 折入）、bibcode（含 Discovery 入库）、DOI **仅当既有解析链已给出 arXiv id**。不新增 DOI 反查 arXiv；**批量 bib 永不自动**。

### 场景表：新的替换旧的，但不动用户上传

提交时和执行时均重查：

| 场景 | 状态 | 行为 |
|---|---|---|
| A | Work 无 Doc，且有 arXiv id | 新获取，挂载为主 Doc |
| B | 有同一 arXiv id 的 arXiv Doc | 恒新鲜下载最新源、重编译、同 Doc id 原位覆盖；doc_ids 顺序和主位不动 |
| C | 有 Doc 但无匹配 arXiv Doc，典型为用户上传 zip | 不自动触发，手动端点 409；绝不覆盖用户内容，想换源先删 Doc |

B 的标注按既有完整三态契约处理：同指纹保留、成功算出不同指纹后 server 访问时整批归档、无法计算则不碰用户标注。不能由“重新获取”推导出任意标注迁移权限。

同 Work 已有 queued/running 获取 job 不堆叠，返回既有 job。执行时已变为 C 则 skipped，不覆盖。JobRunner 串行 FIFO、持久状态，V1 无取消，boot interrupted 不重跑。

### 手动入口、API 与挂载

手动入口：docless 附件 tab 的可点击获取行、arXiv Doc 行“重新获取”、导入菜单重添加（exists 按同一场景表）。自动路径与手动路径共用同一提交实现。

`POST /api/library/attach-arxiv?id=<workId>`：202 `{job}`；400 无 arXiv id / 畸形输入，404 Work 不存在，409 场景 C 或 busy。新端点不是第二套建条目实现。

- 启用预留 job kind `"ingest"`，payload `{workId, arxivId}` 使用创建后最终 ref.id；arXiv 身份可能在 resolve 后 recanonicalize 为 doi 身份。
- `JobSchema.errorCode` 可选，PDF-only 使用 `"arxiv_pdf_only"`；`library.changed` cause 新增 `"ingest"`。这是最终落地语义，不沿用旧方案“复用 upload cause”的设想。
- job.done 先于 `library.changed{cause:"ingest"}`。submit→终态持 DocMutationRegistry pin，与 upload/DELETE 沿用双向 busy 保护。
- 挂载照 upload：新鲜下载/解包/编译 → stampSource 焊身份（`acquired_via="arxiv_eprint"`，与 `user_latex_zip` 分开）→ 直挂 → 锁内 rebuild → **仅 attach 时 reassert 主位** → 终检。刷新不改主位。
- 下载/编译在锁外，library 的 load→save/直挂/rebuild/reassert 在 libraryLock；不把单 server 锁说成跨进程事务。
- arXiv 获取使用无版本 `arxiv-<sanitize(normArxiv)>` Doc id；CLI 显式 vN 摄入的带版本目录是另一条路径，不能将其默认为同一目录。
- 恒新鲜下载不读取 `.latexcache` 旧包，下载成功覆写缓存；解包刷新 src，Throttler 礼貌延迟不变。

### 失败、日志和展示

- `ArxivPdfOnlyError` 类型化，**既有错误文案逐字节不变**，CLI 零变化；PDF-only 的 UI 双语引导上传 zip，其余显示 job.error 原文与重试。
- `<dataDir>/logs/arxiv-fetch.jsonl` append-only plain text，只记 arXiv 来源 failed/interrupted，不记成功，不记 upload。字段包括 time/jobId/workId/arxivId/stage/error；阶段 download/extract/compile/attach，boot interrupted 经 onInterrupted 钩子记录。
- 保持发布包中日志可直接读取。用户将其定为 v1 迭代重要参考：arXiv 来源错误优先处理，上传源本身可能有问题，二者不能混成同一报错队列。不新增 Work 持久“获取失败”状态。
- 信息面板标题下移除全部获取广告态（ready/blocked/unknown），保留“来源”与“待上传”。附件 tab 只保留 arXiv 获取能力：可点击行保持原 pill 样式，不改按钮；显示进度、持久失败、重试，hello 可收养 job。
- journal html/pdf、ADS scan 等来源广告清理；数据层 planFor 仍计算，不以 UI 清理名义改 planner。无 arXiv 的 docless 项保持待上传。
- demo/无后端时依既有 upload 约定禁用/隐藏真实操作，不伪造成功。新 UI 双语。

### 隐藏开关与非目标

`auto_ingest_arxiv` 默认 true，提交前现读 config.toml，UI 不提供开关。false 只关创建/exists 自动排队，手动入口保留。理由：流量限制、不可访问 arXiv 或不想看到报错的边缘需求真实存在。

本阶段没有 CLI 自动拉取（I035 仍推后）、批量 bib 自动获取、PDF/OCR/HTML 摄入、job 取消、全局 job 列表、upload 报错写入该日志、跨进程同 Doc 并发写承诺。未来能力不是默认实施队列。

## 离线与派生数据

`library build --offline` 已 gate ADS、Crossref、OpenAlex，缓存仍可读；不推断所有 CLI 命令全局断网。DOI stub 富化、摄入缓存命中和 arXiv 恒新鲜 job 各自按路径判断。

库图 `graph.json` 是版本化派生缓存，saved-only 自愈规则见 [discovery](discovery.md)；`library.json` 损坏不能当缓存 miss。metadata 缓存的字节兼容规则见 [engineering](engineering.md)。
