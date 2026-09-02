# 产品形态与架构（2026-09-02 Stage 3.1 落地后修订；2026-09-02 Stage 4 定位升级；取代重构期全部架构/设计文档）

## 产品是什么

**ArgelanderSpace**（npm 包 `argelanderspace`；repo github.com/HerculeWu/argelanderspace；LICENSE MIT © Wenjie Wu）：单用户**科研工作台**，承担用户与 AI agent 协作的 interface——**不只是文献工具**（2026-09-02 用户明确的定位升级，取代"单用户科研文献工具"旧表述）。已落地核心能力 = 文献工具链：摄入 → 文献库/引文图谱 → 阅读器 → agent 协作；Stage 4 计划页面是工作台化第一步。终极目标场景：terminal 里跑 pi-agent 基底的科研助手 + webui 工作台（计划/文献/文档），"不剥夺用户看论文的权利"。

- **摄入（Stage 3.1 起收窄定型）**：arXiv LaTeX 源（含本地 .tex/目录/tarball）→ 统一 Document JSON。**PDF / 出版商 HTML 摄入已隔离出 main**（MinerU OCR、A&A/OUP 适配器等封存于 `ocr-features` 分支，2026-09-01 MS1；反爬/配额/401，~90% 论文 arXiv 可得一致内容；`/images` 的 MinerU 分支同删，存量 PDF 摄入文档的图失效，重摄入恢复）。CLI 收 DOI/出版商 URL → 识别并友好报错指路（不建条目——"未识别源先建条目等上传"是推后事项）。
- **pandoc ≥3.9 硬下限**（管线入口 `assertPandocVersion`）：旧版剥 DisplayMath 环境外壳 → 公式编号全灭 + 公式削残（机制见 pitfalls）。报错点名版本/路径/shim 指引。README 版本说明 + 安装检验脚本是推后事项（发布前做）。
- **webui 上传 = LaTeX 源码 zip**（详情页 attach-only，目标 work 须已存在；无 doc 的 work 由 CLI `library build --bib`/`acquire <bib>`/graph-node 预建）：幂等 docId `upload-<slug44>-<hash6>`（重传=覆盖同一 doc）；身份焊死（有 doi/arxiv 写 source，无则 work.title 覆盖 doc meta.title）+ 直挂 `doc_ids` + 返回前校验；解包复用 infra `lib/unzip.ts`（零新依赖）；进度三段可见、失败红字刷新后仍在。
- **公式编号 = 管线自产坐标**：一切 display-math 按序 1..N（含 `equation*`/`\[...\]`/`$$`）；`\tag{x}` 提取为显示号、剥出 body、不推进计数器；per-row 环境逐行、`\nonumber/\notag` 尊重。AASTeX `deluxetable`/`table*` 经 pandoc 前机械预处理（`core/pipelines/latex/aastex.ts`）恢复成表 + caption/label。
- **存储**：项目级库 `<项目根>/literatures/`（内部 output/library/jobs/input）。cwd 相对、**无向上查找**；解析链 `--data-dir` > `ARGELANDERSPACE_DATA_DIR` > config.toml `data_dir` > `./literatures`。全局库复用摄入产物 = 未来方向（未做）。
- **webui**（`serve` 默认 8000）：文献看板（label 色点——色板 red 重点/amber 待读/green 已精读/blue 方法/violet 灵感，优先级：会话右键 overlay > 持久化 `label` > star 播种；已读标识——标题灰化 + `· 已读`，未读有小蓝点；笔记全文只读 tab）+ 三栏阅读器 + **四级深链接** `/doc/<id>#<anchor>`（⚠️ 锚点 `sec-N`/`fig-N`/`eq-N`/`ref-N` 是管线结构 id，**不是印刷编号**）。活动栏剩 计划/文献/文档 + 底部扩展（"终端/浏览器"空 stub 已于 Stage 3.1 移除）。server 轮询 `literatures/` 指纹广播 `library.changed`，CLI 写入后前端免 F5。
- **agent 接入（无 MCP，刻意）**：pi 作者明说不支持 MCP（工具 schema 每轮灌上下文、token 税高），原生方式 = CLI + skills。CLI agent 子命令 `search/read/show/ref/note/label/list`；pi skills 三件套 `skills/argelander-*`（symlink 到 `~/.pi/agent/skills/`）。契约：**项目根跑 CLI、不传 `--data-dir`、不读源码回答文献问题**；`search` stderr 打 `hint: N/M works have empty notes`；CLI 打印深链接端口 = `ARGELANDERSPACE_PORT` > config `port` > 8000。pi 验收/日常用 `pi -nc`（不读 context files，防被本 repo 的 memory 协议带跑）。
- **webui 定位演进（2026-09-02 用户明确，开放方向）**：webui 目标形态是**独立应用**——不与 agent 强绑定、不是纯看板，无 agent 的用户也要能完成全部操作。当前写路径（label 持久化、note 写入等）仍归 CLI/agent，后续 stage 逐步把操作面补进 webui；Stage 4/5 设计遵循此原则。（同日进一步升级为项目级定位：产品 = 科研工作台 + 用户与 agent 协作的 interface，见上文"产品是什么"。）

## 关键使用语义（用户/agent 都会踩）

- **ingest 后必须 `library build`**：ingest 只写 `output/<doc_id>/`，build 后才有 work，才能 search/note/label。
- **id 两个家族**：work id（`arxiv:`/`doi:` 前缀，canonicalId 优先级 doi > arxiv > openalex > title-slug）→ search/note/label；doc id（`arxiv-…` / `latex-…`（本地摄入）/ `upload-…`（webui zip））→ read/show/ref/list。search 行的 `doc_ids` 做映射。
- `--offline` 只禁 Crossref/OpenAlex 活体调用，**ADS 恒活**（有 token 就联网）。
- CLI repo 内调用形态：`node packages/app/dist/bin.js`（或全局装后 `argelanderspace`）。

## 架构（pnpm monorepo，ESM-only，TS strict + noUncheckedIndexedAccess，Biome，Vitest）

- `packages/contracts`：zod schema——Document JSON、**DocIr**（渲染中间表示：块 + 内联段序列，cite/xref 的 occurrence **显式配对**、label/摘要/短引用全预算）、library payload、job/WS 消息。
- `packages/core`：纯领域。documents（citations/crossrefs/structure-free 编排 + **`ir.ts` buildDocIr** + `render.ts` 薄导出层；`geom.ts` 是从 PDF 层抠出的几何/文本正则留守模块）；pipelines/latex（含 `aastex.ts` 预处理）；library（store/seed/graph/build）；acquire（含 `upload.ts` attachLatexZip）。**渲染 SOT 只有一套：web 与 CLI 都消费 IR**（CLI markdown 从 IR 导出，golden 逐字节回归钉死）。
- `packages/infra`：适配器——pandoc CLI（≥3.9 硬下限，`latex/pandoc.ts`）、mupdf（**仅栅格化** `pdf/raster.ts`；PDF 文本/链接随 OCR 面封存）、ArxivFetcher、ADS/Crossref/OpenAlex（pyjson 缓存键兼容）、`lib/unzip.ts` zip 解包、config.toml（smol-toml；XDG_CONFIG_HOME 优先；键 data_dir/port/openalex_api_key/ads_dev_key——`mineru_api_key` 已随隔离删除；出错从不回显值）。
- `packages/server`：Hono。REST（旧端点 + `/api/paper/:id/ir` + `/api/library/upload`（zip）+ images 子路径路由）+ SPA + `/ws`（hello 快照 + job.* + library.changed）+ 串行 job runner（`<dataDir>/jobs/` 落盘；boot 时未完 job → `interrupted` 绝不重跑；wire 顺序 job.done 先于 library.changed）+ `watch.ts` 轮询指纹。
- `packages/web`：React 阅读器，消费 IR（`segments.tsx` 段渲染器；`deeplink.ts` 手卷单路由复用 jumpTo/focusReference）。dev 依赖 core 仅供测试 buildDocIr。
- `packages/app`：发布单包（tsup bundle `dist/bin.js` + dist/web；**mupdf 保持 external**：WASM import.meta.url 定位 + AGPL 双因；createRequire banner 为历史 cheerio 链遗留，保留无害）。

## 工程质量惯例

- 门：`corepack pnpm -r build|test|typecheck` + 根 `corepack pnpm lint`（无 `-r lint`；裸 pnpm 不在 PATH）。
- **重构期基线已于 2026-09-01 退役**（用户拍板，项目脱离重构阶段）：bug-for-bug 兼容、golden 逐字段 diff 验收、"Python 侧观察保留"清单全部作废。golden 夹具转为**普通回归测试**：行为变更时由 TS 管线自洽重冻 + 人工抽查（Stage 3.1 MS3 首次实战：2012.05220 重冻 +48/−16，2501.17225 零 diff）。
- 测试密封：网络全离线 stub（fetchImpl 注入）；config 测试 `$XDG_CONFIG_HOME` 指 tmp；spawn 测试 `HOME=<tmp>` 逼 ADS no-token。
- 单用户文件存储（library.json + output/），SQLite 以后再说；CI 至今未上。
