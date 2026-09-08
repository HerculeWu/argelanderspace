# 产品形态与架构（2026-09-02 Stage 3.1 落地后修订；2026-09-02 Stage 4 定位升级；2026-09-08 Stage 5 MS1–MS4b 管线换代+迁移收尾；取代重构期全部架构/设计文档）

## 产品是什么

**ArgelanderSpace**（npm 包 `argelanderspace`；repo github.com/HerculeWu/argelanderspace；LICENSE MIT © Wenjie Wu）：单用户**科研工作台**，承担用户与 AI agent 协作的 interface——**不只是文献工具**（2026-09-02 用户明确的定位升级，取代"单用户科研文献工具"旧表述）。已落地核心能力 = 文献工具链：摄入 → 文献库/引文图谱 → 阅读器 → agent 协作；Stage 4 计划页面是工作台化第一步。终极目标场景：terminal 里跑 pi-agent 基底的科研助手 + webui 工作台（计划/文献/文档），"不剥夺用户看论文的权利"。

- **摄入（Stage 5 MS1–MS3b 换代定型，2026-09-08）**：arXiv LaTeX 源（含本地 .tex/目录/tarball，或 webui zip 上传）→ **latexmk 编译 + 双通道融合 → TexDocIr 即存储**（管线细节见下"摄入管线"段）。**PDF / 出版商 HTML 摄入已隔离出 main**（MinerU OCR、A&A/OUP 适配器等封存于 `ocr-features` 分支；反爬/配额/401，~90% 论文 arXiv 可得一致内容）。CLI 收 DOI/出版商 URL → 识别并友好报错指路（不建条目——"未识别源先建条目等上传"是推后事项）。**pandoc 与 mupdf 已随 MS3b 从 main 删除**；外部工具链只剩 TeX Live（latexmk + pdflatex/xelatex + bibtex/biber，硬前提）+ dvisvgm（可选，矢量图→SVG）。
- **摄入管线（双通道融合，Stage 5）**：隔离 tmpdir workspace（拒 symlink、2GB/10k 护栏）内 latexmk 编译（pdflatex 优先、失败自动 xelatex 重试、`-interaction=nonstopmode -recorder`、minted/\write18 预扫描拒、错误分类 `!` 摘录、120s SIGKILL 超时；插桩失败自动干净编译回退）→ 编译事实层（.aux/.bbl/.toc/.fls + 插桩包 `argelander.sty` 的 `.argelander.jsonl` 事件流：cite/label/section/**mathnum**）+ unified-latex 源码树（`\input` 合并、有界宏展开层、verbatim 保护）→ 融合（编号/cite/xref 锚定：mathnum 事件按 env 块+序 join、section 事件按序、figure/table 按 lot/lof（含 \@writefile 记录）+ aux + 计数回退）→ IR 构建落盘。**产物编号 = 印刷忠实**（显示号 = 编译器真号；**未编号 display 公式无号**（推翻 Stage 3.1"一切 display-math 自产 1..N"）；结构 id（sec-N/fig-N/eq-N/ref-N）照旧承担寻址/深链接，与印刷号解耦）。compile 失败报 Q4 分类 + `!` 摘录进 job error。
- **webui 上传 = LaTeX 源码 zip**（详情页 attach-only，目标 work 须已存在；无 doc 的 work 由 CLI `library build --bib`/`acquire <bib>`/graph-node 预建）：幂等 docId `upload-<slug44>-<hash6>`（重传=覆盖同一 doc）；身份焊死（有 doi/arxiv 写 source，无则 work.title 覆盖 doc meta.title）+ 直挂 `doc_ids` + 返回前校验；解包复用 infra `lib/unzip.ts`（零新依赖）；进度三段可见、失败红字刷新后仍在。
- **存储 = TexDocIr 即存储**（Stage 5 Q3）：`output/<doc_id>/<doc_id>.json` 就是渲染 IR（`version:1`；DocIr 同构扩展 + `source`/`meta` 身份块 + references/bib/refsManifest/citationsByBlock；**原生 segments**（text/math/cite/xref 直存，`[[cite:…]]` token + occurrences 双轨已退役）；web/CLI 均直读（CLI markdown 从 IR 导出，`renderIrMarkdown`）。同 doc 另有 `src/`（源树）+ `build/`（编译产物 .aux/.bbl/.toc/.fls/.argelander.jsonl）+ `assets/`（dvisvgm SVG）。项目级库 `<项目根>/literatures/`（内部 output/library/jobs/input）。cwd 相对、**无向上查找**；解析链 `--data-dir` > `ARGELANDERSPACE_DATA_DIR` > config.toml `data_dir` > `./literatures`。全局库复用摄入产物 = 未来方向（未做）。
- **webui**（`serve` 默认 8000）：**计划页**（Stage 4，默认 landing：plans→tasks 两层，列表/看板/时间线/今日聚焦四视图，任务抽屉（状态直选/关联文档链 doc_id 跳阅读器/md+数学 note/删除撤销），计划·任务弹窗新建编辑复用，task.due 必填；存储 `status/plans.json`（与 literatures 平级，pretty-print）+ `plan.changed` 广播）+ 文献看板（label 色点——色板 red 重点/amber 待读/green 已精读/blue 方法/violet 灵感，优先级：会话右键 overlay > 持久化 `label` > star 播种；已读标识——标题灰化 + `· 已读`，未读有小蓝点；笔记全文只读 tab）+ 三栏阅读器 + **四级深链接** `/doc/<id>#<anchor>`（⚠️ 锚点 `sec-N`/`fig-N`/`eq-N`/`ref-N` 是管线结构 id，**不是印刷编号**）。活动栏剩 计划/文献/文档 + 底部扩展（"终端/浏览器"空 stub 已于 Stage 3.1 移除）。server 轮询 `literatures/`+`status/` 指纹广播 `library.changed`/`plan.changed`，CLI 写入后前端免 F5。
- **agent 接入（无 MCP，刻意）**：pi 作者明说不支持 MCP（工具 schema 每轮灌上下文、token 税高），原生方式 = CLI + skills。CLI agent 子命令 `search/read/show/ref/note/label/list`；pi skills 三件套 `skills/argelander-*`（symlink 到 `~/.pi/agent/skills/`）。契约：**项目根跑 CLI、不传 `--data-dir`、不读源码回答文献问题**；`search` stderr 打 `hint: N/M works have empty notes`；CLI 打印深链接端口 = `ARGELANDERSPACE_PORT` > config `port` > 8000。pi 验收/日常用 `pi -nc`（不读 context files，防被本 repo 的 memory 协议带跑）。
- **webui 定位演进（2026-09-02 用户明确，开放方向）**：webui 目标形态是**独立应用**——不与 agent 强绑定、不是纯看板，无 agent 的用户也要能完成全部操作。当前写路径（label 持久化、note 写入等）仍归 CLI/agent，后续 stage 逐步把操作面补进 webui；Stage 4/5 设计遵循此原则。（同日进一步升级为项目级定位：产品 = 科研工作台 + 用户与 agent 协作的 interface，见上文"产品是什么"。）

## 关键使用语义（用户/agent 都会踩）

- **ingest 后必须 `library build`**：ingest 只写 `output/<doc_id>/`，build 后才有 work，才能 search/note/label。
- **id 两个家族**：work id（`arxiv:`/`doi:` 前缀，canonicalId 优先级 doi > arxiv > openalex > title-slug）→ search/note/label；doc id（`arxiv-…` / `latex-…`（本地摄入）/ `upload-…`（webui zip））→ read/show/ref/list。search 行的 `doc_ids` 做映射。
- `--offline` 只禁 Crossref/OpenAlex 活体调用，**ADS 恒活**（有 token 就联网）。
- CLI repo 内调用形态：`node packages/app/dist/bin.js`（或全局装后 `argelanderspace`）。

## 架构（pnpm monorepo，ESM-only，TS strict + noUncheckedIndexedAccess，Biome，Vitest）

- `packages/contracts`：zod schema——**TexDocIr**（渲染 IR 即存储：version + DocIr 同构块/段 + source/meta 身份块；Reference schema 同居 `doc-ir.ts`）、DocIr（其子 schema 被复用）、library payload、job/WS 消息。**旧 Document JSON schema 已随 MS4b 删除**。
- `packages/core`：纯领域。**pipelines/tex/**（新摄入主管线：facts 纯解析（.aux/.bbl/.toc/.lof/.lot/.fls/.argelander.jsonl）+ source 源树（unified-latex + \input 合并 + 有界宏展开）+ fuse 融合（编号/cite/xref/表格/图片）+ ir 组装 + pipeline 编排 `ingestTex`/`fuseTexDoc`）；**documents = render 单文件**（MS4b 起：buildDocIr/Document 桥与 ir/tokens/traverse 三件套已删，`citeShort`/`segmentsMarkdown`/`segmentsPlainText` 收养进 render）/references（parseOne）；library（store/seed/graph/build）；acquire（含 `upload.ts` attachLatexZip）。**渲染 SOT 只有一套：web 与 CLI 都消费 IR**。
- `packages/infra`：适配器——**tex/ 编译执行层**（workspace 隔离、latexmk runner（引擎回退/错误分类/超时）、插桩 `argelander.sty`（cite/label/section/mathnum 事件包）、dvisvgm 图片物化、`tex/ingest.ts` 接线）、`latex/arxiv-source.ts`（e-print 抓取/解包 + tar 安全）、ADS/Crossref/OpenAlex（pyjson 缓存键兼容）、`lib/unzip.ts` zip 解包、config.toml（smol-toml；XDG_CONFIG_HOME 优先；键 data_dir/port/openalex_api_key/ads_dev_key；出错从不回显值）。
- `packages/server`：Hono。REST（旧端点 + `/api/paper/:id/ir` + `/api/library/upload`（zip）+ images 子路径路由）+ SPA + `/ws`（hello 快照 + job.* + library.changed）+ 串行 job runner（`<dataDir>/jobs/` 落盘；boot 时未完 job → `interrupted` 绝不重跑；wire 顺序 job.done 先于 library.changed）+ `watch.ts` 轮询指纹。
- `packages/web`：React 阅读器，消费 IR（`segments.tsx` 段渲染器；`deeplink.ts` 手卷单路由复用 jumpTo/focusReference）。
- `packages/app`：发布单包（tsup bundle `dist/bin.js` + `dist/web` + **`dist/argelander.sty`**（插桩资产随包——缺失时插桩静默降级为干净编译丢事件流，MS4a 修复；`copy-assets.mjs` 负责）；**mupdf 已随 MS3b 移除**；createRequire banner 保留——活人 = `ws`（CJS 运行期 require("events")），非原注释的 cheerio 链）。

## 工程质量惯例

- 门：`corepack pnpm -r build|test|typecheck` + 根 `corepack pnpm lint`（无 `-r lint`；裸 pnpm 不在 PATH）。
- **重构期基线已于 2026-09-01 退役**（用户拍板，项目脱离重构阶段）：bug-for-bug 兼容、golden 逐字段 diff 验收、"Python 侧观察保留"清单全部作废。golden 夹具转为**普通回归测试**：行为变更时由 TS 管线自洽重冻 + 人工抽查（Stage 3.1 MS3 首次实战：2012.05220 重冻 +48/−16，2501.17225 零 diff）。
- 测试密封：网络全离线 stub（fetchImpl 注入）；config 测试 `$XDG_CONFIG_HOME` 指 tmp；spawn 测试 `HOME=<tmp>` 逼 ADS no-token。
- 单用户文件存储（library.json + output/），SQLite 以后再说；CI 至今未上。
