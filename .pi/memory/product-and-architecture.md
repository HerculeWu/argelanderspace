# 产品与架构：当前事实

整理：2026-09-16。来源：Stage 3–11 及 reader epoch 已落地记录；后来的明确决定已替代旧方案，详见 [history](history.md)。本文件负责能力与数据布局，硬约束权威见 [contracts-and-decisions](contracts-and-decisions.md)。

## 产品与能力

**ArgelanderSpace**（npm `argelanderspace`，MIT，© Wenjie Wu；repo `HerculeWu/argelanderspace`）是单用户科研工作台，承担用户与 AI agent 协作的 interface。文献工具链是已落地核心，而非产品全部。目标形态是 terminal 科研助手 + webui 工作台，用户仍能亲自读论文。

当前能力：

- arXiv LaTeX / 本地源码摄入 → 项目级文献库与引文图谱 → React 三栏阅读器 → CLI + skills 协作。
- **Stage 14 ADS 文献发现（Discovery）**：文献详情「探索相关文献」（需 work 有 bibcode，demo/无后端禁用）→ 文献页内探索模式：ADS `similar()` top 18 相关 + `useful()` top 6（基于实际 related 集）候选，图为可见节点间真实引用；`#explore/<bibcode>` hash 深链接、前端 session 栈前进/后退（仅成功 seed 跳转进历史、失败保留旧图）；候选详情（摘要/书目/本图引用，无 BibTeX tab）；入库只走 Stage 13 `POST /api/library/works` bibcode 路径，就地更新不打断探索；加载为诚实不确定态 + 真取消。库图退役旧全局推荐：**saved-only**（节点全是已存 work，边 = 已存 referenced_works + 离线 bib）+ graph.json `version`（当前 2）锁内惰性自愈。
- 计划页已落地，默认 landing；webui 可独立 CRUD 计划、任务与文档标注，不依赖 agent。**Stage 13 起 webui 可手动建文献条目**：侧栏导入菜单三模式——标识符（DOI / `arXiv:` 前缀 / arxiv.org URL，裸 arXiv id 报错引导）、ADS bibcode（fail-fast）、BibTeX 全文批量（纯本地、逐条部分成功、尊重用户 cite key、冲突逐条报错）；就地建立不触发全库 rebuild，重复身份 exists 只补空字段。**Stage 15 起**：有 arXiv id 的条目在创建/exists 后自动排队获取 arXiv 最新源并编译挂载（场景表 A 新挂主 doc / B 同 id 原位刷新 / C 只有用户上传则不碰；批量 bib 永不自动）；手动入口 `POST /api/library/attach-arxiv` 与附件 tab 可点击行/「重新获取」；获取类广告标签已清理（只保留来源/待上传事实）。
- Write 页已交付：独立稿件列表、八型 cell、模板选择、Info/Preamble、per-cell comments、上传图片与 LaTeX 源码 zip 导出（附模板 cls/sty/bst 依赖）；CodeMirror 编辑、共享 latexmk→facts+AST→IR 的 cell 预览，不展示 PDF。Stage 12 起渲染由 Shift+Enter/Render 显式触发（自动保存保留），bib 转义与 ADS 富化修复 Report citation；Stage 10/11 为带问题关闭，遗留 I030/I031 已由 Stage 12 关闭。
- webui zh-CN/en 即时切换，偏好随 Tweaks 存 localStorage，默认中文、不探测浏览器语言；UI 文案集中双 JSON。server detail/job.error 与用户数据（例如库名）不在翻译范围，CLI 输出不变。
- 文献 note tab 目前只读，持久化 note/label 写入口仍主要是 CLI；右键色点 overlay 仅会话级。webui 独立应用是目标，不等于所有写路径已补齐。
- PDF/OCR/出版商 HTML 摄入不在 main，封存于 `ocr-features` 一次性快照分支；不要把那里能力写成现行功能。

## 摄入与 work/doc 身份

- 支持 arXiv id/URL、本地 `.tex`、目录、tarball；webui 上传只收 LaTeX **zip**，入口在已存在 work 的详情页，attach-only。
- **CLI 可解析 DOI 建 docless work**（Stage 7 已落地）：DOI、`doi:` 或 URL 路径中明确携带 DOI；Crossref 立即富化，失败保留裸条目，重复 DOI 不写盘、不触发 rebuild。无法解析 DOI 的出版商 URL、裸字符串仍报错，不能声称任意 URL 都能建条目。`10.48550/arXiv.*` 回 arXiv LaTeX 管线。
- 文献条目 **work** 与具体正文 **doc** 分开；work 可以没有 doc，也可有多个 doc。同一 doc 经身份归并可能被多个 work 引用。
- work id：`doi:` / `arxiv:` 等；canonicalId 优先级 doi > arxiv > openalex > title-slug。用于 search/note/label 等文献管理。
- doc id：`arxiv-…` / 本地 `latex-…` / 上传 `upload-…`，用于 read/show/ref/list/annot 与阅读器。`search` 行的 `doc_ids` 做映射。
- `ingest` 只写 output；**随后必须 `library build`** 才成为可 search/note/label 的 work。docless work 还可由 bib 导入、graph-node、DOI 手动建条目产生。
- rebuild 的 `cite_key` **只增不改**：预灌已有键，只给缺失的新 work 分配并避让冲突；不能无条件重排（Stage 7 Q5）。**Stage 12 修订分配侧**：分配时有 bibcode → cite_key = bibcode，无 → 现有 citeKey()；分配后永不改（含后来才富化出 bibcode 的条目）。存量 38 条经一次性授权迁移为 bibcode 并同步替换两个 demo 稿件 key。**Stage 13 手动 bib 建条目例外**：尊重用户 bib 自带 key，与既有键冲突逐条显式报错（`library build --bib` 导入路径仍系统分配）。DOI stub 可 title bridging 归并、就地 planFor 和分配键，不隐式触发全库 rebuild。

### 上传、多 doc 与主位

所有 work 都可上传；主 doc 为 **`doc_ids[0]`**。zip docId = `upload-<slug44>-<workId sha1前6>`，只随 work 身份变，同 work 重传覆盖同一 upload doc。向已有 arXiv/local doc 的 work 上传会增加独立 upload doc 并设主，旧 doc 保留可回看，UI 可“设为主”。这是并行 doc + 位置指针，**不是版本管理**。

上传身份焊死：有 doi/arxiv 则 stamp source，没有则 work.title 覆盖 doc meta.title，随后直挂 `doc_ids` 并校验。主位在 lockedRebuild 后锁内 re-assert，防并发 PATCH 覆盖；已有 library 的 seed dst-first 保序。library 丢失后从零 rebuild 等残余边界见问题清单。

## 存储与配置

默认项目级 `./literatures`，**仅 cwd 相对，无向上查找**。配置优先级：

`--data-dir` > `ARGELANDERSPACE_DATA_DIR` > config.toml `data_dir` > `./literatures`。

**ADS BibTeX 富化（Stage 12）**：enrichAndPlan 中有 bibcode 且无已存字段 → 批量 ADS export 拉取、解析补齐 work 结构化字段（volume/number/pages/eid/month/journal_macro 等），不存 BibTeX 原文 blob、不覆盖既有字段；`--offline` 跳过，失败不阻塞、下次 build 重试，已存不自动刷新。`library.bib` 仍是唯一派生出口：`workToBibtex` 输出全部非空字段并转义 `& % # _`（`$` 除外）；有 journal_macro 输出 `{\aap}` 宏，宏由 Writer 编译/导出侧注入定义。

```text
<有效 dataDir>/
├── output/<doc_id>/
│   ├── <doc_id>.json       # TexDocIr，version:1，渲染 IR 即存储
│   ├── src/               # 源树
│   ├── build/             # aux/bbl/toc/fls/argelander.jsonl 等编译事实
│   └── assets/            # 直通图或 PDF/EPS 转 SVG
├── output/.latexcache/    # arXiv 源包缓存
├── library/               # library.json、bib、富化缓存、cache/{ads,crossref,openalex,ads-discovery}、graph.json(v2)
├── jobs/                  # 持久 job 与 spool
├── logs/                  # Stage 15：arxiv-fetch.jsonl 报错日志（append-only，只记 arXiv 来源失败/中断）
├── input/
├── annotations/<doc_id>/
│   ├── current.json       # 独立用户数据，不是摄入 IR
│   └── archive/           # 整批失效原文，正常 reader/agent 不暴露
├── manuscripts/<m_id>/    # manuscript.json、原始 assets/、派生 build/
└── templates/             # <id>.json 用户覆盖、<id>.deps/ 本机模板依赖
<有效 dataDir 的父目录>/status/plans.json
```

`statusDir = resolve(dataDir, "..", "status")`，不是无条件使用 repo/status。plans/annotations/manuscripts 用 pretty 2 空格、rev 乐观锁、tmp+rename。Writer manuscript/template/cell 为 loose schema 保未知键，不能反推 plans 已解决 I010。配置默认 `~/.config/argelanderspace/config.toml`，支持 XDG_CONFIG_HOME；env 优先，未知键忽略，已知键类型错报键名但不回显值。

**`library build --offline` 已约束 ADS、Crossref、OpenAlex 网络调用**，缓存仍可读（Stage 7 `f320c6b` 修复；旧“ADS 恒活”作废）。不要由此推断所有 CLI 命令都全局断网；ingest 缓存命中、DOI stub 富化是各自路径。

**ADS 发现缓存（Stage 14）**：`cache/ads-discovery/` 独立于元数据 ads 缓存，存 provider 检索响应（{fetchedAt, data}），TTL 24h，键含查询/字段/rows/sort；网络/鉴权/限流错误不缓存，abort 不写缓存。Discovery 响应本身不缓存（含即时 libraryId）。

## LaTeX 双通道管线

1. 隔离 tmpdir workspace，拒 symlink，2 GB / 10k 文件护栏。
2. latexmk：pdflatex 优先，失败自动 xelatex；120s 超时杀进程组，不因超时再换引擎；minted/显式 write18 预扫描拒绝。插桩失败可回退干净编译；**编译本身失败硬报错，不做无编译全文降级**。
3. `.aux/.bbl/.toc/.fls` 与 `argelander.sty` 的 cite/label/section/mathnum JSONL 事实，加 unified-latex 源码树（input 合并、有界宏展开）融合成 IR。
4. 编号采用编译真值（mathnum/section 事件、lot/lof/aux 与有警告的回退），显示号与寻址 id 解耦；**未编号 display 无自产号**。
5. 图物化：光栅/SVG 源字节直通；PDF → `pdftocairo -svg`；EPS → gs pdfwrite → pdftocairo。转换失败或工具缺失只降级图，caption/块保留。pandoc、mupdf、dvisvgm 路线已退役。
6. `TexDocIr` 直接落盘；source/meta 身份块、references/bib/refsManifest/citationsByBlock、原生 text/math/cite/xref segments。旧 Document 桥与双轨 occurrences 已删。

编译成功保必要产物，干净成功不留 log；降级成功保 log，失败分类与 `!` 摘录进入 job error。warning 经进度通道显示，不是 IR 字段。编号盲区、作者抽取、引用清洗等见 [tex-pipeline](../memory-reference/tex-pipeline.md)。

## Web 与同步

- `serve` 默认端口 8000。计划页：plans→tasks；列表/看板/时间线/今日聚焦，任务抽屉、文档链接、Markdown+数学 note。详见 [plans](../memory-reference/plans.md)。
- 文献看板：label 色板 red重点 / amber待读 / green已精读 / blue方法 / violet灵感；overlay > 持久 label > star 播种。已读标题灰化及“已读”，未读蓝点。
- 阅读器：中列流式 + 100ch 上限，顶部折叠当前论文作者块；多引用 per-ref chip（chip 间折行）；图尺寸预留 + jumpTo 停稳校正。
- 右栏 `引用 | 标注`，默认引用；文本选区/结构边钮/整篇按钮可创建标注，正文 DOM 不嵌套高亮 span，使用 CSS Custom Highlight。完整数据契约见决策文件，交互细节见 [annotations](../memory-reference/annotations.md)。
- 手卷深链接 `/doc/<doc_id>#<anchor>`：sec-N/fig-N/eq-N/tab-N/ref-N 等是管线结构 id，非印刷编号；`#ann-<annotation_id>` 定位标注。
- Hono REST + `/ws`；server 轮询 library、plans、per-doc current annotations、manuscript JSON 与模板 JSON 指纹，广播各域 changed（含 `writer.changed`）。server 自写可再收到 external，前端重取幂等；没有资产目录 watcher。
- **图谱可增量更新（Stage 13/14）**：手动建条目时 `mergeWorkIntoGraph` 就地补新节点与本地可算 saved↔saved 边；Stage 14 起不再发 OpenAlex 补 suggested 邻居。即时尽力可视化，全局收敛仅全量 `library build`/refresh 权威。批量 bib 只补裸节点，富化留下次 build。
- **图谱为 saved-only（Stage 14）**：节点全是已存 work；graph.json 带 `version`（当前 2），serve 时缺失/无版本/损坏/版本不符 → `libraryLock` 内 double-check + 重读最新 store 纯本地重建 + 原子写盘；自愈失败显式 500，不广播 library.changed；library.json 损坏仍显式失败。
- 探索模式深链接 `#explore/<bibcode>`；F5 重查当前 seed，历史栈内存态刷新即丢。
- 摘要渲染（Stage 14 修复）：库页与探索页摘要统一 `abstractHtml`——provider HTML 白名单清洗（SUB/SUP/I/B/EM/STRONG/BR/P，剥属性，活性内容剔除）+ 文本节点内 KaTeX（texmath 边界规则）；注入沿用单用户 dangerouslySetInnerHTML 惯例。
- **reader I001 已在批准范围内关闭**：ReaderSession 经 annotations GET `?coherent=1` 共同接纳 IR/current/同读资产 manifest，正常摄入通知后无需 F5。更新/失败保旧文字布局和会话草稿，隐藏高亮/图片并暂停标注与旧定位；图实际 bytes 按 manifest hash 校验后 Blob 展示。失败手动重试、图片自动恢复最多一次，细则见 annotations 专题；不能推广为任意外部资产改动、无限自动恢复或跨进程一致性。
- Job 串行、落盘；boot 时未完 job 标 interrupted，不重跑；hello 回放状态，失败在详情刷新后仍可见；job.done 先于 library.changed。**Stage 15 起启用预留的 `"ingest"` job kind**（arXiv 自动获取，payload `{workId, arxivId}`），`library.changed` cause 枚举加 `"ingest"`，`JobSchema` 增可选 `errorCode`（`"arxiv_pdf_only"` 驱动 UI 双语引导）。

## Writer 与独立稿件

Writer 不属于文献摄入：稿件不建 work/doc、不入 library、不承接 reader annotations。References 只读全库，点击插入裸 key，Crossrefs 裸 label；无独立 Writer CLI，agent 协作接口为有文档的 JSON 文件契约。

内置 aa/report/letter 为 contracts 单源，用户模板 JSON 同 id 覆盖，坏文件警告跳过。cell 序列化规则固定在代码；zip 包含单 manuscript.tex、独立被引 references.bib 与原始图，缺依赖等附警告，不伪装可编译。aa.cls/aa.bst 不随 npm 包分发。

Writer 显式 profile 复用编译、facts/source/fuse/IR 与展示能力，隔离 reader 默认输出和摄入/归档副作用；build 为派生缓存。**Stage 12 起渲染为 Shift+Enter/Render 显式触发**（保存后/打开/外部变更/切模板均不自动编译），自动保存不变；无 ok 缓存时预览区占位提示。编译与导出 zip 注入 `\providecommand` 期刊宏组（`\aap` 等 ADS 常见天文期刊）。只保留与精确源码/目标对应的旧预览；失败不清稿件，不错套旧编号。完整机制与兼容边界见 [writer](../memory-reference/writer.md)。

## Agent 接入

CLI + repo `skills/argelander-*` 三件套（ingest/query-library/read-paper），无 MCP 是项目选择，不依赖对 pi 上游能力的永久断言。skills symlink 到 `~/.pi/agent/skills/`。

- agent 命令：search/read/show/ref/note/label/list + 只读 annot；CLI 直读磁盘，不依赖 server HTTP。
- **回答文献问题**必须走 CLI/skills，项目根运行，不传 `--data-dir`，不读内部 JSON/源码替代文献接口；这不是禁止开发任务读源码。
- repo CLI：`node packages/app/dist/bin.js`；全局装后 `argelanderspace`。
- 深链接端口：`ARGELANDERSPACE_PORT` > config `port` > 8000。
- search 空 note hint 走 stderr，stdout 保持 JSONL；摄入后每篇询问 note 并给建议稿。接口冻结详见契约文件。

## 模块边界

pnpm workspace，ESM-only，TypeScript strict + noUncheckedIndexedAccess，Biome，Vitest：

| 包 | 职责 |
|---|---|
| contracts | Zod：TexDocIr/DocIr、Reference、library/job/WS、plans、annotations/coherent、writer/preview；canonical annotation text 与 Writer 序列化纯函数，web runtime 可用 |
| core | 领域：pipelines/tex facts/source/fuse/ir/编排；documents 渲染与 references 解析；library store/seed/graph/build；acquire/upload；plans/annotations/writer store，Writer export/preview |
| infra | tex workspace/compile/instrument/figures/ingest；latex/arxiv-source 抓取解包；ADS/Crossref/OpenAlex、config、zip、pyjson 缓存兼容；Writer opt-in 编译缓存 |
| server | Hono REST/SPA/images/WS、job runner、watcher、各领域锁及 DocMutationRegistry、Writer 编译 single-flight/drain |
| cli | 命令注册、agent 冻结输出与磁盘读写 |
| web | React 阅读器/文献/计划/标注/Writer/探索；共享 IR 展示、ReaderSession、i18n、graph/ 共享图渲染器（LibraryGraph/DiscoveryGraphView 两 adapter） |
| app | npm 单包，tsup dist/bin.js + dist/web + dist/argelander.sty + 依赖 notices；createRequire banner 仍必需 |

`/api/paper/:id/ir` 直接读存 IR，旧 raw `/api/paper/:id` GET 已删（不要与新 DELETE 混淆）；旧无 version 文档需重摄入，不再投影。单用户文件存储，不使用 SQLite；截至 Stage 8 没有 CI。结构定位优先用 CodeGraph，再在不足时读源码。
