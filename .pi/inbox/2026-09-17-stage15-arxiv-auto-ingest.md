# Stage 15 Grilling：添加文献时自动导入 arXiv 正文

- Session：stage15-arxiv-auto-ingest
- 创建：2026-09-17T22:39:00+02:00
- 更新：2026-09-18T01:20:00+02:00
- 工作状态：**完成**（用户 smoke 通过，Stage 15 关闭）
- 归并状态：已归并（去向见交接状态）
- 范围与授权：用户指令「推进下一个 stage」+ 初步设想（ADS 返回 arXiv 链接 → arXiv API 下载-解压-摄入到对应条目；无 arXiv 跳过等用户上传）。grilling 共识（D1–D18）用户「确认」后「开始实施」授权立项实施；smoke 通过后「请关闭stage15，然后commit+push」授权关闭 + 一次性 commit/push。

## 用户原始设想（2026-09-17）

「ads请求应该会返回arxiv链接，如果有的话就走arxiv的api来下载-解压-摄入到相应条目，如果没有就跳过，等用户上传。」

## 已确认决策

### D1 — 触发范围（Round 1 Q1，2026-09-17 用户按推荐确认）
- 自动导入 arXiv 正文的添加路径：① 标识符模式 `arXiv:` 前缀；② ADS bibcode 模式（Discovery 探索图入库同走 bibcode 通道，自动继承）；③ 标识符模式 DOI——仅当现有解析链已给出 arXiv id（实际仅 OpenAlex 可能补出），不新增「DOI 反查 arXiv」解析。
- BibTeX 批量导入本期**不自动**（条目照常建成、eprint 保留，可手动触发/留下次）。

### D2 — 执行模型（Q2 按推荐）
- 创建请求照常同步返回（work 立即可见、docless）；server 随后自动排队「获取 arXiv 正文」job：JobRunner 串行、持久化、进度/失败复用既有 job 机制，job.done 先于 library.changed。V1 无取消按钮（与 upload 一致）。

### D3 — 挂载语义（Q3 用户原话：「现在手动上传的链路怎么处理的就还怎么处理」）
- 照 upload 链路：stampSource 焊身份（doi/arxiv_id 盖进 doc JSON，`acquired_via` 需新值）→ doc_ids 置首直挂 → 锁内 rebuild 确认 → reassertMainDoc → 终检。不走「普通 ingest + 身份归并碰运气」。

### D4 — 跳过条件（Q4 按推荐）
- job **执行时** re-check：目标 work 已有任何 doc → 跳过（skipped，不覆盖不动主位）；仍 docless 才挂载，挂载后自然成为主 doc（doc_ids[0]）。

### D5 — 失败处理（Q5 按推荐 + 用户补充）
- job 失败 + job.error 详情页可见 + 重试入口；V1 不在 work 上加新持久状态字段。
- **用户补充：另加报错 log**，方便迭代版本参考（落点/格式 Round 2 Q12 定）。

### D6 — exists 触发（Q6 按推荐）
- 触发条件统一为「add 路径结束时该 work 无 doc 且能确定 arXiv id」，created 与 exists 一视同仁。

### D7 — 手动触发 + acquisition 展示整改（Q7 用户方案，超出原推荐）
- 加手动触发，且用户指定 UI 形态：① **删除**文献信息 panel 标题下方的「可获取…」标签（SourcePill）；② 「附件」（files tab）页的「可获取：…」改为可获取时**可点击**（点击即触发获取），下方显示进度；③ **清理非 arXiv 源标签**（如「可获取：A&A html」）——现在只支持 LaTeX 源，本版本只考虑 arXiv 一个 LaTeX 源。

### D8 — CLI 不动（Q8 按推荐 + 用户要求记录）
- 本期 CLI `ingest <doi>` / `library build` 行为不变；server/webui 侧新机制不经 build。
- **用户要求：在 memory 中记录此决定**（CLI 自动拉取为推后项，未来另立小项）。

### D9 — 隐藏配置开关（Q9 用户修正案，推翻原推荐「不加」）
- config.toml 加开关，**默认开启**，UI 不提供该选项（隐藏设置），用户需手动编辑 config.toml 关闭。
- 理由（用户原话）：用户网络有流量限制、无法访问 arXiv 且不想看到报错信息等边缘情况真实存在但不常见。

### D10 — 提交端点形态（Round 2 Q10 用户修正 → Round 3 用户撤回修正，**最终回到原推荐**）
- **最终**（2026-09-17 用户原话：「我收回Q10，按你原先的推荐。我之前以为创建时摄入arxiv有一个单独的api，如果没有的话新建也行。重点是日志区分」）：
  - 新增 `POST /api/library/attach-arxiv?id=<workId>`（复刻 upload 路由结构，job kind 启用 contracts 已预留的 `"ingest"`，payload `{workId, arxivId}`，202 返 `{job}`）；自动触发由 works 路由创建/exists 后 server 内部调同一提交函数。
  - 手动入口（附件 tab 可点击行、arXiv doc 行「重新获取」）调 attach-arxiv；导入菜单重添加走 works API exists 路径自动命中场景表。
- ~~中间态（已作废）~~：曾定手动触发也走 works API identifier 模式——用户误以为创建时摄入已有单独 API，得知没有后同意新建。
- 贯穿理由（用户）：log 区分用户上传 vs arXiv 来源，迭代优先级不同（arXiv 来源出问题优先处理；用户上传可能文档本身问题，优先级低）。

### D11 — 样式不变（Q11 按推荐 + 用户补充）
- 可点击的「可获取：arXiv 全文」行**保持现有文字/pill 样式**，不改成按钮样式。

### D12 — 报错 log 要求（Q12 按推荐 + 用户强化，用户要求记入 memory）
- `<dataDir>/logs/arxiv-fetch.jsonl`（append-only），记 failed/interrupted 的 arXiv 获取 job。
- **用户原话要点：这个 log 系统在 v1 版本要做好，是后续迭代的重要参考；v1 是打包发布形态，不能将 log 集成到难以直接读取的地方**（plain text JSONL 满足）。**本 stage 只做 arXiv 来源的报错记录**（不记 upload）。

### D13 — 失败分类与 UI（Q13 按推荐）
- infra 引入类型化错误（ArxivPdfOnlyError，文案不变 → CLI 零变化）；三类：无 LaTeX 源 → UI 双语引导上传 zip；下载/网络失败、编译/挂载失败 → job.error 原文 + 重试。三类都写 D12 log。

### D14 — 用户原则「新的替换旧的」（Q14 用户未直答幂等去重，给原则）
- 用户原话要点：原则是新的替换旧的，因为 arXiv 上的论文会更新版本，用户重新触发大概率是想更新一下。
- **待 Round 3 落成精确语义**（refresh 场景表 + 入口 + 缓存新鲜度），见 Q16。

### D15 — 隐藏开关语义确认（Q15 用户确认我理解正确）
- `auto_ingest_arxiv`（snake_case）默认 true；false 只关自动触发（创建/exists 不排队），手动可点击行仍可用；提交前现读 config；其余 config 规则不动。

### D16 — 「新的替换旧的」精确语义（Round 3 Q16，2026-09-17 用户按推荐确认）
- server 在 works API 调用结束 / attach-arxiv 调用时按场景表判定：
  - **A**：work 无 doc + 有 arXiv id → 提交获取 job（新挂载，docless → 主 doc）。
  - **B**：work 有同一 arXiv id 的 arXiv doc → 提交**刷新** job：新鲜下载最新源 → 重编译 → **同 doc id 原位覆盖**（doc_ids 顺序/主位不动；指纹同 → 标注保留，内容变 → 整批归档，既有标注契约照常）。
  - **C**：work 有 doc 但无匹配 arXiv doc（典型：用户上传 zip）→ **不触发**，绝不动用户上传内容（想换源先删 doc）。
- **恒新鲜下载**：不读 `.latexcache` 旧 tarball 命中，成功后覆写缓存；Throttler 礼貌延迟不变。
- **不堆叠**：同 work 已有 queued/running 获取 job → 新触发不再排队（进行中 job 与新触发目标完全相同；JobRunner 无取消，不杀运行中 job）。
- 更新入口 ①+② 都做：① 导入菜单重新添加（exists → 场景 B）；② 附件 tab 的 arXiv doc 行「重新获取 arXiv 最新版」文字入口（仅当该 doc 为 arXiv 来源，调 attach-arxiv，样式照现有行内文字）。

### D17 — 信息面板标签去除范围（Q17 按推荐）
- 信息面板标题下方：**移除全部获取类状态**（可获取 readyFrom / 不可用 blocked / 未知 unknown 不再渲染）；**保留**「来源：xxx」（ingestedFrom，已有正文的来源事实）与「待上传」（needsUpload）。
- 附件 tab 同步：docless + arXiv ready → 可点击行（样式不变，D11）；docless 无 arXiv → 维持 needsUpload pill；其余来源广告标签一律清理（D7③）。

### D18 — 共识确认（2026-09-17，用户原话「确认」）
- 三轮 grilling（Q1–Q17）收敛，用户对完整共识汇总回答「确认」：D1–D17 全部生效。
- **注意**：本次「确认」仅确认共识；实施授权、阶段方案写入 memory-reference 授权、commit/push 授权均**未**给出，等用户指示。

## 已验证事实

### F1 — 摄入链路与身份归并（scout ingest-facts，2026-09-17，全文 /tmp/stage15-scout-ingest.md）

- CLI 链路：`cli detectSource` → infra `ingestTexSource`（tex/ingest.ts:63）→ `acquireSource`（latex/arxiv-source.ts:236，下载+解包）→ core `ingestTex`（pipelines/tex/pipeline.ts:55）→ 写 `output/<docId>/`。
- arXiv e-print 端点 `https://arxiv.org/e-print/{id}`，Throttler 1s、磁盘缓存 `output/.latexcache`（键=sanitize(id)+.tar.gz，存在且非空即命中）、`.part`+rename。
- **PDF-only 行为**：解包阶段抛普通 `Error`（文案含 "PDF-only"），无结构化错误类型；webui 友好提示需匹配文案或新引入分类。
- doc id：`arxiv-<sanitize(id)>`，**保留 vN 版本号**（2501.17225v2 → arxiv-2501.17225v2）；`normArxiv` 去版本用于身份归并。
- `library build` 的 seed（library/seed.ts:51）用 `source.doi/arxiv_id/meta.title` 构造临时 Work 经 `identityKeys`（doi▸arxiv▸openalex▸title，store.ts:~330）upsert 归并——**docless work 有相同 arXiv id 时 rebuild 会挂接新 doc**；title bridging 即 `identityKeys` 的 title: 键。`mergeInto` dst 字段优先、doc_ids 并集 dst 在前。
- **`planFor`（acquire/run.ts:67）已有 acquisition 规划**：纯计算，work 有 arxiv_id 时 `arxiv_latex` 层 status=READY（main 唯一 ready 自动获取层）；`w.acquisition = planToDict(...)` 由 enrichAndPlan / commitWork / addDoiWork 写入。Stage 15 本质是**执行 planFor 已算出的计划**。
- Work 无独立 eprint 字段，权威字段 `arxiv_id`；ADS export 的 eprint 经 `parseBibtexText`→`arxivFromEntry` 落 `arxiv_id`（`parseAdsBibtexFields` 只产书目字段）。**bibcode 模式创建的 work 创建后即可读 arxiv_id**。
- identifier-arXiv 模式：work id=`arxiv:<normArxiv>`、`arxiv_id` 落库；DOI 模式拿 arXiv **仅当 OpenAlex 解析补出**（ADS/Crossref resolve 不回传 arXiv）。
- `commitWork` 的 recanonicalize：identifier-arXiv 建的 work 解析出期刊 DOI 后 id 会改写为 `doi:…`（arxiv: identity 键仍可 match）——job payload 用 add 返回的最终 ref.id。

### F2 — server job 与上传链路（scout job-facts，2026-09-17，全文 /tmp/stage15-scout-jobs.md）

- 上传链路 `POST /api/library/upload`（app.ts:1106–1236）是完整模板：预解析 work → `uploadDocId` 纯函数预算 doc id → `docMutations.pinWriter`（submit→终态）→ `runner.submit("upload", handler, query)` → 终态钩子 unpin + `libraryChanged("upload")`（job.done 先于 library.changed）→ 202 `{job}`；handler 内 spool 取字节 → `attachLatexZip`（core acquire/upload.ts:114：`ingestLatexZip` → `stampSource` 焊身份（`acquired_via` 需新值）→ doc_ids 置首直挂 → 锁内 rebuild → `reassertMainDoc` → 终检）。
- JobRunner（server/jobs.ts:43）：串行 FIFO chain；每次状态迁移原子写 `<dataDir>/jobs/<id>.json`；spool 目录 boot 时清空；progress→WS 全员广播（携带完整 job 快照）；handler throw → `job.error`+failed 落盘；boot 时 queued/running → interrupted **绝不重跑**；**无取消**。
- contracts：`JobKindSchema = z.enum(["upload","refresh","ingest"])`——**"ingest" 枚举值已存在但 server 无 submit 点**（预留）；WS union：hello/job.*/library.changed(cause: refresh|patch|add|upload|external)/plan.changed/annotation.changed/writer.changed。
- web：RefDetail.tsx 消费 job——`onJobEvent` 过滤 `job.kind==="upload"` + `payload.workId` 归属；hello 重放收养 queued/running、failed/interrupted 持久错误可见；按钮内联进度；**无全局 job 列表 UI**。docless work 走同一 files tab（upload.initial + SourcePill + needs_upload 提示）。
- job 内网络请求有先例（refresh job 富化阶段 ADS/Crossref/OpenAlex）；`deps.realPipelines` 已把 `ingestTexSource` 接进 server 依赖（ingestLatex 端口），**当前无调用方**。
- Discovery `GET /api/library/discovery` 确认不走 job/锁（只读）。
- 「设为主」= `PATCH /api/library/refs {doc_id}` → core `patchWork` move-to-front。

### F4 — 真实 Chrome + 真实网络探针 26/26（2026-09-18，/tmp/stage15-probe.mjs，临时证据）

- 环境：createServer 真源真管线 + 临时 dataDir + XDG 隔离 + 无头 Chrome（google-chrome --headless=new + 裸 CDP）；真实 arXiv 下载与 latexmk 编译、真实 ADS（~/.ads/dev_key）。
- A（UI 导入 `arXiv:2501.17225`）：导入菜单→标识符→创建→详情自动打开；附件 tab 可点击 pill + 实时进度（Compiling LaTeX…）；自动 job 完成 → doc_ids=[arxiv-2501.17225]、主文档行出现、可获取行消失；doc JSON 印戳 `acquired_via="arxiv_eprint"`；成功不写 log。创建时真实解析链将 work recanonicalize 为 doi:10.1051/0004-6361/202453302（预期行为）。
- B（附件 tab「重新获取」）：刷新 job 完成，仍恰好一个 arXiv doc（新换旧原位覆盖）；reader 打开渲染刷新后正文（标题可见）。
- C（坏 id `arXiv:9999.99999`）：容错建 stub → 自动 job 404 失败 → 附件 tab 错误行+「重试」可见；重试再失败；`logs/arxiv-fetch.jsonl` 恰好两行，字段 {jobId, workId, arxivId, stage:"download", error} 正确。
- D（真实 ADS）：ADS search 解析 doi→bibcode 2025A&A...694A.258R；bibcode 重添加 → exists（身份归并，无重复）→ 场景 B 刷新 job done；库仍恰好 2 works。
- E（真实 ADS 创建）：bibcode 2021AJ....161..147B 创建新 work → 自动摄入 → doc_ids=[arxiv-2012.05220]，`/api/paper/arxiv-2012.05220/ir` 可读（sections>0）。
- 教训修补：探针 clickText 需子串最紧匹配（菜单项是嵌套 span）；job 断言按 payload 过滤而不是目录顺序（readdir 不按时间）。
- 副带修复：infra `ingestTexSource` 此前**声明却不透传** `fetchImpl` 给 ArxivFetcher（ latent gap，无人用过），已透传；不影响既有调用方。

### F3 — Stage 15 实施落地（2026-09-18 凌晨）

- contracts：`JobSchema` 加可选 `errorCode`；`library.changed` cause 枚举加 `"ingest"`；新增 `AttachArxivAcceptedResponseSchema`（与 upload 同形 {job}）。
- infra：arxiv-source.ts `ArxivPdfOnlyError`（两个 PDF-only 抛点，**文案逐字节不变** → CLI 零变化）；tex/ingest.ts `ingestArxivEprint(arxivId, {outRoot, docId, …})`——恒新鲜下载（useCache:false 语义=不读缓存、成功覆写，零改动既有 downloadEprint）+ 清空旧 src 重解包；config.ts 加 `auto_ingest_arxiv` boolean（默认开）。
- core：`acquire/attach-arxiv.ts`——`arxivDocId`（无版本，`arxiv-<sanitize>`，与 infra docIdFor 有 infra 侧 parity 测试）、`arxivAttachScenario`（D16 场景表纯函数）、`attachArxivDoc`（照 attachLatexZip：ingest→stampSource（`acquired_via="arxiv_eprint"`）→attach 置首/refresh 原位不动→锁内 rebuild→attach 时 reassert→终检；执行时 re-check，场景 C 返回 skipped）。`IngestPipelines` 加 `ingestArxivEprint` 必需方法，两个既有 stub 同步。
- server：`arxiv-fetch-log.ts`（`<dataDir>/logs/arxiv-fetch.jsonl` append-only）；JobRunner 加 `onInterrupted` 钩子（server.ts 接线：kind=ingest 的 interrupted 写 log，stage="interrupted"）；app.ts `submitArxivFetch`（场景判定+去重+pin+终态钩子 unpin/libraryChanged("ingest")/失败写 log，阶段追踪 download/extract/compile/attach，ArxivPdfOnlyError→j.errorCode="arxiv_pdf_only"+stage=extract）；`POST /api/library/attach-arxiv?id=`（400/404/400/409 busy/409 场景C，202 {job}，去重返既有 job）；works 路由自动触发（identifier/bibcode 模式 created/exists，config 门控，bib 永不，submit 失败不毁创建，job.created 先于 libraryChanged("add")）。
- web：api/library.ts `attachArxiv`；RefDetail——sourceBadge 移除 ready/blocked/unknown 三获取态（保留 ingestedFrom/needsUpload，D17）；附件 tab docless+arxiv_id → 可点击 pill（原样式+cursor pointer，D11）；行下进度/错误+重试（PDF-only 双语引导）；arxiv- doc 行「重新获取」入口；job 订阅**合并为单个 onJobEvent 按 kind 路由**（upload+ingest；测试 mock 只捉单 listener 的教训）。
- i18n：删 source.ready/readyFrom/blocked/blockedFrom/unknown 五键（双语），新增 source.readyArxiv、arxiv.* 六键、files.refetchArxiv* 两键（双语）。
- 测试：core attach-arxiv.test.ts 11；infra arxiv-source +9（PDF-only 类型化、缓存新鲜度、docId parity）、config +1；server attach-arxiv.test.ts 11（端点矩阵/attach/refresh/去重/PDF-only+普通失败 log/upload 不入 log/自动触发五场景）、jobs +1（onInterrupted）、works-create 注入 autoIngestArxiv:()=>false 保持聚焦；web refdetail-arxiv.test.tsx 9（含 hello replay 收养、清理断言）。
- **四门全绿**：build/typecheck/lint/test 全过；test 1214 passed + 1 可选 skip（Stage 14 基线 1173+1，净增 41）。

### D19 — smoke 通过 + 关闭 + commit/push 授权（2026-09-18，用户原话「通过，请关闭stage15，然后commit+push」）
- Stage 15 正式关闭（用户 smoke 通过）。**授权 commit + push**（一次性，不继承）。
- 下一阶段：用户未指定；Stage 4.1 仍推后。

## 待确认事项

- （无。）

## 交接状态

- 起点：HEAD=5a9b1cc，工作区干净。
- 勘察输出：/tmp/stage15-scout-ingest.md、/tmp/stage15-scout-jobs.md（临时证据）。
- **当前**：实施全部完成（contracts/core/infra/server/web/README + 测试），四门全绿（build 7/7、typecheck 7/7、lint 0 error、test 1216 passed+1 skip），真实探针 26/26（/tmp/stage15-probe.mjs，临时证据；关键结论自包含于 F4）。**未 commit/push**（无授权）。
- 待用户 smoke。smoke 建议：真实库上 `corepack pnpm -r build && node packages/app/dist/bin.js serve`，webui 导入 arXiv 条目看自动摄入与进度；附件 tab 看「可获取 · arXiv 全文」可点击行与「重新获取」；导入失败场景看 log（`literatures/logs/arxiv-fetch.jsonl`）。
- 归并去向（已执行）：D1–D18 → 契约§2「arXiv 自动导入（Stage 15）」；架构（能力/端点/logs 布局/WS cause/config 键）；D8 → known-issues I035（CLI 自动拉取推后）；F1–F4 → 工程（fetchImpl 透传修复、探针教训、验收规模）；history Stage 15 行；00-index 当前状态；AGENTS.md 同步；阶段方案标「已关闭」。本文件原文随 docs 提交入 Git 保留。
