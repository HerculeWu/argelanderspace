# Stage 15 阶段方案：添加文献时自动导入 arXiv 正文

- 状态：**已关闭**（2026-09-18 用户 smoke 通过；契约级边界已归并至 [contracts-and-decisions](../memory/contracts-and-decisions.md) §2）
- 来源：grilling 决策 D1–D18 与勘察事实 F1/F2 见 `.pi/inbox/2026-09-17-stage15-arxiv-auto-ingest.md`（原文随关闭 docs 批入 Git）；本文为自包含工作权威。
- 授权边界：实施、改代码/测试、验收（四门、离线回归、真实 Chrome 探针、真实 arXiv smoke）已授权；commit+push 由用户 2026-09-18 随关闭授权（一次性）。

## 1. 目标

添加/重新添加文献条目时，若条目有 arXiv id，server 后台自动下载 arXiv **最新** LaTeX 源 → 编译 → 正文 doc 挂载到该条目；无 arXiv → 跳过，等用户上传（现状不变）。系统已有的 `planFor` acquisition 规划（有 arXiv id 时 `arxiv_latex` 层 READY，main 唯一可自动获取层）由本阶段真正执行。

## 2. 触发范围与场景表（D1/D6/D10/D16）

**自动触发路径**（`POST /api/library/works` 创建/exists 后 server 内部提交）：

- identifier 模式 `arXiv:` 前缀 / arxiv.org URL（含 DataCite `10.48550/arXiv.*` DOI 折入）；
- identifier 模式 DOI——仅当现有解析链已给出 arXiv id（实际仅 OpenAlex 可能补出），**不新增**「DOI 反查 arXiv」解析；
- bibcode 模式（Discovery 探索图入库同通道，自动继承）；
- **批量 bib 模式永不自动**（D1；其条目可经手动入口触发）。

**场景表**（server 在 works 调用结束 / attach-arxiv 调用时判定；job **执行时** re-check）：

| 场景 | work 状态 | 行为 |
|---|---|---|
| A | 无 doc + 有 arXiv id | 提交获取 job：新挂载，docless → 自然主 doc（`doc_ids[0]`） |
| B | 有**同一 arXiv id** 的 arXiv doc | 提交刷新 job：新鲜下载最新源 → 重编译 → **同 doc id 原位覆盖**（doc_ids 顺序/主位不动；指纹同 → 标注保留，内容变 → 整批归档——既有标注契约照常） |
| C | 有 doc 但无匹配 arXiv doc（典型：用户上传 zip） | **不触发**，绝不动用户上传内容（想换源先删 doc）；attach-arxiv 端点此情形 409 |

**不堆叠**：同 work 已有 queued/running 的获取 job → 新触发不再排队（端点返回既有 job；自动路径跳过提交）。JobRunner 无取消、不杀运行中 job（既有取舍）。

**手动入口**（三处，同一权威实现）：① docless 附件 tab 可点击行「可获取：arXiv 全文」；② 附件 tab arXiv doc 行「重新获取 arXiv 最新版」（仅该 doc 为 arXiv 来源时）；③ 导入菜单重新添加（exists → 场景 B）。

## 3. 端点与契约（D10）

- 新增 `POST /api/library/attach-arxiv?id=<workId>`：复刻 upload 路由结构（app.ts:1106–1236 模板）——guardCsrf → 预解析 work（404/400/409）→ 预算 doc id `arxiv-<normArxiv>`（`docIdFor`，无版本号 → 幂等）→ `docMutations.pinWriter`（submit→终态）→ `runner.submit("ingest", handler, {workId, arxivId})` → 终态钩子 unpin + done 时 `libraryChanged` → **202 `{job}`**。
- job kind 启用 contracts `JobKindSchema` 已预留的 `"ingest"` 值；payload `{workId, arxivId}`（web 归属约定与 upload 相同）。
- 202 body 新增 `AttachArxivAcceptedResponseSchema`（形状 `{job}`，与 upload 同形不共名）。
- `JobSchema` 增**可选** `errorCode`（string）：server 对 PDF-only 失败填 `"arxiv_pdf_only"`，供 web 双语引导；其余失败不填。additive 可选字段，不动既有消费者。
- `library.changed` cause 复用既有枚举值（实现时核实 web 不按 cause 分支；若不安全则复用 `"upload"`）。
- **CLI 冻结面不动**（D8）：`ingest`/`library build` 行为不变；本阶段无任何 CLI 变更。

## 4. 挂载语义（D3：照手动上传链路）

core 新 `acquire/attach-arxiv.ts`，对照 `attachLatexZip`（acquire/upload.ts:114）：

1. infra 新 port 实现 `ingestArxivEprint(arxivId, {outRoot, docId, onProgress})`（server deps 的 `IngestPipelines` 已预留 `ingestLatex` 接线先例）：新鲜下载 e-print → 解包（tar/gzip 既有防御）→ `ingestTex` 编译融合 → 写 `<docId>.json`/`src/`/`build/`/`assets/`。
2. `stampSource(docJson, w, <新 acquired_via 值>)` 焊身份（doi/arxiv_id 盖进 doc JSON；区别于 upload 的 `"user_latex_zip"`）。
3. 直挂：场景 A `doc_ids` 置首；场景 B 原位替换同 doc id（顺序不动）。
4. 锁内 `rebuild` 确认 + `reassertMainDoc`（锁内幂等）+ 终检（重载 store 校验 doc 在列）。

job 执行时 re-check：场景 C（执行期间用户上传了 doc）→ job `done` 带 `{skipped:true}` result，不报错不覆盖。

## 5. 新鲜下载与缓存（D16）

- 本 job **恒新鲜下载**：不读 `output/.latexcache` 旧 tarball 命中；下载成功后覆写缓存（供 CLI 等复用）；`Throttler` 礼貌延迟与 UA 不变。
- 刷新时 `<docId>/src` 需全新解包（acquireSource 的 "cheap idempotence" 对刷新路径不适用：刷新前清理/覆盖 src）。
- doc id 用无版本 `arxiv-<normArxiv>`；CLI `ingest <id>vN` 的带版本 doc 是另一目录，不受影响。

## 6. 失败分类、日志与呈现（D5/D12/D13）

- infra 引入类型化错误 `ArxivPdfOnlyError extends Error`（**文案保持现状** → CLI 行为零变化）；server 按类型/阶段归三类：download / extract（含 PDF-only）/ compile / attach。
- job 失败：`job.error` 原文详情页可见 + 重试入口；PDF-only 另填 `errorCode:"arxiv_pdf_only"`，UI 给双语引导「该论文 arXiv 无 LaTeX 源，请改用上传 zip」。
- **报错 log**（用户要求 v1 做好、后续迭代重要参考、打包发布可直接读取）：`<dataDir>/logs/arxiv-fetch.jsonl` append-only plain text，每个 failed / interrupted 的 arXiv 获取 job 一行 `{time, jobId, workId, arxivId, stage, error}`；成功不写；**只记 arXiv 来源**（不记 upload）；单用户量级不轮转。interrupted 由 JobRunner recover 钩子写入（stage=`"interrupted"`）。
- V1 不在 work 上加新持久状态字段。

## 7. UI 整改（D7/D11/D17）

- **信息面板**（RefDetail L325 SourcePill）：移除全部获取类状态（readyFrom/blocked/unknown 不再渲染）；保留「来源：xxx」（ingestedFrom）与「待上传」（needsUpload）。
- **附件 tab**：docless + 有 arXiv id → 可点击行「可获取：arXiv 全文」（**保持现有 pill 文字样式，不改按钮样式**；点击调 attach-arxiv）；行下方 inline 排队/进度（job.progress 末条）/错误+重试（复用 RefDetail 既有 job 收养与 hello 重放模式，扩展 `kind==="ingest"` 归属 `payload.workId`）；PDF-only 显示双语引导行。docless 无 arXiv → 维持 needsUpload pill。其余来源广告（journal html/pdf、ads scan 等）一律不再渲染；数据层 `planFor` 照算不动。
- arXiv doc 行（doc id `arxiv-` 前缀）加「重新获取 arXiv 最新版」文字入口（照现有行内文字样式）。
- demo/无后端模式：与 upload 入口同样禁用/隐藏。
- 新文案双语同写，守 no-hardcoded-copy / locale-parity。

## 8. 配置开关（D9/D15）

config.toml 键 `auto_ingest_arxiv`（snake_case 同 `data_dir`/`port`），**默认 true**；UI 不暴露（隐藏设置）。`= false` 只关**自动**触发（works 路由不排队），手动入口仍可用；server 提交前现读 config（config.toml 本就每次现读无缓存）；未知键忽略/类型错点名不回显值等既有规则不动。

## 9. 锁与并发

编译/下载在锁外（分钟级）；library.json 的 load→save（直挂、rebuild、re-assert）走 `libraryLock` 注入版；`DocMutationRegistry.pinWriter(docId)` 从 submit 持到终态，与 upload/DELETE 互斥沿用既有规则（`isDeleting` → 409 busy）。job.done 先于 library.changed（既有顺序保证）。

## 10. 测试策略

常规自动化全部离线/确定（fetchImpl/provider stub 注入；web vitest 依赖 contracts/core dist，改后先 build）。

- **contracts**：`AttachArxivAcceptedResponseSchema`；`JobSchema.errorCode` 可选；`"ingest"` kind 既有枚举回归。
- **core**：场景判定纯函数（A/B/C、同 id 匹配、无 arXiv）；attachArxivDoc attach/refresh/skip 三路径（stub pipelines）；stamp `acquired_via` 新值；refresh 保 doc_ids 顺序；终检失败抛错。
- **infra**：新鲜下载不读缓存且成功后覆写；`ArxivPdfOnlyError` 类型与文案不变；doc id 无版本幂等。
- **server**：端点 202/400/404/409；去重返既有 job；works 路由自动触发（identifier-arXiv/bibcode/DOI-有 arXiv 触发；bib 模式不触发；exists 场景 B 触发；场景 C 不触发）；`auto_ingest_arxiv=false` 关自动；失败写 log 一行（字段齐全）；recover interrupted 写 log；job.done→library.changed 顺序。
- **web**：pill 渲染规则（信息面板只余来源/待上传；附件 tab 三态）；可点击行触发 API 与进度/错误/重试呈现；PDF-only 双语引导；doc 行重新获取入口可见性；i18n key 对拍。
- **真实浏览器探针**（真实 Chrome/CDP，临时 dataDir）：添加 arXiv 条目 → 自动摄入 → 正文可读；进度呈现；重新添加 → 刷新；失败路径（构造 PDF-only/坏 id）→ 错误+引导+重试+log 落盘。
- **真实 arXiv smoke**：真实 bibcode 创建 → 自动摄入 → 正文可读 → 重新添加刷新。

## 11. 验收标准

四门（`corepack pnpm -r build|test|typecheck` + `corepack pnpm lint`）全绿；新增离线回归齐；真实 Chrome 探针过；一次真实 arXiv smoke 过；用户 smoke 通过后关闭。README 最小能力同步。阶段关闭后按 inbox 协议归并。

## 12. 非目标（本阶段明确不做）

批量 bib 自动触发；CLI 自动拉取（`ingest <doi>`/`library build` 不变，推后项已要求记入 memory）；PDF/OCR/HTML 摄入；job 取消按钮；全局 job 列表 UI；upload 报错入 arxiv-fetch log；acquisition planner 数据层改动；work 持久「获取失败」状态字段；跨进程并发写支持。
