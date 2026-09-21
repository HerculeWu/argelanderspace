# 产品与架构

ArgelanderSpace（npm `argelanderspace`，MIT，© Wenjie Wu）是单用户科研工作台。用户通过 webui 独立操作、亲自阅读，也通过 CLI + skills 与 agent 协作。领域语言见 [CONTEXT](../CONTEXT.md)，不可擅改的边界见 [contracts](contracts.md)。

本页记录当前能力和结构，不列待实现任务。产品事实来自 Stage 15 关闭后的记录；阶段结果见 [history](history.md)，新工作由用户决定。

## 能力入口

- **文献库与正文**：arXiv LaTeX / 本地源码摄入，手动 DOI、显式 arXiv、ADS bibcode 或 BibTeX 建条目，zip 挂载，多 Doc 与主位；web 添加时自动 arXiv 获取。身份、存储规则及获取场景见 [library](library.md)。
- **文献发现**：从详情页进入 ADS related/useful 临时探索；库图只含已存 Work。边义、失败语义、缓存与用户状态分离见 [discovery](discovery.md)。
- **阅读器**：React 三栏，正文、引用和标注共享 IR；同 Doc 正文更新经共同 epoch 接纳，无需正常流程中手动 F5。交互、资产、草稿和恢复边界见 [annotations](annotations.md)。
- **计划页**：默认 landing，plans→tasks 的列表/看板/时间线/今日聚焦，webui 可独立 CRUD。详细模型和否决项见 [plans](plans.md)。
- **Writer**：独立稿件、八型 cell、CodeMirror、显式 Render/Shift+Enter、共享编译→IR 预览及源码 zip；不展示 PDF。工作流见 [writer](writer.md)，文件协议沿用 [writer-data-model](writer-data-model.md)。
- **web i18n**：zh-CN/en，默认中文、不探测浏览器，Tweaks 即时切换，偏好存 localStorage。server detail/job.error 和用户数据不纳入翻译；CLI 不变。
- **尚未完整的写路径**：文献 note tab 当前只读；持久 note/label 主要通过 CLI，右键色点 overlay 仅会话级。这是能力缺口，不推翻独立应用定位。
- **不在 main**：PDF/OCR/出版商 HTML 摄入封存于 `ocr-features` 快照分支，不能宣传为现行能力。

## 数据与配置

默认项目级 `./literatures`，只按 cwd 相对解析，不向上查找。优先级：

`--data-dir` > `ARGELANDERSPACE_DATA_DIR` > config.toml `data_dir` > `./literatures`。

配置通常在 `~/.config/argelanderspace/config.toml`，支持 XDG_CONFIG_HOME；env 优先，未知键忽略，已知键类型错只报键名、不回显值。隐藏 `auto_ingest_arxiv` 默认 true，语义见 library。

```text
<有效 dataDir>/
├── output/<doc_id>/
│   ├── <doc_id>.json       # TexDocIr，version:1，渲染 IR 即存储
│   ├── src/               # 源树
│   ├── build/             # aux/bbl/toc/fls/argelander.jsonl 等编译事实
│   └── assets/            # 直通图或 PDF/EPS 转 SVG
├── output/.latexcache/    # arXiv 源包缓存
├── library/              # library.json、bib、富化与 discovery 缓存、graph.json
├── jobs/                 # 持久 job 与 spool
├── logs/                 # arxiv-fetch.jsonl；错误日志，不是用户文档
├── input/
├── annotations/<doc_id>/
│   ├── current.json      # 独立用户数据，不是 IR
│   └── archive/          # 原批次标注，不对正常 reader/agent 开放
├── manuscripts/<m_id>/   # manuscript.json、原始 assets/、派生 build/
└── templates/            # <id>.json 覆盖与 <id>.deps/ 依赖
<有效 dataDir 的父目录>/status/plans.json
```

`statusDir = resolve(dataDir, "..", "status")`，不是无条件使用 repo/status。plans/annotations/manuscripts 使用 pretty 2 空格、rev 乐观锁和 tmp+rename；不能由此推断所有 schema 都保留未知键，plans 的 I010 仍需相关任务核对。

TexDocIr 直接落盘，含 source/meta 身份、references/bib/refsManifest/citationsByBlock 和原生 text/math/cite/xref segments。旧 Document 桥与双轨 occurrences 已删除。`/api/paper/:id/ir` 直接读 IR；旧 raw GET `/api/paper/:id` 已删除，不能与同路径的新 DELETE 混淆；旧无 version 文档需要重摄入，不再投影。

## LaTeX 数据流

隔离 workspace → latexmk（编译事实与插桩事件）＋unified-latex 源码树/有界宏展开 → 融合 IR → 图资产物化 → 直接存储/展示。

印刷编号取编译真值，不从结构 id 猜测；编译失败不做无编译全文降级。PDF/EPS 图片转换采用 pdftocairo/gs，旧 pandoc/mupdf/dvisvgm 路线退役。执行护栏、事实盲区、回退和测试范围见 [tex-pipeline](tex-pipeline.md)。Writer 显式 profile 共享主干但不共享摄入/归档副作用。

## Web 与同步

- `serve` 默认 8000；Hono REST、SPA、images、`/ws`。
- watcher 轮询 library、plans、per-doc current annotations、manuscript JSON 和模板 JSON 指纹；server 自写可再收到 external，前端幂等重取。没有资产目录 watcher。
- JobRunner 串行、持久化；boot 将未完成 job 标 interrupted，不重跑；hello 回放，失败在详情刷新后仍可见；job.done 先于 library.changed。upload、refresh 和 arXiv ingest 生命周期不能与 Discovery 只读请求混淆。
- 文献 label 色板：red重点 / amber待读 / green已精读 / blue方法 / violet灵感；overlay > 持久 label > star 播种。已读标题灰化及“已读”，未读蓝点。
- 阅读中列流式、100ch 上限；顶部可折叠作者块，多引用 per-ref chip；图片尺寸预留与停稳校正。右栏默认引用，可切标注；DOM 不嵌套高亮 span。
- 文献深链接 `/doc/<doc_id>#<anchor>` 使用 sec-N/fig-N/eq-N/tab-N/ref-N 等结构 id，不是印刷编号；标注使用 `#ann-<annotation_id>`。探索链接及历史见 discovery。

## Agent 接入

CLI + 仓库 `skills/argelander-*` 三件套（ingest/query-library/read-paper），无 MCP 是项目选择；本机安装方式不成为跨机器保证。

- search/read/show/ref/note/label/list + 只读 annot，CLI 直读磁盘，不依赖 HTTP。
- 文献问答从项目根走 CLI/skills，不传 `--data-dir`，不读内部 JSON/源码替代文献接口。开发任务不受此源码禁读限制。
- 仓库 CLI：`node packages/app/dist/bin.js`；全局安装后 `argelanderspace`。
- 深链接端口：`ARGELANDERSPACE_PORT` > config `port` > 8000。
- search 空 note 提示只走 stderr，stdout JSONL 保持可 pipe；摄入后每篇询问 note 并给建议稿。输出冻结以 contracts 为准。

## 包职责

pnpm workspace，ESM-only，TypeScript strict + noUncheckedIndexedAccess，Biome，Vitest：

| 包 | 职责 |
|---|---|
| contracts | Zod 数据/REST/WS 契约，canonical annotation text 与 Writer 序列化纯函数，web runtime 可用 |
| core | tex facts/source/fuse/IR 编排；文档展示与引用；library store/seed/graph/build；acquire/upload；plans/annotations/writer store、导出和预览 |
| infra | workspace/compile/instrument/figures/ingest；arXiv 抓取解包；ADS/Crossref/OpenAlex、config、zip、pyjson 缓存兼容；Writer opt-in 编译缓存 |
| server | REST/SPA/images/WS、jobs/watcher、领域锁、DocMutationRegistry、Writer single-flight/drain |
| cli | 命令注册、冻结 agent 输出、磁盘读写 |
| web | 阅读/文献/计划/标注/Writer/探索，共享 IR 展示、ReaderSession、i18n、graph 共享 renderer 与两个 adapter |
| app | npm 单包；tsup bin/web/argelander.sty/许可 notices；createRequire banner 有实际运行作用 |

单用户文件存储，不使用 SQLite。源码结构优先通过 CodeGraph 定位；工具不足再读源码。旧“截至 Stage 8 无 CI”的历史观测不是本次对 CI 的重验证。

来源：迁移基线 `46093915` 的 `.pi/memory/product-and-architecture.md`；本页仅重组已有事实，没有重新测试产品。
